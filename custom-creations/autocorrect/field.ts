/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface Point { path: number[]; offset: number; }
export interface TextRange { anchor: Point; focus: Point; }

export interface WordAtCaret {
    word: string;
    range: TextRange;
    before: string;
    after: string;
    path: number[];
    start: number;
}

/** One text box Autocorrect can work in: Discord's chat editor or a plain text box like the custom status. */
export interface Field {
    readonly kind: "slate" | "plain";
    allowed(): boolean;
    composing(): boolean;
    focused(): boolean;
    focus(): void;
    hasCommand(): boolean;
    caret(): Point | null;
    wordAtCaret(): WordAtCaret | null;
    textBeforeCaret(): { line: string; all: string; } | null;
    /** Returns false when the box refused the change, e.g. it would go over the box's length limit. */
    replace(range: TextRange, text: string): boolean;
    undoEntry(after: string): boolean;
    rects(range: TextRange): DOMRect[];
    /** Extra events that should refresh the strip, beyond the document's own selection and focus events. */
    subscribe?(onChange: () => void): () => void;
}

const WORD_CHAR = /[\p{L}\p{M}'’]/u;
const QUOTES = /^['’]+|['’]+$/g;

/** The word around `offset` in one run of text, with leading and trailing apostrophes left out. */
export function wordIn(text: string, offset: number, path: number[]): WordAtCaret {
    let s = offset;
    while (s > 0 && WORD_CHAR.test(text[s - 1])) s--;
    let e = offset;
    while (e < text.length && WORD_CHAR.test(text[e])) e++;

    const raw = text.slice(s, e);
    const lead = raw.length - raw.replace(/^['’]+/, "").length;
    const word = raw.replace(QUOTES, "");
    const start = s + lead;
    const end = start + word.length;
    if (offset < start || offset > end) return { word: "", range: { anchor: { path, offset }, focus: { path, offset } }, before: text.slice(0, offset), after: text.slice(offset), path, start: offset };

    return {
        word,
        range: { anchor: { path, offset: start }, focus: { path, offset: end } },
        before: text.slice(0, start),
        after: text.slice(end),
        path,
        start,
    };
}

/** Smallest box around a set of client rects, or null if there are none. */
export function unionRect(rects: DOMRect[]): DOMRect | null {
    const real = rects.filter(r => r.width || r.height);
    const list = real.length ? real : rects;
    if (!list.length) return null;
    const left = Math.min(...list.map(r => r.left));
    const top = Math.min(...list.map(r => r.top));
    const right = Math.max(...list.map(r => r.right));
    const bottom = Math.max(...list.map(r => r.bottom));
    return new DOMRect(left, top, right - left, bottom - top);
}
