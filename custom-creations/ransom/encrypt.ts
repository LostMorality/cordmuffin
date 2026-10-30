/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { settings } from "./settings";

// "Your Discord has been encrypted": while the ransom runs, every visible bit of Discord's text turns into flickering
// scrambled characters and the message box is locked. It's only drawn over the page; the real text is kept and put
// back the moment the ransom ends.

const GLYPHS = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#$%&@!?/\\<>[]{}=+*^~█▓▒░";
const SKIP = "script, style, svg, input, textarea, [contenteditable], .vc-ransom-layer, .vc-ransom-enc-bar, .vc-ransom-revive, .vc-ransom-loot-field, .vc-ransom-creature, .vc-ransom-topgold";
const BARS = 'form [class*="channelTextArea_"], #ransom-demo-backdrop .rdb-bar';

interface Entry { original: string; shown: string; }

const passedOver = new WeakMap<Element, number>();
const texts = new Map<Text, Entry>();
const marked = new Set<Element>();
const covers = new Map<Element, HTMLElement>();
let timer: ReturnType<typeof setInterval> | undefined;

function scramble(s: string, amount: number) {
    let out = "";
    for (const ch of s) out += /\s/.test(ch) || Math.random() > amount ? ch : GLYPHS[Math.random() * GLYPHS.length | 0];
    return out;
}

function visible(el: Element) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
        && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
}

function editable(target: EventTarget | null) {
    return target instanceof Element && !!target.closest("input, textarea, [contenteditable=''], [contenteditable='true']");
}

function block(e: Event) {
    if (e instanceof KeyboardEvent && e.key === "Escape") return;
    if (!editable(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
}

const BLOCKED = ["keydown", "keypress", "beforeinput", "paste", "drop"] as const;

function lockBars(calm: boolean) {
    for (const [bar, cover] of covers) if (!bar.isConnected) { cover.remove(); covers.delete(bar); }
    for (const bar of document.querySelectorAll(BARS)) {
        if (!visible(bar)) continue;
        let cover = covers.get(bar);
        if (!cover) {
            cover = document.createElement("div");
            cover.className = "vc-ransom-enc-bar";
            cover.innerHTML = '<span class="vc-ransom-enc-lock">🔒</span><span class="vc-ransom-enc-msg"></span>';
            document.body.appendChild(cover);
            covers.set(bar, cover);
        }
        const r = bar.getBoundingClientRect();
        Object.assign(cover.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        cover.lastElementChild!.textContent = scramble(`MESSAGE BOX ENCRYPTED BY ${by}`, calm ? 0.15 : 0.35);
    }
}

function pass() {
    const calm = settings.store.calmEffects;
    const amount = calm ? 0.45 : 0.7;
    // Every layout read first, then every write, so the page is laid out once per pass instead of once per text.
    const now = Date.now();
    const found: Text[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        if (texts.has(node) || !node.nodeValue?.trim()) continue;
        const parent = node.parentElement;
        if (!parent || (passedOver.get(parent) ?? 0) > now) continue;
        if (parent.closest(SKIP) || !visible(parent)) {
            // Hidden or off screen: don't measure it again for a few seconds.
            passedOver.set(parent, now + 3000);
            continue;
        }
        found.push(node);
    }
    for (const [node, entry] of texts) {
        if (!node.isConnected) { texts.delete(node); continue; }
        // Discord changed the text itself (an edit, a new name): keep that as the real text from now on.
        if (node.nodeValue !== entry.shown) entry.original = node.nodeValue ?? "";
        if (node.nodeValue !== entry.shown || Math.random() < (calm ? 0.1 : 0.35)) {
            entry.shown = scramble(entry.original, amount);
            node.nodeValue = entry.shown;
        }
    }
    for (const el of marked) if (!el.isConnected) marked.delete(el);
    for (const node of found) {
        const parent = node.parentElement!;
        const entry = { original: node.nodeValue ?? "", shown: scramble(node.nodeValue ?? "", amount) };
        node.nodeValue = entry.shown;
        texts.set(node, entry);
        parent.setAttribute("data-vc-ransom-enc", "");
        marked.add(parent);
    }
    lockBars(calm);
}

// Who the message box says did it: the EasterEgg's Ransom goes by Beggar.
let by = "RANSOM";

export function encryptUI(name = "RANSOM") {
    by = name;
    if (timer || !settings.store.encryptUI) return;
    (document.activeElement as HTMLElement | null)?.blur?.();
    for (const type of BLOCKED) document.addEventListener(type, block, true);
    pass();
    timer = setInterval(pass, settings.store.calmEffects ? 1200 : 450);
}

export function decryptUI() {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
    for (const type of BLOCKED) document.removeEventListener(type, block, true);
    for (const [node, entry] of texts) if (node.isConnected && node.nodeValue === entry.shown) node.nodeValue = entry.original;
    texts.clear();
    for (const el of marked) el.removeAttribute("data-vc-ransom-enc");
    marked.clear();
    for (const cover of covers.values()) cover.remove();
    covers.clear();
}
