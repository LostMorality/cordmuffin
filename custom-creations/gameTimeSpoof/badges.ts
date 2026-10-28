/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RestAPI, UserStore } from "@webpack/common";

import { settings } from ".";

export const UPDATE_WITHIN_MS = 24 * 3_600_000;
const FORGET_AFTER_MS = 72 * 3_600_000;

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

interface RawBadge {
    badge_id: number;
    progress?: { current: number; }[];
    tiers?: { name: string; requirements?: { threshold: number; }[]; }[];
}

export async function loadBadges(): Promise<Partial<Record<BadgeKind, BadgeProgress>>> {
    const userId = UserStore.getCurrentUser()?.id;
    const { body } = await RestAPI.get({ url: `/users/${userId}/badges` });
    const result: Partial<Record<BadgeKind, BadgeProgress>> = {};
    for (const kind of ["time", "variety"] as const) {
        const raw = (body?.badges as RawBadge[] | undefined)?.find(b => b.badge_id === BADGE_IDS[kind]);
        const current = raw?.progress?.[0]?.current;
        if (current == null || !raw?.tiers?.length) continue;
        result[kind] = {
            current,
            tiers: raw.tiers.map(t => ({ name: t.name, threshold: t.requirements?.[0]?.threshold ?? 0 })).sort((a, b) => a.threshold - b.threshold)
        };
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

export function getPending(badges: Partial<Record<BadgeKind, BadgeProgress>>) {
    const now = Date.now();
    const kept = settings.store.pending.filter(e => now - e.at < FORGET_AFTER_MS && !(isCounted(e, badges, "time") && isCounted(e, badges, "variety")));
    if (kept.length !== settings.store.pending.length) settings.store.pending = kept;
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
    settings.store.pending = [...settings.store.pending, {
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
