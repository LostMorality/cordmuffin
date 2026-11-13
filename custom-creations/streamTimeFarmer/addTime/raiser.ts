/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";

import { addRow, hourTaken, ledgerLoaded, type LedgerRow, settleRow } from "./ledger";

const logger = new Logger("AddStreamTime");

export const HOUR_MS = 3_600_000;
// 43199 s was credited in full; 43200 s and above was credited as zero, not trimmed. One minute is kept as a margin.
export const MAX_CLAIM_S = 43_140;
export const MIN_REAL_S = 30;
// Reports this close to an hour boundary could land in the neighbouring hour on Discord's side (clock skew,
// or Discord using the event timestamp), so they're left as they are and the scheduler makes the hour's report.
const EDGE_MS = 3 * 60_000;

export const utcHour = (t = Date.now()) => Math.floor(t / HOUR_MS);

// A report this plugin is sending again itself. It never ended a stream, so the usual "a stream of the farm's
// just ended" test would turn it away; it's let through by its own stream's id instead, which no other report
// carries. The window covers the tracker handing it to the network a tick or two after the call.
const RESEND_WINDOW_MS = 15_000;
let resendSession = "";
let resendUntil = 0;

export function beginResend(sessionId: string) {
    resendSession = sessionId;
    resendUntil = Date.now() + RESEND_WINDOW_MS;
}

export function endResend() {
    resendSession = "";
    resendUntil = 0;
}

const isOurResend = (p: Record<string, unknown>) =>
    resendSession !== "" && Date.now() < resendUntil && p.media_session_id === resendSession;

interface RaiserHooks {
    // Why a report can't be raised here right now, "" when it can.
    whyNot(): string;
    // A real report of the farm's own stream, copied before it was raised, to be sent again in later hours.
    onRaised(props: Record<string, unknown>): void;
    // What this hour's report should claim: min(cap, what the job has left), 0 without a job.
    claimSeconds(): number;
    // startedAt of the running job, stored on each row so a late answer can't count toward a different job.
    jobId(): number;
    onStreamerReport(): void;
    onResult(row: LedgerRow, ok: boolean): void;
}

export const idleRaiserHooks: RaiserHooks = { whyNot: () => "no job is running", onRaised: () => { }, claimSeconds: () => 0, jobId: () => 0, onStreamerReport: () => { }, onResult: () => { } };
let hooks: RaiserHooks = idleRaiserHooks;
export const configureRaiser = (h: RaiserHooks) => void (hooks = h);

const skip = (why: string) => {
    logger.info(`Stream report left as it is: ${why}`);
    return null;
};

function tryRaise(p: Record<string, unknown>, ours: boolean): string | null {
    if (!ledgerLoaded()) return skip("the send log hasn't loaded yet");
    const whyNot = ours ? "" : hooks.whyNot();
    if (whyNot) return skip(whyNot);
    const real = Number(p.duration);
    const viewers = Number(p.max_viewers);
    if (!Number.isFinite(real) || real < MIN_REAL_S) return skip(`the stream ran for less than ${MIN_REAL_S}s`);
    if (!Number.isFinite(viewers) || viewers < 1) return skip("nobody watched the stream");
    const goal = Math.min(MAX_CLAIM_S, Math.floor(hooks.claimSeconds()));
    if (!(goal > 0)) return skip("no job is running");
    const now = Date.now();
    const into = now % HOUR_MS;
    if (into < EDGE_MS || into > HOUR_MS - EDGE_MS) return skip("too close to the edge of the hour");
    const hour = utcHour(now);
    if (hourTaken(hour)) return skip("this hour already has a send");
    const job = hooks.jobId();

    // Over the cap Discord credits nothing, so it's trimmed to the cap and still counts.
    if (real > MAX_CLAIM_S) {
        p.duration = MAX_CLAIM_S;
        if (typeof p.duration_aggregation === "number") p.duration_aggregation = Math.min(MAX_CLAIM_S, p.duration_aggregation);
        logger.info(`Trimming stream report from ${real}s to ${MAX_CLAIM_S}s`);
        return addRow({ hour, sentAt: now, real, claimed: MAX_CLAIM_S, viewers, status: "pending", job });
    }

    // Already covers what's left: it goes out as it is and counts at its real value.
    if (real >= goal) {
        logger.info(`Stream report of ${real}s already covers the ${goal}s left, sending it as it is`);
        return addRow({ hour, sentAt: now, real, claimed: real, viewers, status: "pending", job });
    }

    const delta = goal - real;
    p.duration = goal;
    if (typeof p.duration_aggregation === "number") p.duration_aggregation = Math.min(MAX_CLAIM_S, p.duration_aggregation + delta);
    logger.info(`Raising stream report from ${real}s to ${goal}s`);
    return addRow({ hour, sentAt: now, real, claimed: goal, viewers, status: "pending", job });
}

// Returns the (possibly rewritten) body and the ledger row id when this body carries the raised report.
function edit(body: string): { body: string; claim: string | null; } {
    if (!body.includes("video_stream_ended")) return { body, claim: null };
    let data: any;
    try {
        data = JSON.parse(body);
    } catch {
        return { body, claim: null };
    }
    if (!Array.isArray(data?.events)) return { body, claim: null };
    let claim: string | null = null;
    for (const e of data.events) {
        if (e?.type !== "video_stream_ended" || e.properties?.participant_type !== "streamer") continue;
        try {
            hooks.onStreamerReport();
        } catch (err) {
            logger.error("Stream report listener failed", err);
        }
        if (claim) continue;
        const ours = isOurResend(e.properties);
        if (ours) endResend();
        // Copied before raising, so what's kept is the stream's real length.
        const real = ours ? null : snapshot(e.properties);
        claim = tryRaise(e.properties, ours);
        if (claim && real) {
            try {
                hooks.onRaised(real);
            } catch (err) {
                logger.error("Couldn't keep the stream report", err);
            }
        }
    }
    return claim ? { body: JSON.stringify(data), claim } : { body, claim: null };
}

function snapshot(p: Record<string, unknown>): Record<string, unknown> | null {
    try {
        return JSON.parse(JSON.stringify(p));
    } catch {
        return null;
    }
}

function safeEdit(body: string) {
    try {
        return edit(body);
    } catch (e) {
        logger.error("Couldn't read a stream report", e);
        return { body, claim: null };
    }
}

function settle(claim: string, status: number | "beacon" | "failed") {
    const ok = status === "beacon" || typeof status === "number" && status >= 200 && status < 300;
    if (ok) logger.info("Stream report accepted:", status);
    else logger.warn("Stream report failed:", status, "- this hour stays open");
    const row = settleRow(claim, ok ? status : typeof status === "number" && status > 0 ? status : "failed");
    if (!row) return;
    try {
        hooks.onResult(row, ok);
    } catch (e) {
        logger.error("Couldn't count the send", e);
    }
}

function isScience(url: unknown) {
    try {
        const raw = typeof url === "string" || url instanceof URL ? String(url) : (url as Request | undefined)?.url;
        if (!raw) return false;
        return /\/(science|track)\/?$/.test(new URL(raw, location.href).pathname);
    } catch {
        return false;
    }
}

type Fn = (...args: any[]) => any;

interface Slot {
    read(): Fn | undefined;
    write(fn: Fn): void;
    wrap(prev: Fn): Fn;
    prev?: Fn;
    mine?: Fn;
}

let live = false;
const scienceXhrs = new WeakSet<XMLHttpRequest>();

const slots: Slot[] = [
    {
        read: () => XMLHttpRequest.prototype.open,
        write: fn => void (XMLHttpRequest.prototype.open = fn as typeof XMLHttpRequest.prototype.open),
        wrap: prev => function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
            if (isScience(url)) scienceXhrs.add(this);
            return prev.call(this, method, url, ...rest);
        }
    },
    {
        read: () => XMLHttpRequest.prototype.send,
        write: fn => void (XMLHttpRequest.prototype.send = fn as typeof XMLHttpRequest.prototype.send),
        wrap: prev => function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
            if (!live || typeof body !== "string" || !scienceXhrs.has(this)) return prev.call(this, body);
            const res = safeEdit(body);
            const { claim } = res;
            if (!claim) return prev.call(this, res.body);
            this.addEventListener("loadend", () => settle(claim, this.status || "failed"), { once: true });
            try {
                return prev.call(this, res.body);
            } catch (e) {
                settle(claim, "failed");
                throw e;
            }
        }
    },
    {
        read: () => window.fetch,
        write: fn => void (window.fetch = fn as typeof window.fetch),
        wrap: prev => function (input: RequestInfo | URL, init?: RequestInit) {
            if (!live || typeof init?.body !== "string" || !isScience(input)) return prev.call(window, input, init);
            const { body, claim } = safeEdit(init.body);
            if (!claim) return prev.call(window, input, init);
            let result: Promise<Response>;
            try {
                result = prev.call(window, input, { ...init, body });
            } catch (e) {
                settle(claim, "failed");
                throw e;
            }
            Promise.resolve(result).then(r => settle(claim, r.status), () => settle(claim, "failed"));
            return result;
        }
    },
    {
        read: () => typeof navigator.sendBeacon === "function" ? navigator.sendBeacon : undefined,
        write: fn => void (navigator.sendBeacon = fn as typeof navigator.sendBeacon),
        wrap: prev => function (url: string | URL, data?: BodyInit | null) {
            if (!live || typeof data !== "string" || !isScience(url)) return prev.call(navigator, url, data);
            const { body, claim } = safeEdit(data);
            let queued = false;
            try {
                queued = prev.call(navigator, url, body);
            } finally {
                if (claim) settle(claim, queued ? "beacon" : "failed");
            }
            return queued;
        }
    }
];

// Safe to call repeatedly: re-wraps only a slot something else replaced since (StreamTimeFarmer's report watch
// restores and re-wraps the same functions and calls its own saved originals, which would bypass this one).
export function installHooks() {
    live = true;
    for (const s of slots) {
        const current = s.read();
        if (!current || s.mine && current === s.mine) continue;
        s.prev = current;
        s.mine = s.wrap(current);
        s.write(s.mine);
    }
}

export const hooksInPlace = () => slots.every(s => !s.read() || s.read() === s.mine);

// A wrapper something else has since wrapped over can't be taken out of that chain; `live` makes it a pass-through.
export function removeHooks() {
    live = false;
    for (const s of slots) {
        if (s.mine && s.prev && s.read() === s.mine) s.write(s.prev);
        s.prev = s.mine = undefined;
    }
}
