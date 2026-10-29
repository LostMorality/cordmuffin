/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { User } from "@vencord/discord-types";
import { GuildMemberStore, IconUtils, openMediaModal, UserProfileStore } from "@webpack/common";

import { settings } from "./settings";

export interface ProfileImage {
    label: string;
    url: string;
    original: string;
    width: number;
    height: number;
}

export interface ProfileImages {
    avatars: ProfileImage[];
    banners: ProfileImage[];
    decoration: ProfileImage | null;
    color: string | null;
}

// Banner colours as the banner itself paints them, so a colour picked from the avatar (no Nitro theme) is right too.
const bannerColors = new Map<string, string>();
const colorListeners = new Set<() => void>();

export function setBannerColor(userId: string, hex: string) {
    if (bannerColors.get(userId) === hex) return;
    bannerColors.set(userId, hex);
    colorListeners.forEach(fn => fn());
}

export function subscribeBannerColors(fn: () => void) {
    colorListeners.add(fn);
    return () => void colorListeners.delete(fn);
}

const isAnimated = (hash?: string | null) => !!hash?.startsWith("a_");

function sized(raw: string, animated: boolean, width: number, height: number, label: string): ProfileImage {
    const u = new URL(raw, location.href);
    if (u.pathname.includes("/embed/avatars/") || u.pathname.startsWith("/assets/"))
        return { label, url: u.toString(), original: u.toString(), width, height };

    const ext = animated ? settings.store.animatedFormat : settings.store.format;
    u.pathname = u.pathname.replace(/\.(png|jpe?g|webp|gif)$/i, `.${ext}`);
    if (animated && ext === "webp") u.searchParams.set("animated", "true");
    else u.searchParams.delete("animated");

    u.searchParams.set("size", settings.store.imgSize);
    const url = u.toString();
    u.searchParams.set("size", "4096");
    return { label, url, original: u.toString(), width, height };
}

const toHex = (n?: number | null) => n == null ? null : "#" + n.toString(16).padStart(6, "0");

export function collectImages(user: User, guildId: string | null | undefined, displayProfile?: any): ProfileImages {
    const serverFirst = settings.store.prefer === "server";
    const gid = guildId ?? displayProfile?.guildId ?? null;

    const avatars: ProfileImage[] = [];
    const memberAvatar = gid ? GuildMemberStore.getMember(gid, user.id)?.avatar : null;
    if (memberAvatar) {
        avatars.push(sized(IconUtils.getGuildMemberAvatarURLSimple({
            userId: user.id, guildId: gid, avatar: memberAvatar, canAnimate: true
        }), isAnimated(memberAvatar), 512, 512, "Server Avatar"));
    }
    avatars.push(sized(IconUtils.getUserAvatarURL(user, true), isAnimated(user.avatar), 512, 512, memberAvatar ? "Main Avatar" : "Avatar"));
    if (!serverFirst) avatars.reverse();

    const banners: ProfileImage[] = [];
    const memberBanner = gid
        ? UserProfileStore.getGuildMemberProfile(user.id, gid)?.banner ?? displayProfile?._guildMemberProfile?.banner
        : null;
    const mainBanner = UserProfileStore.getUserProfile(user.id)?.banner ?? displayProfile?._userProfile?.banner ?? (user as any).banner;
    if (memberBanner) {
        const url = IconUtils.getGuildMemberBannerURL({ id: user.id, guildId: gid, banner: memberBanner, canAnimate: true, size: 1024 });
        if (url) banners.push(sized(url, isAnimated(memberBanner), 1024, 410, "Server Banner"));
    }
    if (mainBanner) {
        const url = IconUtils.getUserBannerURL({ id: user.id, banner: mainBanner, canAnimate: true, size: 1024 });
        if (url) banners.push(sized(url, isAnimated(mainBanner), 1024, 410, banners.length ? "Main Banner" : "Banner"));
    }
    if (!serverFirst) banners.reverse();

    let decoration: ProfileImage | null = null;
    const deco = user.avatarDecorationData ?? (user as any).avatarDecoration;
    if (deco) {
        const url = IconUtils.getAvatarDecorationURL({ avatarDecoration: deco, size: 1024, canAnimate: true });
        if (url) decoration = { label: "Avatar Decoration", url, original: url, width: 512, height: 512 };
    }

    const color = bannerColors.get(user.id)
        ?? toHex(displayProfile?.primaryColor ?? displayProfile?.accentColor ?? UserProfileStore.getUserProfile(user.id)?.accentColor);

    return { avatars, banners, decoration, color };
}

export function openGallery(images: ProfileImage[], startingIndex = 0) {
    if (!images.length) return;
    openMediaModal({
        items: images.map(i => ({ type: "IMAGE", url: i.url, original: i.original, width: i.width, height: i.height, alt: i.label })),
        startingIndex
    });
}
