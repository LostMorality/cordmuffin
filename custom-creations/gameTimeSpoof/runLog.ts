/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { settings } from ".";
import type { CreditPlan } from "./science";

const KEEP_RUNS = 25;
// A session ending this long before the run started was dated into the past.
const BACKDATED_AFTER_MS = 60_000;

export type RunKind = "add" | "test";
export type RunStatus = "done" | "stopped" | "failed" | "no answer";

export interface TestPart {
    hours: number;
    endsHoursAgo: number;
}

export interface RunEntry {
    at: number;
    kind: RunKind;
    games: number;
    newGames: number | null;
    sessions: number;
    sent: number;
    hours: number;
    longestHours: number;
    backdated: number;
    status: RunStatus;
    httpStatus: number | null;
    baseHours: number | null;
    baseGames: number | null;
    waitingHours: number | null;
    spoofing: boolean | null;
    parts: TestPart[] | null;
}

// Items read through settings.store come back wrapped, so every saved entry is copied into a plain object first.
export function savedRuns(): RunEntry[] {
    return (settings.store.runLog ?? []).map(r => ({
        at: r.at,
        kind: r.kind,
        games: r.games,
        newGames: r.newGames,
        sessions: r.sessions,
        sent: r.sent,
        hours: r.hours,
        longestHours: r.longestHours,
        backdated: r.backdated,
        status: r.status,
        httpStatus: r.httpStatus,
        baseHours: r.baseHours,
        baseGames: r.baseGames,
        waitingHours: r.waitingHours ?? null,
        spoofing: r.spoofing ?? null,
        parts: r.parts ? r.parts.map(p => ({ hours: p.hours, endsHoursAgo: p.endsHoursAgo })) : null
    }));
}

const toHours = (ms: number) => Math.round(ms / 360_000) / 10;

export interface RunInfo {
    kind: RunKind;
    startedAt: number;
    plan: CreditPlan;
    sent: number;
    played: Set<string> | null;
    baseHours: number | null;
    baseGames: number | null;
    waitingHours: number | null;
    spoofing: boolean | null;
    status: RunStatus;
    httpStatus: number | null;
    parts: TestPart[] | null;
}

export function logRun(run: RunInfo) {
    // One pass without spreading: big runs have far more sessions than a function call takes arguments.
    const games = new Set<string>();
    let ms = 0;
    let longest = 0;
    let backdated = 0;
    for (let i = 0; i < run.sent; i++) {
        const s = run.plan.at(i);
        games.add(s.game.id);
        ms += s.durationMs;
        if (s.durationMs > longest) longest = s.durationMs;
        if (s.end < run.startedAt - BACKDATED_AFTER_MS) backdated++;
    }
    const entry: RunEntry = {
        at: run.startedAt,
        kind: run.kind,
        games: games.size,
        newGames: run.played ? [...games].filter(id => !run.played!.has(id)).length : null,
        sessions: run.plan.length,
        sent: run.sent,
        hours: toHours(ms),
        longestHours: toHours(longest),
        backdated,
        status: run.status,
        httpStatus: run.httpStatus,
        baseHours: run.baseHours,
        baseGames: run.baseGames,
        waitingHours: run.waitingHours,
        spoofing: run.spoofing,
        parts: run.parts
    };
    settings.store.runLog = [...savedRuns(), entry].slice(-KEEP_RUNS);
}
