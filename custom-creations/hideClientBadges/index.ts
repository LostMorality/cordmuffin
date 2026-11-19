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
import { filters, mapMangledModuleLazy } from "@webpack";
import { UserStore } from "@webpack/common";

const logger = new Logger("HideClientBadges");

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

interface DirectoryBadge {
    badge_id: number | string;
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
        description: "Don't download the Vencord and Equicord donor badge lists at all (saves two downloads on every start and every 30 minutes). While on, Equicord's settings page can't tell that you're a donor either.",
        default: false,
        onChange: (on: boolean) => running && (on ? emptyDonorLists() : refillDonorLists())
    },
    hideNitroBoost: {
        type: OptionType.BOOLEAN,
        description: "Also hide Discord's own Nitro and server boost badges, in profiles and in other people's badge window.",
        default: false
    }
});

// The Vencord global doesn't exist yet at StartAt.Init, so go through the plugin manager.
const badgeApi = () => plugins.BadgeAPI as unknown as BadgeApi;

// Discord's own table that maps profile badge ids ("premium", "guild_booster_lvl3") to badge window ids.
const BadgeIds = mapMangledModuleLazy("guild_booster_lvl1:", {
    toDirectoryId: filters.byCode(".toUpperCase()]")
});

function sourceOf({ id = "", description }: AnyBadge): [Source, boolean] | null {
    if (id.startsWith("vencord_donor_badge_")) return ["vencord", false];
    if (id === "vencord_contributor_badge") return ["vencord", true];
    if (id.startsWith("equicord_donor_badge_")) return ["equicord", description === "Equicord Translator"];
    if (id === "equicord_contributor_badge" || id === "user_plugin_contributor_badge") return ["equicord", true];
    if (id.startsWith("global_badges_badge_")) return ["otherMods", false];
    return null;
}

// Mod badges always bring their own image (iconSrc) or a component. Discord's come with an icon hash or neither.
// A plugin badge with neither can only be told apart where it comes out of BadgeAPI, so that path passes fromBadgeApi.
const isModBadge = (b: AnyBadge) => b.iconSrc != null || b.component != null;

const isNitroBoostId = (id: string) => id.startsWith("premium") || id.startsWith("guild_booster");

let running = false;

const isOwn = (userId?: string | null) => userId != null && userId === UserStore.getCurrentUser()?.id;

function shouldKeep(badge: AnyBadge, userId?: string, fromBadgeApi = false) {
    const { store } = settings;
    if (!running || badge == null) return true;
    if (store.keepOwn && isOwn(userId)) return true;

    const known = sourceOf(badge);
    if (known == null && !fromBadgeApi && !isModBadge(badge)) {
        return !(store.hideNitroBoost && isNitroBoostId(badge.id ?? ""));
    }

    const [source, contributor]: [Source, boolean] = known ?? ["plugins", false];
    if (store.keepContributors && contributor) return true;
    return !store.hideAll && !store[SOURCE_SETTING[source]];
}

function keepBadge(badge: AnyBadge, userId?: string, fromBadgeApi = false) {
    try {
        return shouldKeep(badge, userId, fromBadgeApi);
    } catch (e) {
        logger.error("Couldn't check a badge", e);
        return true;
    }
}

// Everything BadgeAPI hands out is a mod or plugin badge, even one with no image of its own.
function filterProfileBadges(badges: AnyBadge[], userId?: string) {
    return Array.isArray(badges) ? badges.filter(b => keepBadge(b, userId, true)) : badges;
}

// Kept as strings, so a badge_id of 12 and "12" both match.
let nitroBoostDirectoryIds: Set<string> | null = null;

// Looked up once. If Discord's table moved, the badge window just stays unfiltered instead of logging every render.
function getNitroBoostDirectoryIds() {
    if (nitroBoostDirectoryIds) return nitroBoostDirectoryIds;
    try {
        const ids = ["premium", "guild_booster_lvl1"].map(id => BadgeIds.toDirectoryId(id)).filter(id => id != null);
        if (ids.length !== 2) throw new Error("Nitro or boost badge id not found");
        nitroBoostDirectoryIds = new Set(ids.map(String));
    } catch (e) {
        logger.error("Couldn't find Discord's badge ids, so the badge window won't hide Nitro and boost badges", e);
        nitroBoostDirectoryIds = new Set();
    }
    return nitroBoostDirectoryIds;
}

// The badge window reads Discord's badges from BadgeDirectoryStore, not from the profile record.
// Your own catalog is left alone: it's also where you customize your badges.
function filterDirectoryBadges<T extends DirectoryBadge>(badges: T[], userId?: string | null) {
    try {
        if (!running || !settings.store.hideNitroBoost || !Array.isArray(badges)) return badges;
        if (userId == null || isOwn(userId)) return badges;
        const hidden = getNitroBoostDirectoryIds();
        return badges.filter(b => b?.badge_id == null || !hidden.has(String(b.badge_id)));
    } catch (e) {
        logger.error("Couldn't filter the badge window", e);
        return badges;
    }
}

const donorListsBlocked = () => running && settings.store.blockDonorLists;

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
            .then(data => {
                // Blocking may have been turned back on while this was downloading.
                if (donorListsBlocked()) return;
                Object.assign(api[key], data);
            })
            .catch(e => logger.warn(`Couldn't reload ${url}`, e));
    }
}

const urlOf = (input: RequestInfo | URL) =>
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

// Ignores query strings and hashes, so a cache-busted URL is still caught.
function donorListOf(input: RequestInfo | URL) {
    try {
        const { origin, pathname } = new URL(urlOf(input), location.href);
        const key = origin + pathname;
        return key in DONOR_LISTS ? key : null;
    } catch {
        return null;
    }
}

let realFetch: typeof fetch = window.fetch;
let fetchWrapped = false;

// BadgeAPI downloads both lists one after the other and only then swaps them in. If blocking gets turned on
// while that's running, the answer is decided when the body is read, and the lists are emptied again right
// after the swap (it happens in the same chain of microtasks, so a 0 ms timeout runs after it).
async function fetchDonorList(input: RequestInfo | URL, init?: RequestInit) {
    const blockedAtStart = donorListsBlocked();
    const res = blockedAtStart
        ? new Response("{}", { headers: { "Content-Type": "application/json" } })
        : await realFetch(input, init);

    const readJson = res.json.bind(res);
    res.json = async () => {
        if (!donorListsBlocked()) {
            // Unblocked while the empty answer was on its way, so hand BadgeAPI the real list after all.
            const data = await (blockedAtStart ? realFetch(input, init).then(r => r.json()) : readJson());
            // Blocking can also be turned on while the body is still downloading.
            if (!donorListsBlocked()) return data;
        } else if (!blockedAtStart) {
            await readJson().catch(() => { });
        }
        setTimeout(() => donorListsBlocked() && emptyDonorLists(), 0);
        return {};
    };
    return res;
}

function blockingFetch(input: RequestInfo | URL, init?: RequestInit) {
    if (running && donorListOf(input) != null) return fetchDonorList(input, init);
    return realFetch(input, init);
}

let realGetBadges: BadgeApi["getBadges"] | null = null;
let getBadgesWrapper: BadgeApi["getBadges"] | null = null;

export default definePlugin({
    name: "HideClientBadges",
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
                match: /(getBadges\(\)\{.{0,100}?return\[.{0,400}?)\]\}/,
                replace: "$1].filter(b=>$self.keepBadge(b,this.userId))}"
            }
        },
        // Discord's badges in the badge window you get when you click a badge.
        {
            find: '"BadgeDirectoryStore"',
            replacement: {
                match: /getBadges\((\i)\)\{/,
                replace: "getBadges($1){return $self.filterDirectoryBadges(this.hcbGetBadges($1),$1)}hcbGetBadges($1){"
            }
        }
    ],

    keepBadge,
    filterDirectoryBadges,

    start() {
        running = true;
        // If something wrapped fetch after us, stop() leaves ours in place, so don't wrap a second time.
        if (!fetchWrapped) {
            realFetch = window.fetch;
            window.fetch = blockingFetch;
            fetchWrapped = true;
        }
        if (settings.store.blockDonorLists) emptyDonorLists();

        // BadgeAPI's getBadges also feeds the mod badges in the badge window. Same rule as fetch: if something
        // wrapped it after us, stop() leaves ours in place (it does nothing while stopped), so reuse it.
        if (getBadgesWrapper) return;
        const api = badgeApi();
        const original = api.getBadges;
        realGetBadges = original;
        getBadgesWrapper = function (this: BadgeApi, profile: BadgeUserArgs) {
            return filterProfileBadges(original.call(this, profile), profile?.userId);
        };
        api.getBadges = getBadgesWrapper;
    },

    stop() {
        running = false;
        if (window.fetch === blockingFetch) {
            window.fetch = realFetch;
            fetchWrapped = false;
        }
        const api = badgeApi();
        if (getBadgesWrapper && realGetBadges && api.getBadges === getBadgesWrapper) {
            api.getBadges = realGetBadges;
            getBadgesWrapper = null;
            realGetBadges = null;
        }
        if (settings.store.blockDonorLists) refillDonorLists();
    }
});
