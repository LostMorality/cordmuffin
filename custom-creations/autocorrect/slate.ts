/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByPropsLazy } from "@webpack";

export interface Point { path: number[]; offset: number; }
export interface SlateRange { anchor: Point; focus: Point; }
interface SlateText { text: string; }
interface SlateElement { type?: string; children?: SlateNode[]; }
type SlateNode = SlateText | SlateElement;

export interface SlateEditor {
    children: SlateNode[];
    selection: SlateRange | null;
    chatInputType?: { analyticsName?: string; };
}

const Transforms: {
    insertText(editor: SlateEditor, text: string, options?: { at?: SlateRange; }): void;
} = findByPropsLazy("insertNodes", "textToText");

const Editor: {
    isComposing(editor: SlateEditor): boolean;
    isFocused(editor: SlateEditor): boolean;
    focus(editor: SlateEditor): void;
} = findByPropsLazy("start", "end", "toSlateRange");

const History: {
    withSingleEntry(editor: SlateEditor, fn: () => void): void;
    withoutSaving?(editor: SlateEditor, fn: () => void): void;
} = findByPropsLazy("withSingleEntry", "withMergedEntry");

const WORD_CHAR = /[\p{L}\p{M}'’]/u;
const INLINE = "\uFFFC";
const QUOTES = /^['’]+|['’]+$/g;

export interface WordAtCaret {
    word: string;
    range: SlateRange;
    before: string;
    after: string;
    path: number[];
    start: number;
}

const isText = (node: SlateNode | undefined): node is SlateText => typeof (node as SlateText)?.text === "string";

function nodeAt(editor: SlateEditor, path: number[]): SlateNode | undefined {
    let node: SlateNode | undefined = { children: editor.children };
    for (const i of path) node = (node as SlateElement | undefined)?.children?.[i];
    return node;
}

export function isComposing(editor: SlateEditor) {
    return Editor.isComposing(editor);
}

export function isFocused(editor: SlateEditor) {
    return Editor.isFocused(editor);
}

export function hasCommand(editor: SlateEditor) {
    const first = editor.children[0] as SlateElement | undefined;
    return first?.type === "applicationCommand" || !!first?.children?.some(c => (c as SlateElement).type === "applicationCommand");
}

/** Plain text of the line the caret is on, up to the caret, and everything before that line. */
export function textBeforeCaret(editor: SlateEditor): { line: string; all: string; } | null {
    const sel = editor.selection;
    if (!sel) return null;
    const [blockIndex, leaf] = sel.anchor.path;
    const text = (n: SlateNode): string => isText(n) ? n.text : n.type && n.type !== "line" ? INLINE : (n.children ?? []).map(text).join("");
    // top level blocks (lines, quotes) keep their text; only inline elements like mentions and emoji collapse
    const block = (n: SlateNode): string => isText(n) ? n.text : (n.children ?? []).map(text).join("");

    let line = "";
    const lineNode = editor.children[blockIndex] as SlateElement | undefined;
    lineNode?.children?.forEach((child, i) => {
        if (i < leaf) line += text(child);
        else if (i === leaf && isText(child)) line += child.text.slice(0, sel.anchor.offset);
    });

    const earlier = editor.children.slice(0, blockIndex).map(block).join("\n");
    return { line, all: earlier ? `${earlier}\n${line}` : line };
}

export function wordAtCaret(editor: SlateEditor): WordAtCaret | null {
    const sel = editor.selection;
    if (!sel || sel.anchor.offset !== sel.focus.offset || sel.anchor.path.join() !== sel.focus.path.join()) return null;

    const { path, offset } = sel.anchor;
    const leaf = nodeAt(editor, path);
    if (!isText(leaf)) return null;

    const { text } = leaf;
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

export function replaceRange(editor: SlateEditor, range: SlateRange, text: string) {
    History.withSingleEntry(editor, () => Transforms.insertText(editor, text, { at: range }));
}

/**
 * Undoes the editor's last history entry, then inserts `after` at the caret without recording it,
 * so the next undo goes on to the edit before. Returns false when the editor has no history to use.
 */
export function undoEntry(editor: SlateEditor, after: string) {
    const ed = editor as SlateEditor & { undo?(): void; };
    if (typeof ed.undo !== "function" || typeof History.withoutSaving !== "function") return false;
    ed.undo();
    if (after) History.withoutSaving(editor, () => Transforms.insertText(editor, after));
    return true;
}

export function focusEditor(editor: SlateEditor) {
    try {
        Editor.focus(editor);
    } catch { }
}

export function caretPoint(editor: SlateEditor): Point | null {
    const sel = editor.selection;
    if (!sel || sel.anchor.offset !== sel.focus.offset || sel.anchor.path.join() !== sel.focus.path.join()) return null;
    return sel.anchor;
}
