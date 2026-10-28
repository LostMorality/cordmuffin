/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { RestAPI, UserStore } from "@webpack/common";

import { settings } from ".";

const logger = new Logger("GameTimeSpoof");

const DAY_MS = 24 * 3_600_000;
const FORGET_AFTER_MS = 72 * 3_600_000;
// A rise seen this soon after the last look pins the update time closely enough to show.
const SEEN_WITHIN_MS = 3 * 3_600_000;

export type BadgeKind = "time" | "variety";

const BADGE_IDS: Record<BadgeKind, number> = { time: 20, variety: 21 };

export interface Tier {
    name: string;
    threshold: number;
}

export interface BadgeProgress {
    current: number;
    tiers: Tier[];
}

export interface PendingCredit {
    at: number;
    hours: number;
    games: number;
    baseHours: number | null;
    baseGames: number | null;
}

// When Discord's daily badge update runs for this account, as minutes past midnight UTC.
export interface UpdateClock {
    minuteUtc: number;
    learnedAt: number;
}

export interface SeenBadges {
    hours: number | null;
    games: number | null;
    at: number;
}

interface RawBadge {
    badge_id: number;
    progress?: { current: number; }[];
    tiers?: { name: string; requirements?: { threshold: number; }[]; }[];
    obtained_at?: string;
    tier_obtained_at?: Record<string, string>;
}

const minuteOfDay = (ms: number) => Math.floor(ms % DAY_MS / 60_000);

// Discord hands out new ranks during its daily update, so the newest rank's timestamp shows when that runs.
function learnFromRanks(raw: RawBadge[]) {
    const times = raw
        .filter(b => b.badge_id === BADGE_IDS.time || b.badge_id === BADGE_IDS.variety)
        .flatMap(b => [b.obtained_at, ...Object.values(b.tier_obtained_at ?? {})])
        .map(t => t ? Date.parse(t) : NaN)
        .filter(Number.isFinite);
    if (!times.length) return;
    const newest = Math.max(...times);
    const known = settings.store.updateClock;
    if (!known || newest > known.learnedAt) settings.store.updateClock = { minuteUtc: minuteOfDay(newest), learnedAt: newest };
}

// A count that went up between two looks means the daily update ran in between.
function learnFromChange(result: Partial<Record<BadgeKind, BadgeProgress>>, now: number) {
    const hours = result.time?.current ?? null;
    const games = result.variety?.current ?? null;
    const last = settings.store.lastSeen;
    if (last && now - last.at <= SEEN_WITHIN_MS) {
        const rose = (hours != null && last.hours != null && hours > last.hours) || (games != null && last.games != null && games > last.games);
        const known = settings.store.updateClock;
        if (rose && (!known || last.at > known.learnedAt)) {
            const middle = Math.round((last.at + now) / 2);
            settings.store.updateClock = { minuteUtc: minuteOfDay(middle), learnedAt: middle };
        }
    }
    settings.store.lastSeen = { hours, games, at: now };
}

// The first daily update after `after`, or null while the time isn't known for this account.
export function nextUpdate(after: number) {
    const clock = settings.store.updateClock;
    if (!clock) return null;
    const dayStart = after - after % DAY_MS;
    const today = dayStart + clock.minuteUtc * 60_000;
    return today > after ? today : today + DAY_MS;
}

export async function loadBadges(): Promise<Partial<Record<BadgeKind, BadgeProgress>>> {
    const userId = UserStore.getCurrentUser()?.id;
    const { body } = await RestAPI.get({ url: `/users/${userId}/badges` });
    const raw = (body?.badges ?? []) as RawBadge[];
    const result: Partial<Record<BadgeKind, BadgeProgress>> = {};
    for (const kind of ["time", "variety"] as const) {
        const badge = raw.find(b => b.badge_id === BADGE_IDS[kind]);
        const current = badge?.progress?.[0]?.current;
        if (current == null || !badge?.tiers?.length) continue;
        result[kind] = {
            current,
            tiers: badge.tiers.map(t => ({ name: t.name, threshold: t.requirements?.[0]?.threshold ?? 0 })).sort((a, b) => a.threshold - b.threshold)
        };
    }
    try {
        learnFromRanks(raw);
        learnFromChange(result, Date.now());
    } catch (e) {
        logger.error("Couldn't save when badges update", e);
    }
    return result;
}

export function tierFor(progress: BadgeProgress, value: number) {
    let index = -1;
    progress.tiers.forEach((t, i) => { if (value >= t.threshold) index = i; });
    return { tier: progress.tiers[index] ?? null, next: progress.tiers[index + 1] ?? null };
}

function isCounted(entry: PendingCredit, badges: Partial<Record<BadgeKind, BadgeProgress>>, kind: BadgeKind) {
    const base = kind === "time" ? entry.baseHours : entry.baseGames;
    const amount = kind === "time" ? Math.floor(entry.hours) : entry.games;
    const current = badges[kind]?.current;
    if (!amount) return true;
    return base != null && current != null && current >= base + amount;
}

// Items read through settings.store come back wrapped, and a wrapped item saved back breaks every later settings save.
export function savedPending(): PendingCredit[] {
    return settings.store.pending.map(e => ({ at: e.at, hours: e.hours, games: e.games, baseHours: e.baseHours, baseGames: e.baseGames }));
}

export function getPending(badges: Partial<Record<BadgeKind, BadgeProgress>>) {
    const now = Date.now();
    const saved = savedPending();
    const kept = saved.filter(e => now - e.at < FORGET_AFTER_MS && !(isCounted(e, badges, "time") && isCounted(e, badges, "variety")));
    if (kept.length !== saved.length) settings.store.pending = kept;
    return {
        hours: kept.reduce((sum, e) => sum + (isCounted(e, badges, "time") ? 0 : e.hours), 0),
        games: kept.reduce((sum, e) => sum + (isCounted(e, badges, "variety") ? 0 : e.games), 0),
        oldest: kept.length ? Math.min(...kept.map(e => e.at)) : null,
        newest: kept.length ? Math.max(...kept.map(e => e.at)) : null
    };
}

export function recordCredit(hours: number, games: number, badges: Partial<Record<BadgeKind, BadgeProgress>> | null) {
    if (hours <= 0 && games <= 0) return;
    const pending = badges ? getPending(badges) : null;
    settings.store.pending = [...savedPending(), {
        at: Date.now(),
        hours,
        games,
        baseHours: badges?.time && pending ? badges.time.current + Math.floor(pending.hours) : null,
        baseGames: badges?.variety && pending ? badges.variety.current + pending.games : null
    }];
}

export function formatWhen(ms: number) {
    return new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}
