/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { plugins } from "@api/PluginManager";
import { Settings } from "@api/Settings";
import { SYM_LAZY_GET } from "@utils/lazy";
import { Logger } from "@utils/Logger";
import { sleep } from "@utils/misc";
import type { PluginNative } from "@utils/types";
import type { Channel } from "@vencord/discord-types";
import { findByCodeLazy, findByPropsLazy, findStoreLazy } from "@webpack";
import { AuthenticationStore, ChannelStore, FluxDispatcher, GuildStore, PermissionStore, SelectedChannelStore, UserStore, VoiceStateStore } from "@webpack/common";

import { changeStreamProfile, settings } from ".";
import { formatTime } from "./CallWidget";
import { currentUserId, FARM_SOURCE, type FarmGame, type GoLiveSettings, profileFor, type StreamProfile, updateProfileFor } from "./profile";
import { BROKEN_TEXT, onSecondStatus, RESTART_TEXT, type SecondStatus, secondStatus } from "./secondAccount";
import { toast } from "./toast";
import { expectReports, onReport, reportMissing, trackingProblem, trackingState, watchReportsFrom } from "./tracking";

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
// Whether Discord's own connection is up. Windows can say it's online with no internet (a VPN or Hyper-V adapter).
const GatewayConnectionStore: { isConnected?(): boolean; } = findStoreLazy("GatewayConnectionStore");
// The call's own voice connection. "RTC_CONNECTED" when it works; a dead one can sit at "DISCONNECTED" for good.
const RTCConnectionStore: { getState?(): string; } = findStoreLazy("RTCConnectionStore");
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
// Longer than the streaming account takes to come back, and shorter than Discord's own kick for being alone.
const LEAVE_AFTER_MS = 2 * 60_000;
const CONNECT = 1n << 20n;
const VIEW_CHANNEL = 1n << 10n;
const SAVE_EVERY_MS = 60_000;
const PRESET_CUSTOM = 3;
const HANG_UP_SAVE_MS = 5_000;
// Right after Discord connects (startup, or a reconnect) it rejoins the old call and then drops it again by itself.
const SETTLE_MS = 30_000;
// Long enough for a mute or deafen to show up in the store before it is asked for again.
const MUTE_RETRY_MS = 5_000;
// A watched stream that stays paused this long is stuck, not just catching up, and gets reopened.
const STUCK_MS = 20_000;
// A broken Go Live is restarted at most this often, so a stream that keeps failing doesn't flap.
const RESTART_EVERY_MS = 60_000;
// A Go Live that Discord lists but never actually sends (its error 2012 and friends) looks fine to the farm forever,
// so it's restarted after this long. Longer than the viewer's wait, because a stream is briefly not ACTIVE anyway.
const SENDER_STUCK_MS = 45_000;
// After this many failed starts in a row the status stops sounding like a hiccup and names the likely cause.
const FAILS_BEFORE_REASON = 3;
// Past that many, each further failure doubles the wait before the next try, up to this.
const FAIL_WAIT_MAX_MS = 5 * 60_000;
const LOST_STREAM_MS = 2 * 60_000;
// A call can stay selected while its voice connection is dead (seen after a quick leave and rejoin): every Go Live then
// fails with "stream-failed-to-start" until the call is left. Not connected for this long means it's left and joined again.
const VOICE_DEAD_MS = 30_000;
// Each rejoin that didn't help doubles the wait before the next one, up to this, so a connection that can't work at
// all (UDP blocked, no route) doesn't hang up and ring the other account every half minute.
const VOICE_DEAD_MAX_MS = 10 * 60_000;
// A gap this long between checks means the call wasn't being watched (left, waiting, asleep), so the clock starts over.
const VOICE_CHECK_GAP_MS = 15_000;
// Discord ends a DM call by itself after 3 minutes alone (unless DisableCallIdle is on); a little less is enough to tell.
const ALONE_KICK_MS = 150_000;
// A move to the AFK channel this soon after a real click or key press is the user's own.
const USER_INPUT_MS = 3_000;
// The first wait before joining a call Discord ended by itself. It doubles with each one in a row, up to VOICE_DEAD_MAX_MS.
const DROP_WAIT_MS = 15_000;
// How long nothing has to count before the status says for how long, and before one toast says so.
const DOWN_NOTE_MS = 60_000;
const DOWN_TOAST_MS = 15 * 60_000;
const DOWN_NOTE = / Not counting for \d+(h \d+)?m\.$/;
// A second account window still starting after this long has a problem worth naming.
const SECOND_SLOW_MS = 2 * 60_000;
// A farm window that can't start (antivirus, a blocked PowerShell) is tried again after a wait that doubles each time,
// and after this many failures a DM call streams the screen instead. A server channel never does (see fallbackAllowed).
const FARM_RETRY_MS = 30_000;
const FARM_RETRY_MAX_MS = 10 * 60_000;
const FARM_FAILS_MAX = 3;
// Discord pieces missing after one of its updates are looked for again this often, in case they load late.
const FINDS_RECHECK_MS = 5 * 60_000;
const OFFLINE_TEXT = "Offline. The farm picks up again when the internet is back.";
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
let dmFailed = false;
let partnerGoneSince = 0;
let lastSave = 0;
let sessionMs = 0;
let unsaved = 0;
let mutedFor = "";
let lastMuteTry = 0;
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
// Whether the last Go Live the farm started showed its own window, and when a stream it started last ended.
let startedOwnWindow = true;
let ownEndedAt = 0;
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
let voiceDeadSince = 0;
let voiceCheckedAt = 0;
let voiceDeadHits = 0;
// The voice connection's state at the last check ("" when it can't be read).
let voiceState = "";
// The call states that mean "not connected yet". A state Discord adds later counts as connected, so it can't block the farm.
const VOICE_NOT_READY = new Set(["DISCONNECTED", "AWAITING_ENDPOINT", "AUTHENTICATING", "CONNECTING", "RTC_DISCONNECTED", "RTC_CONNECTING", "NO_ROUTE", "ICE_CHECKING", "DTLS_CONNECTING"]);
// A leave Discord made by itself (its idle kick, a move to the AFK channel): why, when the call is joined again, and
// how many came in a row.
let droppedWhy = "";
let rejoinAt = 0;
let dropHits = 0;
// Since when this account has been the only one in the farm's call, and when the user last clicked or pressed a key.
let aloneSince = 0;
let lastInput = 0;
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
// The run whose farm window is being opened right now, so only one try runs at a time.
let farmOpeningFor = -1;
// Farm windows that failed to start in a row, when the next try may run, and what's streamed instead after too many.
let farmFails = 0;
let farmRetryAt = 0;
let fallbackNote = "";
// Since when the streamer hasn't counted any time (0 while it counts), and whether that outage got its toast.
let notCountingSince = 0;
let downToastShown = false;
let unsavedDown = 0;
let secondSlowSince = 0;
let stopSecondWatch: (() => void) | undefined;
// Set by Discord's own connection events, for when its connection store can't be read.
let gatewayClosed = false;
// The Discord piece this run can't find ("" when all are there, null before the first look), and when it last looked.
let missingFind: string | null = null;
let findsCheckedAt = 0;
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
    // A detail passed back in (resetStreamCount) already has its note.
    detail = detail.replace(DOWN_NOTE, "");
    const down = phase === "counting" || phase === "off" ? null : notCountingFor();
    if (down != null && down >= DOWN_NOTE_MS) detail = `${detail} Not counting for ${formatTime(down)}.`;
    const countedMs = prof().countedMs + unsaved;
    if (status.phase === phase && status.detail === detail && status.countedMs === countedMs && status.sessionMs === sessionMs) return;
    status = { phase, detail, countedMs, sessionMs };
    for (const listener of listeners) listener();
}

function save(force = false) {
    const now = Date.now();
    if (!unsaved && !unsavedDown || !force && now - lastSave < SAVE_EVERY_MS) return;
    const { countedMs, downtimeMs } = prof();
    setProf({ countedMs: countedMs + unsaved, downtimeMs: downtimeMs + unsavedDown });
    unsaved = unsavedDown = 0;
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
        try {
            if (!joinedHere(channel.id) && (!PermissionStore.can(VIEW_CHANNEL, channel) || !PermissionStore.can(CONNECT, channel))) {
                return `This account can't join ${channel.name}. Pick another voice channel.`;
            }
        } catch { }
        return { id: channel.id, name: channel.name, guildId: channel.guild_id ?? null, dm: false };
    }
    if (!partner) return prof().hostSecond
        ? "Your second account isn't set up yet. Log into it in its window."
        : "Your second account isn't set up yet. Press Log in to second account.";
    if (partner === UserStore.getCurrentUser().id) return "Your second account's window is logged into this same account. Sign out there and log into your other account.";
    const dm = ChannelStore.getDMFromUserId(partner);
    if (dm) return { id: dm, name: `the call with ${partnerName("your other account")}`, guildId: null, dm: true };
    // Opened even when Discord hasn't loaded the other account yet: opening the DM is what loads it.
    if (now - lastDmOpen >= DM_RETRY_MS) {
        lastDmOpen = now;
        const myRun = run;
        PrivateChannelActions.getOrEnsurePrivateChannel(partner).then(() => {
            if (myRun === run) dmFailed = false;
        }, e => {
            logger.warn("Couldn't open the DM with the other account", e);
            if (myRun === run) dmFailed = true;
        });
    }
    return dmFailed ? "Couldn't open a DM with your second account. Add it as a friend." : "Opening a DM with your second account...";
}

// The account is in that call from another session: the phone, or another Discord. Its own voice state from before the
// leave can still be listed for a moment, so the session has to differ.
function onOtherDevice(userId: string, channelId: string) {
    const state = VoiceStateStore.getVoiceStateForUser(userId);
    return state?.channelId === channelId && !!state.sessionId && state.sessionId !== AuthenticationStore.getSessionId();
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

// navigator.onLine only says whether some network adapter is up, so Discord's own connection is checked as well.
function offline() {
    if (!navigator.onLine) return true;
    try {
        const connected = GatewayConnectionStore.isConnected?.();
        if (typeof connected === "boolean") return !connected;
    } catch { }
    return gatewayClosed;
}

const onGatewayClosed = () => {
    gatewayClosed = true;
};
const onGatewayOpen = () => {
    gatewayClosed = false;
};

const voiceDeadWait = () => Math.min(VOICE_DEAD_MS * 2 ** voiceDeadHits, VOICE_DEAD_MAX_MS);

// A wait in words, for status texts.
const inAbout = (ms: number) => ms >= 60_000 ? `in ${formatTime(ms)}` : "in under a minute";

// True when the call this Discord has selected hasn't had a working voice connection for VOICE_DEAD_MS. It's left
// then, and the next tick joins it again, which is what fixes it by hand too.
function voiceDead(now: number) {
    if (now - voiceCheckedAt > VOICE_CHECK_GAP_MS) voiceDeadSince = 0;
    voiceCheckedAt = now;
    let state = "";
    voiceState = "";
    try {
        state = RTCConnectionStore.getState?.() ?? "";
    } catch {
        return false;
    }
    voiceState = state;
    if (!state || state === "RTC_CONNECTED") {
        voiceDeadSince = voiceDeadHits = 0;
        return false;
    }
    // Offline, Discord resumes the call by itself once the network is back.
    if (offline()) {
        voiceDeadSince = 0;
        return false;
    }
    voiceDeadSince ||= now;
    if (now - voiceDeadSince < voiceDeadWait()) return false;
    logger.info(`The call's voice connection is stuck at ${state}, joining it again`);
    voiceDeadSince = 0;
    voiceDeadHits++;
    // Not a hang up: with inCall off, the leave below doesn't stop the farm. join()'s own retry spacing still applies.
    inCall = false;
    VoiceActions.disconnect();
    return true;
}

// The streamer starts DM calls and rings the viewer; the viewer only joins a call that's already going.
function join(where: Target, now: number, startCall: boolean) {
    if (isFull(where)) return setStatus("waiting", `${where.name} is full. Waiting for a spot.`);
    const calling = where.dm && startCall;
    // The other account is only rung when it isn't sitting in the call already, so coming back to it doesn't wait out
    // the spacing between rings.
    const ring = calling && !VoiceStateStore.getVoiceStatesForChannel(where.id)?.[partnerId()];
    if (now - lastJoin < (ring ? CALL_RETRY_MS : JOIN_RETRY_MS)) return setStatus("joining", ring ? "Calling again in a moment..." : `Joining ${where.name}...`);
    setStatus("joining", ring ? `Calling ${partnerName("your other account")}...` : `Joining ${where.name}...`);
    lastJoin = now;
    if (prof().joinedCall !== where.id) setProf({ joinedCall: where.id });
    farmJoined = true;
    voiceDeadSince = 0;
    VoiceActions.selectVoiceChannel(where.id);
    if (ring) CallActions.ring(where.id);
}

// Both roles stay muted and deafened in the farm's call: the two accounts usually sit on one PC, and a real call
// joined on top of the farm's would feed sound back both ways. Discord clears both flags whenever a Go Live starts,
// which the farm does on every restart, so the state is checked on each tick instead of set once and trusted. Mute
// and deafen stick after a call in Discord, so the farm remembers what it did and undoes it when it stops.
function keepMuted(channelId: string) {
    const wantMute = settings.store.muteMic;
    const wantDeaf = settings.store.deafenBoth;
    const needMute = wantMute && !MediaEngineStore.isSelfMute();
    const needDeaf = wantDeaf && !MediaEngineStore.isSelfDeaf();
    if (!needMute && !needDeaf) {
        mutedFor = channelId;
        return;
    }
    const now = Date.now();
    // Deafening is a toggle, so asking again before the first answer shows up would undo it.
    if (now - lastMuteTry < MUTE_RETRY_MS) return;
    lastMuteTry = now;

    if (needMute) {
        MuteActions.setSelfMute("default", true);
        setProf({ muted: true });
    }
    if (needDeaf) {
        MuteActions.toggleSelfDeaf();
        setProf({ deafened: true });
    }
    if (mutedFor === channelId) logger.info("The farm's mute in the call was cleared; setting it again");
    else logger.info(`In the call ${wantMute ? "muted" : "left unmuted"} and ${wantDeaf ? "deafened" : "left undeafened"}`);
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

// Anyone in a server channel can watch the stream, so there nothing but the farm's own window is ever streamed. A DM
// call is only watched by the user's own second account.
const fallbackAllowed = () => prof().where !== "server";
const usingFarmWindow = () => farmFails < FARM_FAILS_MAX || !fallbackAllowed();
const farmOpening = () => farmOpeningFor === run;

// The farm window, unless it keeps failing to start in a DM call: then this run streams the screen instead. Not a
// random window, which could be anything private and would change with every restart.
async function farmOrFallback(): Promise<CaptureSource | null> {
    const myRun = run;
    if (usingFarmWindow()) {
        // A slow start can outlast the wait between Go Live tries. A second try alongside it would count the same
        // failure twice and close the window the first one is still waiting for.
        if (farmOpening() || Date.now() < farmRetryAt) return null;
        farmOpeningFor = myRun;
        let source: CaptureSource | null = null;
        let why: unknown = "it never showed up in Go Live";
        try {
            source = await farmSource();
        } catch (e) {
            why = e;
        } finally {
            if (farmOpeningFor === myRun) farmOpeningFor = -1;
        }
        if (myRun !== run) return null;
        if (source) {
            farmFails = farmRetryAt = 0;
            fallbackNote = "";
            return source;
        }
        farmFails++;
        farmRetryAt = Date.now() + Math.min(FARM_RETRY_MS * 2 ** (farmFails - 1), FARM_RETRY_MAX_MS);
        logger.warn(`The farm window didn't start (${farmFails} in a row):`, why);
        // A window that started but never showed up in Go Live would only sit there.
        closeFarmWindow();
        if (usingFarmWindow()) return null;
    }
    const source = (await captureSources()).find(s => s.id.startsWith("screen:")) ?? null;
    if (myRun !== run || !source) return null;
    if (!fallbackNote) toast({ text: "The farm's own window wouldn't open, so the farm is showing your screen to your second account instead.", variant: "critical" });
    fallbackNote = "The farm's own window wouldn't open (antivirus or Windows may be blocking it), so it's streaming your screen instead.";
    return source;
}

// The saved choice is the farm window ("farm"), a window title or "screen"; window ids change every time a window opens.
let lastWindow: { source: string; handle: string; } | null = null;

async function pickSource(): Promise<CaptureSource | null> {
    const wanted = prof().source.trim().toLowerCase();
    if (wanted === FARM_SOURCE || wanted === "random") return canUseFarmWindow() ? farmOrFallback() : randomWindow();
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

// The wait before the next try, growing once a stream has failed often enough to be more than a hiccup.
const failWait = (base: number) => Math.min(base * 2 ** Math.max(0, liveFails - FAILS_BEFORE_REASON), FAIL_WAIT_MAX_MS);

async function goLive(now: number, where: Target) {
    if (now - lastStart < failWait(START_RETRY_MS)) return;
    lastStart = now;
    const myRun = run;
    const myStart = ++starts;
    // The growing wait is for starts Discord refused. A look that started nothing is made again after the flat wait.
    const flatWait = () => {
        lastStart = now - failWait(START_RETRY_MS) + START_RETRY_MS;
    };
    const source = await pickSource();
    if (myRun !== run) return;
    if (!source) {
        flatWait();
        const wanted = prof().source.trim().toLowerCase();
        liveError = !isFarmSource() ? ["", "screen", FARM_SOURCE, "random"].includes(wanted) ? "Couldn't find anything to stream. Pick a window instead." : `Couldn't find "${prof().source}" to stream. Pick another source.`
            : !usingFarmWindow() ? "The farm's own window wouldn't open, and there's no screen to stream instead."
                : farmOpening() ? "Opening the farm's own window..."
                    : farmFails ? `The farm's own window didn't open (${fallbackAllowed() ? `${farmFails} of ${FARM_FAILS_MAX} tries` : "antivirus or Windows may be blocking it"}). Trying again ${inAbout(farmRetryAt - Date.now())}.`
                        : "The farm's own window didn't show up in Go Live. Trying again soon.";
        return;
    }
    // Stopped, or moved to another call while looking for the source.
    if (SelectedChannelStore.getVoiceChannelId() !== where.id) return flatWait();
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
        if (ok && myStart === starts) {
            stopStream(key, false);
            ownEndedAt = Date.now();
        }
        if (!isFarmGoLive(before)) applyGoLive(before);
        return;
    }
    if (ok) {
        startedKey = lastStartedKey = key;
        startedOwnWindow = isFarmSource() && !fallbackNote;
        lastWindow = source.id.startsWith("window:") ? { source: prof().source.trim().toLowerCase(), handle: source.id.split(":")[1] } : null;
        liveSince = Date.now();
        watchedSinceReport = 0;
        senderStuckSince = 0;
        forgetStreamErrors("sender", me);
    } else if (!offline()) liveFails++;
    liveError = ok ? "" : failNote(`Go Live didn't start. Trying again ${inAbout(failWait(START_RETRY_MS))}.`);
    if (!ok) logger.warn("Go Live didn't start:", why);
}

const streamKey = (stream: AppStream) => stream.guildId
    ? `${stream.streamType}:${stream.guildId}:${stream.channelId}:${stream.ownerId}`
    : `${stream.streamType}:${stream.channelId}:${stream.ownerId}`;

const isFarmSource = () => canUseFarmWindow() && [FARM_SOURCE, "random"].includes(prof().source.trim().toLowerCase());
const withFallback = (text: string) => fallbackNote && isFarmSource() ? `${text} ${fallbackNote}` : text;

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
// The same for a stream that keeps breaking, which waits longer each time.
const canRetry = (now: number) => now - lastRestart >= failWait(RESTART_EVERY_MS);

// Once a stream has failed a few times running, say so plainly instead of looking like it's about to work.
const failNote = (text: string) => liveFails >= FAILS_BEFORE_REASON
    ? `${text} Discord has refused this stream ${liveFails} times in a row, so the farm keeps trying.`
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
    if (startedKey) ownEndedAt = now;
    startedKey = "";
    lastStart = 0;
    liveError = `${why} Restarting Go Live...`;
    return true;
}

// A stream that failed (for example its window closed) stays listed until it's started again.
const isLive = (stream: AppStream | null, channelId: string): stream is AppStream =>
    stream != null && stream.channelId === channelId && stream.state !== "FAILED" && stream.state !== "ENDED";

// Whether what the farm streams right now is its own window, not the screen it falls
// back to, a window the user picked, or a Go Live the user started themselves.
export function streamingOwnWindow() {
    if (!canUseFarmWindow() || !isFarmSource() || fallbackNote || !startedOwnWindow) return false;
    try {
        const stream = ApplicationStreamingStore.getCurrentUserActiveStream();
        // A stream of the farm's that was just ended can stay listed for a moment.
        const users = stream != null && stream.state !== "FAILED" && stream.state !== "ENDED" && streamKey(stream) !== startedKey
            && Date.now() - ownEndedAt > 3 * TICK_MS;
        return !users;
    } catch {
        return false;
    }
}

// When a stream the farm started itself last ended (0 if none has).
export const ownStreamEndedAt = () => ownEndedAt;

// Ends the Go Live this run started, if it's still the one that's live.
function endOwnStream() {
    if (!startedKey) return;
    const own = ApplicationStreamingStore.getCurrentUserActiveStream();
    // Already gone: leaving the call ended it, which is noted the same as ending it here.
    if (!own) {
        ownEndedAt = Date.now();
        return;
    }
    if (streamKey(own) !== startedKey) return;
    // A stream that was counting sends its report as it ends, so one is expected. Not offline or while logging out,
    // where it may not get out at all.
    if (status.phase === "counting" && watchedSinceReport > 0 && !loggingOut && !offline()) expectReports(true);
    stopStream(startedKey, false);
    ownEndedAt = Date.now();
}

function count(elapsed: number) {
    notCountingSince = 0;
    downToastShown = false;
    sessionMs += elapsed;
    unsaved += elapsed;
    save();
}

const reportEveryMs = () => (settings.store.reportEvery ?? 60) * 60_000;

// How long the streaming account has gone without counting while the farm runs, or null while it counts (or isn't on).
export function notCountingFor(): number | null {
    return timer && notCountingSince && prof().role === "streamer" ? Math.max(0, Date.now() - notCountingSince) : null;
}

// Runs after every streamer tick: a tick that didn't count starts (or continues) an outage.
function noteDowntime(now: number, elapsed: number) {
    if (status.phase === "counting") return;
    notCountingSince ||= now;
    unsavedDown += elapsed;
    save();
    if (downToastShown || now - notCountingSince < DOWN_TOAST_MS) return;
    downToastShown = true;
    toast({ text: `The stream farm hasn't counted any time for ${formatTime(now - notCountingSince)}. Check the farm to see why.`, variant: "critical" });
}

// What's wrong with the second account hosted here, in plain words, or "" when nothing is (or it isn't hosted here).
function secondProblem(second: SecondStatus, now: number) {
    if (!prof().hostSecond) return "";
    switch (second.phase) {
        case "login": return "Your second account is logged out. Press Show login window and log in again.";
        case "same": return "Your second account's window is logged into this same account. Sign out there and log into your other account.";
        case "broken": return BROKEN_TEXT;
        case "unavailable": return "Your second account's window couldn't download what it needs to run. Check your internet; the farm keeps trying.";
        case "restart": return RESTART_TEXT;
        case "starting": return secondSlowSince && now - secondSlowSince >= SECOND_SLOW_MS ? "Your second account's window has been loading for over 2 minutes. Press Open its window to see what it's stuck on." : "";
        default: return "";
    }
}

// Timed from every change, so a window that went back to starting after being ready is timed from then.
function noteSecondPhase() {
    if (secondStatus().phase !== "starting") secondSlowSince = 0;
    else secondSlowSince ||= Date.now();
}

// How long until the next report goes out, or null while there's none on a timer.
export function nextReportMs() {
    const every = reportEveryMs();
    return every > 0 && startedKey ? Math.max(0, every - watchedSinceReport) : null;
}

function streamerTick(now: number, elapsed: number) {
    const where = target(now);
    if (typeof where === "string") return setStatus("setup", where);
    // Every start and restart fails while offline, which would only look like Discord's error 2012. Failures from
    // just before the connection went were the outage too.
    if (offline()) {
        senderStuckSince = liveFails = 0;
        return setStatus("waiting", OFFLINE_TEXT);
    }
    const me = UserStore.getCurrentUser().id;
    if (!joinedHere(where.id)) {
        aloneSince = 0;
        // Leaving the call ended the farm's stream too. Noted now, not when the call is joined again.
        const left = ApplicationStreamingStore.getCurrentUserActiveStream();
        if (startedKey && (!left || streamKey(left) !== startedKey)) {
            startedKey = "";
            lostStreamAt = ownEndedAt = now;
        }
        // Taken over on another device (the phone) after the leave: the user's, not something to take back.
        if (droppedWhy && inCall && onOtherDevice(me, where.id)) {
            userHungUp("The stream farm stopped because you took its call on another device. Press Call to start it again.");
            return;
        }
        if (now < rejoinAt) return setStatus("waiting", `${droppedWhy} The farm joins it again ${inAbout(rejoinAt - now)}.`);
        return join(where, now, true);
    }
    droppedWhy = "";
    rejoinAt = 0;
    if (voiceDead(now)) return setStatus("joining", "The call's connection dropped. Joining it again...");
    if (!inCall) {
        joinedAt = now;
        // Discord only rejoins calls by itself right after it connects; any other call it was already in is the user's.
        if (now - lastConnect >= SETTLE_MS) farmJoined = true;
    }
    inCall = true;
    farmCall = where.id;
    keepMuted(where.id);
    const others = Object.keys(VoiceStateStore.getVoiceStatesForChannel(where.id) ?? {}).some(id => id !== me);
    aloneSince = others ? 0 : aloneSince || now;

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
            lostStreamAt = ownEndedAt = now;
        }
        // Go Live can't start before the call itself is connected, and a try made too early would only hold up the next.
        if (VOICE_NOT_READY.has(voiceState)) {
            return setStatus("joining", voiceDeadHits && voiceDeadSince
                ? `The call isn't connecting. The farm joins it again ${inAbout(voiceDeadWait() - (now - voiceDeadSince))}.`
                : "Connecting to the call...");
        }
        const myRun = run;
        void goLive(now, where).catch(e => {
            logger.error("Couldn't go live", e);
            if (myRun !== run) return;
            liveError = failNote(`Go Live didn't start. Trying again ${inAbout(failWait(START_RETRY_MS))}.`);
            kick();
        });
        return setStatus("starting", liveError || "Going live...");
    }
    liveError = "";

    if (ours && canRetry(now) && freshStreamError("sender", me) && restartLive(stream, now, "Discord said the stream wasn't sending.", true)) return setStatus("starting", failNote(liveError));
    if (ours && isFarmSource() && usingFarmWindow() && !farmCheck) {
        // The farm window was closed (Task Manager, a crash): the stream would only show a frozen picture.
        const myRun = run, checked = farmPid;
        farmCheck = farmAlive().then(alive => {
            if (myRun !== run || alive || farmPid !== checked) return;
            farmPid = 0;
            const own = ApplicationStreamingStore.getCurrentUserActiveStream();
            // Only the farm's own stream: by now it may be gone and the live one the user's.
            if (own && startedKey && streamKey(own) === startedKey && restartLive(own, Date.now(), "The farm window closed.")) kick();
        }).finally(() => farmCheck = null);
    }

    const partner = partnerId();
    const viewers = ApplicationStreamingStore.getViewerIds(stream).filter(id => id !== me);
    const watched = partner ? viewers.includes(partner) : viewers.length > 0;
    const reconnecting = !!stream.state && stream.state !== "ACTIVE";
    // A window the user picked stops sending while it's minimized. That isn't a broken stream, so it isn't restarted.
    const paused = stream.state === "PAUSED" && !isFarmSource();
    // The second account hosted here says when its picture is stuck, even though Discord still lists it as watching.
    const second = secondStatus();
    const pictureStuck = second.phase === "ready" && second.account?.id === partner && !!second.viewer && second.viewer.phase !== "watching";
    const stalled = !watched || reconnecting || pictureStuck;
    const secondWhy = secondProblem(second, now);

    // Listed as live but never sending: Discord's error 2012 leaves a stream like this for good. The viewer side has
    // the same timer; without one here the farm would sit on "reconnecting" all night and count nothing.
    if (ours && reconnecting && !paused) senderStuckSince ||= now;
    else senderStuckSince = 0;
    if (senderStuckSince && now - senderStuckSince >= SENDER_STUCK_MS && canRetry(now) && restartLive(stream, now, "The stream never started sending.", true)) {
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
        // Streaming the screen because the farm window wouldn't open: the window gets one more try with each report.
        if (!usingFarmWindow()) {
            farmFails = FARM_FAILS_MAX - 1;
            farmRetryAt = 0;
        }
        kick();
        return setStatus("starting", liveError);
    }

    // Nobody can watch a stream that isn't sending, so that's said before pointing at the other account.
    if (paused && !secondWhy) return setStatus("waiting", "Live, but the window you're streaming is minimized. Open it so time counts.");
    if (reconnecting && !secondWhy) {
        return setStatus("waiting", watchedSinceReport > 0
            ? "Live, but the stream is reconnecting. Time counts again once it's back."
            : "Live, but the stream is still connecting. Time counts once it's up.");
    }
    if (!watched) {
        if (secondWhy) return setStatus("waiting", withFallback(`Live, but nothing counts: ${secondWhy}`));
        const who = partner ? partnerName("your other account") : "someone";
        return setStatus("waiting", withFallback(`Live, waiting for ${who} to watch. The farm only adds time while they do.`));
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
    dropHits = 0;
    const watchers = viewers.length === 1 ? "1 viewer" : `${viewers.length} viewers`;
    // The counter only knows about the stream; whether Discord gets told is another matter, and that's the part that counts.
    const tracking = second.phase === "ready" ? second.tracking : null;
    const reportLost = reportMissing(trackingState()) || !!tracking && reportMissing(tracking, true);
    setStatus("counting", withFallback(!ours && reportMs > 0 ? "Counting. The farm won't restart a stream you started yourself."
        : reportLost ? `Live and watched by ${watchers}, but the last time report didn't reach Discord. See the plugin's settings.`
            : trackingProblem(tracking) ? `Live and watched by ${watchers}, but a setting may stop Discord counting it. See the plugin's settings.`
                : `Live and watched by ${watchers}. Time is counting.`));
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
    if (!partner) return setStatus("setup", "Waiting for your main account to call this one.");
    if (partner === UserStore.getCurrentUser().id) return setStatus("setup", "This is the same account as the one that streams. Log into your other account here.");
    if (!UserStore.getUser(partner)) return setStatus("setup", "Waiting for your main account to call this one.");
    // Offline, the stream only looks stuck, and closing and opening it again wouldn't help.
    if (offline()) {
        partnerGoneSince = stuckSince = 0;
        return setStatus("waiting", OFFLINE_TEXT);
    }
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
    if (voiceDead(now)) return setStatus("joining", "The call's connection dropped. Joining it again...");
    keepMuted(where.id);

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

// The Discord pieces each side can't work without, by a name a user can pass on. The ones only used inside a try
// (voice connection state, stream errors, the full-channel check, window handles) have a fallback and aren't listed.
function neededFinds(role: string): [string, unknown][] {
    const shared: [string, unknown][] = [
        ["stream list", ApplicationStreamingStore],
        ["mute state", MediaEngineStore],
        ["call joining", VoiceActions],
        ["mute buttons", MuteActions]
    ];
    return role === "streamer"
        ? [...shared, ["Go Live settings", StreamSettingsStore], ["call ringing", CallActions], ["DM opener", PrivateChannelActions], ["stream starter", startStreamWithSource], ["stream stopper", stopStream]]
        : [...shared, ["stream opener", watchStream], ["stream closer", closeStream]];
}

// Looks each lazy find up once and names the first one that's gone, or "" when all are there.
function missingPiece(role: string) {
    for (const [name, lazy] of neededFinds(role)) {
        let found: unknown;
        try {
            found = (lazy as any)[SYM_LAZY_GET]();
        } catch {
            found = undefined;
        }
        if (found == null) return name;
    }
    return "";
}

function tick() {
    const now = Date.now();
    // A sleeping PC or a stalled tick shouldn't count as streamed time.
    const elapsed = Math.max(0, Math.min(now - lastTick, 3 * TICK_MS));
    lastTick = now;
    if (systemAsleep()) return;
    try {
        const { role } = prof();
        if (missingFind !== "" && (missingFind === null || now - findsCheckedAt >= FINDS_RECHECK_MS)) {
            findsCheckedAt = now;
            const missing = missingPiece(role);
            if (missing && missing !== missingFind) logger.error(`Discord's ${missing} couldn't be found; the farm can't run until the plugin is updated`);
            missingFind = missing;
        }
        if (missingFind) {
            setStatus("setup", `Discord changed something the farm needs (${missingFind}). Check for a cordmuffin update.`);
        } else {
            forgetUndone();
            if (role === "streamer") streamerTick(now, elapsed);
            else if (role === "viewer") viewerTick(now, elapsed);
        }
    } catch (e) {
        logger.error("Stream farm tick failed", e);
        setStatus("setup", `Something went wrong (${(e as Error)?.message ?? e}). Trying again.`);
    }
    try {
        if (prof().role === "streamer") noteDowntime(now, elapsed);
    } catch (e) {
        logger.warn("Couldn't note the time the farm didn't count", e);
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
const EVENTS = ["STREAM_CREATE", "STREAM_UPDATE", "STREAM_DELETE", "STREAM_CLOSE", "VOICE_CHANNEL_SELECT"] as const;
const VOICE_EVENTS = ["VOICE_STATE_UPDATES", "CALL_CREATE", "CALL_UPDATE", "CALL_DELETE"] as const;

interface VoiceEvent {
    type: string;
    voiceStates?: { userId?: string; channelId?: string | null; oldChannelId?: string | null; }[];
    channelId?: string | null;
    ringing?: string[];
}

// Every call the farm could care about: its own, the one this Discord is in, the meeting place, and the other account's.
function farmChannels(partner: string) {
    const { joinedCall, channel } = prof();
    const ids = [farmCall, joinedCall, snowflake(channel), SelectedChannelStore.getVoiceChannelId(),
        partner ? ChannelStore.getDMFromUserId(partner) : "", partner ? VoiceStateStore.getVoiceStateForUser(partner)?.channelId : ""];
    return new Set(ids.filter((id): id is string => !!id));
}

// Voice changes come in from every server this account is in, so only ones about the farm's accounts or calls wake it.
function onVoiceEvent(action: VoiceEvent) {
    if (!timer) return;
    try {
        const partner = partnerId();
        const users = new Set([currentUserId(), owner, partner].filter(Boolean));
        let channels: Set<string> | undefined;
        const ours = (id?: string | null) => !!id && (channels ??= farmChannels(partner)).has(id);
        const relevant = action.type === "VOICE_STATE_UPDATES"
            ? (action.voiceStates ?? []).some(s => users.has(s.userId ?? "") || ours(s.channelId) || ours(s.oldChannelId))
            : ours(action.channelId) || (action.ringing ?? []).some(id => users.has(id));
        if (relevant) kick();
    } catch {
        // Better a tick too many than a missed one.
        kick();
    }
}

const onInput = (e: Event) => {
    if (e.isTrusted) lastInput = Date.now();
};
const INPUT_EVENTS = ["pointerdown", "keydown"] as const;

// DisableCallIdle, once it's running, turns off both of Discord's own leaves: the DM kick and the AFK move.
function callIdleOff() {
    try {
        return !plugins.DisableCallIdle?.started || !Settings.plugins.DisableCallIdle?.enabled;
    } catch {
        return true;
    }
}

// Why a leave was Discord's doing rather than the user's, or "" when it looks like the user's. Only Discord's own two
// leaves count: a move to the AFK channel, and ending a DM call after 3 minutes alone in it. Hang-ups from outside this
// window (the pop-out call window, the overlay, a keybind, the phone) leave no trace here, so anything else is the user's.
function droppedByDiscord(channelId: string | null, now: number) {
    if (!callIdleOff()) return "";
    if (channelId) {
        // Moving to the AFK channel by hand takes a click just before.
        if (now - lastInput < USER_INPUT_MS) return "";
        const guildId = ChannelStore.getChannel(channelId)?.guild_id;
        return guildId && GuildStore.getGuild(guildId)?.afkChannelId === channelId ? "Discord moved you to the AFK channel." : "";
    }
    // Typing or clicking around Discord says nothing here: the kick comes when it comes. A hang-up at that same moment
    // is caught by the "stay hung up" notification instead.
    const type = ChannelStore.getChannel(farmCall)?.type;
    if (type !== 1 && type !== 3 || !aloneSince || now - aloneSince < ALONE_KICK_MS) return "";
    return prof().hostSecond && secondStatus().phase !== "ready"
        ? "Discord ended the call while your second account was away."
        : "Discord ended the call because you were alone in it.";
}

// Stops the farm the way pressing Hang up does, for a leave that was the user's. Run outside Discord's dispatch,
// which the teardown would dispatch into.
function userHungUp(text: string) {
    inCall = false;
    const leftBy = owner;
    pendingOff = leftBy;
    // The call ends right away, but the choice to stay off is only saved a few seconds later: Discord also leaves the
    // call while it's closing, and that shouldn't count as hanging up, so the call comes back after a restart.
    setTimeout(() => {
        stopStreamFarm();
        toast({ text });
        clearTimeout(hangUpTimer);
        hangUpTimer = setTimeout(() => {
            pendingOff = "";
            // Saved for the account that left, even if a different one is logged in by now.
            if (leftBy === currentUserId()) changeStreamProfile({ role: "off" });
            else updateProfileFor(leftBy, { role: "off" });
        }, HANG_UP_SAVE_MS);
    });
}

// A hang-up from another window looks just like Discord's kick, so every rejoin can be called off.
function offerStayHungUp(why: string, wait: number) {
    const myRun = run;
    void showNotification({
        title: "Stream farm",
        body: `${why} The farm joins it again ${inAbout(wait)}. If you hung up yourself, click here to stay hung up.`,
        noPersist: true,
        onClick: () => {
            if (myRun === run && timer && inCall) userHungUp("The stream farm stays hung up. Press Call to start it again.");
        }
    }).catch(e => logger.warn("Couldn't show the rejoin notice", e));
}

// The user leaving the farm's call in Discord (hanging up, or moving to another call) is the same as pressing Hang up.
// The farm's own Hang up stops it before its leave comes through here.
function onVoiceSelect(action: { channelId?: string | null; }) {
    if (loggingOut || !inCall || prof().role !== "streamer" || !farmCall || action.channelId === farmCall) return;
    // Discord leaves the call itself when the PC goes to sleep. That isn't a hang up, so the farm carries on after it wakes.
    if (!action.channelId && systemAsleep()) return;
    // Right after Discord connects, or in a call Discord rejoined by itself, leaving is Discord's doing. The farm
    // rejoins then, but not straight away if the user went into another call.
    const now = Date.now();
    const settled = now - lastConnect >= SETTLE_MS && (farmJoined || now - joinedAt >= SETTLE_MS);
    if (!settled && !action.channelId) return;
    const why = droppedByDiscord(action.channelId ?? null, now);
    if (why) {
        // Like a dead connection, the call is joined again, each drop in a row waiting longer first. inCall stays on, so
        // the user going into another call meanwhile still counts as hanging up.
        logger.info(`${why} Joining the call again`);
        const wait = Math.min(DROP_WAIT_MS * 2 ** dropHits, VOICE_DEAD_MAX_MS);
        droppedWhy = why;
        rejoinAt = now + wait;
        dropHits++;
        aloneSince = 0;
        offerStayHungUp(why, wait);
        kick();
        return;
    }
    userHungUp(action.channelId ? "The stream farm stopped because you joined another call. Press Call to start it again." : "The stream farm stopped because you left its call. Press Call to start it again.");
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
    endOwnStream();
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
    lastJoin = lastStart = lastWatch = lastDmOpen = partnerGoneSince = lastRestart = stuckSince = senderStuckSince = liveFails = voiceDeadSince = voiceCheckedAt = voiceDeadHits = 0;
    rejoinAt = dropHits = aloneSince = lastInput = sessionMs = 0;
    mutedFor = liveError = droppedWhy = fallbackNote = "";
    farmFails = farmRetryAt = notCountingSince = secondSlowSince = findsCheckedAt = 0;
    farmOpeningFor = -1;
    gatewayClosed = false;
    dmFailed = false;
    startedOwnWindow = true;
    voiceState = "";
    downToastShown = false;
    missingFind = null;
    inCall = false;
    farmCall = "";
    loggingOut = false;
    farmJoined = false;
    joinedAt = 0;
    for (const e of EVENTS) FluxDispatcher.subscribe(e, kick);
    for (const e of VOICE_EVENTS) FluxDispatcher.subscribe(e, onVoiceEvent);
    for (const e of INPUT_EVENTS) window.addEventListener(e, onInput, { capture: true, passive: true });
    FluxDispatcher.subscribe("VOICE_CHANNEL_SELECT", onVoiceSelect);
    FluxDispatcher.subscribe("LOGOUT", onLogout);
    FluxDispatcher.subscribe("CONNECTION_CLOSED", onGatewayClosed);
    FluxDispatcher.subscribe("CONNECTION_OPEN", onGatewayOpen);
    FluxDispatcher.subscribe("CONNECTION_RESUMED", onGatewayOpen);
    window.addEventListener("beforeunload", onUnload);
    stopSecondWatch = onSecondStatus(noteSecondPhase);
    noteSecondPhase();
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
        for (const e of VOICE_EVENTS) FluxDispatcher.unsubscribe(e, onVoiceEvent);
        for (const e of INPUT_EVENTS) window.removeEventListener(e, onInput, { capture: true });
        FluxDispatcher.unsubscribe("VOICE_CHANNEL_SELECT", onVoiceSelect);
        FluxDispatcher.unsubscribe("LOGOUT", onLogout);
        FluxDispatcher.unsubscribe("CONNECTION_CLOSED", onGatewayClosed);
        FluxDispatcher.unsubscribe("CONNECTION_OPEN", onGatewayOpen);
        FluxDispatcher.unsubscribe("CONNECTION_RESUMED", onGatewayOpen);
        window.removeEventListener("beforeunload", onUnload);
        stopSecondWatch?.();
        stopSecondWatch = undefined;
        try {
            teardown();
        } catch (e) {
            logger.error("Couldn't end the stream farm's call", e);
        }
        restoreGoLive();
    }
    save(true);
    notCountingSince = 0;
    downToastShown = false;
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
    unsaved = unsavedDown = 0;
    setProf({ countedMs: 0, downtimeMs: 0 });
    setStatus(status.phase, status.detail);
}

// The source or game changed mid-run: only the Go Live is restarted, the call stays.
export function refreshGoLive() {
    if (!timer) return;
    // Any Go Live still starting belongs to the old choice.
    run++;
    try {
        endOwnStream();
    } catch (e) {
        logger.error("Couldn't end the old Go Live", e);
    }
    startedKey = "";
    closeFarmWindow();
    // A new source or game gets the farm window another chance.
    farmFails = farmRetryAt = 0;
    fallbackNote = "";
    lastStartedKey = "";
    watchedSinceReport = liveSince = 0;
    lastStart = lastRestart = 0;
    // Errors and failures of the old choice say nothing about the new one.
    liveError = "";
    liveFails = senderStuckSince = 0;
    kick();
}
