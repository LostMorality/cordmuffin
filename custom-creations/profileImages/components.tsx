/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { copyToClipboard } from "@utils/clipboard";
import type { Guild, User } from "@vencord/discord-types";
import { findCssClassesLazy } from "@webpack";
import { ContextMenuApi, GuildMemberStore, GuildStore, Menu, ReactDOM, Tooltip, useEffect, useLayoutEffect, useRef, UserProfileStore, useState, useStateFromStores } from "@webpack/common";
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

// Set once the full-profile row patch has rendered our square buttons. Until then the full profile keeps its Avatar pill,
// so a Discord update that breaks the row patch never leaves that profile without an avatar button.
let rowPatched = false;
const rowListeners = new Set<() => void>();

function markRowPatched() {
    if (rowPatched) return;
    rowPatched = true;
    rowListeners.forEach(fn => fn());
}

function useRowPatched() {
    const [patched, setPatched] = useState(rowPatched);
    useLayoutEffect(() => {
        // The row may have marked itself between our render and this effect, so catch up instead of waiting for a call.
        if (rowPatched) return void setPatched(true);
        const fn = () => setPatched(true);
        rowListeners.add(fn);
        return () => void rowListeners.delete(fn);
    }, []);
    return patched;
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

async function openInBrowser(url: string) {
    try {
        await VencordNative.native.openExternal(url);
    } catch {
        notify("Couldn't open the browser", "critical");
    }
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
    return images.map(img => {
        const id = `vc-pimg-${prefix}-${img.label.toLowerCase().replace(/\s+/g, "-")}`;
        return (
            <Menu.MenuItem key={id} id={id} label={`View ${img.label}`} action={() => openGallery(all, all.indexOf(img))}>
                <Menu.MenuItem id={`${id}-copy`} label="Copy Link" action={() => copy(img.original, "link")} />
                <Menu.MenuItem id={`${id}-open`} label="Open in Browser" action={() => openInBrowser(img.original)} />
            </Menu.MenuItem>
        );
    });
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
                        <Menu.MenuItem id="vc-pimg-copy-color" label={`Copy Colour ${images.color}`} action={() => copy(images.color!, "banner colour")} />
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
    useLayoutEffect(markRowPatched, []);
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
        // Skip buttons hidden behind this surface, like chat under a popout: the topmost thing there that isn't ours must be the button.
        const top = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2).find(x => !el.contains(x));
        if (!top || !b.contains(top)) continue;
        shift = Math.max(shift, corner === "left" ? r.right - me.left : me.right - r.left);
    }
    if (shift) el.style.setProperty("--vc-pimg-shift", `${Math.ceil(shift / scale) + 6}px`);
}

interface BannerProps extends Target {
    themeType?: string;
    // false while Discord still paints its loading grey instead of the real banner colour
    colorReady: boolean;
    // the profile editor's unsaved colour preview
    preview: boolean;
}

export const BannerOverlay = ErrorBoundary.wrap(({ themeType, colorReady, preview, ...target }: BannerProps) => {
    const s = settings.use(["avatarButton", "bannerButton", "profileRow", "pillsPopout", "pillsModal", "pillsSidebar", "pillCorner", "noBanner"]);
    // Sits in the banner fill, which holds the banner colour.
    const anchor = useRef<HTMLSpanElement>(null);
    const pills = useRef<HTMLDivElement>(null);
    const [host, setHost] = useState<HTMLElement | null>(null);
    const images = useImages(target);
    const rowShown = useRowPatched();

    const key = themeType ? SURFACE[themeType as keyof typeof SURFACE] : undefined;
    const isModal = key === "pillsModal";
    const avatar = !!key && s[key] && s.avatarButton && !(isModal && s.profileRow && rowShown);
    const banner = !!key && s[key] && s.bannerButton && showBanner(images);

    // The banner fill is masked (for the avatar cutout), which traps anything inside it under the profile effect layer.
    // Its parent is the same size and isn't masked, so the pills go there and can sit above the effect.
    useLayoutEffect(() => {
        setHost(anchor.current?.parentElement?.parentElement ?? null);
    }, []);

    useLayoutEffect(() => {
        if (!colorReady || preview) return;
        const bg = anchor.current?.parentElement?.style.backgroundColor;
        const hex = bg ? rgbToHex(bg) : null;
        if (hex) setBannerColor(target.user.id, target.guildId, target.displayProfile, hex);
    });

    useEffect(() => {
        const el = pills.current;
        if (!el) return;
        avoidOverlap(el, s.pillCorner);
        // Popouts animate in and load their buttons late, so check again once they settle.
        const t = setTimeout(() => avoidOverlap(el, s.pillCorner), 400);
        return () => clearTimeout(t);
    }, [s.pillCorner, avatar, banner, images.banners.length, images.color, host]);

    const content = (avatar || banner) && (
        <div ref={pills} className={`vc-pimg-pills vc-pimg-profile vc-pimg-${s.pillCorner}`} onMouseDown={e => e.stopPropagation()}>
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
                        : <><span className="vc-pimg-swatch vc-pimg-swatch-sm" style={{ backgroundColor: images.color! }} /><span className="vc-pimg-hex">{images.color}</span></>}
                </ImageButton>
            )}
        </div>
    );

    // The anchor is always rendered so the banner colour gets read for the square buttons.
    return (
        <>
            <span ref={anchor} hidden />
            {content && (host ? ReactDOM.createPortal(content, host) : content)}
        </>
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

// Keeps server-banner pills that were moved out of the banner lined up with it, and hides them once the banner
// starts fading as the channel list scrolls, so they never sit over the channels.
function trackBanner(el: HTMLElement, banner: HTMLElement, animated: HTMLElement, host: HTMLElement) {
    const place = () => {
        const b = banner.getBoundingClientRect();
        const h = host.getBoundingClientRect();
        const scale = host.offsetWidth ? h.width / host.offsetWidth : 1;
        el.style.top = `${(b.bottom - h.top) / scale - 10}px`;
        el.style.right = `${(h.right - b.right) / scale + 10}px`;
        const { opacity } = animated.style;
        el.classList.toggle("vc-pimg-faded", !b.height || (opacity !== "" && Number(opacity) < 1));
    };
    place();
    const mo = new MutationObserver(place);
    mo.observe(animated, { attributes: true, attributeFilter: ["style"] });
    const ro = new ResizeObserver(place);
    ro.observe(banner);
    ro.observe(host);
    return () => {
        mo.disconnect();
        ro.disconnect();
    };
}

export const GuildBannerPills = ErrorBoundary.wrap(({ guild }: { guild: Guild; }) => {
    const { guildHeader } = settings.use(["guildHeader", "format", "animatedFormat", "imgSize"]);
    // The banner component gets a trimmed guild, so read the full one for its icon.
    const full = useStateFromStores([GuildStore], () => GuildStore.getGuild(guild.id)) ?? guild;
    const anchor = useRef<HTMLSpanElement>(null);
    const pills = useRef<HTMLDivElement>(null);
    const [host, setHost] = useState<HTMLElement | null>(null);

    const { icon, banner } = collectGuildImages(full);
    const shown = guildHeader && !!(icon || banner);

    // The banner sits in a transformed layer under the channel list, which takes every click there, so the pills are
    // moved up into the header container where they sit above the list.
    useLayoutEffect(() => {
        setHost(anchor.current?.closest<HTMLElement>("[class*='animatedContainer_']")?.parentElement ?? null);
    }, []);

    useEffect(() => {
        const el = pills.current;
        const bannerEl = anchor.current?.parentElement;
        const animated = anchor.current?.closest<HTMLElement>("[class*='animatedContainer_']");
        if (!el || !host || !bannerEl || !animated) return;
        return trackBanner(el, bannerEl, animated, host);
    }, [host, shown]);

    const content = shown && (
        <div
            ref={pills}
            className={host ? "vc-pimg-pills vc-pimg-guild vc-pimg-lifted" : "vc-pimg-pills vc-pimg-guild"}
            onMouseDown={e => e.stopPropagation()}
            onKeyDown={e => e.stopPropagation()}
        >
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

    return (
        <>
            <span ref={anchor} hidden />
            {content && (host ? ReactDOM.createPortal(content, host) : content)}
        </>
    );
}, { noop: true });
