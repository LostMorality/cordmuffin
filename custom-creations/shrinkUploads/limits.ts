/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { User } from "@vencord/discord-types";
import { findByCodeLazy, findByPropsLazy, findLazy } from "@webpack";
import { UserStore } from "@webpack/common";

const PremiumUtils = findByPropsLazy("getUserMaxFileSize") as { getUserMaxFileSize(user: User): number; };
const getGuildMaxFileSize = findByCodeLazy(".getUserMaxFileSize(", ".features.has(", ".getGuild(") as (guildId?: string | null) => number;
const applyFloor = findLazy(m =>
    typeof m === "function" && m.length === 1 && /^function\s*[\w$]*\([\w$]+\)\s*{\s*return Math\.max\((?:0x[\da-f]+|\d+(?:e\d+)?),[\w$]+\)\s*}$/.test(String(m)) && m(0) >= 1024 * 1024
) as (bytes: number) => number;

export interface LimitParts {
    user: number;
    guild: number;
    floored: number;
}

function safe(fn: () => number) {
    try {
        const n = fn();
        return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
        return 0;
    }
}

export const combineLimit = ({ user, guild, floored }: LimitParts) => floored || guild || user;

export function getLimitParts(guildId?: string | null): LimitParts {
    const user = safe(() => PremiumUtils.getUserMaxFileSize(UserStore.getCurrentUser()));
    const guild = safe(() => getGuildMaxFileSize(guildId ?? null));
    const floored = safe(() => applyFloor(guild || user));
    return { user, guild, floored };
}

export const getUploadLimit = (guildId?: string | null) => combineLimit(getLimitParts(guildId));

export function describeLimit(guildId?: string | null) {
    const parts = getLimitParts(guildId);
    const limit = combineLimit(parts);
    const premium = UserStore.getCurrentUser()?.premiumType ?? 0;
    const plan = premium === 2 ? "Nitro" : premium === 3 ? "Nitro Basic" : premium === 1 ? "Nitro Classic" : "no Nitro";
    const boosted = parts.guild > parts.user && parts.guild >= parts.floored;
    return { limit, plan, boosted };
}
