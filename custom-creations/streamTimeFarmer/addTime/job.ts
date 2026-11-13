/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { useEffect, useState } from "@webpack/common";

import { notify as baseNotify } from "./notify";
import { changeStreamProfile } from "..";
import { currentUserId, profileFor, type StreamRole, updateProfileFor } from "../profile";
import { type LedgerRow, pendingFor, statusOk } from "./ledger";
import { MAX_CLAIM_S } from "./raiser";

const logger = new Logger("AddStreamTime");

const KEY = "AddStreamTime_job";
const TITLE = "Add Streaming Time";

export const MIN_HOURS = 1;
export const MAX_HOURS = 9999;

export interface SentRow {
    hour: number;
    at: number;
    claimed: number;
}

export interface StreamJob {
    userId: string;
    // Seconds.
    total: number;
    remaining: number;
    sent: SentRow[];
    startedAt: number;
    // The farm's role on this account before the job, put back when it ends.
    roleBefore: StreamRole;
}

let job: StreamJob | null = null;
// startedAt doubles as the job's id on log rows, so two jobs in one millisecond still get different ones.
let lastStartedAt = 0;
let loaded = false;
let running = false;
let loading: Promise<StreamJob | null> | null = null;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach(l => {
    try {
        l();
    } catch (e) {
        logger.error("Job listener failed", e);
    }
});

export const notify = (text: string, variant: "default" | "success" | "critical" = "default") => baseNotify(text, variant, TITLE);

export const currentJob = () => job;
export const jobRunning = () => job !== null;
export const jobLoaded = () => loaded;
export const pluginRunning = () => running;
export const setPluginRunning = (on: boolean) => void (running = on);

export function onJob(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}

export function useJob() {
    const [, rerender] = useState(0);
    useEffect(() => onJob(() => rerender(n => n + 1)), []);
    return job;
}

export const hoursText = (s: number) => (Math.round(s / 360) / 10).toLocaleString();
export const hoursWord = (s: number) => `${hoursText(s)} ${Math.round(s / 360) === 10 ? "hour" : "hours"}`;
export const sentSeconds = (j: StreamJob) => j.total - j.remaining;
// A send is a minute short of 12 h, so a job in whole hours ends with a few minutes over. Not worth another hour's wait.
const LEFTOVER_S = 180;
export const sendsLeft = (j: StreamJob) => splitSends(j.remaining).count;
export const sendsTotal = (j: StreamJob) => j.sent.length + sendsLeft(j);

// How a total splits into sends of just under 12 h each.
export function splitSends(totalS: number) {
    const full = Math.floor(totalS / MAX_CLAIM_S);
    const left = totalS - full * MAX_CLAIM_S;
    const rest = full > 0 && left < LEFTOVER_S ? 0 : left;
    return { count: full + (rest > 0 ? 1 : 0), full, rest };
}

export function formatWait(ms: number) {
    const minutes = Math.round(ms / 60_000);
    if (minutes < 1) return "under a minute";
    if (minutes < 60) return `about ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    return `about ${minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`}`;
}

const isJob = (j: any): j is StreamJob => j && typeof j.userId === "string" && typeof j.total === "number" && typeof j.remaining === "number"
    && Array.isArray(j.sent) && typeof j.startedAt === "number" && typeof j.roleBefore === "string";

function save() {
    (job ? DataStore.set(KEY, job) : DataStore.del(KEY)).catch(e => logger.error("Couldn't save the job", e));
}

function setJob(next: StreamJob | null) {
    job = next;
    save();
    emit();
}

// Read once per page, so a plugin restart keeps the job in memory as it is.
export function loadJob(): Promise<StreamJob | null> {
    if (loaded) return Promise.resolve(job);
    loading ??= (async () => {
        try {
            const saved = await DataStore.get(KEY);
            if (isJob(saved) && saved.remaining > 0) {
                job = { ...saved, sent: saved.sent.filter(r => r && typeof r.claimed === "number") };
                lastStartedAt = Math.max(lastStartedAt, saved.startedAt);
            }
        } catch (e) {
            logger.error("Couldn't load the job", e);
        }
        loaded = true;
        emit();
        return job;
    })();
    return loading;
}

function restoreRole(j: StreamJob) {
    if (j.roleBefore === "streamer" || profileFor(j.userId).role !== "streamer") return;
    try {
        if (currentUserId() === j.userId) changeStreamProfile({ role: j.roleBefore });
        else updateProfileFor(j.userId, { role: j.roleBefore });
    } catch (e) {
        logger.error("Couldn't put StreamTimeFarmer's role back", e);
    }
}

export function startJob(totalS: number) {
    const me = currentUserId();
    const total = Math.round(totalS);
    if (job || !running || !loaded || !me || !(total >= MIN_HOURS * 3600)) return false;
    const roleBefore = profileFor(me).role;
    const startedAt = lastStartedAt = Math.max(Date.now(), lastStartedAt + 1);
    setJob({ userId: me, total, remaining: total, sent: [], startedAt, roleBefore });
    if (roleBefore !== "streamer") changeStreamProfile({ role: "streamer" });
    logger.info(`Adding ${total}s of streaming time`);
    return true;
}

function end(): StreamJob | null {
    const j = job;
    if (!j) return null;
    setJob(null);
    restoreRole(j);
    return j;
}

export function stopJob() {
    const j = end();
    if (!j) return;
    const sent = sentSeconds(j);
    logger.info(`Stopped with ${sent}s of ${j.total}s sent`);
    const waiting = pendingFor(j.startedAt) ? " One more send is still waiting for Discord's answer; it counts if it goes through." : "";
    notify((sent
        ? `Stopped: ${hoursText(sent)} of ${hoursWord(j.total)} were sent in ${j.sent.length} send${j.sent.length === 1 ? "" : "s"} and still count.`
        : "Stopped. Nothing was sent yet.") + waiting);
}

// A send Discord accepted (2xx, or a queued beacon) comes off what's left.
export function noteResult(row: LedgerRow, ok: boolean) {
    if (!ok || !job || row.job !== job.startedAt) return;
    const claimed = Math.min(row.claimed, job.remaining);
    const next = { ...job, remaining: job.remaining - claimed, sent: [...job.sent, { hour: row.hour, at: row.sentAt, claimed: row.claimed }] };
    if (next.remaining >= LEFTOVER_S) return setJob(next);
    job = next;
    end();
    logger.info(`Done: ${next.total}s in ${next.sent.length} sends`);
    notify(`Done: ${hoursWord(next.total)} sent in ${next.sent.length} send${next.sent.length === 1 ? "" : "s"}. They show on your badge in about 1.5 to 3 hours.`, "success");
}

// Accepted sends for this job the saved job missed (it was saved before the answer came, or the answer came while
// the plugin was off), so they come off what's left instead of being sent again.
export function reconcileJob(rows: readonly LedgerRow[]) {
    for (const row of rows) {
        const j = job;
        if (!j) return;
        if (row.job === j.startedAt && statusOk(row.status) && !j.sent.some(s => s.hour === row.hour && s.at === row.sentAt))
            noteResult(row, true);
    }
}

export const claimSeconds = () => job ? Math.min(MAX_CLAIM_S, job.remaining) : 0;
export const jobId = () => job?.startedAt ?? 0;
