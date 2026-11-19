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
// Windows (settings, the plugin's own options) stay readable, so the way out of a broken Discord can always be found.
const SKIP = "script, style, svg, input, textarea, [contenteditable], [role='dialog'], [aria-modal='true'], [class*='standardSidebarView_'], [class*='userSettingsContentPanel_'], .vc-ransom-layer, .vc-ransom-enc-bar, .vc-ransom-revive, .vc-ransom-loot-field, .vc-ransom-creature, .vc-ransom-topgold, .vc-ransom-item, .vc-ransom-hint";
const BARS = 'form [class*="channelTextArea_"], #ransom-demo-backdrop .rdb-bar';

interface Entry { original: string; shown: string; }

const passedOver = new WeakMap<Element, number>();
const texts = new Map<Text, Entry>();
const marked = new Set<Element>();
const covers = new Map<Element, HTMLElement>();
// Text that was hidden or off screen when it was found, by the element holding it. It's only measured again while
// that element is in view, instead of walking the whole page every pass.
const waiting = new Map<Element, Set<Text>>();
const inView = new Set<Element>();
// Parts of the page Discord added or rewrote since the last pass: the only places a pass looks for new text.
const pending = new Set<Node>();
let changes: MutationObserver | undefined;
let sight: IntersectionObserver | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

const insideSkip: NodeFilter = {
    acceptNode: n => n.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT
        : (n as Element).matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP
};

function noteChanges(records: MutationRecord[]) {
    for (const r of records) {
        if (r.type === "characterData") {
            // Text already scrambled is checked every pass anyway.
            if (r.target.nodeType === Node.TEXT_NODE && !texts.has(r.target as Text)) pending.add(r.target);
        } else {
            for (const n of r.addedNodes) if (n.nodeType === Node.ELEMENT_NODE || n.nodeType === Node.TEXT_NODE) pending.add(n);
            // Text React swaps out under a parent that never comes into view would otherwise pile up in `waiting`.
            const held = waiting.get(r.target as Element);
            if (held) {
                for (const n of r.removedNodes) if (n.nodeType === Node.TEXT_NODE) held.delete(n as Text);
                if (!held.size) release(r.target as Element);
            }
        }
    }
}

function release(parent: Element) {
    waiting.delete(parent);
    inView.delete(parent);
    sight?.unobserve(parent);
}

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

// Only the message boxes are locked; search fields and settings keep working.
function inMessageBox(target: EventTarget | null) {
    return target instanceof Element && !!target.closest(BARS) && !!target.closest("input, textarea, [contenteditable=''], [contenteditable='true']");
}

function block(e: Event) {
    if (e instanceof KeyboardEvent && e.key === "Escape") return;
    if (!inMessageBox(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
}

const BLOCKED = ["keydown", "keypress", "beforeinput", "paste", "drop"] as const;

function lockBars(calm: boolean) {
    for (const [bar, cover] of covers) if (!bar.isConnected) { cover.remove(); covers.delete(bar); }
    for (const bar of document.querySelectorAll(BARS)) {
        let cover = covers.get(bar);
        // A hidden box (settings open over the chat) mustn't leave its cover sitting over whatever is on screen now.
        if (!visible(bar)) {
            if (cover) cover.style.display = "none";
            continue;
        }
        if (!cover) {
            cover = document.createElement("div");
            cover.className = "vc-ransom-enc-bar";
            cover.innerHTML = '<span class="vc-ransom-enc-lock">🔒</span><span class="vc-ransom-enc-msg"></span>';
            document.body.appendChild(cover);
            covers.set(bar, cover);
        }
        const r = bar.getBoundingClientRect();
        Object.assign(cover.style, { display: "", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        cover.lastElementChild!.textContent = scramble(`MESSAGE BOX ENCRYPTED BY ${by}`, calm ? 0.15 : 0.35);
    }
}

function consider(node: Text, now: number, seen: Map<Element, boolean>, found: Set<Text>) {
    if (texts.has(node) || !node.nodeValue?.trim()) return;
    const parent = node.parentElement;
    if (!parent) return;
    const held = waiting.get(parent);
    if (held) { held.add(node); return; }
    let shown = seen.get(parent);
    if (shown === undefined) seen.set(parent, shown = visible(parent));
    if (shown) { found.add(node); return; }
    // Hidden or off screen: don't measure it again for a few seconds, and only once it's in view.
    passedOver.set(parent, now + 3000);
    waiting.set(parent, new Set([node]));
    sight?.observe(parent);
}

function collect(root: Node, now: number, seen: Map<Element, boolean>, found: Set<Text>) {
    if (!root.isConnected) return;
    if (root.nodeType === Node.TEXT_NODE) {
        if (!root.parentElement?.closest(SKIP)) consider(root as Text, now, seen, found);
        return;
    }
    if ((root as Element).closest(SKIP)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, insideSkip);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) consider(node as Text, now, seen, found);
}

function pass() {
    const calm = settings.store.calmEffects;
    const amount = calm ? 0.45 : 0.7;
    // Every layout read first, then every write, so the page is laid out once per pass instead of once per text.
    const now = Date.now();
    const seen = new Map<Element, boolean>();
    const found = new Set<Text>();
    if (changes) noteChanges(changes.takeRecords());
    const roots = [...pending];
    pending.clear();
    for (const root of roots) collect(root, now, seen, found);
    for (const parent of inView) {
        const held = waiting.get(parent);
        if (!held || !parent.isConnected) { release(parent); continue; }
        if ((passedOver.get(parent) ?? 0) > now) continue;
        if (!(seen.get(parent) ?? visible(parent))) { passedOver.set(parent, now + 3000); continue; }
        for (const node of held) if (node.parentElement === parent && !texts.has(node) && node.nodeValue?.trim()) found.add(node);
        release(parent);
    }
    for (const parent of waiting.keys()) if (!parent.isConnected) release(parent);
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
    // Everything recorded since the start of this pass is the pass's own scrambling.
    changes?.takeRecords();
}

// Who the message box says did it: the EasterEgg's Ransom goes by Beggar.
let by = "RANSOM";

/** `slow` is for the broken Discord after a loss, which can last for hours: it flickers less often to go easy on the PC. */
export function encryptUI(name = "RANSOM", slow = false) {
    by = name;
    const every = slow ? 2000 : settings.store.calmEffects ? 1200 : 450;
    // Already encrypted (a ransom just lost): only the pace changes.
    if (timer) {
        clearInterval(timer);
        timer = setInterval(pass, every);
        return;
    }
    if (!settings.store.encryptUI) return;
    if (inMessageBox(document.activeElement)) (document.activeElement as HTMLElement).blur();
    for (const type of BLOCKED) document.addEventListener(type, block, true);
    changes = new MutationObserver(noteChanges);
    changes.observe(document.body, { childList: true, subtree: true, characterData: true });
    sight = new IntersectionObserver(entries => {
        for (const e of entries) {
            if (e.isIntersecting && waiting.has(e.target)) inView.add(e.target);
            else inView.delete(e.target);
        }
    });
    pending.add(document.body);
    pass();
    timer = setInterval(pass, every);
}

export function decryptUI() {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
    for (const type of BLOCKED) document.removeEventListener(type, block, true);
    changes?.disconnect();
    changes = undefined;
    sight?.disconnect();
    sight = undefined;
    pending.clear();
    waiting.clear();
    inView.clear();
    for (const [node, entry] of texts) if (node.isConnected && node.nodeValue === entry.shown) node.nodeValue = entry.original;
    texts.clear();
    for (const el of marked) el.removeAttribute("data-vc-ransom-enc");
    marked.clear();
    for (const cover of covers.values()) cover.remove();
    covers.clear();
}
