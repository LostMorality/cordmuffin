/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import type { Channel } from "@vencord/discord-types";
import { findByCodeLazy, findByPropsLazy, findStoreLazy } from "@webpack";
import { ChannelStore, FluxDispatcher, GuildStore, PermissionStore, SelectedChannelStore, UserStore, VoiceStateStore } from "@webpack/common";

import { changeStreamProfile, settings } from ".";
import { currentUserId, type GoLiveSettings, profileFor, type StreamProfile, updateProfileFor } from "./profile";

const logger = new Logger("StreamTimeFarmer");

// Discord only counts Streaming badge time while someone else in the call is watching the stream. One account
// streams, the other (a second Discord, or the hidden window in secondAccount.ts) watches, and both sides keep
// themselves connected.

interface AppStream { streamType: string; guildId: string | null; channelId: string; ownerId: string; state?: string; }
interface CaptureSource { id: string; name: string; }
interface Target { id: string; name: string; guildId: string | null; dm: boolean; }

const ApplicationStreamingStore: {
    getCurrentUserActiveStream(): AppStream | null;
    getViewerIds(stream: AppStream | string): string[];
    getStreamForUser(userId: string, guildId: string | null): AppStream | null;
    getActiveStreamForApplicationStream(stream: AppStream): AppStream | null;
} = findStoreLazy("ApplicationStreamingStore");
const MediaEngineStore: { isSelfMute(): boolean; isSelfDeaf(): boolean; } = findStoreLazy("MediaEngineStore");
const StreamSettingsStore: { getState(): GoLiveSettings; persist?(): void; } = findStoreLazy("ApplicationStreamingSettingsStore");
const VoiceActions: { selectVoiceChannel(channelId: string): void; disconnect(): void; } = findByPropsLazy("selectVoiceChannel", "disconnect");
const CallActions: { ring(channelId: string, recipients?: string[]): void; } = findByPropsLazy("ring", "stopRinging", "call");
const PrivateChannelActions: { getOrEnsurePrivateChannel(userId: string): Promise<string>; } = findByPropsLazy("getOrEnsurePrivateChannel", "openPrivateChannel");
const MuteActions: { setSelfMute(context: string, mute: boolean): void; toggleSelfDeaf(options?: { context?: string; syncRemote?: boolean; }): void; } = findByPropsLazy("setSelfMute", "toggleSelfDeaf");
const startStreamWithSource: (source: CaptureSource, options: Record<string, unknown>) => Promise<[boolean, string | undefined]> = findByCodeLazy('"no user or channel"');
const watchStream: (stream: AppStream, options?: { noFocus?: boolean; forceMultiple?: boolean; }) => void = findByCodeLazy('type:"STREAM_WATCH",streamKey');
const stopStream: (streamKey: string, canShowFeedback?: boolean) => void = findByCodeLazy('type:"STREAM_STOP",streamKey');
const closeStream: (streamKey: string, canShowFeedback?: boolean) => void = findByCodeLazy('type:"STREAM_CLOSE",streamKey');
// Discord's own "is this voice channel full for me" check, the one that decides whether joining opens the full window.
const isChannelFull: (channel: Channel, voiceStates: typeof VoiceStateStore, guilds: typeof GuildStore) => boolean = findByCodeLazy("maxStageVideoChannelUsers", "userLimit");

export type StreamPhase = "off" | "setup" | "joining" | "starting" | "waiting" | "counting" | "watching";

export interface StreamStatus {
    phase: StreamPhase;
    detail: string;
    countedMs: number;
    sessionMs: number;
}

const TICK_MS = 5_000;
const JOIN_RETRY_MS = 15_000;
// Each new DM call rings the other account, so starting one again is spaced out more than joining a server channel.
const CALL_RETRY_MS = 60_000;
const START_RETRY_MS = 30_000;
const WATCH_RETRY_MS = 10_000;
const DM_RETRY_MS = 60_000;
// How long the viewer stays in a call it joined after the streaming account is gone, in case it's just reconnecting.
const LEAVE_AFTER_MS = 30_000;
const CONNECT = 1n << 20n;
const VIEW_CHANNEL = 1n << 10n;
const SAVE_EVERY_MS = 60_000;
const PRESET_CUSTOM = 3;
const HANG_UP_SAVE_MS = 5_000;
// Right after Discord connects (startup, or a reconnect) it rejoins the old call and then drops it again by itself.
const SETTLE_MS = 30_000;

let timer: ReturnType<typeof setInterval> | undefined;
let lastTick = 0;
let lastJoin = 0;
let lastStart = 0;
let lastWatch = 0;
let lastDmOpen = 0;
let partnerGoneSince = 0;
let lastSave = 0;
let sessionMs = 0;
let unsaved = 0;
let mutedFor = "";
let run = 0;
let liveError = "";
// What this run started itself, so stopping the farm ends only that and leaves the user's own calls alone. The
// joined call is also kept in settings, because Discord rejoins it by itself after a reload.
let startedKey = "";
let watchedKey = "";
// The account this run belongs to, so its settings stay with it even if the user switches accounts mid-run.
let owner = "";
// Whether the streamer has been in its call this run, so leaving it can be told apart from not having joined yet.
let inCall = false;
// The call this run is in. Leaving it counts as hanging up, even when the farm didn't join it itself.
let farmCall = "";
// Logging out (or switching accounts) also leaves the call, and that isn't hanging up either.
let loggingOut = false;
// When Discord last connected. Set at load too, since the plugin starts along with Discord.
let lastConnect = Date.now();
// Whether this run joined its call itself, and since when it's been in it.
let farmJoined = false;
let joinedAt = 0;
// The account whose hang-up is waiting to be saved.
let pendingOff = "";
let hangUpTimer: ReturnType<typeof setTimeout> | undefined;
let status: StreamStatus = { phase: "off", detail: "", countedMs: 0, sessionMs: 0 };
const listeners = new Set<() => void>();

const who = () => owner || currentUserId();
const prof = () => profileFor(who());
const setProf = (patch: Partial<StreamProfile>) => updateProfileFor(who(), patch);

export const streamStatus = () => status;

export function onStreamStatus(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}

function setStatus(phase: StreamPhase, detail: string) {
    const countedMs = prof().countedMs + unsaved;
    if (status.phase === phase && status.detail === detail && status.countedMs === countedMs && status.sessionMs === sessionMs) return;
    status = { phase, detail, countedMs, sessionMs };
    for (const listener of listeners) listener();
}

function save(force = false) {
    const now = Date.now();
    if (!unsaved || !force && now - lastSave < SAVE_EVERY_MS) return;
    setProf({ countedMs: prof().countedMs + unsaved });
    unsaved = 0;
    lastSave = now;
}

export const snowflake = (id: string) => /^\d{17,20}$/.test(id.trim()) ? id.trim() : "";

const partnerId = () => snowflake(prof().partner);
const partnerName = (fallback: string) => UserStore.getUser(partnerId())?.username ?? fallback;

// A DM call with the other account, or a server voice channel both accounts can join.
function target(now: number): Target | string {
    const partner = partnerId();
    const { where: meetAt, channel: channelId } = prof();
    if (meetAt === "server") {
        const id = snowflake(channelId);
        const channel = id ? ChannelStore.getChannel(id) : null;
        if (!channel || channel.type !== 2) return "Pick the voice channel both accounts can join.";
        return { id: channel.id, name: channel.name, guildId: channel.guild_id ?? null, dm: false };
    }
    if (!partner) return "Enter your other account's user ID so the two can call each other.";
    if (partner === UserStore.getCurrentUser().id) return "The other account's ID is this account. Enter the other one.";
    if (!UserStore.getUser(partner)) return "Couldn't find that account. Check the ID, and make sure the two accounts are friends.";
    const dm = ChannelStore.getDMFromUserId(partner);
    if (dm) return { id: dm, name: `the call with ${partnerName("your other account")}`, guildId: null, dm: true };
    if (now - lastDmOpen >= DM_RETRY_MS) {
        lastDmOpen = now;
        PrivateChannelActions.getOrEnsurePrivateChannel(partner).catch(e => logger.warn("Couldn't open the DM with the other account", e));
    }
    return "Opening a DM with your other account...";
}

function inChannel(userId: string, channelId: string) {
    return VoiceStateStore.getVoiceStateForUser(userId)?.channelId === channelId;
}

// This Discord, not the account: the same account in a call on a phone doesn't count as joined here.
const joinedHere = (channelId: string) => SelectedChannelStore.getVoiceChannelId() === channelId;

// Joining a full server channel opens Discord's "channel is full" window, so it isn't retried.
function isFull(where: Target) {
    if (where.dm) return false;
    const channel = ChannelStore.getChannel(where.id);
    if (!channel) return false;
    try {
        return isChannelFull(channel, VoiceStateStore, GuildStore);
    } catch {
        const limit = channel.userLimit ?? 0;
        return limit > 0 && Object.keys(VoiceStateStore.getVoiceStatesForChannel(where.id) ?? {}).length >= limit;
    }
}

// The streamer starts DM calls and rings the viewer; the viewer only joins a call that's already going.
function join(where: Target, now: number, startCall: boolean) {
    if (isFull(where)) return setStatus("waiting", `${where.name} is full. Waiting for a spot.`);
    setStatus("joining", where.dm && startCall ? `Calling ${partnerName("your other account")}...` : `Joining ${where.name}...`);
    if (now - lastJoin < (where.dm && startCall ? CALL_RETRY_MS : JOIN_RETRY_MS)) return;
    lastJoin = now;
    if (prof().joinedCall !== where.id) setProf({ joinedCall: where.id });
    // A fresh join comes in unmuted, so it gets muted again.
    mutedFor = "";
    farmJoined = true;
    VoiceActions.selectVoiceChannel(where.id);
    if (where.dm && startCall) CallActions.ring(where.id);
}

// Mute once per joined channel, so someone who unmutes on purpose isn't fought every few seconds. The viewer also
// deafens: both accounts usually sit on one PC, so hearing the call would only risk feedback. Deafen sticks after a
// call in Discord, so the farm remembers it did it and undoes it when it stops.
function muteOnJoin(channelId: string, deafen: boolean) {
    if (mutedFor === channelId) return;
    mutedFor = channelId;
    if (settings.store.muteMic && !MediaEngineStore.isSelfMute()) MuteActions.setSelfMute("default", true);
    if (deafen && settings.store.deafenViewer && !MediaEngineStore.isSelfDeaf()) {
        MuteActions.toggleSelfDeaf();
        setProf({ deafened: true });
    }
}

function undeafen() {
    if (!prof().deafened) return;
    setProf({ deafened: false });
    if (MediaEngineStore.isSelfDeaf()) MuteActions.toggleSelfDeaf();
}

export async function captureSources(): Promise<CaptureSource[]> {
    const capture = (window as any).DiscordNative?.desktopCapture;
    if (!capture?.getDesktopCaptureSources) return [];
    const list = await capture.getDesktopCaptureSources({ types: ["screen", "window"], thumbnailSize: { width: 1, height: 1 } });
    return (Array.isArray(list) ? list : []).map((s: any) => ({ id: String(s.id), name: String(s.name ?? s.id) }));
}

// The saved choice is a window title, "screen" or "random"; window ids change every time the window opens.
async function pickSource(): Promise<CaptureSource | null> {
    const sources = await captureSources();
    const wanted = prof().source.trim().toLowerCase();
    const screen = sources.find(s => s.id.startsWith("screen:"));
    if (wanted === "random") {
        const windows = sources.filter(s => s.id.startsWith("window:"));
        return windows.length ? windows[Math.floor(Math.random() * windows.length)] : screen ?? null;
    }
    if (!wanted || wanted === "screen") return screen ?? null;
    return sources.find(s => s.id.startsWith("window:") && s.name.toLowerCase() === wanted)
        ?? sources.find(s => s.id.startsWith("window:") && s.name.toLowerCase().includes(wanted))
        ?? null;
}

// Go Live remembers the last quality used. The user's own choice is kept in the plugin's settings (so a crash
// can't lose it) and put back when the farm stops.
const FARM_GO_LIVE: GoLiveSettings = { preset: PRESET_CUSTOM, resolution: 480, fps: 5, soundshareEnabled: false };
const isFarmGoLive = (s: GoLiveSettings) => s.preset === FARM_GO_LIVE.preset && s.resolution === FARM_GO_LIVE.resolution
    && s.fps === FARM_GO_LIVE.fps && s.soundshareEnabled === FARM_GO_LIVE.soundshareEnabled;

function restoreGoLive() {
    const saved = prof().savedGoLive;
    if (!saved) return;
    setProf({ savedGoLive: null });
    applyGoLive(saved);
}

function applyGoLive({ preset, resolution, fps, soundshareEnabled }: GoLiveSettings) {
    FluxDispatcher.dispatch({ type: "STREAM_UPDATE_SETTINGS", preset, resolution, frameRate: fps, soundshareEnabled });
    // Discord saves this store when idle, which never comes while the window is closing.
    try {
        StreamSettingsStore.persist?.();
    } catch (e) {
        logger.warn("Couldn't save the Go Live settings", e);
    }
}

async function goLive(now: number, where: Target) {
    if (now - lastStart < START_RETRY_MS) return;
    lastStart = now;
    const myRun = run;
    const source = await pickSource();
    if (myRun !== run) return;
    if (!source) {
        liveError = `Couldn't find "${prof().source}" to stream. Pick another source.`;
        return;
    }
    // Stopped, or moved to another call while looking for the source.
    if (SelectedChannelStore.getVoiceChannelId() !== where.id) return;
    const { preset, resolution, fps, soundshareEnabled } = StreamSettingsStore.getState();
    const before = { preset, resolution, fps, soundshareEnabled };
    // The farm's own quality, left behind by a stream that started late, is never mistaken for the user's choice.
    if (!prof().savedGoLive && !isFarmGoLive(before)) setProf({ savedGoLive: before });
    const me = UserStore.getCurrentUser().id;
    const key = where.guildId ? `guild:${where.guildId}:${where.id}:${me}` : `call:${where.id}:${me}`;
    const [ok, why] = await startStreamWithSource(source, { ...FARM_GO_LIVE, previewDisabled: true });
    if (myRun !== run) {
        // The farm stopped while Go Live was starting, so its teardown couldn't end this stream yet, and starting it
        // set the farm's quality after the user's was already put back.
        if (ok) stopStream(key, false);
        if (!isFarmGoLive(before)) applyGoLive(before);
        return;
    }
    if (ok) startedKey = key;
    liveError = ok ? "" : `Go Live didn't start${why ? ` (${why})` : ""}. Trying again soon.`;
    if (!ok) logger.warn("Go Live didn't start:", why);
}

const streamKey = (stream: AppStream) => stream.guildId
    ? `${stream.streamType}:${stream.guildId}:${stream.channelId}:${stream.ownerId}`
    : `${stream.streamType}:${stream.channelId}:${stream.ownerId}`;

// A stream that failed (for example its window closed) stays listed until it's started again.
const isLive = (stream: AppStream | null, channelId: string): stream is AppStream =>
    stream != null && stream.channelId === channelId && stream.state !== "FAILED" && stream.state !== "ENDED";

function count(elapsed: number) {
    sessionMs += elapsed;
    unsaved += elapsed;
    save();
}

function streamerTick(now: number, elapsed: number) {
    const where = target(now);
    if (typeof where === "string") return setStatus("setup", where);
    const me = UserStore.getCurrentUser().id;
    if (!joinedHere(where.id)) return join(where, now, true);
    if (!inCall) joinedAt = now;
    inCall = true;
    farmCall = where.id;
    muteOnJoin(where.id, false);

    const stream = ApplicationStreamingStore.getCurrentUserActiveStream();
    if (!isLive(stream, where.id)) {
        startedKey = "";
        void goLive(now, where).catch(e => logger.error("Couldn't go live", e));
        return setStatus("starting", liveError || "Going live...");
    }
    liveError = "";

    const partner = partnerId();
    const viewers = ApplicationStreamingStore.getViewerIds(stream).filter(id => id !== me);
    const watched = partner ? viewers.includes(partner) : viewers.length > 0;
    if (!watched) {
        const who = partner ? partnerName("your other account") : "someone";
        return setStatus("waiting", `Live, waiting for ${who} to watch. Time only counts while they do.`);
    }
    count(elapsed);
    setStatus("counting", `Live and watched by ${viewers.length === 1 ? "1 viewer" : `${viewers.length} viewers`}. Time is counting.`);
}

// Where the streaming account is right now, if this account can be there too: a DM call with it, or a server voice
// channel this account can join. The viewer follows it there instead of sticking to one channel.
function partnerSpot(partner: string): Target | null {
    const channelId = VoiceStateStore.getVoiceStateForUser(partner)?.channelId;
    const channel = channelId ? ChannelStore.getChannel(channelId) : null;
    if (!channel) return null;
    if (channel.type === 1) return channel.recipients?.includes(partner) ? { id: channel.id, name: `the call with ${partnerName("the streaming account")}`, guildId: null, dm: true } : null;
    if (channel.type !== 2) return null;
    if (!PermissionStore.can(VIEW_CHANNEL, channel) || !PermissionStore.can(CONNECT, channel)) return null;
    return { id: channel.id, name: channel.name, guildId: channel.guild_id ?? null, dm: false };
}

function leaveIfAlone(now: number) {
    const joined = prof().joinedCall;
    if (!joined || !joinedHere(joined)) return;
    partnerGoneSince ||= now;
    if (now - partnerGoneSince < LEAVE_AFTER_MS) return;
    VoiceActions.disconnect();
    setProf({ joinedCall: "" });
    mutedFor = "";
    undeafen();
}

function viewerTick(now: number, elapsed: number) {
    const partner = partnerId();
    if (!partner) return setStatus("setup", "Enter the user ID of the account that streams.");
    if (partner === UserStore.getCurrentUser().id) return setStatus("setup", "The other account's ID is this account. Enter the other one.");
    if (!UserStore.getUser(partner)) return setStatus("setup", "Couldn't find that account. Check the ID, and make sure the two accounts are friends.");
    const me = UserStore.getCurrentUser().id;
    const name = partnerName("the streaming account");

    const where = partnerSpot(partner);
    const stream = where && ApplicationStreamingStore.getStreamForUser(partner, where.guildId);
    const live = where != null && isLive(stream, where.id);
    // DM calls are joined as soon as the other account calls; server channels only while it's streaming there.
    if (!where || !where.dm && !live) {
        leaveIfAlone(now);
        return setStatus("waiting", `Waiting for ${name} to call or go live somewhere this account can join.`);
    }
    partnerGoneSince = 0;
    if (!joinedHere(where.id)) return join(where, now, false);
    muteOnJoin(where.id, true);

    if (!live || !stream) return setStatus("waiting", `In ${where.name}, waiting for ${name} to go live.`);
    const watching = ApplicationStreamingStore.getActiveStreamForApplicationStream(stream) != null
        && ApplicationStreamingStore.getViewerIds(stream).includes(me);
    if (!watching) {
        if (now - lastWatch >= WATCH_RETRY_MS) {
            lastWatch = now;
            watchedKey = streamKey(stream);
            watchStream(stream, { noFocus: true });
        }
        return setStatus("joining", `Opening ${name}'s stream...`);
    }
    // Watching earns the streaming account's time, not this one's, so it only shows in this call's time.
    sessionMs += elapsed;
    setStatus("watching", `Watching ${name}'s stream in ${where.name}. Their time is counting.`);
}

function tick() {
    const now = Date.now();
    // A sleeping PC or a stalled tick shouldn't count as streamed time.
    const elapsed = Math.max(0, Math.min(now - lastTick, 3 * TICK_MS));
    lastTick = now;
    try {
        const { role } = prof();
        if (role === "streamer") streamerTick(now, elapsed);
        else if (role === "viewer") viewerTick(now, elapsed);
    } catch (e) {
        logger.error("Stream farm tick failed", e);
    }
}

// Reacts right away when the other account joins, goes live or drops, instead of waiting for the next tick.
let kickTimer: ReturnType<typeof setTimeout> | undefined;
const kick = () => {
    if (!timer || kickTimer) return;
    kickTimer = setTimeout(() => {
        kickTimer = undefined;
        if (timer) tick();
    }, 250);
};
const EVENTS = ["STREAM_CREATE", "STREAM_UPDATE", "STREAM_DELETE", "STREAM_CLOSE", "VOICE_CHANNEL_SELECT", "VOICE_STATE_UPDATES", "CALL_CREATE", "CALL_UPDATE", "CALL_DELETE"] as const;

// Leaving the farm's call in Discord (hanging up, or moving to another call) is the same as pressing Hang up.
function onVoiceSelect(action: { channelId?: string | null; }) {
    if (loggingOut || !inCall || prof().role !== "streamer" || !farmCall || action.channelId === farmCall) return;
    // Right after Discord connects, or in a call Discord rejoined by itself, leaving is Discord's doing. The farm
    // rejoins then, but not straight away if the user went into another call.
    const now = Date.now();
    const settled = now - lastConnect >= SETTLE_MS && (farmJoined || now - joinedAt >= SETTLE_MS);
    if (!settled) {
        if (action.channelId) lastJoin = now;
        return;
    }
    inCall = false;
    const leftBy = owner;
    pendingOff = leftBy;
    // The call ends right away (not from inside Discord's dispatch, which the teardown would dispatch into), but the
    // choice to stay off is only saved a few seconds later: Discord also leaves the call while it's closing, and
    // that shouldn't count as hanging up, so the call comes back after a restart.
    setTimeout(() => {
        stopStreamFarm();
        clearTimeout(hangUpTimer);
        hangUpTimer = setTimeout(() => {
            pendingOff = "";
            // Saved for the account that left, even if a different one is logged in by now.
            if (leftBy === currentUserId()) changeStreamProfile({ role: "off" });
            else updateProfileFor(leftBy, { role: "off" });
        }, HANG_UP_SAVE_MS);
    });
}

const onLogout = () => {
    loggingOut = true;
};

const onConnect = () => {
    lastConnect = Date.now();
};

const onUnload = () => {
    save(true);
    restoreGoLive();
};

// Ends the Go Live and leaves the call this run started; anything the user started themselves stays.
function teardown() {
    const own = ApplicationStreamingStore.getCurrentUserActiveStream();
    if (startedKey && own && streamKey(own) === startedKey) stopStream(startedKey, false);
    const joined = prof().joinedCall;
    if (joined && joinedHere(joined)) VoiceActions.disconnect();
    else if (watchedKey) closeStream(watchedKey, false);
    setProf({ joinedCall: "" });
    startedKey = watchedKey = "";
    undeafen();
}

export function startStreamFarm() {
    stopStreamFarm();
    clearTimeout(hangUpTimer);
    // A hang-up still waiting to be saved belongs to the account that left; a new call from that same account
    // replaces it, but switching accounts mustn't lose it.
    if (pendingOff && pendingOff !== currentUserId()) updateProfileFor(pendingOff, { role: "off" });
    pendingOff = "";
    owner = currentUserId();
    if (!owner || prof().role === "off") return;
    // Left over from a Discord that closed mid-run: put the user's Go Live quality back before starting again.
    if (!ApplicationStreamingStore.getCurrentUserActiveStream()) restoreGoLive();
    lastTick = Date.now();
    lastJoin = lastStart = lastWatch = lastDmOpen = partnerGoneSince = 0;
    sessionMs = 0;
    mutedFor = liveError = "";
    inCall = false;
    farmCall = "";
    loggingOut = false;
    farmJoined = false;
    joinedAt = 0;
    for (const e of EVENTS) FluxDispatcher.subscribe(e, kick);
    FluxDispatcher.subscribe("VOICE_CHANNEL_SELECT", onVoiceSelect);
    FluxDispatcher.subscribe("LOGOUT", onLogout);
    FluxDispatcher.subscribe("CONNECTION_OPEN", onConnect);
    window.addEventListener("beforeunload", onUnload);
    timer = setInterval(tick, TICK_MS);
    tick();
}

export function stopStreamFarm() {
    run++;
    if (timer) {
        clearInterval(timer);
        clearTimeout(kickTimer);
        timer = kickTimer = undefined;
        for (const e of EVENTS) FluxDispatcher.unsubscribe(e, kick);
        FluxDispatcher.unsubscribe("VOICE_CHANNEL_SELECT", onVoiceSelect);
        FluxDispatcher.unsubscribe("LOGOUT", onLogout);
        FluxDispatcher.unsubscribe("CONNECTION_OPEN", onConnect);
        window.removeEventListener("beforeunload", onUnload);
        try {
            teardown();
        } catch (e) {
            logger.error("Couldn't end the stream farm's call", e);
        }
        restoreGoLive();
    }
    save(true);
    owner = "";
    setStatus("off", "");
}

export const streamFarmRunning = () => timer != null;
export const streamFarmOwner = () => owner;

export function resetStreamCount() {
    unsaved = 0;
    setProf({ countedMs: 0 });
    setStatus(status.phase, status.detail);
}
