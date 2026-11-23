/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Field, TextRange } from "./field";
import { wordIn } from "./field";

/** Plain text boxes Autocorrect works in, matched by Discord's own ids so it doesn't depend on the app language. */
export const PLAIN_FIELDS = "textarea#custom-status-input";

export type PlainBox = HTMLTextAreaElement | HTMLInputElement;

export const isPlainField = (el: EventTarget | null): el is PlainBox =>
    (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) && el.matches(PLAIN_FIELDS);

const PATH = [0];
const MIRRORED = [
    "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "borderStyle",
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant", "fontStretch", "fontFeatureSettings",
    "lineHeight", "letterSpacing", "wordSpacing", "textTransform", "textIndent", "tabSize", "direction",
] as const;

/** Screen rects of a stretch of a text box's value, measured on an invisible copy laid out the same way. */
function measure(el: PlainBox, start: number, end: number): DOMRect[] {
    const doc = el.ownerDocument;
    const style = doc.defaultView!.getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const mirror = doc.createElement("div");
    for (const prop of MIRRORED) mirror.style[prop] = style[prop];
    const multiLine = el instanceof HTMLTextAreaElement;
    Object.assign(mirror.style, {
        position: "fixed",
        left: `${box.left}px`,
        top: `${box.top}px`,
        height: "auto",
        visibility: "hidden",
        pointerEvents: "none",
        overflow: "hidden",
        whiteSpace: multiLine ? "pre-wrap" : "pre",
        overflowWrap: multiLine ? "break-word" : "normal",
        borderColor: "transparent",
    });
    // a scrollbar narrows the text area inside the box, so match the width the text really wraps at
    if (multiLine) {
        const width = style.boxSizing === "border-box"
            ? el.clientWidth + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)
            : el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        mirror.style.width = `${width}px`;
    }

    const value = el.value;
    const mark = doc.createElement("span");
    mark.textContent = value.slice(start, end) || "​";
    mirror.append(value.slice(0, start), mark, value.slice(end) || "​");
    doc.body.appendChild(mirror);
    try {
        const dx = -el.scrollLeft, dy = -el.scrollTop;
        return Array.from(mark.getClientRects()).map(r => new DOMRect(r.left + dx, r.top + dy, end > start ? r.width : 0, r.height));
    } finally {
        mirror.remove();
    }
}

const fields = new WeakMap<PlainBox, Field>();

/** A plain text box as a Field; the same box always gets the same Field. */
export function plainField(el: PlainBox): Field {
    let field = fields.get(el);
    if (field) return field;

    let composing = false;
    // our last edit, so undoing a fix can check the browser's undo would revert exactly that edit
    let last: { before: string; after: string; restoredEnd: number; } | null = null;
    el.addEventListener("compositionstart", () => composing = true);
    el.addEventListener("compositionend", () => composing = false);

    const caretOffset = () => {
        const s = el.selectionStart, e = el.selectionEnd;
        return s == null || s !== e ? null : s;
    };

    field = {
        kind: "plain",
        allowed: () => el.isConnected && !el.disabled && !el.readOnly,
        composing: () => composing,
        focused: () => el.ownerDocument.activeElement === el,
        focus: () => el.focus(),
        hasCommand: () => false,
        caret() {
            const offset = caretOffset();
            return offset == null ? null : { path: PATH, offset };
        },
        wordAtCaret() {
            const offset = caretOffset();
            return offset == null ? null : wordIn(el.value, offset, PATH);
        },
        textBeforeCaret() {
            const offset = caretOffset();
            if (offset == null) return null;
            const all = el.value.slice(0, offset);
            return { line: all.slice(all.lastIndexOf("\n") + 1), all };
        },
        replace(range: TextRange, text: string) {
            const value = el.value;
            const start = Math.min(range.anchor.offset, range.focus.offset);
            const end = Math.max(range.anchor.offset, range.focus.offset);
            if (end > value.length) return false;
            if (el.maxLength > 0 && value.length - (end - start) + text.length > el.maxLength) return false;

            el.focus();
            el.setSelectionRange(start, end);
            // typing through the browser keeps Discord's own state and the box's undo history in step
            const typed = el.ownerDocument.execCommand("insertText", false, text);
            if (typed && el.value === value.slice(0, start) + text + value.slice(end)) {
                last = { before: value, after: el.value, restoredEnd: end };
                return true;
            }

            last = null;
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
            if (!setter) return false;
            setter.call(el, value.slice(0, start) + text + value.slice(end));
            el.setSelectionRange(start + text.length, start + text.length);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
        },
        // undoes our own last edit through the browser's undo, so a later Ctrl+Z goes on to older edits instead of bringing it back
        undoEntry(after) {
            const edit = last;
            last = null;
            if (!edit || el.value !== edit.after) return false;
            const doc = el.ownerDocument;
            if (!doc.execCommand("undo")) return false;
            if (el.value !== edit.before) {
                doc.execCommand("redo");
                return false;
            }
            el.setSelectionRange(edit.restoredEnd, edit.restoredEnd);
            if (after) doc.execCommand("insertText", false, after);
            return true;
        },
        rects(range) {
            try {
                return measure(el, range.anchor.offset, range.focus.offset);
            } catch {
                return [];
            }
        },
        subscribe(onChange) {
            const events = ["input", "keyup", "mouseup", "select", "scroll"];
            for (const ev of events) el.addEventListener(ev, onChange);
            return () => { for (const ev of events) el.removeEventListener(ev, onChange); };
        },
    };
    fields.set(el, field);
    return field;
}
