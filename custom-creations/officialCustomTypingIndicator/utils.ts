/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Channel } from "@vencord/discord-types";
import { findByCodeLazy, findByPropsLazy } from "@webpack";
import { AuthenticationStore, EmojiStore, FluxDispatcher, GuildMemberStore, GuildRoleStore, PermissionsBits, RelationshipStore, RestAPI, TypingStore, UserStore } from "@webpack/common";

// Same order as Discord's TypingIndicatorAnimation / TypingSuggestion enums (discord_protos.users.v1).
export const ANIMATIONS = ["None", "Pulse", "Ring", "Wave"] as const;
export const WORDS = ["typing", "yapping", "venting", "oversharing", "barking", "babbling", "daydreaming", "meowing", "purring", "chirping", "keysmashing", "thinking", "squeaking"] as const;

export interface StyleEmoji {
    id?: string;
    name: string;
    animated?: boolean;
}

// Client-side shape, the same one Discord keeps on the user object and in TypingStore.
export interface TypingStyle {
    emojis: StyleEmoji[];
    animation: number;
    typingSuggestion: number;
}

const EmojiUtils = findByPropsLazy("getEmojiColors", "getURL");
const EmojiNames = findByPropsLazy("convertSurrogateToName");

export function verbFor(suggestion: number) {
    return `is ${WORDS[suggestion] ?? WORDS[0]}…`;
}

// The 7 words Discord's FAQ lists. The other 5 exist in Discord's code but aren't announced yet.
export const ANNOUNCED_WORDS = [1, 2, 3, 4, 5, 6, 7];

// A single typed emoji like 👍🏽 that Discord knows, or null.
export function typedEmoji(query: string): string | null {
    const q = query.trim();
    if (!q) return null;
    const parts = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(q)];
    if (parts.length !== 1) return null;
    try {
        return /^:[^:]+:$/.test(EmojiNames.convertSurrogateToName(q)) ? q : null;
    } catch {
        return null;
    }
}

export function emojiUrl(emoji: StyleEmoji, animate = true): string | null {
    if (emoji.id) return `${location.protocol}//${window.GLOBAL_ENV.CDN_HOST}/emojis/${emoji.id}.webp?size=48&animated=${emoji.animated && animate ? "true" : "false"}`;
    try {
        return EmojiUtils.getURL(emoji.name) || null;
    } catch {
        return null;
    }
}

export function sameEmoji(a?: StyleEmoji, b?: StyleEmoji) {
    if (!a || !b) return a === b;
    return a.id ? a.id === b.id : !b.id && a.name === b.name;
}

export function sameStyle(a: TypingStyle | null | undefined, b: TypingStyle | null | undefined) {
    if (!a || !b) return !a === !b;
    return a.animation === b.animation
        && a.typingSuggestion === b.typingSuggestion
        && a.emojis.length === b.emojis.length
        && a.emojis.every((e, i) => sameEmoji(e, b.emojis[i]));
}

export function normalize(raw: unknown): TypingStyle | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Partial<TypingStyle>;
    const emojis = Array.isArray(r.emojis) ? r.emojis.filter(e => e && (e.id || e.name)) : [];
    const animation = Number.isInteger(r.animation) && r.animation! >= 0 && r.animation! < ANIMATIONS.length ? r.animation! : 0;
    const typingSuggestion = Number.isInteger(r.typingSuggestion) && r.typingSuggestion! >= 0 && r.typingSuggestion! < WORDS.length ? r.typingSuggestion! : 0;
    if (!emojis.length && !animation && !typingSuggestion) return null;
    return { emojis, animation, typingSuggestion };
}

export function getSavedStyle(): TypingStyle | null {
    return normalize((UserStore.getCurrentUser() as any)?.typingIndicatorStyle);
}

interface ServerStyle {
    emojis?: { custom_emoji_id?: string; unicode_emoji?: string; animated?: boolean; }[];
    animation?: number;
    typing_suggestion?: number;
}

function toServer(style: TypingStyle): ServerStyle {
    return {
        emojis: style.emojis.map(e => e.id ? { custom_emoji_id: e.id, animated: !!e.animated } : { unicode_emoji: e.name }),
        animation: style.animation,
        typing_suggestion: style.typingSuggestion
    };
}

function fromServer(s: ServerStyle | null | undefined): TypingStyle | null {
    if (!s) return null;
    return normalize({
        emojis: (s.emojis ?? []).map(e => e.custom_emoji_id ? { id: e.custom_emoji_id, name: "", animated: !!e.animated } : { name: e.unicode_emoji ?? "" }),
        animation: s.animation ?? 0,
        typingSuggestion: s.typing_suggestion ?? 0
    });
}

// The server silently drops this field unless the request says it comes from a mobile app version that has the feature.
// Only this one request gets the Android client info; everything else keeps the real header.
const MOBILE_VERSION = "353.11";
const MOBILE_BUILD = 353011;
let deviceId: string | undefined;

function mobileSuperProperties() {
    deviceId ??= crypto.randomUUID();
    const props = {
        os: "Android", browser: "Discord Android", device: "panther", system_locale: navigator.language || "en-US", has_client_mods: false,
        client_version: `${MOBILE_VERSION} - rn`, release_channel: "googleRelease", device_vendor_id: deviceId, design_id: 2,
        browser_user_agent: "", browser_version: "", os_version: "34", os_sdk_version: "34", client_build_number: MOBILE_BUILD,
        client_event_source: null, client_launch_id: crypto.randomUUID(), client_heartbeat_session_id: crypto.randomUUID()
    };
    return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(props))));
}

const TAG = Symbol("vc-cti-mobile");
type TaggedXHR = XMLHttpRequest & { [TAG]?: boolean; };

let mobileHeader: string | null = null;
let saving: Promise<unknown> | null = null;

// The wrappers only act while a save is running. If another script wraps XHR after us, we can't unwrap
// without breaking it, so the wrappers stay behind as pass-throughs instead.
async function patchAsMobile(body: object) {
    const proto = XMLHttpRequest.prototype;
    const { open, setRequestHeader } = proto;
    const ourOpen = function (this: TaggedXHR, method: string, url: string | URL, ...rest: unknown[]) {
        this[TAG] = mobileHeader != null && method.toUpperCase() === "PATCH" && /\/users\/@me(\?|$)/.test(String(url));
        return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
    };
    const ourSetHeader = function (this: TaggedXHR, name: string, value: string) {
        return setRequestHeader.call(this, name, this[TAG] && mobileHeader && name.toLowerCase() === "x-super-properties" ? mobileHeader : value);
    };
    mobileHeader = mobileSuperProperties();
    proto.open = ourOpen;
    proto.setRequestHeader = ourSetHeader;
    try {
        return await RestAPI.patch({ url: "/users/@me", body });
    } finally {
        mobileHeader = null;
        if (proto.open === ourOpen) proto.open = open;
        if (proto.setRequestHeader === ourSetHeader) proto.setRequestHeader = setRequestHeader;
    }
}

export const isSaving = () => saving != null;

// Returns false when Discord answered but kept the old style (no Nitro, not in the rollout, or the app version is too old).
// The PATCH reply isn't always the final word (a captcha retry can replace it), so read the account back to be sure.
export async function saveStyle(style: TypingStyle | null): Promise<boolean> {
    if (saving) throw new Error("A save is already running. Wait for it to finish.");
    const run = (async () => {
        const res = await patchAsMobile({ typing_indicator_style: style ? toServer(style) : null });
        if (sameStyle(fromServer(res.body?.typing_indicator_style), style)) {
            if (res.body?.id) FluxDispatcher.dispatch({ type: "CURRENT_USER_UPDATE", user: res.body });
            return true;
        }
        const me = await RestAPI.get({ url: "/users/@me" }).then(r => r.body, () => null);
        if (!me?.id) throw new Error("Couldn't check with Discord whether it worked. Reopen settings to see your current style.");
        FluxDispatcher.dispatch({ type: "CURRENT_USER_UPDATE", user: me });
        return sameStyle(fromServer(me.typing_indicator_style), style);
    })();
    saving = run;
    try {
        return await run;
    } finally {
        saving = null;
    }
}

function firstFieldError(errors: unknown): string | null {
    if (!errors || typeof errors !== "object") return null;
    const own = (errors as { _errors?: { message?: string; }[]; })._errors?.[0]?.message;
    if (own) return own;
    for (const [key, value] of Object.entries(errors)) {
        if (key === "_errors") continue;
        const found = firstFieldError(value);
        if (found) return found;
    }
    return null;
}

export function errorText(e: any): string {
    const body = e?.body;
    if (body?.captcha_key) return "Discord asked for a captcha and it wasn't finished. Try again and solve it.";
    return firstFieldError(body?.errors) || body?.message || e?.message || "Discord refused the change.";
}

// The typing bar only gets names, so find the one person typing the same way Discord's hook does.
export function soleTyperId(channelId: string): string | null {
    const me = AuthenticationStore.getId();
    const ids = Object.keys(TypingStore.getTypingUsers(channelId) ?? {})
        .filter(id => id !== me && !RelationshipStore.isBlockedOrIgnored(id));
    return ids.length === 1 ? ids[0] : null;
}

export function getUserStyle(userId: string): TypingStyle | null {
    return normalize((TypingStore as any).getCustomTypingIndicatorConfig?.(userId));
}

// Discord's own helper; PermissionStore only answers for the current user.
const computePermissions: (o: { user: string; context: Channel; overwrites: Channel["permissionOverwrites"]; }) => bigint
    = findByCodeLazy(".getCurrentUser()", ".computeLurkerPermissionsAllowList()");

// FAQ: in a server with Use External Emoji turned off, others see the plain dots instead of outside emoji.
// Uses the typer's real channel permissions when their member is cached, else the @everyone role.
export function emojisAllowed(style: TypingStyle, channel: Channel, userId: string) {
    const guildId = channel.guild_id;
    if (!guildId) return true;
    const external = style.emojis.some(e => e.id && EmojiStore.getCustomEmojiById(e.id)?.guildId !== guildId);
    if (!external) return true;
    try {
        if (GuildMemberStore.getMember(guildId, userId)) {
            const perms = computePermissions({ user: userId, context: channel, overwrites: channel.permissionOverwrites });
            return (perms & PermissionsBits.USE_EXTERNAL_EMOJIS) !== 0n;
        }
        const everyone = GuildRoleStore.getRole(guildId, guildId);
        return !everyone || (BigInt(everyone.permissions as any) & PermissionsBits.USE_EXTERNAL_EMOJIS) !== 0n;
    } catch {
        return true;
    }
}
