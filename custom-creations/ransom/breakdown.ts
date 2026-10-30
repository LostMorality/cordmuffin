/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { settings } from "./settings";

// As the ransom timer runs down, Discord itself starts to come apart: bits twitch and split into colour, then tilt,
// flicker and tear, and in the last seconds messages, channels and members fall off the screen while the whole app
// shakes. It's only drawn: every piece is put back exactly as it was when the ransom ends.

const PIECES = '[class*="messageListItem"], [data-list-item-id], #ransom-demo-backdrop :is(.rdb-msg, .rdb-cont, .rdb-ch, .rdb-mem, .rdb-pill)';
const PANELS = 'nav[class*="guilds_"], [class*="sidebarList_"], section[class*="panels_"], [class*="chatContent_"], [class*="membersWrap_"], section[class*="title_"], #ransom-demo-backdrop :is(.rdb-rail, .rdb-side, .rdb-top, .rdb-chat, .rdb-members, .rdb-title)';
const SKIP = ".vc-ransom-layer, .vc-ransom-enc-bar, .vc-ransom-loot-field, .vc-ransom-revive, form, [contenteditable]";
const PROPS = ["translate", "rotate", "opacity", "transition"] as const;

type Saved = Record<typeof PROPS[number], string>;

const touched = new Map<HTMLElement, Saved>();
const flashes = new Set<HTMLElement>();
let level = 0;
// After a lost ransom Discord stays wrecked: still glitching, with some of it fallen, but it stops short of falling
// apart completely and doesn't shake, so it can be lived with until it's revived.
let wrecked = false;
let timer: ReturnType<typeof setInterval> | undefined;

const rand = (min: number, max: number) => min + Math.random() * (max - min);

function visible(selector: string) {
    return [...document.querySelectorAll<HTMLElement>(selector)].filter(el => {
        if (el.closest(SKIP) || el.querySelector(".vc-ransom-layer")) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && el.checkVisibility({ visibilityProperty: true });
    });
}

const some = <T,>(list: T[], n: number) => list.sort(() => Math.random() - 0.5).slice(0, n);

function save(el: HTMLElement) {
    if (!touched.has(el)) touched.set(el, Object.fromEntries(PROPS.map(p => [p, el.style[p]])) as Saved);
}

/** Adds a class for a moment. */
function flash(el: HTMLElement, className: string, ms: number) {
    el.classList.add(className);
    flashes.add(el);
    setTimeout(() => el.classList.remove(className), ms);
}

function tick() {
    // A wreck can last for hours: let go of pieces Discord has already thrown away (old channels, closed popouts).
    for (const el of flashes) if (!el.isConnected) flashes.delete(el);
    for (const el of touched.keys()) if (!el.isConnected) touched.delete(el);
    const calm = settings.store.calmEffects;
    const pieces = visible(PIECES);
    const panels = visible(PANELS);

    for (const el of some(pieces, level >= 2 ? 4 : 2)) flash(el, "vc-ransom-twitch", 420);
    if (calm) return;
    for (const el of some(panels, 1)) flash(el, "vc-ransom-rgb", 260);

    if (level >= 2) {
        for (const el of some(pieces, 2)) {
            save(el);
            el.style.rotate = `${rand(-5, 5).toFixed(1)}deg`;
            el.style.translate = `${rand(-6, 6) | 0}px ${rand(-3, 6) | 0}px`;
        }
        for (const el of some(pieces, 1)) flash(el, "vc-ransom-blink", 160);
        if (Math.random() < 0.6) for (const el of some(panels, 1)) flash(el, "vc-ransom-tear", 300);
    }

    if (level >= 3) {
        const standing = pieces.filter(el => !el.dataset.vcRansomFell);
        const room = wrecked ? Math.max(0, Math.floor(pieces.length * 0.35) - (pieces.length - standing.length)) : 2;
        for (const el of some(standing, Math.min(2, room))) {
            save(el);
            el.dataset.vcRansomFell = "";
            el.style.transition = `translate ${rand(0.7, 1.3).toFixed(2)}s cubic-bezier(0.5, 0, 1, 0.6), rotate 1.1s ease-in, opacity 1.2s ease-in`;
            el.style.rotate = `${rand(-45, 45) | 0}deg`;
            el.style.translate = `${rand(-40, 40) | 0}px ${rand(120, 420) | 0}px`;
            el.style.opacity = "0.15";
        }
        for (const el of some(panels, wrecked ? 0 : 1)) {
            save(el);
            el.style.translate = `${rand(-14, 14) | 0}px ${rand(-6, 6) | 0}px`;
            el.style.rotate = `${rand(-1.5, 1.5).toFixed(2)}deg`;
        }
    }
}

/** Sets how broken Discord looks: 0 = untouched, 1 = twitching, 2 = tearing, 3 = falling apart. */
export function breakUI(next: number) {
    if (!settings.store.breakUI || next <= level) return;
    level = next;
    document.documentElement.classList.toggle("vc-ransom-quake", level >= 3 && !settings.store.calmEffects);
    if (!timer) timer = setInterval(tick, 650);
    tick();
}

/** Leaves Discord broken after a lost ransom, until it's revived or Ransom finishes the job. */
export function wreckUI() {
    if (!settings.store.breakUI) return;
    wrecked = true;
    level = 3;
    document.documentElement.classList.remove("vc-ransom-quake");
    clearInterval(timer);
    timer = setInterval(tick, 900);
    tick();
}

export function repairUI() {
    clearInterval(timer);
    timer = undefined;
    level = 0;
    wrecked = false;
    document.documentElement.classList.remove("vc-ransom-quake");
    for (const el of flashes) el.classList.remove("vc-ransom-twitch", "vc-ransom-rgb", "vc-ransom-blink", "vc-ransom-tear");
    flashes.clear();
    for (const [el, saved] of touched) {
        for (const p of PROPS) el.style[p] = saved[p];
        delete el.dataset.vcRansomFell;
    }
    touched.clear();
}
