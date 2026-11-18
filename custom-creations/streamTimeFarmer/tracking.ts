/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isPluginEnabled, plugins } from "@api/PluginManager";
import { Settings } from "@api/Settings";
import { findStoreLazy } from "@webpack";
import { FluxDispatcher, RestAPI, UserStore } from "@webpack/common";

// Discord adds up the Streaming badge from the report each Discord sends when a stream ends. Equicord's NoTrack stops
// those reports while its "Disable Analytics" is on, unless its "Allow Badge Tracking" (on by default) lets them
// through. Discord's badge article names "Use data to personalize my Discord experience" as required. The client sends
// reports whatever "Use data to improve Discord" says, and whether Discord's servers ignore them when it's off isn't
// known, so it's only recommended. Each account has its own NoTrack and privacy settings, since the second account runs
// its own Equicord.
// Other tracking blockers can stop the reports too, so what really gets sent is watched as well.

export const ConsentStore = findStoreLazy("ConsentStore");
const USAGE = "usage_statistics";
const PERSONALIZE = "personalization";
const CONSENT_URL = "/users/@me/consent";
const STREAMING_BADGE = 19;
const RETRY_MS = 60_000;
const BADGE_EVERY_MS = 60 * 60_000;
// How long a report may take to reach Discord after a stream ends before it counts as lost.
const REPORT_WAIT_MS = 3 * 60_000;

// Whether Discord still has its ConsentStore; without it the checks say "couldn't check" instead of breaking the plugin.
export function hasConsentStore() {
    try {
        return ConsentStore.getName != null;
    } catch {
        return false;
    }
}

// NoTrack's "Allow Badge Tracking" keeps Discord's own reporting while "Disable Analytics" is on and lets through only
// the stream and game events badges count (a stream report as the streamer, never as a viewer). A NoTrack without
// that switch blocks everything while "Disable Analytics" is on.
const hasBadgeSwitch = () => !!plugins.NoTrack?.settings?.def && "allowBadgeTracking" in plugins.NoTrack.settings.def;
const analyticsOff = () => Settings.plugins.NoTrack?.disableAnalytics !== false;
const badgeOnly = () => analyticsOff() && hasBadgeSwitch() && Settings.plugins.NoTrack?.allowBadgeTracking !== false;
const noTrackBlocks = () => analyticsOff() && !badgeOnly();
// NoTrack picks how Discord reports while Discord loads, so either switch only takes effect after a restart.
const blockedAtStart = noTrackBlocks();
const badgeOnlyAtStart = badgeOnly();
const loadedAt = Date.now();

const BLOCKER = /(do[\s_-]*not|dont|no|anti|stop)[\s_-]*track|tracking|analytics|telemetry/i;

// Other plugins that may block the reports. NoTrack has its own row.
function trackingBlockers() {
    const found = Object.keys(plugins).filter(name => name !== "NoTrack" && BLOCKER.test(name) && isPluginEnabled(name));
    const bd = isPluginEnabled("Muffinshelf") ? Settings.plugins.Muffinshelf?.bdEnabled : null;
    if (Array.isArray(bd)) {
        for (const file of bd) {
            const name = String(file).replace(/\.plugin\.js$/i, "");
            if (BLOCKER.test(name)) found.push(name);
        }
    }
    return found;
}

export interface TrackingState {
    // NoTrack's switches are set to block stream reports.
    blocked: boolean;
    // NoTrack was blocking when Discord started, so it still is until a restart.
    blockedAtStart: boolean;
    // NoTrack let only badge events through when Discord started: the streamer's report goes out, a viewer's doesn't.
    badgeOnlyAtStart?: boolean;
    // NoTrack has "Allow Badge Tracking", so the fix can keep the rest of the analytics blocked.
    badgeSwitch?: boolean;
    // "Use data to improve Discord", or null while Discord hasn't said yet.
    usageData: boolean | null;
    // "Use data to personalize my Discord experience", or null while Discord hasn't said yet.
    personalized: boolean | null;
    // Other enabled plugins that may block the reports.
    blockers: string[];
    // When Discord last accepted a stream report from this account (0: not since this page loaded).
    lastReportAt: number;
    // When this page loaded, since a report sent before that can't be seen.
    loadedAt: number;
}

let lastReportAt = 0;

export function trackingState(): TrackingState {
    void loadConsents();
    let usageData: boolean | null = null, personalized: boolean | null = null;
    try {
        const { consents } = ConsentStore;
        if (consents?.[USAGE]) usageData = consents[USAGE].consented === true;
        if (consents?.[PERSONALIZE]) personalized = consents[PERSONALIZE].consented === true;
    } catch { }
    return { blocked: noTrackBlocks(), blockedAtStart, badgeOnlyAtStart, badgeSwitch: hasBadgeSwitch(), usageData, personalized, blockers: trackingBlockers(), lastReportAt, loadedAt };
}

// A report Discord accepted since this page loaded proves this client still sends them. NoTrack's switch, its state
// when Discord started and other blocking plugins only predict that it won't, so one accepted report answers all
// three and the warning stands down. Discord's own privacy settings are not answered by it: Discord takes a report
// and can still ignore what it was sent, which nothing here can see.
export const reportsGetThrough = (state: TrackingState) => state.lastReportAt > state.loadedAt;

const trackingOk = (state: TrackingState) =>
    (reportsGetThrough(state) || !state.blocked && !state.blockedAtStart && !state.blockers.length)
    && state.usageData !== false && state.personalized !== false;

// Discord only loads the privacy settings when its Data & Privacy page opens (the login data has just some of them),
// so they're fetched the same way, tried again until it works, and again every hour since Discord doesn't announce a
// change made on another device.
let consentsLoad: Promise<void> | null = null;
let consentsFor = "";
let consentsAt = 0;
let consentsTriedFor = "";
let consentsTriedAt = 0;
const CONSENTS_EVERY_MS = 60 * 60_000;
let consentsRetry: ReturnType<typeof setTimeout> | undefined;
export function loadConsents(): Promise<void> {
    const me = UserStore.getCurrentUser()?.id ?? "";
    const now = Date.now();
    if (!me || consentsFor === me && now - consentsAt < CONSENTS_EVERY_MS) return Promise.resolve();
    if (consentsLoad) return consentsLoad;
    if (consentsTriedFor === me && now - consentsTriedAt < RETRY_MS) return Promise.resolve();
    consentsTriedFor = me;
    consentsTriedAt = now;
    consentsLoad = RestAPI.get({ url: CONSENT_URL })
        .then(res => {
            if (!res?.body) throw new Error("No privacy settings in the answer");
            consentsFor = me;
            consentsAt = Date.now();
            FluxDispatcher.dispatch({ type: "UPDATE_CONSENTS", consents: { ...res.body } });
        })
        .catch(() => {
            clearTimeout(consentsRetry);
            // The report watch only runs while the plugin does, so a retry never outlives the plugin.
            consentsRetry = setTimeout(() => watching && void loadConsents(), RETRY_MS);
        })
        .finally(() => void (consentsLoad = null));
    return consentsLoad;
}

export function stopConsents() {
    clearTimeout(consentsRetry);
    consentsRetry = undefined;
}

// Turns them all on for this account, the same way Discord's own privacy settings do. Says whether Discord has to restart.
export async function allowTracking(): Promise<{ restart: boolean; }> {
    const noTrack = Settings.plugins.NoTrack;
    // NoTrack's "Allow Badge Tracking" when it has one, so the rest of Discord's analytics stays blocked, otherwise its
    // "Disable Analytics".
    if (noTrack && noTrackBlocks()) {
        if (hasBadgeSwitch()) noTrack.allowBadgeTracking = true;
        else noTrack.disableAnalytics = false;
    }
    await loadConsents();
    const { usageData, personalized } = trackingState();
    const grant = [...usageData === true ? [] : [USAGE], ...personalized === true ? [] : [PERSONALIZE]];
    if (grant.length) {
        const res = await RestAPI.post({ url: CONSENT_URL, body: { grant, revoke: [] } });
        if (res?.body) FluxDispatcher.dispatch({ type: "UPDATE_CONSENTS", consents: { ...res.body } });
    }
    // Either switch only applies after a restart, so one is needed exactly when NoTrack was blocking at startup.
    // Reports already getting through mean NoTrack isn't in the way, so there's nothing a restart would change.
    return { restart: blockedAtStart && !reportsGetThrough(trackingState()) };
}

// The settings above can look right while something else stops the reports, which is how 40 hours once went missing
// unnoticed. So the requests themselves are watched: a stream report only counts once Discord answered it with a 2xx.
export interface StreamReport {
    at: number;
    duration: number | null;
    frames: number | null;
    zeroReceivers: number | null;
    type: string;
    reason: string;
}

const reportListeners = new Set<(at: number, report: StreamReport) => void>();
export function onReport(listener: (at: number, report: StreamReport) => void) {
    reportListeners.add(listener);
    return () => void reportListeners.delete(listener);
}

const scienceRequests = new WeakSet<XMLHttpRequest>();
const scienceUrl = /\/science\b/;
let watching = false;
// Bumped on every start, so a wrapper left inside another plugin's chain after a stop stays a pass-through for good.
let watchRun = 0;
let partnerId = () => "";
export function watchReportsFrom(partner: () => string) {
    partnerId = partner;
}

// Discord sends this event for every stream that ends, so only this account's own stream counts, or watching the
// other account's when this one is the viewer. Closing a friend's stream sends no time to the badge.
function streamReportIn(body: unknown): StreamReport | null {
    if (typeof body !== "string" || !body.includes("video_stream_ended")) return null;
    try {
        const { events } = JSON.parse(body);
        const partner = partnerId();
        const found = events.find(({ type, properties: p }: { type: string; properties?: Record<string, unknown>; }) => type === "video_stream_ended"
            && (p?.participant_type === "streamer" || p?.participant_type === "receiver" && !!partner && p?.sender_user_id === partner));
        if (!found) return null;
        const p = found.properties;
        return { at: 0, duration: p.duration ?? null, frames: p.num_frames ?? null, zeroReceivers: p.duration_zero_receivers ?? null, type: String(p.participant_type), reason: String(p.reason ?? "") };
    } catch {
        return null;
    }
}

function reportAccepted(report: StreamReport) {
    lastReportAt = report.at = Date.now();
    for (const listener of reportListeners) listener(lastReportAt, report);
}

type Fn = (...args: any[]) => any;

interface WatchSlot {
    read(): Fn | undefined;
    write(fn: Fn): void;
    wrap(prev: Fn, run: number): Fn;
    prev?: Fn;
    mine?: Fn;
}

const live = (run: number) => watching && run === watchRun;

// Each slot wraps whatever is there when the watch starts, so wrappers other plugins installed before it keep running.
const watchSlots: WatchSlot[] = [
    {
        read: () => XMLHttpRequest.prototype.open,
        write: fn => void (XMLHttpRequest.prototype.open = fn as typeof XMLHttpRequest.prototype.open),
        wrap: (prev, run) => function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
            if (live(run) && scienceUrl.test(String(url))) scienceRequests.add(this);
            return prev.call(this, method, url, ...rest);
        }
    },
    {
        read: () => XMLHttpRequest.prototype.send,
        write: fn => void (XMLHttpRequest.prototype.send = fn as typeof XMLHttpRequest.prototype.send),
        wrap: (prev, run) => function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
            const report = live(run) && scienceRequests.has(this) ? streamReportIn(body) : null;
            if (report) {
                this.addEventListener("load", () => {
                    if (this.status >= 200 && this.status < 300) reportAccepted(report);
                });
            }
            return prev.call(this, body);
        }
    },
    // Reports still queued when the page is hidden or closing go out through fetch instead.
    {
        read: () => window.fetch,
        write: fn => void (window.fetch = fn as typeof window.fetch),
        wrap: (prev, run) => function (input: RequestInfo | URL, init?: RequestInit) {
            const result: Promise<Response> = prev.call(window, input, init);
            if (!live(run)) return result;
            const url = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
            const report = scienceUrl.test(String(url)) ? streamReportIn(init?.body) : null;
            if (report) {
                Promise.resolve(result).then(res => {
                    if (res.ok) reportAccepted(report);
                }, () => { });
            }
            return result;
        }
    }
];

export function startReportWatch() {
    if (watching) return;
    watching = true;
    const run = ++watchRun;
    for (const s of watchSlots) {
        const current = s.read();
        if (!current) continue;
        s.prev = current;
        s.mine = s.wrap(current, run);
        s.write(s.mine);
    }
}

// Only a slot still holding this watch's own wrapper is put back; one something else has wrapped over since stays in
// that chain, and `live` makes it a pass-through.
export function stopReportWatch() {
    if (!watching) return;
    watching = false;
    for (const s of watchSlots) {
        if (s.mine && s.prev && s.read() === s.mine) s.write(s.prev);
        s.prev = s.mine = undefined;
    }
    // Nothing can see a report from here on, so it can't be called missing either.
    reportExpectedAt = secondReportExpectedAt = 0;
}

// The stream was just ended to send its time, so its report should reach Discord soon. The second account only has one
// to send when it was watching at that moment.
let reportExpectedAt = 0;
let secondReportExpectedAt = 0;
let reportExpectedFor = "";
export function expectReports(fromSecond: boolean) {
    reportExpectedFor = UserStore.getCurrentUser()?.id ?? "";
    reportExpectedAt = Date.now();
    if (fromSecond) secondReportExpectedAt = reportExpectedAt;
}

// True when a report that should have gone out by now didn't reach Discord.
export function reportMissing(state: TrackingState, isSecond = false) {
    const expected = isSecond ? secondReportExpectedAt : reportExpectedAt;
    // The second account only sends a viewer's report, which NoTrack's badge-only mode drops on purpose.
    if (isSecond && state.badgeOnlyAtStart) return false;
    if (!expected || reportExpectedFor !== UserStore.getCurrentUser()?.id || Date.now() - expected < REPORT_WAIT_MS) return false;
    return state.loadedAt < expected && state.lastReportAt < expected;
}

// Whether the Streaming badge is being held back on this account or the second one (when it can be read).
export function trackingProblem(second?: TrackingState | null) {
    const mine = trackingState();
    return !trackingOk(mine) || reportMissing(mine) || !!second && (!trackingOk(second) || reportMissing(second, true));
}

// Discord's own number for the Streaming badge, like "22 hours streamed to others", which is the only one that counts.
let badgeLabel = "";
let badgeFor = "";
let badgeAt = 0;
let badgeMissing = false;
let badgeFails = 0;
// True when Discord answered and this account has no Streaming badge entry.
export function streamingBadgeMissing() {
    return badgeMissing && badgeFor === (UserStore.getCurrentUser()?.id ?? "");
}

export function streamingBadgeLabel() {
    const me = UserStore.getCurrentUser()?.id ?? "";
    return me && me === badgeFor ? badgeLabel : "";
}

// True once the lookup has failed a few times in a row, so the missing count can be explained.
export function streamingBadgeUnreadable() {
    return badgeFails >= 3 && badgeFor === (UserStore.getCurrentUser()?.id ?? "");
}

export async function refreshStreamingBadge() {
    const me = UserStore.getCurrentUser()?.id ?? "";
    if (!me || me === badgeFor && Date.now() - badgeAt < BADGE_EVERY_MS) return;
    if (me !== badgeFor) {
        badgeLabel = "";
        badgeMissing = false;
        badgeFails = 0;
    }
    badgeAt = Date.now();
    badgeFor = me;
    try {
        const res = await RestAPI.get({ url: `/users/${me}/badges` });
        const list = res?.body?.badges ?? res?.body;
        const badge = Array.isArray(list) ? list.find(b => b?.badge_id === STREAMING_BADGE) : null;
        if (badgeFor !== me) return;
        if (typeof badge?.info_label === "string") badgeLabel = badge.info_label;
        badgeMissing = Array.isArray(list) && !badge;
        badgeFails = 0;
    } catch {
        // Tried again after 5 minutes, then 10, 20, 40 and at most every hour, instead of every minute.
        if (badgeFor === me) badgeAt = Date.now() - BADGE_EVERY_MS + Math.min(60, 5 * 2 ** badgeFails++) * 60_000;
    }
}
