/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByPropsLazy } from "@webpack";

import type { Field, Point, TextRange } from "./field";
import { wordIn } from "./field";
import { settings } from "./settings";

interface SlateText { text: string; }
interface SlateElement { type?: string; children?: SlateNode[]; }
type SlateNode = SlateText | SlateElement;

export interface SlateEditor {
    children: SlateNode[];
    selection: TextRange | null;
    chatInputType?: { analyticsName?: string; };
}

const Transforms: {
    insertText(editor: SlateEditor, text: string, options?: { at?: TextRange; }): void;
} = findByPropsLazy("insertNodes", "textToText");

const Editor: {
    isComposing(editor: SlateEditor): boolean;
    isFocused(editor: SlateEditor): boolean;
    focus(editor: SlateEditor): void;
    toDOMRange(editor: SlateEditor, range: TextRange): Range;
} = findByPropsLazy("start", "end", "toSlateRange");

const History: {
    withSingleEntry(editor: SlateEditor, fn: () => void): void;
    withoutSaving?(editor: SlateEditor, fn: () => void): void;
} = findByPropsLazy("withSingleEntry", "withMergedEntry");

const INLINE = "￼";

const isText = (node: SlateNode | undefined): node is SlateText => typeof (node as SlateText)?.text === "string";

function nodeAt(editor: SlateEditor, path: number[]): SlateNode | undefined {
    let node: SlateNode | undefined = { children: editor.children };
    for (const i of path) node = (node as SlateElement | undefined)?.children?.[i];
    return node;
}

function caretPoint(editor: SlateEditor): Point | null {
    const sel = editor.selection;
    if (!sel || sel.anchor.offset !== sel.focus.offset || sel.anchor.path.join() !== sel.focus.path.join()) return null;
    return sel.anchor;
}

/** Plain text of the line the caret is on, up to the caret, and everything before that line. */
function textBeforeCaret(editor: SlateEditor): { line: string; all: string; } | null {
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

function hasCommand(editor: SlateEditor) {
    const first = editor.children[0] as SlateElement | undefined;
    return first?.type === "applicationCommand" || !!first?.children?.some(c => (c as SlateElement).type === "applicationCommand");
}

const fields = new WeakMap<SlateEditor, Field>();

/** The chat editor as a Field; the same editor always gets the same Field. */
export function slateField(editor: SlateEditor): Field {
    let field = fields.get(editor);
    if (field) return field;

    field = {
        kind: "slate",
        allowed() {
            const type = editor.chatInputType?.analyticsName;
            if (!type) return false;
            return type !== "edit" || settings.store.editMessages;
        },
        composing: () => Editor.isComposing(editor),
        focused: () => Editor.isFocused(editor),
        focus() {
            try {
                Editor.focus(editor);
            } catch { }
        },
        hasCommand: () => hasCommand(editor),
        caret: () => caretPoint(editor),
        wordAtCaret() {
            const point = caretPoint(editor);
            if (!point) return null;
            const leaf = nodeAt(editor, point.path);
            return isText(leaf) ? wordIn(leaf.text, point.offset, point.path) : null;
        },
        textBeforeCaret: () => textBeforeCaret(editor),
        replace(range, text) {
            History.withSingleEntry(editor, () => Transforms.insertText(editor, text, { at: range }));
            return true;
        },
        // undoes the editor's last history entry, then inserts `after` without recording it, so the next undo goes on to the edit before
        undoEntry(after) {
            const ed = editor as SlateEditor & { undo?(): void; };
            if (typeof ed.undo !== "function" || typeof History.withoutSaving !== "function") return false;
            ed.undo();
            if (after) History.withoutSaving(editor, () => Transforms.insertText(editor, after));
            return true;
        },
        rects(range) {
            try {
                return Array.from(Editor.toDOMRange(editor, range).getClientRects());
            } catch {
                return [];
            }
        },
    };
    fields.set(editor, field);
    return field;
}
