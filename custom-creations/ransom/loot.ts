/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addGoldFound, addHoneyPot, isRunning, onGoldGrabbed } from "./challenge";
import { image } from "./images";
import { notify } from "./notify";
import { settings } from "./settings";
import { play } from "./sound";

// Gold lying around Discord, the way it lies around the rooms in DOORS: now and then a pile turns up, and after you
// pay Ransom off a Honey Pot drops that breaks open into a heap of gold. Nothing is covered or blocked; only the gold
// and the pot take clicks. This is your own gold, kept apart from the ransom, which always has to be found fresh.

const ANCHORS = '[class*="messageListItem"], [data-list-item-id]';
// Chance on each 30 second check that a pile turns up.
const CHANCE: Record<string, number> = { off: 0, sometimes: 0.14, often: 0.45 };
const MAX_PILES = 3;

interface Loot {
    el: HTMLButtonElement;
    anchor: HTMLElement;
    ox: number;
    oy: number;
    // Pixel nudge from the anchor point, for gold spilled out of a pot.
    dx: number;
    dy: number;
    size: number;
    value: number;
    pot?: boolean;
    spilled?: boolean;
    // Dropped from the toolbox: it stays even with loose gold turned off.
    byHand?: boolean;
}

const loot = new Set<Loot>();
let field: HTMLElement | undefined;
let checkTimer: ReturnType<typeof setInterval> | undefined;
let frame = 0;
let poll: ReturnType<typeof setInterval> | undefined;

const rand = (min: number, max: number) => min + Math.random() * (max - min);

function remove(item: Loot) {
    loot.delete(item);
    item.el.remove();
    if (!loot.size) stopFollowing();
}

const schedule = () => void (frame ||= requestAnimationFrame(follow));

// Piles stick to what they lie on. Instead of measuring every frame for as long as a pile is out, they're placed again
// when something scrolls or the window resizes, and a few times a second to catch everything else (new messages).
function startFollowing() {
    if (poll) return;
    poll = setInterval(schedule, 400);
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
}

function stopFollowing() {
    clearInterval(poll);
    poll = undefined;
    document.removeEventListener("scroll", schedule, true);
    window.removeEventListener("resize", schedule);
    cancelAnimationFrame(frame);
    frame = 0;
}

function anchors(exclude: Set<HTMLElement>) {
    return [...document.querySelectorAll<HTMLElement>(ANCHORS)].filter(el => {
        if (exclude.has(el) || el.closest(".vc-ransom-layer")) return false;
        const r = el.getBoundingClientRect();
        return r.width >= 32 && r.height >= 24 && r.top >= 60 && r.bottom <= innerHeight - 70 && r.left >= 0 && r.right <= innerWidth
            && el.checkVisibility({ visibilityProperty: true });
    });
}

const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];

function follow() {
    cancelAnimationFrame(frame);
    frame = 0;
    const hide = isRunning();
    for (const item of loot) {
        let r = item.anchor.getBoundingClientRect();
        if (!item.anchor.isConnected || r.width === 0 || r.bottom < 40 || r.top > innerHeight) {
            // The Honey Pot is a reward, so it moves to something still on screen instead of being lost.
            const next = item.pot ? pick(anchors(new Set())) : undefined;
            if (!next) {
                remove(item);
                continue;
            }
            item.anchor = next;
            r = next.getBoundingClientRect();
        }
        item.el.style.visibility = hide ? "hidden" : "";
        const x = Math.min(innerWidth - item.size, Math.max(0, r.left + r.width * item.ox + item.dx - item.size / 2));
        const y = Math.min(innerHeight - item.size, Math.max(0, r.top + r.height * item.oy + item.dy - item.size / 2));
        item.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }
}

function floatText(x: number, y: number, text: string, big = false) {
    const tag = document.createElement("div");
    tag.className = big ? "vc-ransom-loot-tag vc-ransom-loot-tag-big" : "vc-ransom-loot-tag";
    tag.textContent = text;
    tag.style.left = `${x}px`;
    tag.style.top = `${y}px`;
    field?.appendChild(tag);
    setTimeout(() => tag.remove(), 1000);
}

function take(item: Loot) {
    if (!loot.has(item) || isRunning()) return;
    const r = item.el.getBoundingClientRect();
    remove(item);
    play("coin", settings.store.soundVolume);
    floatText(r.left + r.width / 2, r.top, `+${item.value}`);
    addGoldFound(item.value);
    if (!item.spilled) onGoldGrabbed();
}

function place(item: Omit<Loot, "el">, className: string, src: string, title: string, onTake: (item: Loot) => void) {
    const el = document.createElement("button");
    el.className = className;
    el.title = title;
    el.style.setProperty("--tilt", `${rand(-25, 25)}deg`);
    el.style.width = el.style.height = `${item.size}px`;
    const img = document.createElement("img");
    img.src = src;
    img.alt = "";
    el.appendChild(img);
    const full: Loot = { ...item, el };
    el.addEventListener("mousedown", e => {
        e.preventDefault();
        e.stopPropagation();
        onTake(full);
    });
    el.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
    });
    loot.add(full);
    field!.appendChild(el);
    startFollowing();
    follow();
    return full;
}

function anchorPoint(anchor: HTMLElement) {
    const wide = anchor.getBoundingClientRect().width > 120;
    return { ox: wide ? rand(0.3, 0.92) : rand(0.55, 0.8), oy: rand(0.3, 0.7) };
}

const piles = () => [...loot].filter(l => !l.pot && !l.spilled).length;

/** Drops one gold pile on something visible in Discord. Returns false when there's nowhere to put it. */
function dropGold(byHand = false) {
    if (!field || isRunning() || piles() >= MAX_PILES) return false;
    const anchor = pick(anchors(new Set([...loot].map(l => l.anchor))));
    if (!anchor) return false;
    place({ anchor, ...anchorPoint(anchor), dx: 0, dy: 0, size: 26, value: 5 * Math.round(rand(2, 8)), byHand }, "vc-ransom-loot", image("coin"), "Gold", take);
    return true;
}

/** The toolbox's "Drop some gold": says why when no pile can be dropped. */
export function dropGoldByHand() {
    if (!field) return notify("Turn Ransom on first.", "critical");
    if (isRunning()) return notify("Not while Ransom is here.", "critical");
    if (piles() >= MAX_PILES) return notify(`There are already ${MAX_PILES} piles out.`, "critical");
    if (!dropGold(true)) notify("No spot for gold on this screen.", "critical");
}

/** Loose gold was turned off: the piles that turned up by themselves go right away. */
export function clearLooseGold() {
    for (const item of [...loot]) if (!item.pot && !item.spilled && !item.byHand) remove(item);
}

/** Shakes the pot, breaks it in two and spills its gold around where it stood. */
function breakPot(pot: Loot) {
    if (!loot.has(pot) || isRunning() || pot.el.classList.contains("vc-ransom-pot-breaking")) return;
    pot.el.classList.add("vc-ransom-pot-breaking");
    play("popupOut", settings.store.soundVolume);
    setTimeout(() => {
        if (!loot.has(pot)) return;
        const r = pot.el.getBoundingClientRect();
        remove(pot);
        for (const side of ["left", "right"]) {
            const half = document.createElement("img");
            half.className = `vc-ransom-pot-half vc-ransom-pot-${side}`;
            half.src = image("honeypot");
            Object.assign(half.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
            field?.appendChild(half);
            setTimeout(() => half.remove(), 700);
        }
        play("goldUp", settings.store.soundVolume);
        addHoneyPot();
        // A random amount, spilled as a ring of piles to pick up.
        const total = 5 * Math.round(rand(20, 100));
        const count = Math.max(4, Math.min(10, Math.round(total / 50)));
        floatText(r.left + r.width / 2, r.top, `${total} GOLD`, true);
        let left = total;
        for (let i = 0; i < count; i++) {
            // Leave at least 5 for each pile still to come, so the piles add up to exactly what was shown.
            const value = i === count - 1 ? left : Math.min(left - 5 * (count - 1 - i), Math.max(5, 5 * Math.round(total / count / 5 * rand(0.6, 1.4))));
            left -= value;
            if (value <= 0) break;
            const angle = (i / count) * Math.PI * 2 + rand(-0.3, 0.3);
            const dist = rand(34, 70);
            const pile = place({
                anchor: pot.anchor, ox: pot.ox, oy: pot.oy,
                dx: pot.dx + Math.cos(angle) * dist, dy: pot.dy + Math.sin(angle) * dist * 0.7,
                size: 26, value, spilled: true
            }, "vc-ransom-loot vc-ransom-loot-spill", image("coin"), "Gold", take);
            pile.el.style.animationDelay = `${i * 40}ms`;
            // Gold from a pot is claimed by itself, one coin after another.
            setTimeout(() => take(pile), 650 + i * 110);
        }
    }, 380);
}

/** The Honey Pot that drops after Ransom is paid off. Returns false when there's nowhere to put it. */
export function dropHoneyPot() {
    if (!field) return false;
    const anchor = pick(anchors(new Set()));
    if (!anchor) return false;
    place({ anchor, ...anchorPoint(anchor), dx: 0, dy: 0, size: 54, value: 0, pot: true }, "vc-ransom-pot", image("honeypot"), "Honey Pot: click to break it open", breakPot);
    play("popupIn", settings.store.soundVolume);
    return true;
}

function check() {
    const chance = CHANCE[settings.store.looseGold] ?? 0;
    if (!chance) return clearLooseGold();
    if (document.hidden || !document.hasFocus() || Math.random() > chance) return;
    dropGold();
}

export function startLoot() {
    stopLoot();
    field = document.createElement("div");
    field.className = "vc-ransom-loot-field";
    document.body.appendChild(field);
    checkTimer = setInterval(check, 30_000);
}

export function stopLoot() {
    clearInterval(checkTimer);
    checkTimer = undefined;
    stopFollowing();
    for (const item of [...loot]) remove(item);
    field?.remove();
    field = undefined;
}
