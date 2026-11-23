/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { createRoot } from "@webpack/common";
import type { Root } from "react-dom/client";

import type { Field } from "./field";
import { editors, floating, onKeyDown } from "./logic";
import { isPlainField, plainField } from "./plain";
import { cl } from "./settings";
import { type SlateEditor, slateField } from "./slate";
import { StripView } from "./strip";
import { logger } from "./words";

interface Mounted {
    el: HTMLElement;
    field: Field;
    host: HTMLDivElement;
    root: Root;
    timer: number;
    reposition(): void;
}

let mounted: Mounted | null = null;
let running = false;
let pending = 0;

/** Key events this file already handed to Autocorrect, so the editor's own patched handler doesn't run it a second time. */
export const seenKeys = new WeakSet<Event>();

/** Keeps the host lined up with the text box, so the strip's own CSS puts it just above the box. */
function place(el: HTMLElement, host: HTMLDivElement) {
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
        logger.error("Couldn't remove a floating suggestion strip", e);
    }
    m.host.remove();
}

function mount(el: HTMLElement, field: Field) {
    if (mounted?.el === el) return;
    unmount();
    floating.add(field);
    const doc = el.ownerDocument;
    const host = doc.createElement("div");
    host.className = cl("float");
    doc.body.appendChild(host);
    place(el, host);

    const root = createRoot(host);
    const Wrapped = ErrorBoundary.wrap(StripView, { noop: true });
    root.render(<Wrapped editor={field} autocompleteRef={undefined} onRender={() => place(el, host)} />);

    // dialogs can close without the box ever losing focus first, so check that the box is still there
    const timer = doc.defaultView!.setInterval(() => {
        if (!el.isConnected || doc.activeElement !== el) unmount();
        else place(el, host);
    }, 400);
    const reposition = () => place(el, host);
    doc.defaultView!.addEventListener("resize", reposition);
    doc.addEventListener("scroll", reposition, true);
    mounted = { el, field, host, root, timer, reposition };
}

const isSlateEditor = (v: unknown): v is SlateEditor =>
    !!v && typeof v === "object" && Array.isArray((v as SlateEditor).children) && "selection" in (v as object) && typeof (v as { insertText?: unknown; }).insertText === "function";

/** The Slate editor behind a rich text box, found through the props React gave the components around it. */
function slateEditorOf(el: Element): SlateEditor | null {
    const key = Object.keys(el).find(k => k.startsWith("__reactFiber$"));
    let fiber = key ? (el as unknown as Record<string, { return?: unknown; memoizedProps?: Record<string, unknown>; }>)[key] : null;
    for (let i = 0; fiber && i < 30; i++) {
        const editor = fiber.memoizedProps?.editor;
        if (isSlateEditor(editor)) return editor;
        fiber = fiber.return as typeof fiber;
    }
    return null;
}

/**
 * Rich text boxes like About Me, channel topics and forum guidelines use the same editor as the chat box but are drawn
 * somewhere the chat box strip isn't. Those get a floating strip; the chat box keeps its own.
 */
function mountRich(el: HTMLElement) {
    const editor = slateEditorOf(el);
    if (!editor) return;
    const field = slateField(editor);
    if (!field.allowed() || editors.has(field)) return;
    mount(el, field);
}

function watch(el: EventTarget | null) {
    if (!running) return;
    if (isPlainField(el)) {
        mount(el, plainField(el));
        return;
    }
    if (el instanceof HTMLElement && el.isContentEditable && el.dataset.slateEditor === "true" && el.getAttribute("role") === "textbox") {
        // wait a frame so a chat box strip that is still mounting can claim the editor first
        cancelAnimationFrame(pending);
        pending = requestAnimationFrame(() => {
            if (running && el.ownerDocument.activeElement === el) mountRich(el);
        });
    }
}

const onFocusIn = (e: FocusEvent) => watch(e.target);

// boxes with a floating strip don't send their keys through the patched chat box handler, so catch them here first
function onKey(e: KeyboardEvent) {
    if (!running || !mounted || !(e.target instanceof Node) || !mounted.el.contains(e.target)) return;
    seenKeys.add(e);
    // these boxes mostly sit in dialogs, where Esc would close the whole dialog; the first Esc only hides the suggestions
    const hiding = e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey && !!mounted.host.querySelector(`.${cl("strip")}`);
    if (onKeyDown(mounted.field, e) || hiding) {
        e.preventDefault();
        e.stopImmediatePropagation();
    }
}

/** Turns Autocorrect on for text boxes outside the chat box, like the custom status, notes and About Me. */
export function startPlainFields() {
    if (running) return;
    running = true;
    // capture on the window runs before Discord's own key handling on the box
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocusIn, true);
    watch(document.activeElement);
}

export function stopPlainFields() {
    running = false;
    cancelAnimationFrame(pending);
    window.removeEventListener("keydown", onKey, true);
    document.removeEventListener("focusin", onFocusIn, true);
    unmount();
}
