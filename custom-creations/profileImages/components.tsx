/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { copyToClipboard } from "@utils/clipboard";
import type { Guild, User } from "@vencord/discord-types";
import { findCssClassesLazy } from "@webpack";
import { ContextMenuApi, GuildMemberStore, GuildStore, Menu, Tooltip, useEffect, useLayoutEffect, useRef, UserProfileStore, useState, useStateFromStores } from "@webpack/common";
import type { MouseEvent, ReactNode } from "react";

import { collectGuildImages, collectImages, openGallery, type ProfileImage, type ProfileImages, setBannerColor, subscribeBannerColors } from "./images";
import { notify } from "./notify";
import { settings } from "./settings";

const ButtonClasses = findCssClassesLazy("button", "sm", "secondary", "buttonChildrenWrapper");

// Discord's own button classes, so themes style these like the buttons next to them. Falls back to our CSS if they move
// (a missing module gives an empty object, not an error).
function rowButtonClass() {
    try {
        const { button, sm, secondary } = ButtonClasses;
        if (button && sm && secondary) return `vc-pimg-btn ${button} ${sm} ${secondary}`;
    } catch { }
    return "vc-pimg-btn vc-pimg-fallback";
}

interface Target {
    user: User;
    guildId?: string | null;
    displayProfile?: any;
}

function PersonIcon({ size = 16 }: { size?: number; }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" fillRule="evenodd" d="M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22Zm0-2a8.96 8.96 0 0 0 6.36-2.63C17.08 16.33 14.73 15 12 15s-5.08 1.33-6.36 3.37A8.96 8.96 0 0 0 12 21Zm0-8a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
        </svg>
    );
}

function PictureIcon({ size = 16 }: { size?: number; }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" fillRule="evenodd" d="M2 6a4 4 0 0 1 4-4h12a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V6Zm4-2a2 2 0 0 0-2 2v8.59l3.3-3.3a1 1 0 0 1 1.4 0L14 16.59l2.3-2.3a1 1 0 0 1 1.4 0L20 16.6V6a2 2 0 0 0-2-2H6Zm11 4.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z" />
        </svg>
    );
}

function ServerIcon({ size = 16 }: { size?: number; }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" fillRule="evenodd" d="M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22Zm0-2a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-4.5-5.5 3-4 2.25 3 1.5-2 2.25 3h-9Zm7-6a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
        </svg>
    );
}

function useImages({ user, guildId, displayProfile }: Target): ProfileImages {
    const gid = guildId ?? displayProfile?.guildId ?? null;
    // Re-render when the profile or member loads, the images come from these stores.
    useStateFromStores([UserProfileStore], () => [UserProfileStore.getUserProfile(user.id)?.banner, gid && UserProfileStore.getGuildMemberProfile(user.id, gid)?.banner].join());
    useStateFromStores([GuildMemberStore], () => gid ? GuildMemberStore.getMember(gid, user.id)?.avatar ?? "" : "");
    settings.use(["prefer", "format", "animatedFormat", "imgSize"]);
    const [, bump] = useState(0);
    useEffect(() => subscribeBannerColors(() => bump(n => n + 1)), []);
    return collectImages(user, guildId, displayProfile);
}

async function copy(text: string, what: string) {
    try {
        await copyToClipboard(text);
        notify(`Copied ${what}`, "success");
    } catch {
        notify(`Couldn't copy the ${what}`, "critical");
    }
}

function imageItems(prefix: string, images: ProfileImage[], all: ProfileImage[]) {
    return images.map(img => (
        <Menu.MenuItem
            key={`${prefix}-${img.label}`}
            id={`vc-pimg-${prefix}-${img.label.toLowerCase().replace(/\s+/g, "-")}`}
            label={`View ${img.label}`}
            action={() => openGallery(all, all.indexOf(img))}
        >
            <Menu.MenuItem id={`vc-pimg-${prefix}-${img.label}-copy`} label="Copy Link" action={() => copy(img.original, "link")} />
            <Menu.MenuItem id={`vc-pimg-${prefix}-${img.label}-open`} label="Open in Browser" action={() => VencordNative.native.openExternal(img.original)} />
        </Menu.MenuItem>
    ));
}

function openMenu(e: MouseEvent, kind: "avatar" | "banner", images: ProfileImages) {
    e.preventDefault();
    e.stopPropagation();
    ContextMenuApi.openContextMenu(e, () => (
        <Menu.Menu navId="vc-profile-images" onClose={ContextMenuApi.closeContextMenu} aria-label="Profile images">
            {kind === "avatar" ? (
                <Menu.MenuGroup>
                    {imageItems("avatar", images.avatars, images.avatars)}
                    {images.decoration && imageItems("deco", [images.decoration], [images.decoration])}
                </Menu.MenuGroup>
            ) : (
                <Menu.MenuGroup>
                    {imageItems("banner", images.banners, images.banners)}
                    {images.color && (
                        <Menu.MenuItem id="vc-pimg-copy-color" label={`Copy Banner Colour (${images.color})`} action={() => copy(images.color!, "banner colour")} />
                    )}
                </Menu.MenuGroup>
            )}
        </Menu.Menu>
    ));
}

function tooltipFor(kind: "avatar" | "banner", images: ProfileImages) {
    if (kind === "avatar") return images.avatars.length > 1 ? `View ${images.avatars[0].label.toLowerCase()} (arrows: ${images.avatars[1].label.toLowerCase()})` : "View avatar";
    if (!images.banners.length) return images.color ? `No banner. Colour ${images.color}, click to copy` : "No banner";
    return images.banners.length > 1 ? `View ${images.banners[0].label.toLowerCase()} (arrows: ${images.banners[1].label.toLowerCase()})` : "View banner";
}

function activate(e: MouseEvent, kind: "avatar" | "banner", images: ProfileImages) {
    e.stopPropagation();
    if (kind === "avatar") return openGallery(images.avatars);
    if (images.banners.length) return openGallery(images.banners);
    if (images.color) copy(images.color, "banner colour");
}

function showBanner(images: ProfileImages) {
    return images.banners.length > 0 || (settings.store.noBanner === "color" && images.color != null);
}

interface ImageButtonProps {
    kind: "avatar" | "banner";
    images: ProfileImages;
    className: string;
    children: ReactNode;
}

function ImageButton({ kind, images, className, children }: ImageButtonProps) {
    const label = tooltipFor(kind, images);
    return (
        <Tooltip text={label}>
            {(tooltipProps: any) => (
                <button
                    {...tooltipProps}
                    type="button"
                    aria-label={label}
                    className={className}
                    onClick={e => activate(e, kind, images)}
                    onContextMenu={e => openMenu(e, kind, images)}
                >
                    {children}
                </button>
            )}
        </Tooltip>
    );
}

export const ProfileButtons = ErrorBoundary.wrap((target: Target) => {
    const { avatarButton, bannerButton, profileRow } = settings.use(["avatarButton", "bannerButton", "profileRow", "noBanner"]);
    const images = useImages(target);
    if (!profileRow) return null;

    return (
        <>
            {avatarButton && (
                <ImageButton kind="avatar" images={images} className={rowButtonClass()}>
                    <PersonIcon />
                </ImageButton>
            )}
            {bannerButton && showBanner(images) && (
                <ImageButton kind="banner" images={images} className={rowButtonClass()}>
                    {images.banners.length ? <PictureIcon /> : <span className="vc-pimg-swatch" style={{ backgroundColor: images.color! }} />}
                </ImageButton>
            )}
        </>
    );
}, { noop: true });

const SURFACE = { POPOUT: "pillsPopout", MODAL: "pillsModal", MODAL_V2: "pillsModal", SIDEBAR: "pillsSidebar" } as const;

function rgbToHex(rgb: string) {
    const m = rgb.match(/\d+/g);
    if (!m || m.length < 3) return null;
    return "#" + m.slice(0, 3).map(n => Number(n).toString(16).padStart(2, "0")).join("");
}

// Discord puts its own buttons (like More) in some banner corners, so slide the pills over until nothing overlaps.
function avoidOverlap(el: HTMLElement, corner: string) {
    el.style.removeProperty("--vc-pimg-shift");
    const me = el.getBoundingClientRect();
    if (!me.width || !el.offsetWidth) return;
    const scale = me.width / el.offsetWidth;
    let shift = 0;
    for (const b of document.querySelectorAll<HTMLElement>("button, [role='button']")) {
        if (el.contains(b) || b.contains(el)) continue;
        const r = b.getBoundingClientRect();
        // Only small corner buttons, never clickable layers that cover the whole banner
        if (!r.width || r.width > me.height * 4 || r.height > me.height * 3 || r.bottom <= me.top || r.top >= me.bottom || r.right <= me.left || r.left >= me.right) continue;
        shift = Math.max(shift, corner === "left" ? r.right - me.left : me.right - r.left);
    }
    if (shift) el.style.setProperty("--vc-pimg-shift", `${Math.ceil(shift / scale) + 6}px`);
}

interface BannerProps extends Target {
    themeType?: string;
}

export const BannerOverlay = ErrorBoundary.wrap(({ themeType, ...target }: BannerProps) => {
    const s = settings.use(["avatarButton", "bannerButton", "profileRow", "pillsPopout", "pillsModal", "pillsSidebar", "pillCorner", "noBanner"]);
    const ref = useRef<HTMLElement>(null);
    const images = useImages(target);

    useLayoutEffect(() => {
        const bg = ref.current?.parentElement?.style.backgroundColor;
        const hex = bg ? rgbToHex(bg) : null;
        if (hex) setBannerColor(target.user.id, hex);
    });

    useEffect(() => {
        const el = ref.current;
        if (!el?.classList.contains("vc-pimg-pills")) return;
        avoidOverlap(el, s.pillCorner);
        // Popouts animate in and load their buttons late, so check again once they settle.
        const t = setTimeout(() => avoidOverlap(el, s.pillCorner), 400);
        return () => clearTimeout(t);
    });

    const key = themeType ? SURFACE[themeType as keyof typeof SURFACE] : undefined;
    const isModal = key === "pillsModal";
    const avatar = !!key && s[key] && s.avatarButton && !(isModal && s.profileRow);
    const banner = !!key && s[key] && s.bannerButton && showBanner(images);
    // Still rendered when empty so the banner colour gets read for the square buttons.
    if (!avatar && !banner) return <span ref={ref} hidden />;

    return (
        <div ref={ref as any} className={`vc-pimg-pills vc-pimg-${s.pillCorner}`} onMouseDown={e => e.stopPropagation()}>
            {avatar && (
                <ImageButton kind="avatar" images={images} className="vc-pimg-pill">
                    <PersonIcon size={12} />
                    <span>Avatar</span>
                </ImageButton>
            )}
            {banner && (
                <ImageButton kind="banner" images={images} className="vc-pimg-pill">
                    {images.banners.length
                        ? <><PictureIcon size={12} /><span>Banner</span></>
                        : <><span className="vc-pimg-swatch vc-pimg-swatch-sm" style={{ backgroundColor: images.color! }} /><span>{images.color}</span></>}
                </ImageButton>
            )}
        </div>
    );
}, { noop: true });

function GuildPill({ image, children }: { image: ProfileImage; children: ReactNode; }) {
    const label = `View ${image.label.toLowerCase()}`;
    return (
        <Tooltip text={label}>
            {(tooltipProps: any) => (
                <button
                    {...tooltipProps}
                    type="button"
                    aria-label={label}
                    className="vc-pimg-pill"
                    onClick={e => {
                        e.stopPropagation();
                        openGallery([image]);
                    }}
                    onContextMenu={e => {
                        e.preventDefault();
                        e.stopPropagation();
                        ContextMenuApi.openContextMenu(e, () => (
                            <Menu.Menu navId="vc-profile-images" onClose={ContextMenuApi.closeContextMenu} aria-label="Server images">
                                <Menu.MenuGroup>{imageItems("guild", [image], [image])}</Menu.MenuGroup>
                            </Menu.Menu>
                        ));
                    }}
                >
                    {children}
                </button>
            )}
        </Tooltip>
    );
}

export const GuildBannerPills = ErrorBoundary.wrap(({ guild }: { guild: Guild; }) => {
    const { guildHeader } = settings.use(["guildHeader", "format", "animatedFormat", "imgSize"]);
    // The banner component gets a trimmed guild, so read the full one for its icon.
    const full = useStateFromStores([GuildStore], () => GuildStore.getGuild(guild.id)) ?? guild;
    if (!guildHeader) return null;

    const { icon, banner } = collectGuildImages(full);
    if (!icon && !banner) return null;

    return (
        <div className="vc-pimg-pills vc-pimg-guild" onMouseDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
            {icon && (
                <GuildPill image={icon}>
                    <ServerIcon size={12} />
                    <span>Icon</span>
                </GuildPill>
            )}
            {banner && (
                <GuildPill image={banner}>
                    <PictureIcon size={12} />
                    <span>Banner</span>
                </GuildPill>
            )}
        </div>
    );
}, { noop: true });
