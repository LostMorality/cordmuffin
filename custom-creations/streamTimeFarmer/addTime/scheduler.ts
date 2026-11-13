/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { findByCodeLazy, findStoreLazy } from "@webpack";
import { SelectedChannelStore } from "@webpack/common";

import { currentUserId, FARM_SOURCE, profileFor } from "../profile";
import { ownStreamEndedAt, streamFarmOwner, streamFarmRunning, streamingOwnWindow, streamStatus } from "../stream";
import { notify } from "./job";
import { hourDone, hourTaken, ledgerLoaded } from "./ledger";
import { hooksInPlace, HOUR_MS, installHooks, utcHour } from "./raiser";
import { canResend, reportLoaded, resendReport } from "./resend";

const logger = new Logger("AddStreamTime");

interface AppStream { streamType: string; guildId: string | null; channelId: string; ownerId: string; state?: string; }

const ApplicationStreamingStore: {
    getCurrentUserActiveStream(): AppStream | null;
    addChangeListener(listener: () => void): void;
    removeChangeListener(listener: () => void): void;
} = findStoreLazy("ApplicationStreamingStore");
const stopStream: (streamKey: string, canShowFeedback?: boolean) => void = findByCodeLazy('type:"STREAM_STOP",streamKey');

const TICK_MS = 30_000;
const MIN_LIVE_MS = 60_000;
// Sends at :52 and at :04 of neighbouring hours both counted for their own hour. The raiser leaves reports in the
// first and last 3 minutes alone, so a stream ended in minute 53 still has 3 minutes for its report to go out.
const FIRST_MINUTE = 4;
const LAST_MINUTE = 53;
const REPORT_WAIT_MS = 5 * 60_000;
// One more end in the same hour when the first one's report is known not to have counted.
const MAX_TRIES = 2;
// Discord can batch analytics, so the report of a stream ended right before the farm stopped still counts as ours.
// The grace ends early as soon as a newer Go Live starts, so a stream the user starts afterwards is never raised.
const FARM_GRACE_MS = 10 * 60_000;
// A stream seen showing something else this shortly before it ended is not the farm window's stream.
const OTHER_SOURCE_MS = 60_000;
// The farm notes an end this scheduler made on its own next tick, a few seconds later.
const OWN_END_MS = 15_000;
const STATE_KEY = "AddStreamTime_scheduler";
const MISS_NOTE = "No time was added in the last hour because the send didn't go through.";

let timer: ReturnType<typeof setInterval> | undefined;
let enabled: () => boolean = () => false;
let liveSeenAt = 0;
let farmSeenAt = 0;
let farmSeenFor = "";
// Whether the farm's last Go Live has gone away since the farm was last seen streaming.
let farmStreamGone = false;
// When this scheduler last ended the farm's stream: the farm itself only notices on its next tick.
let ownEndAt = 0;
// Last time a Go Live was up that wasn't the farm showing its own window.
let otherSourceAt = 0;
// Last time the farm's Go Live was up and showing its own window.
let ownLiveAt = 0;
// The newest end of a farm stream seen so far, and otherSourceAt as it stood then: anything sampled after an end is
// about the next stream, not the one that ended.
let lastEnded = 0;
let otherBeforeEnd = 0;
let reportSeenAt = 0;
let stopFailTold = false;
// For one toast when a whole hour passes without a send: the hour being watched and why it is stuck, if it is.
let stallHour = -1;
let stallNote = "";
let stallWhy: Blocker = "";
let stallTold = false;

// Persisted so a Discord restart can't end the farm's stream more often than allowed in the same UTC hour.
interface SchedState {
    endedHour: number;
    // How many times the stream was ended in endedHour.
    tries: number;
    pendingCheck: { at: number; hour: number; } | null;
    // The hour the saved report was last sent again in, so a restart can't send twice in one hour.
    resentHour: number;
}

let state: SchedState = { endedHour: -1, tries: 0, pendingCheck: null, resentHour: -1 };
let stateLoaded = false;
let stateLoading: Promise<void> | null = null;

const num = (v: unknown, fallback: number) => typeof v === "number" && Number.isFinite(v) ? v : fallback;

function saveState() {
    DataStore.set(STATE_KEY, state).catch(e => logger.error("Couldn't save the scheduler state", e));
}

function setState(patch: Partial<SchedState>) {
    state = { ...state, ...patch };
    saveState();
}

function loadState() {
    stateLoading ??= (async () => {
        try {
            const saved: any = await DataStore.get(STATE_KEY);
            if (saved && typeof saved === "object") {
                const pc = saved.pendingCheck;
                const savedCheck = pc && typeof pc.at === "number" && typeof pc.hour === "number" ? { at: pc.at, hour: pc.hour } : null;
                const savedHour = num(saved.endedHour, -1);
                // A state saved before tries existed had ended its hour once.
                const savedTries = Math.max(1, num(saved.tries, 1));
                state = {
                    resentHour: Math.max(state.resentHour, num(saved.resentHour, -1)),
                    endedHour: Math.max(state.endedHour, savedHour),
                    tries: savedHour > state.endedHour ? savedTries : savedHour === state.endedHour ? Math.max(state.tries, savedTries) : state.tries,
                    pendingCheck: state.pendingCheck ?? savedCheck
                };
            }
        } catch (e) {
            logger.error("Couldn't load the scheduler state", e);
        }
        stateLoaded = true;
    })();
    return stateLoading;
}

const streamKey = (s: AppStream) => s.guildId
    ? `${s.streamType}:${s.guildId}:${s.channelId}:${s.ownerId}`
    : `${s.streamType}:${s.channelId}:${s.ownerId}`;

const isLive = (s: AppStream | null): s is AppStream => s != null && s.state !== "FAILED" && s.state !== "ENDED";

function farmStreamingHere(me = currentUserId()) {
    return IS_DISCORD_DESKTOP && !!me && streamFarmRunning() && streamFarmOwner() === me && profileFor(me).role === "streamer";
}

// When a stream the farm started last ended. Keeps the sample that belongs to that stream the first time it's seen.
function farmEndedAt() {
    const ended = Math.max(ownStreamEndedAt(), ownEndAt);
    if (ended > lastEnded) {
        lastEnded = ended;
        otherBeforeEnd = otherSourceAt;
    }
    return ended;
}

// A report belongs to the farm only if a stream the farm started ended a short while ago and that stream was
// showing the farm's own window, never the user's screen, a window they picked or a Go Live they started.
// Returns why it doesn't, or "" when it does.
function notOwnWindow(now: number) {
    const endedAt = farmEndedAt();
    const fresh = now - endedAt < FARM_GRACE_MS;
    // This scheduler only ends a stream it has just seen showing the farm window.
    if (fresh && ownEndAt && endedAt - ownEndAt < OWN_END_MS) return "";
    if (fresh && endedAt - otherBeforeEnd >= OTHER_SOURCE_MS) return "";
    // A report can go out before the farm has noted its stream's end, so a farm window stream that was up at the
    // last look counts too, as long as nothing else was streamed lately.
    if (ownLiveAt > endedAt && now - ownLiveAt < 2 * TICK_MS && now - otherSourceAt >= FARM_GRACE_MS) return "";
    return fresh ? "the stream that ended wasn't showing the farm window" : "no stream of the farm's ended in the last 10 minutes";
}

// Why a stream report can't be raised here right now, or "" when it can.
// The hosted second-account window runs Equicord's web build, so IS_DISCORD_DESKTOP alone already rules it out.
export function whyNotEarning() {
    if (!IS_DISCORD_DESKTOP) return "this isn't the desktop app";
    if (!enabled()) return "no job is running on this account";
    const me = currentUserId();
    if (!streamsFarmWindow(me)) return "the farm's source isn't the farm window";
    const notOwn = notOwnWindow(Date.now());
    if (notOwn) return notOwn;
    if (farmStreamingHere(me)) return "";
    trackFarmStream();
    if (me === "" || me !== farmSeenFor) return "the stream farm isn't streaming on this account";
    return Date.now() - farmSeenAt < FARM_GRACE_MS ? "" : "the stream farm stopped more than 10 minutes ago";
}

// Ends the post-farm grace once the farm's last Go Live is gone and a new one has started.
function trackFarmStream() {
    if (farmStreamingHere()) return;
    if (!isLive(ApplicationStreamingStore.getCurrentUserActiveStream())) farmStreamGone = true;
    else if (farmStreamGone) farmSeenFor = "";
}

function onStreamChange() {
    try {
        trackFarmStream();
    } catch (e) {
        logger.error("Go Live change check failed", e);
    }
}

export function noteStreamerReport() {
    liveSeenAt = 0;
    reportSeenAt = Date.now();
}

// Any accepted send ends a stall, whichever restart sent it.
export function noteSendResult(ok: boolean) {
    if (ok) stallTold = false;
}

const hourSettled = (hour: number) => hourDone(hour);

function resolvePending(now: number) {
    const check = state.pendingCheck;
    if (!check) return;
    if (hourSettled(check.hour)) {
        setState({ pendingCheck: null });
        return;
    }
    // The report went out and didn't count (too short, nobody watching, or Discord refused it), or never came.
    const dead = reportSeenAt >= check.at && !hourTaken(check.hour);
    if (!dead && now - check.at < REPORT_WAIT_MS) return;
    const waiting = hourTaken(check.hour);
    setState({ pendingCheck: null });
    if (waiting) logger.info("Ended the farm's stream and its report is still waiting for Discord's answer");
    else logger.warn(`Ended the farm's stream but its report didn't count; ${canRetry(check.hour) ? "trying once more this hour" : "the next try is next hour"}`);
}

type Blocker = "" | "off" | "loading" | "farm" | "screen" | "watch" | "own" | "live" | "done" | "ended" | "minute";

// Only the farm's own window is streamed for sends, never the user's screen or a random window of theirs.
export const streamsFarmWindow = (me = currentUserId()) => !!me && profileFor(me).source.trim().toLowerCase() === FARM_SOURCE;

// A second end in an hour is only for a first one known to have failed, never while its answer is still out.
const canRetry = (hour: number) => state.endedHour === hour && state.tries < MAX_TRIES && !state.pendingCheck && !hourTaken(hour);

function blocker(now: number): Blocker {
    if (!enabled()) return "off";
    if (!stateLoaded || !ledgerLoaded() || !reportLoaded()) return "loading";
    if (!farmStreamingHere()) return "farm";
    if (!streamsFarmWindow()) return "screen";
    const hour = utcHour(now);
    if (hourTaken(hour)) return "done";
    if (state.endedHour === hour && !canRetry(hour)) return "ended";
    const minute = new Date(now).getUTCMinutes();
    if (minute < FIRST_MINUTE || minute > LAST_MINUTE) return "minute";
    if (streamStatus().phase !== "counting") return "watch";
    if (!streamingOwnWindow()) return "own";
    if (!liveSeenAt || now - liveSeenAt < MIN_LIVE_MS) return "live";
    return "";
}

// One toast when an hour ends without a send for a reason the user can fix, and no more until a send goes out.
function watchStall(now: number, why: Blocker) {
    if (why === "off" || why === "loading") {
        stallHour = -1;
        stallNote = "";
        stallWhy = "";
        return;
    }
    const hour = utcHour(now);
    if (stallHour !== -1 && hour > stallHour) {
        // A problem the user has fixed since isn't told. The first minutes of an hour never get as far as "own".
        const still = why === "farm" || why === "screen" || stallWhy === "own" && !streamingOwnWindow();
        const note = stallWhy ? still ? stallNote : "" : state.endedHour === stallHour ? MISS_NOTE : "";
        if (note && !stallTold && !hourTaken(stallHour)) {
            stallTold = true;
            notify(note, "critical");
        }
        stallNote = "";
        stallWhy = "";
    }
    stallHour = hour;
    const minute = new Date(now).getUTCMinutes();
    if (minute < FIRST_MINUTE || minute > LAST_MINUTE) return;
    // "watch" is left out: the farm shows its own message when the other account stops watching.
    stallWhy = why === "farm" || why === "screen" || why === "own" ? why : "";
    stallNote = stallWhy ? plan(now).note : "";
}

function tick() {
    try {
        const now = Date.now();
        const me = currentUserId();
        if (enabled() && !hooksInPlace()) installHooks();
        const stream = ApplicationStreamingStore.getCurrentUserActiveStream();
        if (farmStreamingHere(me)) {
            farmSeenAt = now;
            farmSeenFor = me;
            farmStreamGone = !isLive(stream);
        } else {
            trackFarmStream();
        }
        if (!isLive(stream) || !farmStreamingHere(me)) liveSeenAt = 0;
        else liveSeenAt ||= now;
        farmEndedAt();
        if (isLive(stream)) {
            const own = streamingOwnWindow();
            if (own && farmStreamingHere(me)) ownLiveAt = now;
            // While the farm is still starting its Go Live, the new stream isn't known as the farm's yet.
            else if (!own && !(farmStreamingHere(me) && streamStatus().phase === "starting")) otherSourceAt = now;
        }
        if (stateLoaded) resolvePending(now);

        const why = blocker(now);
        watchStall(now, why);
        if (why !== "" || !isLive(stream)) return;
        // Never a stream outside the farm's call, and never one the user started themselves.
        if (stream.channelId !== SelectedChannelStore.getVoiceChannelId() || stream.ownerId !== me) return;
        const hour = utcHour(now);

        // Sending the saved report again keeps the farm's stream up, and a stream that is never ended can
        // never fail to come back. The stream is only ended when no report is fresh enough to send again,
        // which both sends that hour's time and leaves a new report for the hours after it.
        if (state.resentHour !== hour && canResend(me, now)) {
            setState({ resentHour: hour });
            if (resendReport(me, now)) {
                logger.info("Sent this hour's time with the saved report, leaving the stream running");
                return;
            }
            logger.warn("Couldn't send the saved report again, ending the stream instead");
        }

        const endBefore = ownEndAt;
        ownEndAt = now;
        try {
            stopStream(streamKey(stream), false);
        } catch (e) {
            // Nothing was ended, so the hour stays open and there is no report to wait for.
            ownEndAt = endBefore;
            logger.error("Couldn't end the farm's stream", e);
            if (!stopFailTold) notify("Couldn't restart the stream to send this hour's time.", "critical");
            stopFailTold = true;
            return;
        }
        farmEndedAt();
        setState({ endedHour: hour, tries: state.endedHour === hour ? state.tries + 1 : 1, pendingCheck: { at: now, hour } });
        liveSeenAt = 0;
        logger.info("Ended the farm's stream so this hour's report goes out");
    } catch (e) {
        logger.error("Scheduler tick failed", e);
    }
}

export function startScheduler(isEnabled: () => boolean) {
    stopScheduler();
    enabled = isEnabled;
    timer = setInterval(tick, TICK_MS);
    try {
        ApplicationStreamingStore.addChangeListener(onStreamChange);
    } catch (e) {
        logger.error("Couldn't watch Go Live changes", e);
    }
    void loadState();
    tick();
}

export function stopScheduler() {
    if (timer) clearInterval(timer);
    timer = undefined;
    liveSeenAt = 0;
    stallHour = -1;
    stallNote = "";
    stallWhy = "";
    stallTold = stopFailTold = false;
    try {
        ApplicationStreamingStore.removeChangeListener(onStreamChange);
    } catch (e) {
        logger.error("Couldn't stop watching Go Live changes", e);
    }
}

export interface Plan {
    hourDone: boolean;
    hourPending: boolean;
    nextEndAt: number | null;
    note: string;
}

const hourStart = (hour: number) => hour * HOUR_MS;
const windowOpen = (hour: number) => hourStart(hour) + FIRST_MINUTE * 60_000;

export function plan(now = Date.now()): Plan {
    const hour = utcHour(now);
    const done = hourSettled(hour);
    const pending = !done && hourTaken(hour);
    const next = (at: number, note: string): Plan => ({ hourDone: done, hourPending: pending, nextEndAt: at, note });
    const none = (note: string): Plan => ({ hourDone: done, hourPending: pending, nextEndAt: null, note });
    const nextWindow = windowOpen(hour + 1);

    switch (blocker(now)) {
        case "off": return none("No job running.");
        case "loading": return none("Loading...");
        case "farm": return none("The stream farm isn't running. Press Call to start it.");
        case "screen": return none("Set the farm's source to the farm window to continue.");
        case "done": return next(nextWindow, pending ? "Waiting for Discord's answer on this hour's send." : "This hour's send is done.");
        case "ended": return next(nextWindow, state.pendingCheck ? "Stream ended, waiting for its report." : "The last send didn't go through. Trying again next hour.");
        case "minute": return next(new Date(now).getUTCMinutes() < FIRST_MINUTE ? windowOpen(hour) : nextWindow, "Waiting a few minutes before sending.");
        case "watch": return none("Waiting for your other account to watch.");
        case "own": return none("Waiting for the farm to stream its own window.");
        case "live": return next(Math.max(now, (liveSeenAt || now) + MIN_LIVE_MS), "Letting the stream run a bit first.");
        default: return next(now, state.resentHour !== hour && canResend(currentUserId(), now)
            ? "Sending now, without stopping the stream."
            : "Sending now.");
    }
}

// When the first send of a new job could go out: this hour if it has no send yet and the window is still open.
export function firstSlot(now = Date.now()) {
    const hour = utcHour(now);
    const at = Math.max(now + MIN_LIVE_MS, windowOpen(hour));
    const late = utcHour(at) !== hour || new Date(at).getUTCMinutes() > LAST_MINUTE;
    if (late || hourTaken(hour) || state.endedHour === hour && !canRetry(hour)) return windowOpen(hour + 1);
    return at;
}

// From when the next send can go out, one more send as soon as each following UTC hour's window opens.
export const finishAt = (nextAt: number, sends: number) => sends > 1 ? windowOpen(utcHour(nextAt) + sends - 1) : nextAt;
