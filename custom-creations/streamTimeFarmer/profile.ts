/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { UserStore, useStateFromStores } from "@webpack/common";

import { settings } from ".";

// Stream farm settings are kept per account, so switching accounts in one Discord keeps each one's call, partner and
// total apart. (Two Discords running at once on one shared settings file still each save their own copy of it.)

export type StreamRole = "off" | "streamer" | "viewer";
// The farm's own window (see native.ts), the default thing to stream.
export const FARM_SOURCE = "farm";
// A game from Discord's list of games it detects, which the farm window is shown as.
export interface FarmGame { id: string; name: string; exeName: string; cover: string; }
export interface GoLiveSettings { preset: number; resolution: number; fps: number; soundshareEnabled: boolean; }
// Who the second account logged in here is, kept so the settings and the call widget can show it while its window is closed.
export interface SecondAccountInfo { id: string; username: string; globalName: string; tag: string; avatar: string; }

export interface StreamProfile {
    role: StreamRole;
    partner: string;
    where: "dm" | "server";
    channel: string;
    source: string;
    // Game mode: the farm window is shown as this game; null streams it as itself.
    farmGame: FarmGame | null;
    hostSecond: boolean;
    countedMs: number;
    joinedCall: string;
    deafened: boolean;
    // Whether the farm muted this account itself, so it unmutes it again when it stops.
    muted: boolean;
    savedGoLive: GoLiveSettings | null;
    account: SecondAccountInfo | null;
    // The second account's login is kept apart for each main account. Ones linked before that use the old shared login.
    ownLogin: boolean;
    // The online status the second account is set to when it starts; "" leaves whatever it has.
    secondPresence: SecondPresence;
}

export type SecondPresence = "" | "online" | "idle" | "dnd" | "invisible";

export const DEFAULT_PROFILE: StreamProfile = {
    role: "off",
    partner: "",
    where: "dm",
    channel: "",
    source: FARM_SOURCE,
    farmGame: null,
    hostSecond: false,
    countedMs: 0,
    joinedCall: "",
    deafened: false,
    muted: false,
    savedGoLive: null,
    account: null,
    ownLogin: false,
    secondPresence: ""
};

const LEGACY: Record<string, keyof StreamProfile> = {
    streamRole: "role",
    streamPartner: "partner",
    streamWhere: "where",
    streamChannel: "channel",
    streamSource: "source",
    streamHostSecond: "hostSecond",
    streamCountedMs: "countedMs",
    streamJoinedCall: "joinedCall",
    streamDeafened: "deafened",
    streamSavedGoLive: "savedGoLive"
};

export const currentUserId = () => UserStore.getCurrentUser()?.id ?? "";

export function profileFor(userId: string): StreamProfile {
    return { ...DEFAULT_PROFILE, ...settings.store.profiles[userId] };
}

export const profile = () => profileFor(currentUserId());

export function useProfile(): StreamProfile {
    settings.use(["profiles"]);
    const me = useStateFromStores([UserStore], () => UserStore.getCurrentUser()?.id ?? "");
    return profileFor(me);
}

export function updateProfileFor(userId: string, patch: Partial<StreamProfile>) {
    if (!userId) return;
    const current = profileFor(userId);
    // Nothing changed: skip rewriting the whole settings file.
    if (Object.entries(patch).every(([k, v]) => JSON.stringify(current[k as keyof StreamProfile]) === JSON.stringify(v))) return;
    // Replaced as a whole, so settings listeners always see the change. The stored values are live settings proxies,
    // which can't be sent to the settings file, so it's a plain copy.
    const next = { ...settings.store.profiles, [userId]: { ...profileFor(userId), ...patch } };
    settings.store.profiles = JSON.parse(JSON.stringify(next));
}

export const updateProfile = (patch: Partial<StreamProfile>) => updateProfileFor(currentUserId(), patch);

// Stream farm settings from before they were per account go to whichever account starts the plugin first.
export function migrateLegacy(userId: string) {
    const raw = settings.store as unknown as Record<string, unknown>;
    const found = Object.keys(LEGACY).filter(k => raw[k] !== undefined);
    if (!found.length || !userId) return;
    if (!settings.store.profiles[userId]) {
        const patch: Partial<StreamProfile> = {};
        for (const k of found) (patch as Record<string, unknown>)[LEGACY[k]] = raw[k];
        updateProfileFor(userId, patch);
    }
    for (const k of found) delete raw[k];
}

// "A random open window" was the default before the farm had its own window, and could stream a window that was
// minimized, closed or private. Everyone still on it moves to the farm window; a window someone picked stays.
export function migrateRandomSource() {
    const profiles = settings.store.profiles ?? {};
    const old = Object.keys(profiles).filter(id => profiles[id]?.source === "random");
    for (const id of old) updateProfileFor(id, { source: FARM_SOURCE });
}
