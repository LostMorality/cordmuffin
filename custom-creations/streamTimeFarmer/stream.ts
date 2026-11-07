/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Settings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { sleep } from "@utils/misc";
import type { PluginNative } from "@utils/types";
import type { Channel } from "@vencord/discord-types";
import { findByCodeLazy, findByPropsLazy, findStoreLazy } from "@webpack";
import { ChannelStore, FluxDispatcher, GuildStore, PermissionStore, SelectedChannelStore, UserStore, VoiceStateStore } from "@webpack/common";

import { changeStreamProfile, settings } from ".";
import { currentUserId, FARM_SOURCE, type FarmGame, type GoLiveSettings, profileFor, type StreamProfile, updateProfileFor } from "./profile";
import { secondStatus } from "./secondAccount";
import { expectReports, onReport, trackingProblem, watchReportsFrom } from "./tracking";

const logger = new Logger("StreamTimeFarmer");

// Discord only counts Streaming badge time while someone else in the call is watching the stream. One account
// streams, the other (a second Discord, or the hidden window in secondAccount.ts) watches, and both sides keep
// themselves connected.

interface AppStream { streamType: string; guildId: string | null; channelId: string; ownerId: string; state?: string; }
interface CaptureSource { id: string; name: string; }
interface Target { id: string; name: string; guildId: string | null; dm: boolean; }
interface AVError { type?: string; mediaContext?: string; userId?: string; }

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
const IdleStore: { getSystemSuspended?(): boolean; } = findStoreLazy("IdleStore");
const StreamRTCConnectionStore: { getRTCConnections(): Record<string, { isOwner: boolean; destroy(reason: string): void; }>; } = findStoreLazy("StreamRTCConnectionStore");
const startStreamWithSource: (source: CaptureSource, options: Record<string, unknown>) => Promise<[boolean, string | undefined]> = findByCodeLazy('"no user or channel"');
const watchStream: (stream: AppStream, options?: { noFocus?: boolean; forceMultiple?: boolean; }) => void = findByCodeLazy('type:"STREAM_WATCH",streamKey');
const stopStream: (streamKey: string, canShowFeedback?: boolean) => void = findByCodeLazy('type:"STREAM_STOP",streamKey');
const closeStream: (streamKey: string, canShowFeedback?: boolean) => void = findByCodeLazy('type:"STREAM_CLOSE",streamKey');
// Discord's own "is this voice channel full for me" check, the one that decides whether joining opens the full window.
const DesktopSources: { getDesktopSourceFromPid(pid: number): string | null; } = findByPropsLazy("getDesktopSourceFromPid", "getPidFromDesktopSource");
const AVErrorStore: { getActiveErrors(): Map<string, AVError> | null; } = findStoreLazy("AVErrorStore");
const Native = IS_DISCORD_DESKTOP ? VencordNative.pluginHelpers.StreamTimeFarmer as PluginNative<typeof import("./native")> : null;
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
// A watched stream that stays paused this long is stuck, not just catching up, and gets reopened.
const STUCK_MS = 20_000;
// A broken Go Live is restarted at most this often, so a stream that keeps failing doesn't flap.
const RESTART_EVERY_MS = 60_000;
// A Go Live that Discord lists but never actually sends (its error 2012 and friends) looks fine to the farm forever,
// so it's restarted after this long. Longer than the viewer's wait, because a stream is briefly not ACTIVE anyway.
const SENDER_STUCK_MS = 45_000;
// After this many failed starts in a row the status stops sounding like a hiccup and names the likely cause.
const FAILS_BEFORE_REASON = 3;
const LOST_STREAM_MS = 2 * 60_000;
const FARM_TITLE = "Stream farm (StreamTimeFarmer)";
// The farm window is a Windows program started by Discord's desktop app; anywhere else the farm streams a random
// open window, like it did before it had its own.
export const canUseFarmWindow = () => Native != null && navigator.userAgent.includes("Windows");

let timer: ReturnType<typeof setInterval> | undefined;
let lastTick = 0;
let lastJoin = 0;
let lastStart = 0;
// Counts Go Live starts, so a start that finishes late can tell whether a newer one has begun since.
let starts = 0;
let lastWatch = 0;
let lastDmOpen = 0;
let partnerGoneSince = 0;
let lastSave = 0;
let sessionMs = 0;
let unsaved = 0;
let mutedFor = "";
let run = 0;
let liveError = "";
// When the farm's own stream stopped being ACTIVE, and how many starts have failed in a row.
let senderStuckSince = 0;
let liveFails = 0;
// What this run started itself, so stopping the farm ends only that and leaves the user's own calls alone. The
// joined call is also kept in settings, because Discord rejoins it by itself after a reload.
let startedKey = "";
// Time watched since the last report went out, for sending Discord its time with a restart (settings.reportEvery).
let watchedSinceReport = 0;
let liveSince = 0;
// The farm's last stream, so it isn't taken for the user's own after a short gap in Discord's list of streams.
let lastStartedKey = "";
let lostStreamAt = 0;
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
// The farm's own window (see native.ts) and the game it's shown as, if any.
let farmPid = 0;
let farmSince = 0;
let farmGameSet = false;
// The game the open farm window was made for ("" for none), so a different game gets a new window.
let farmWindowFor = "";
// The farm window's handle in Go Live's list, once it showed up there.
let farmHandle = "";
let lastRestart = 0;
let stuckSince = 0;
let farmCheck: Promise<void> | null = null;
// Error id -> when it was acted on. Discord reuses one id per user, so an id is dropped once its error clears and a
// later one counts as new; one that never clears counts again after ERROR_RECHECK_MS.
const handledErrors = new Map<string, number>();
const ERROR_RECHECK_MS = 60_000;
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
// deafens: both accounts usually sit on one PC, so hearing the call would only risk feedback. Mute and deafen stick
// after a call in Discord, so the farm remembers what it did and undoes it when it stops.
function muteOnJoin(channelId: string, deafen: boolean) {
    if (mutedFor === channelId) return;
    mutedFor = channelId;
    if (settings.store.muteMic && !MediaEngineStore.isSelfMute()) {
        MuteActions.setSelfMute("default", true);
        setProf({ muted: true });
    }
    if (deafen && settings.store.deafenViewer && !MediaEngineStore.isSelfDeaf()) {
        MuteActions.toggleSelfDeaf();
        setProf({ deafened: true });
    }
}

function undeafen() {
    if (prof().deafened) {
        setProf({ deafened: false });
        if (MediaEngineStore.isSelfDeaf()) MuteActions.toggleSelfDeaf();
    }
    // After undeafening, since Discord can bring a mute back along with it.
    if (prof().muted) {
        setProf({ muted: false });
        if (MediaEngineStore.isSelfMute()) MuteActions.setSelfMute("default", false);
    }
}

export async function captureSources(): Promise<CaptureSource[]> {
    const capture = (window as any).DiscordNative?.desktopCapture;
    if (!capture?.getDesktopCaptureSources) return [];
    const list = await capture.getDesktopCaptureSources({ types: ["screen", "window"], thumbnailSize: { width: 1, height: 1 } });
    return (Array.isArray(list) ? list : []).map((s: any) => ({ id: String(s.id), name: String(s.name ?? s.id) }));
}

// gameSessionSpoofer shows its game through the same one-game slot in Discord, so game mode steps aside while it runs one.
export const gameSlotTaken = () => {
    const gss = Settings.plugins.GameSessionSpoofer;
    return !!gss?.enabled && gss.session != null;
};

// Discord's own game detection is told the farm window's process is the picked game, the same way it sees a real
// game, so Go Live shows "Streaming <game>". Nothing else about the game is faked; the picture is the farm window.
function setFarmGame(game: FarmGame | null, pid = 0, handle: string | null = null) {
    if (!game) {
        if (!farmGameSet) return;
        farmGameSet = false;
        if (!gameSlotTaken()) FluxDispatcher.dispatch({ type: "RUNNING_GAME_SET_DEBUG_GAME", game: null });
        return;
    }
    if (gameSlotTaken()) return;
    const now = Date.now();
    const folder = game.name.replace(/[<>:"/\\|?*]/g, "").toLowerCase();
    const running = {
        id: game.id,
        name: game.name,
        exeName: game.exeName,
        exePath: `c:/program files/${folder}/${game.exeName}`,
        cmdLine: `c:/program files/${folder}/${game.exeName}`,
        processName: game.name,
        pid,
        pidPath: [pid],
        start: farmSince || now,
        lastFocused: Math.floor(now / 1000),
        lastLaunched: farmSince || now,
        nativeProcessObserverId: -1,
        hidden: false,
        isLauncher: false,
        elevated: false,
        sandboxed: false,
        windowHandle: handle
    };
    // Discord resets the start time of a game it's told about again, so it's set twice to keep the original one.
    const { start } = running;
    FluxDispatcher.dispatch({ type: "RUNNING_GAME_SET_DEBUG_GAME", game: running });
    running.start = start;
    FluxDispatcher.dispatch({ type: "RUNNING_GAME_SET_DEBUG_GAME", game: running });
    farmGameSet = true;
}

const farmGameNow = () => gameSlotTaken() ? null : prof().farmGame;

async function farmAlive() {
    return farmPid !== 0 && await Native?.farmWindowPid().catch(() => 0) === farmPid;
}

// Opens the farm window if it isn't open, waits for Go Live to list it, and returns it as the source.
async function farmSource(): Promise<CaptureSource | null> {
    if (!Native) throw new Error("Discord needs a full quit and reopen first");
    const myRun = run;
    const game = farmGameNow();
    const alive = await farmAlive();
    if (myRun !== run) return null;
    // Made for another game (or before gameSessionSpoofer stepped in or out): it shows the wrong name and cover.
    if (alive && farmWindowFor !== (game?.id ?? "")) {
        setFarmGame(null);
        void Native.stopFarmWindow(farmPid).catch(() => { });
        farmPid = 0;
        farmHandle = "";
    }
    if (!alive || !farmPid) {
        farmSince ||= Date.now();
        const pid = await Native.startFarmWindow(game?.name || FARM_TITLE, game?.cover ?? "", farmSince);
        // Stopped or restarted while it was starting: this window belongs to nobody now.
        if (myRun !== run) {
            void Native.stopFarmWindow(pid).catch(() => { });
            return null;
        }
        farmPid = pid;
        farmWindowFor = game?.id ?? "";
    }
    const pid = farmPid;
    for (let i = 0; i < 60; i++) {
        if (myRun !== run) return null;
        let handle: string | undefined;
        try {
            handle = String(await DesktopSources.getDesktopSourceFromPid(pid) ?? "").split(":")[1];
        } catch { }
        const windows = (await captureSources()).filter(s => s.id.startsWith("window:"));
        if (myRun !== run) return null;
        // Going by the title is only safe for the farm's own name; a game's name could match the real game's window.
        const found = handle ? windows.find(s => s.id.split(":")[1] === handle)
            : !game && i >= 12 ? windows.find(s => s.name === FARM_TITLE) : undefined;
        if (found) {
            farmHandle = found.id.split(":")[1] ?? "";
            if (game) setFarmGame(game, pid, farmHandle || null);
            return found;
        }
        await sleep(250);
    }
    return null;
}

// Also closes a window that's still starting, which farmPid doesn't know about yet.
function closeFarmWindow() {
    setFarmGame(null);
    void Native?.stopFarmWindow().catch(() => { });
    farmPid = farmSince = 0;
    farmWindowFor = farmHandle = "";
}

// The farm window only works as the "farm" choice: picked by its title, it would be closed and then never found.
export const isFarmWindow = (source: CaptureSource) => source.name === FARM_TITLE || farmHandle !== "" && source.id.split(":")[1] === farmHandle;

// The old default, still used where the farm window can't run.
async function randomWindow(): Promise<CaptureSource | null> {
    const sources = await captureSources();
    const windows = sources.filter(s => s.id.startsWith("window:"));
    return windows.length ? windows[Math.floor(Math.random() * windows.length)] : sources.find(s => s.id.startsWith("screen:")) ?? null;
}

// The saved choice is the farm window ("farm"), a window title or "screen"; window ids change every time a window opens.
let lastWindow: { source: string; handle: string; } | null = null;

async function pickSource(): Promise<CaptureSource | null> {
    const wanted = prof().source.trim().toLowerCase();
    if (wanted === FARM_SOURCE || wanted === "random") return canUseFarmWindow() ? farmSource() : randomWindow();
    const sources = await captureSources();
    const screen = sources.find(s => s.id.startsWith("screen:"));
    if (!wanted || wanted === "screen") return screen ?? null;
    // A window's title can change while it streams (a browser tab, the next song), so the one already picked is found
    // again by its handle. Otherwise a report restart would lose it and leave the farm with nothing to stream.
    if (lastWindow?.source === wanted) {
        const same = sources.find(s => s.id.startsWith("window:") && s.id.split(":")[1] === lastWindow?.handle);
        if (same) return same;
    }
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
    const myStart = ++starts;
    const source = await pickSource();
    if (myRun !== run) return;
    if (!source) {
        liveError = isFarmSource()
            ? "The farm's own window didn't show up in Go Live. Trying again soon."
            : `Couldn't find "${prof().source}" to stream. Pick another source.`;
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
        // set the farm's quality after the user's was already put back. The stream key is the same for every stream in
        // the call, so once a newer start (after a source change) has begun, the stream is that one's and stays.
        if (ok && myStart === starts) stopStream(key, false);
        if (!isFarmGoLive(before)) applyGoLive(before);
        return;
    }
    if (ok) {
        startedKey = lastStartedKey = key;
        lastWindow = source.id.startsWith("window:") ? { source: prof().source.trim().toLowerCase(), handle: source.id.split(":")[1] } : null;
        liveSince = Date.now();
        watchedSinceReport = 0;
        senderStuckSince = 0;
        forgetStreamErrors("sender", me);
    } else liveFails++;
    liveError = ok ? "" : `Go Live didn't start${why ? ` (${why})` : ""}. Trying again soon.`;
    if (!ok) logger.warn("Go Live didn't start:", why);
}

const streamKey = (stream: AppStream) => stream.guildId
    ? `${stream.streamType}:${stream.guildId}:${stream.channelId}:${stream.ownerId}`
    : `${stream.streamType}:${stream.channelId}:${stream.ownerId}`;

const isFarmSource = () => canUseFarmWindow() && [FARM_SOURCE, "random"].includes(prof().source.trim().toLowerCase());

// Stream errors Discord shows for this account's own stream (sending) or for the partner's (receiving).
function streamErrors(kind: "sender" | "receiver", userId: string): string[] {
    try {
        const active = AVErrorStore.getActiveErrors();
        if (!(active instanceof Map)) return [];
        return [...active.entries()].filter(([, e]) => e && e.mediaContext === "stream" && (e.userId == null || e.userId === userId)
            && (e.type?.startsWith(`video-stream-${kind}-ready-timeout`) || kind === "sender" && e.type === "stream-failed-to-start"))
            .map(([id]) => id);
    } catch {
        return [];
    }
}

// Whether one of those errors is new, or still there a while after something was done about it.
function freshStreamError(kind: "sender" | "receiver", userId: string) {
    const now = Date.now();
    const ids = streamErrors(kind, userId);
    const mine = (id: string) => kind === "sender" ? !id.includes("-receiver-") : id.includes("-receiver-");
    for (const id of [...handledErrors.keys()]) if (mine(id) && !ids.includes(id)) handledErrors.delete(id);
    return ids.some(id => !handledErrors.has(id) || now - handledErrors.get(id)! >= ERROR_RECHECK_MS);
}

// Errors from before a restart or a new stream were about the old one.
function forgetStreamErrors(kind: "sender" | "receiver", userId: string) {
    for (const id of streamErrors(kind, userId)) handledErrors.set(id, Date.now());
}

// Ends a broken Go Live so the next tick starts a fresh one (and reopens the farm window if it closed).
const canRestart = (now: number) => now - lastRestart >= RESTART_EVERY_MS;

// Once a stream has failed a few times running, say so plainly instead of looking like it's about to work.
const failNote = (text: string) => liveFails >= FAILS_BEFORE_REASON
    ? `${text} Discord has refused this stream ${liveFails} times in a row, usually its own error 2012 rather than anything this plugin or your settings did.`
    : text;

// A failed restart is one the stream forced; a scheduled one isn't, so only failures count toward liveFails.
function restartLive(stream: AppStream, now: number, why: string, failure = false) {
    if (!canRestart(now)) return false;
    lastRestart = now;
    if (failure) liveFails++;
    senderStuckSince = 0;
    watchedSinceReport = 0;
    forgetStreamErrors("sender", stream.ownerId);
    logger.info("Restarting Go Live:", why);
    stopStream(streamKey(stream), false);
    startedKey = "";
    lastStart = 0;
    liveError = `${why} Restarting Go Live...`;
    return true;
}

// A stream that failed (for example its window closed) stays listed until it's started again.
const isLive = (stream: AppStream | null, channelId: string): stream is AppStream =>
    stream != null && stream.channelId === channelId && stream.state !== "FAILED" && stream.state !== "ENDED";

function count(elapsed: number) {
    sessionMs += elapsed;
    unsaved += elapsed;
    save();
}

const reportEveryMs = () => (settings.store.reportEvery ?? 60) * 60_000;

// How long until the next report goes out, or null while there's none on a timer.
export function nextReportMs() {
    const every = reportEveryMs();
    return every > 0 && startedKey ? Math.max(0, every - watchedSinceReport) : null;
}

function streamerTick(now: number, elapsed: number) {
    const where = target(now);
    if (typeof where === "string") return setStatus("setup", where);
    const me = UserStore.getCurrentUser().id;
    if (!joinedHere(where.id)) return join(where, now, true);
    if (!inCall) {
        joinedAt = now;
        // Discord only rejoins calls by itself right after it connects; any other call it was already in is the user's.
        if (now - lastConnect >= SETTLE_MS) farmJoined = true;
    }
    inCall = true;
    farmCall = where.id;
    muteOnJoin(where.id, false);

    const stream = ApplicationStreamingStore.getCurrentUserActiveStream();
    if (!startedKey && stream && isLive(stream, where.id) && streamKey(stream) === lastStartedKey && now - lostStreamAt < LOST_STREAM_MS) {
        startedKey = lastStartedKey;
        liveSince ||= now;
    }
    // Only a stream the farm started is ever restarted; one the user started themselves is theirs.
    const ours = stream != null && startedKey !== "" && streamKey(stream) === startedKey;
    const failed = ours && stream.state === "FAILED";
    // A failed Go Live stays listed and blocks a new one, so it's ended first. While the wait between restarts is
    // still running there's nothing to end it with, and starting another would only fail the same way.
    if (failed && stream.channelId === where.id && !restartLive(stream, now, "The stream failed.", true)) {
        return setStatus("starting", failNote("The stream failed. Restarting it shortly..."));
    }
    if (!isLive(stream, where.id)) {
        // Kept while the farm's own stream is failed, so it can still be restarted once the wait between restarts is over.
        if (!failed && startedKey) {
            startedKey = "";
            lostStreamAt = now;
        }
        const myRun = run;
        void goLive(now, where).catch(e => {
            logger.error("Couldn't go live", e);
            if (myRun !== run) return;
            liveError = `Go Live didn't start (${e?.message ?? e}). Trying again soon.`;
            kick();
        });
        return setStatus("starting", liveError || "Going live...");
    }
    liveError = "";

    if (ours && canRestart(now) && freshStreamError("sender", me) && restartLive(stream, now, "Discord said the stream wasn't sending.", true)) return setStatus("starting", failNote(liveError));
    if (ours && isFarmSource() && !farmCheck) {
        // The farm window was closed (Task Manager, a crash): the stream would only show a frozen picture.
        const myRun = run, checked = farmPid;
        farmCheck = farmAlive().then(alive => {
            if (myRun !== run || alive || farmPid !== checked) return;
            farmPid = 0;
            const own = ApplicationStreamingStore.getCurrentUserActiveStream();
            if (own && restartLive(own, Date.now(), "The farm window closed.")) kick();
        }).finally(() => farmCheck = null);
    }

    const partner = partnerId();
    const viewers = ApplicationStreamingStore.getViewerIds(stream).filter(id => id !== me);
    const watched = partner ? viewers.includes(partner) : viewers.length > 0;
    const reconnecting = !!stream.state && stream.state !== "ACTIVE";
    // The second account hosted here says when its picture is stuck, even though Discord still lists it as watching.
    const second = secondStatus();
    const pictureStuck = second.phase === "ready" && second.account?.id === partner && !!second.viewer && second.viewer.phase !== "watching";
    const stalled = !watched || reconnecting || pictureStuck;

    // Listed as live but never sending: Discord's error 2012 leaves a stream like this for good. The viewer side has
    // the same timer; without one here the farm would sit on "reconnecting" all night and count nothing.
    if (ours && reconnecting) senderStuckSince ||= now;
    else senderStuckSince = 0;
    if (senderStuckSince && now - senderStuckSince >= SENDER_STUCK_MS && restartLive(stream, now, "The stream never started sending.", true)) {
        kick();
        return setStatus("starting", failNote(liveError));
    }

    // Discord only adds a stream's time to the badge when the stream ends, so a long one is ended and started again
    // now and then: each restart sends the time so far, and a crash can only lose what came after the last one. Time
    // already watched is sent on schedule even while the stream is having trouble, or a stuck viewer would hold it back.
    const reportMs = reportEveryMs();
    if (ours && reportMs > 0 && (watchedSinceReport >= reportMs || watchedSinceReport > 0 && now - liveSince >= (stalled ? reportMs : 2 * reportMs))
        && restartLive(stream, now, "Sending Discord this stream's time.")) {
        // A stalled stream may have already sent its report when its connection dropped, so nothing is expected from it.
        if (!stalled) expectReports(true);
        kick();
        return setStatus("starting", liveError);
    }

    if (!watched) {
        const who = partner ? partnerName("your other account") : "someone";
        return setStatus("waiting", `Live, waiting for ${who} to watch. The farm only adds time while they do.`);
    }
    if (reconnecting) return setStatus("waiting", "Live, but the stream is reconnecting. Time counts again once it's back.");
    if (pictureStuck) return setStatus("waiting", second.viewer!.phase === "setup" && second.viewer!.detail
        ? `Live, but nothing counts: ${second.viewer!.detail}`
        : `Live, but ${partnerName("your other account")}'s picture is reconnecting. Time counts again once it's back.`);
    count(elapsed);
    if (ours) {
        watchedSinceReport += elapsed;
        liveFails = 0;
    }
    const watchers = viewers.length === 1 ? "1 viewer" : `${viewers.length} viewers`;
    // The counter only knows about the stream; whether Discord gets told is another matter, and that's the part that counts.
    setStatus("counting", trackingProblem(second.phase === "ready" ? second.tracking : null)
        ? `Live and watched by ${watchers}, but the red items may stop Discord counting it.`
        : `Live and watched by ${watchers}. Time is counting.`);
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

    if (!live || !stream) {
        stuckSince = 0;
        return setStatus("waiting", `In ${where.name}, waiting for ${name} to go live.`);
    }
    const active = ApplicationStreamingStore.getActiveStreamForApplicationStream(stream);
    const watching = active != null && ApplicationStreamingStore.getViewerIds(stream).includes(me);
    // Open but broken: failed (error 2012), paused for too long, or Discord said no picture is coming. It's closed and
    // opened again, and nothing counts meanwhile.
    if (active) {
        if (active.state === "ACTIVE") stuckSince = 0;
        else stuckSince ||= now;
        const why = active.state === "FAILED" ? "failed"
            : freshStreamError("receiver", partner) ? "stopped sending a picture"
                : stuckSince && now - stuckSince >= STUCK_MS ? "got stuck" : "";
        if (why) {
            logger.info(`Reopening the stream, it ${why}`);
            stuckSince = 0;
            forgetStreamErrors("receiver", partner);
            closeStream(streamKey(stream), false);
            lastWatch = now;
            return setStatus("joining", `${name}'s stream ${why}. Opening it again...`);
        }
    } else stuckSince = 0;
    if (!watching) {
        if (now - lastWatch >= WATCH_RETRY_MS) {
            lastWatch = now;
            watchedKey = streamKey(stream);
            watchStream(stream, { noFocus: true });
        }
        return setStatus("joining", `Opening ${name}'s stream...`);
    }
    if (active.state && active.state !== "ACTIVE") return setStatus("joining", `${name}'s stream is connecting...`);
    // Watching earns the streaming account's time, not this one's, so it only shows in this call's time.
    sessionMs += elapsed;
    setStatus("watching", `Watching ${name}'s stream in ${where.name}. Their time is counting.`);
}

// Once the user unmutes or undeafens themselves, a later mute or deafen is theirs, and stopping leaves it alone.
function forgetUndone() {
    if (prof().muted && !MediaEngineStore.isSelfMute()) setProf({ muted: false });
    if (prof().deafened && !MediaEngineStore.isSelfDeaf()) setProf({ deafened: false });
}

function tick() {
    const now = Date.now();
    // A sleeping PC or a stalled tick shouldn't count as streamed time.
    const elapsed = Math.max(0, Math.min(now - lastTick, 3 * TICK_MS));
    lastTick = now;
    if (systemAsleep()) return;
    try {
        const { role } = prof();
        forgetUndone();
        if (role === "streamer") streamerTick(now, elapsed);
        else if (role === "viewer") viewerTick(now, elapsed);
    } catch (e) {
        logger.error("Stream farm tick failed", e);
        setStatus("setup", `Something went wrong (${(e as Error)?.message ?? e}). Trying again.`);
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
    // Discord leaves the call itself when the PC goes to sleep. That isn't a hang up, so the farm carries on after it wakes.
    if (!action.channelId && systemAsleep()) return;
    // Right after Discord connects, or in a call Discord rejoined by itself, leaving is Discord's doing. The farm
    // rejoins then, but not straight away if the user went into another call.
    const now = Date.now();
    const settled = now - lastConnect >= SETTLE_MS && (farmJoined || now - joinedAt >= SETTLE_MS);
    if (!settled && !action.channelId) return;
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

// Subscribed by the plugin for as long as it runs, since the first connect usually comes before a run starts.
export const noteConnect = () => {
    lastConnect = Date.now();
};

function systemAsleep() {
    try {
        return !!IdleStore.getSystemSuspended?.();
    } catch {
        return false;
    }
}

// Discord doesn't end a stream when it closes, so its report would never go out and the time since the last one would
// be lost. Ending the connection the way Discord does itself queues the report, and Discord sends its queue as the page
// goes away. Discord also fires a fake beforeunload when opening some links, which must not end anything.
const onUnload = (e: BeforeUnloadEvent) => {
    save(true);
    if (!e.isTrusted) return;
    restoreGoLive();
    try {
        for (const connection of Object.values(StreamRTCConnectionStore.getRTCConnections())) {
            connection.destroy(connection.isOwner ? "sender-disconnect" : "receiver-disconnect");
        }
    } catch (err) {
        logger.warn("Couldn't end the stream before closing:", err);
    }
};

// Ends the Go Live and leaves the call this run started; anything the user started themselves stays.
function teardown() {
    const own = ApplicationStreamingStore.getCurrentUserActiveStream();
    if (startedKey && own && streamKey(own) === startedKey) stopStream(startedKey, false);
    const joined = prof().joinedCall;
    if (joined && joinedHere(joined)) VoiceActions.disconnect();
    else if (watchedKey) closeStream(watchedKey, false);
    setProf({ joinedCall: "" });
    startedKey = watchedKey = lastStartedKey = "";
    watchedSinceReport = liveSince = 0;
    undeafen();
    closeFarmWindow();
}

// A hang-up from leaving the call in Discord, not saved yet: the UI already shows the call as ended, and anything
// that restarts the farm in the meantime must not bring the call back unless the user presses Call.
export const hangingUp = () => pendingOff !== "" && pendingOff === currentUserId();

export function takePendingHangUp() {
    if (!hangingUp()) return false;
    clearTimeout(hangUpTimer);
    pendingOff = "";
    return true;
}

export function startStreamFarm() {
    stopStreamFarm();
    clearTimeout(hangUpTimer);
    // A hang-up still waiting to be saved is saved now (Call takes it back through changeStreamProfile first), so
    // neither a restart nor switching accounts brings that call back.
    if (pendingOff) updateProfileFor(pendingOff, { role: "off" });
    pendingOff = "";
    owner = currentUserId();
    if (!owner || prof().role === "off") return;
    // Left over from a Discord that closed mid-run: put the user's Go Live quality back before starting again.
    if (!ApplicationStreamingStore.getCurrentUserActiveStream()) restoreGoLive();
    lastTick = Date.now();
    lastJoin = lastStart = lastWatch = lastDmOpen = partnerGoneSince = lastRestart = stuckSince = senderStuckSince = liveFails = 0;
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
    window.addEventListener("beforeunload", onUnload);
    timer = setInterval(tick, TICK_MS);
    tick();
}

export function stopStreamFarm() {
    stoppedAt = Date.now();
    run++;
    if (timer) {
        clearInterval(timer);
        clearTimeout(kickTimer);
        timer = kickTimer = undefined;
        for (const e of EVENTS) FluxDispatcher.unsubscribe(e, kick);
        FluxDispatcher.unsubscribe("VOICE_CHANNEL_SELECT", onVoiceSelect);
        FluxDispatcher.unsubscribe("LOGOUT", onLogout);
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
// Leaving the call and undoing mute and deafen make their sounds just after the farm stops.
const SOUND_TAIL_MS = 5000;
let stoppedAt = 0;
export const farmJustRan = () => streamFarmRunning() || Date.now() - stoppedAt < SOUND_TAIL_MS;
export const streamFarmOwner = () => owner;

// Remembered per account, so it still shows after a restart.
const REPORT_LOG_SIZE = 200;
export function noteReports() {
    watchReportsFrom(() => prof().partner);
    return onReport((at, report) => {
        logger.info("Stream report sent:", report);
        setProf({ lastReportAt: at, reportLog: [...prof().reportLog, report].slice(-REPORT_LOG_SIZE) });
    });
}

export function resetStreamCount() {
    unsaved = 0;
    setProf({ countedMs: 0 });
    setStatus(status.phase, status.detail);
}

// The source or game changed mid-run: only the Go Live is restarted, the call stays.
export function refreshGoLive() {
    if (!timer) return;
    // Any Go Live still starting belongs to the old choice.
    run++;
    const own = ApplicationStreamingStore.getCurrentUserActiveStream();
    if (startedKey && own && streamKey(own) === startedKey) stopStream(startedKey, false);
    startedKey = "";
    closeFarmWindow();
    lastStartedKey = "";
    watchedSinceReport = liveSince = 0;
    lastStart = lastRestart = 0;
    kick();
}
