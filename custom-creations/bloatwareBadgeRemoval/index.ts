/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { BadgeUserArgs, ProfileBadge } from "@api/Badges";
import { plugins } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, StartAt } from "@utils/types";
import { UserStore } from "@webpack/common";

const logger = new Logger("BloatwareBadgeRemoval");

type DonorList = Record<string, unknown>;

interface BadgeApi {
    DonorBadges: DonorList;
    EquicordDonorBadges: DonorList;
    getBadges(profile: BadgeUserArgs): AnyBadge[];
}

interface AnyBadge {
    id?: string;
    description?: string;
    icon?: string;
    simple_icon_url?: string;
    iconSrc?: string;
    component?: ProfileBadge["component"];
}

const DONOR_LISTS = {
    "https://badges.vencord.dev/badges.json": "DonorBadges",
    "https://badge.equicord.org/badges.json": "EquicordDonorBadges"
} as const satisfies Record<string, keyof BadgeApi>;

const SOURCE_SETTING = {
    vencord: "hideVencord",
    equicord: "hideEquicord",
    otherMods: "hideOtherMods",
    plugins: "hidePlugins"
} as const;

type Source = keyof typeof SOURCE_SETTING;

const isHidingAll = () => settings.store.hideAll;

const settings = definePluginSettings({
    hideAll: {
        type: OptionType.BOOLEAN,
        description: "Hide every client mod badge. Turn this off to pick which kinds to hide below.",
        default: true
    },
    hideVencord: {
        type: OptionType.BOOLEAN,
        description: "Hide Vencord donor, custom and contributor badges.",
        default: true,
        disabled: isHidingAll
    },
    hideEquicord: {
        type: OptionType.BOOLEAN,
        description: "Hide Equicord donor, custom, translator and contributor badges.",
        default: true,
        disabled: isHidingAll
    },
    hideOtherMods: {
        type: OptionType.BOOLEAN,
        description: "Hide other mods' badges from GlobalBadges (Aliucord, BetterDiscord, Replugged, Nekocord, ReviewDB and more).",
        default: true,
        disabled: isHidingAll
    },
    hidePlugins: {
        type: OptionType.BOOLEAN,
        description: "Hide badges that plugins add, like FriendshipRanks.",
        default: true,
        disabled: isHidingAll
    },
    keepOwn: {
        type: OptionType.BOOLEAN,
        description: "Leave your own profile alone, so you still see all of your own badges.",
        default: false
    },
    keepContributors: {
        type: OptionType.BOOLEAN,
        description: "Keep Vencord and Equicord contributor and translator badges.",
        default: false
    },
    blockDonorLists: {
        type: OptionType.BOOLEAN,
        description: "Don't download the Vencord and Equicord donor badge lists at all. Saves two downloads on every start and every 30 minutes.",
        default: false,
        onChange: (on: boolean) => running && (on ? emptyDonorLists() : refillDonorLists())
    },
    hideNitroBoost: {
        type: OptionType.BOOLEAN,
        description: "Also hide Discord's own Nitro and server boost badges.",
        default: false
    }
});

// The Vencord global doesn't exist yet at StartAt.Init, so go through the plugin manager.
const badgeApi = () => plugins.BadgeAPI as unknown as BadgeApi;

function sourceOf({ id = "", description }: AnyBadge): [Source, boolean] {
    if (id.startsWith("vencord_donor_badge_")) return ["vencord", false];
    if (id === "vencord_contributor_badge") return ["vencord", true];
    if (id.startsWith("equicord_donor_badge_")) return ["equicord", description === "Equicord Translator"];
    if (id === "equicord_contributor_badge" || id === "user_plugin_contributor_badge") return ["equicord", true];
    if (id.startsWith("global_badges_badge_")) return ["otherMods", false];
    return ["plugins", false];
}

// Discord's own badges carry an icon hash, mod badges have iconSrc or a component instead.
const isDiscordBadge = (b: AnyBadge) =>
    b.iconSrc == null && b.component == null && (typeof b.icon === "string" || typeof b.simple_icon_url === "string");

let running = false;

function shouldKeep(badge: AnyBadge, userId?: string) {
    const { store } = settings;
    if (!running || badge == null) return true;
    if (store.keepOwn && userId != null && userId === UserStore.getCurrentUser()?.id) return true;

    if (isDiscordBadge(badge)) {
        const id = badge.id ?? "";
        return !(store.hideNitroBoost && (id.startsWith("premium") || id.startsWith("guild_booster")));
    }

    const [source, contributor] = sourceOf(badge);
    if (store.keepContributors && contributor) return true;
    return !store.hideAll && !store[SOURCE_SETTING[source]];
}

function keepBadge(badge: AnyBadge, userId?: string) {
    try {
        return shouldKeep(badge, userId);
    } catch (e) {
        logger.error("Couldn't check a badge", e);
        return true;
    }
}

function emptyDonorLists() {
    const api = badgeApi();
    for (const key of Object.values(DONOR_LISTS)) {
        for (const id of Object.keys(api[key])) delete api[key][id];
    }
}

// BadgeAPI only refetches every 30 minutes, so after unblocking put the lists back right away.
function refillDonorLists() {
    const api = badgeApi();
    for (const [url, key] of Object.entries(DONOR_LISTS)) {
        realFetch(url, { cache: "no-cache" })
            .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
            .then(data => Object.assign(api[key], data))
            .catch(e => logger.warn(`Couldn't reload ${url}`, e));
    }
}

const urlOf = (input: RequestInfo | URL) =>
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

let realFetch: typeof fetch = window.fetch;
let fetchWrapped = false;

function blockingFetch(input: RequestInfo | URL, init?: RequestInit) {
    if (running && settings.store.blockDonorLists && urlOf(input) in DONOR_LISTS) {
        return Promise.resolve(new Response("{}", { headers: { "Content-Type": "application/json" } }));
    }
    return realFetch(input, init);
}

let realGetBadges: BadgeApi["getBadges"] | null = null;

export default definePlugin({
    name: "BloatwareBadgeRemoval",
    description: "Hides client mod badges (Vencord and Equicord donor, custom and contributor badges, other mods' badges and plugin badges) so profiles only show Discord's own badges.",
    authors: [{ name: "nolifepops", id: 221807880053981184n }],
    tags: ["Appearance"],
    searchTerms: ["badges", "donor", "hide badges", "clean profile"],
    settings,
    // Init so the fetch block is ready before BadgeAPI downloads the donor lists on startup.
    startAt: StartAt.Init,

    patches: [
        // The profile record every badge row reads (popout, full profile, DM side panel). This also catches
        // badges added some other way, and Discord's Nitro and boost badges.
        {
            find: "getLegacyUsername(){",
            replacement: {
                match: /(getBadges\(\)\{return\[.{0,300}?)\]\}/,
                replace: "$1].filter(b=>$self.keepBadge(b,this.userId))}"
            }
        }
    ],

    keepBadge,

    start() {
        running = true;
        // If something wrapped fetch after us, stop() leaves ours in place, so don't wrap a second time.
        if (!fetchWrapped) {
            realFetch = window.fetch;
            window.fetch = blockingFetch;
            fetchWrapped = true;
        }
        if (settings.store.blockDonorLists) emptyDonorLists();

        // BadgeAPI's getBadges also feeds Discord's badge directory window.
        const api = badgeApi();
        if (realGetBadges) return;
        const original = api.getBadges;
        realGetBadges = original;
        api.getBadges = function (this: BadgeApi, profile: BadgeUserArgs) {
            return original.call(this, profile).filter(b => keepBadge(b, profile?.userId));
        };
    },

    stop() {
        running = false;
        if (window.fetch === blockingFetch) {
            window.fetch = realFetch;
            fetchWrapped = false;
        }
        if (realGetBadges) badgeApi().getBadges = realGetBadges;
        realGetBadges = null;
        if (settings.store.blockDonorLists) refillDonorLists();
    }
});
