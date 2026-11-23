/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { createRoot } from "@webpack/common";
import type { Root } from "react-dom/client";

import { onKeyDown } from "./logic";
import { isPlainField, type PlainBox, plainField } from "./plain";
import { cl } from "./settings";
import { StripView } from "./strip";
import { logger } from "./words";

interface Mounted {
    el: PlainBox;
    host: HTMLDivElement;
    root: Root;
    timer: number;
    reposition(): void;
}

let mounted: Mounted | null = null;
let running = false;

/** Keeps the host lined up with the text box, so the strip's own CSS puts it just above the box. */
function place(el: PlainBox, host: HTMLDivElement) {
    const r = el.getBoundingClientRect();
    Object.assign(host.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
}

function unmount() {
    const m = mounted;
    if (!m) return;
    mounted = null;
    const win = m.el.ownerDocument.defaultView;
    win?.clearInterval(m.timer);
    win?.removeEventListener("resize", m.reposition);
    m.el.ownerDocument.removeEventListener("scroll", m.reposition, true);
    try {
        m.root.unmount();
    } catch (e) {
        logger.error("Couldn't remove the status box strip", e);
    }
    m.host.remove();
}

function mount(el: PlainBox) {
    if (mounted?.el === el) return;
    unmount();
    const doc = el.ownerDocument;
    const host = doc.createElement("div");
    host.className = cl("float");
    doc.body.appendChild(host);
    place(el, host);

    const root = createRoot(host);
    const Wrapped = ErrorBoundary.wrap(StripView, { noop: true });
    root.render(<Wrapped editor={plainField(el)} autocompleteRef={undefined} onRender={() => place(el, host)} />);

    // the status dialog can close without the box ever losing focus first, so check that the box is still there
    const timer = doc.defaultView!.setInterval(() => {
        if (!el.isConnected || doc.activeElement !== el) unmount();
        else place(el, host);
    }, 400);
    const reposition = () => place(el, host);
    doc.defaultView!.addEventListener("resize", reposition);
    doc.addEventListener("scroll", reposition, true);
    mounted = { el, host, root, timer, reposition };
}

function onFocusIn(e: FocusEvent) {
    if (running && isPlainField(e.target)) mount(e.target);
}

function onKey(e: KeyboardEvent) {
    if (!running || !isPlainField(e.target) || mounted?.el !== e.target) return;
    if (onKeyDown(plainField(e.target), e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
    }
}

/** Turns Autocorrect on for the plain text boxes listed in PLAIN_FIELDS, like the custom status box. */
export function startPlainFields() {
    if (running) return;
    running = true;
    // capture on the window runs before Discord's own key handling on the box
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocusIn, true);
    if (isPlainField(document.activeElement)) mount(document.activeElement);
}

export function stopPlainFields() {
    running = false;
    window.removeEventListener("keydown", onKey, true);
    document.removeEventListener("focusin", onFocusIn, true);
    unmount();
}
