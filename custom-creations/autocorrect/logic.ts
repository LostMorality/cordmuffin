/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByPropsLazy } from "@webpack";

import type { Sensitivity } from "./engine";
import { settings } from "./settings";
import { caretPoint, hasCommand, isComposing, replaceRange, type SlateEditor, type SlateRange, textBeforeCaret, undoEntry, wordAtCaret, type WordAtCaret } from "./slate";
import { addWord, countFix, getEngine, logger, uncountFix } from "./words";

export type SlotKind = "literal" | "fix" | "suggestion" | "typed" | "prediction" | "undo";

export interface Slot {
    kind: SlotKind;
    label: string;
    insert: string;
}

export interface View {
    slots: Slot[];
    primary: number;
    word: string;
    key: string;
}

export interface EditorState {
    autocompleteRef: { current?: { isVisible?(): boolean; state?: { isVisible?: boolean; }; } | null; } | undefined;
    dismissed: string | null;
    refresh(): void;
    announce(text: string): void;
}

interface LastFix {
    path: string;
    start: number;
    original: string;
    fixed: string;
    sep: string;
}

interface AutoSpace {
    path: string;
    offset: number;
}

export const editors = new WeakMap<SlateEditor, EditorState>();
const lastFixes = new WeakMap<SlateEditor, LastFix>();
const autoSpaces = new WeakMap<SlateEditor, AutoSpace>();
const kept = new WeakMap<SlateEditor, Set<string>>();

const DOM: { toDOMRange(editor: SlateEditor, range: SlateRange): Range; } = findByPropsLazy("start", "end", "toSlateRange");

const BLOCKED_NEAR = /[@#:<>/\\_\d=$%^&*+~|[\]{}]/;
const BOUNDARY_KEYS = new Set([" ", ".", ",", "!", "?", ";", ")"]);
const SWALLOW_KEYS = new Set([".", ",", "!", "?"]);
const WORDS = /[\p{L}'’]+/gu;
const TOKENS = /[\p{L}\p{M}\d_'’]+/gu;

export const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform ?? "");
export const ACCEPT_HINT = IS_MAC ? "⌃ Enter" : "Ctrl Space";
export const pickHint = (i: number) => IS_MAC ? `⌃${i}` : `Alt+${i}`;

function autocompleteOpen(st: EditorState) {
    const ac = st.autocompleteRef?.current;
    try {
        return !!(ac?.isVisible?.() ?? ac?.state?.isVisible);
    } catch {
        return false;
    }
}

function blockedByContext(editor: SlateEditor, w: WordAtCaret, all: string) {
    if (hasCommand(editor)) return true;
    if ((all.match(/```/g)?.length ?? 0) % 2) return true;
    if ((all.replace(/```[\s\S]*?```/g, "").match(/`/g)?.length ?? 0) % 2) return true;

    const before = /\S*$/.exec(w.before)?.[0] ?? "";
    const after = /^\S*/.exec(w.after)?.[0] ?? "";
    if (BLOCKED_NEAR.test(before) || BLOCKED_NEAR.test(after)) return true;
    if (/^\.\p{L}/u.test(after) || /\p{L}\.$/u.test(before)) return true;
    return /https?:|www\./i.test(before + w.word + after);
}

function context(textBefore: string) {
    const trimmed = textBefore.trimEnd();
    const sentenceStart = !trimmed || /[.!?]$/.test(trimmed) || /\n[ \t]*$/.test(textBefore);
    const prev = /([\p{L}'’]+)[ \t,]*$/u.exec(textBefore)?.[1] ?? null;
    return { prev: sentenceStart ? null : prev, sentenceStart };
}

function looksForeign(all: string) {
    const engine = getEngine();
    if (!engine) return false;
    const words = (all.match(WORDS) ?? []).slice(0, -1);
    if (words.length < 6) return false;
    const unknown = words.filter(w => !engine.isKnown(w)).length;
    return unknown / words.length > 0.6;
}

function keyFor(w: WordAtCaret) {
    return `${w.path.join(".")}:${w.start}:${w.word}`;
}

export function isEditorAllowed(editor: SlateEditor) {
    const type = editor.chatInputType?.analyticsName;
    if (!type) return false;
    return type !== "edit" || settings.store.editMessages;
}

export function buildView(editor: SlateEditor, st: EditorState): View | null {
    const engine = getEngine();
    const { mode, sensitivity, nextWord, capitalizeSentences } = settings.store;
    if (!engine || mode === "off" || !isEditorAllowed(editor) || isComposing(editor) || autocompleteOpen(st)) return null;

    const w = wordAtCaret(editor);
    const text = textBeforeCaret(editor);
    if (!w || !text) return null;
    if (!text.all.trim() && !w.word && !w.after) {
        kept.delete(editor);
        lastFixes.delete(editor);
        autoSpaces.delete(editor);
    }

    const undo = currentFix(editor);
    const caret = caretPoint(editor);
    if (undo) {
        const slots: Slot[] = [{ kind: "undo", label: undo.original, insert: undo.original }];
        return { slots, primary: 0, word: "", key: `undo:${undo.path}:${undo.start}` };
    }

    const caretOffset = caret?.offset ?? 0;
    const lead = text.all.slice(0, text.all.length - (caretOffset - w.start));
    const { prev, sentenceStart } = context(lead);
    const key = keyFor(w);
    if (st.dismissed === key) return null;

    if (!w.word) {
        if (!nextWord || !prev || !engine.isKnown(prev) || !/\s$/.test(w.before) || w.after && !/^\s/.test(w.after)) return null;
        if (blockedByContext(editor, { ...w, before: w.before.trimEnd() }, text.all)) return null;
        const list = engine.predict(prev, 3);
        if (!list.length) return null;
        const slots = list.map<Slot>(p => ({ kind: "prediction", label: p, insert: p }));
        const order = slots.length === 3 ? [slots[1], slots[0], slots[2]] : slots;
        return { slots: order, primary: order.indexOf(slots[0]), word: "", key };
    }

    if (blockedByContext(editor, w, text.all)) return null;
    if (caretOffset !== w.range.focus.offset) return null;

    const sens: Sensitivity = mode === "auto" ? sensitivity as Sensitivity : "off";
    const result = engine.suggest(w.word, prev, 3, sens, capitalizeSentences && sentenceStart);
    if (result.skip) return null;

    const literal: Slot = { kind: "literal", label: w.word, insert: w.word };
    const fixAllowed = mode === "auto" && !kept.get(editor)?.has(key) && !looksForeign(text.all);
    const cands = result.candidates.map(c => c.word);

    if (result.autoCorrect && fixAllowed) {
        const fixed = result.autoCorrect.toLowerCase();
        const alt = cands.find(c => c.toLowerCase() !== fixed);
        const slots: Slot[] = [literal, { kind: "fix", label: result.autoCorrect, insert: result.autoCorrect }];
        if (alt) slots.push({ kind: "suggestion", label: alt, insert: alt });
        return { slots, primary: 1, word: w.word, key };
    }

    if (!cands.length) return null;

    if (!result.known) {
        const slots: Slot[] = [literal, ...cands.slice(0, 2).map<Slot>(c => ({ kind: "suggestion", label: c, insert: c }))];
        return { slots, primary: 1, word: w.word, key };
    }

    const completions = result.candidates.filter(c => c.kind === "completion" && c.word.toLowerCase().startsWith(w.word.toLowerCase())).map(c => c.word);
    if (!completions.length) return null;
    const typed: Slot = { kind: "typed", label: w.word, insert: w.word };
    const [a, b] = completions.map<Slot>(c => ({ kind: "suggestion", label: c, insert: c }));
    const slots = [a, typed, b].filter(Boolean);
    return { slots, primary: slots.indexOf(typed), word: w.word, key };
}

function flash(editor: SlateEditor, range: SlateRange) {
    try {
        const dom = DOM.toDOMRange(editor, range);
        const doc = dom.startContainer.ownerDocument ?? document;
        for (const r of Array.from(dom.getClientRects())) {
            const mark = doc.createElement("div");
            mark.className = "vc-autocorrect-mark";
            Object.assign(mark.style, { left: `${r.left}px`, top: `${r.bottom - 3}px`, width: `${r.width}px` });
            doc.body.appendChild(mark);
            mark.addEventListener("animationend", () => mark.remove());
            setTimeout(() => mark.remove(), 4000);
        }
    } catch { }
}

/** Screen box of what the strip is about: the word at the caret, the word a fix just changed, or the caret itself. */
export function anchorRect(editor: SlateEditor): DOMRect | null {
    try {
        const fix = currentFix(editor);
        const w = wordAtCaret(editor);
        if (!w) return null;
        const range: SlateRange = fix
            ? { anchor: { path: w.path, offset: fix.start }, focus: { path: w.path, offset: fix.start + fix.fixed.length } }
            : w.range;
        const dom = DOM.toDOMRange(editor, range);
        const rect = dom.getBoundingClientRect();
        if (rect.width || rect.height) return rect;
        return dom.getClientRects()[0] ?? null;
    } catch {
        return null;
    }
}

/** A word that is only capitalized because it starts a sentence is stored lowercase. */
export function learnedForm(word: string) {
    return /^\p{Lu}[\p{Ll}'’]*$/u.test(word) ? word.toLowerCase() : word;
}

function withSpace(w: WordAtCaret) {
    return w.after ? "" : " ";
}

/** The last autofix, but only while the caret still sits right after it and the text is unchanged. */
function currentFix(editor: SlateEditor) {
    const fix = lastFixes.get(editor);
    if (!fix) return null;
    const caret = caretPoint(editor);
    const w = caret && wordAtCaret(editor);
    const end = fix.start + fix.fixed.length + fix.sep.length;
    if (caret && w && !w.word && caret.path.join(".") === fix.path && caret.offset === end && w.before.slice(fix.start) === fix.fixed + fix.sep) return fix;
    lastFixes.delete(editor);
    return null;
}

function insertSlot(editor: SlateEditor, w: WordAtCaret, insert: string) {
    const space = withSpace(w);
    replaceRange(editor, w.range, insert + space);
    if (space) autoSpaces.set(editor, { path: w.path.join("."), offset: w.range.anchor.offset + insert.length + 1 });
}

export function applySlot(editor: SlateEditor, st: EditorState, slot: Slot) {
    const engine = getEngine();
    const w = wordAtCaret(editor);
    if (!w || !engine) return;

    if (slot.kind === "undo") {
        undoLastFix(editor, st);
        return;
    }

    if (slot.kind === "prediction") {
        insertSlot(editor, w, slot.insert);
        return;
    }

    if (slot.kind === "literal") {
        const view = buildView(editor, st);
        const best = view?.slots[view.primary];
        if (best && best.kind !== "literal" && engine.noteRevert(w.word, best.insert)) addWord(learnedForm(w.word), settings.store.shareWithDiscord);
        (kept.get(editor) ?? kept.set(editor, new Set()).get(editor))?.add(keyFor(w));
    }

    const typo = slot.kind === "fix" || (slot.kind === "suggestion" && !engine.isKnown(w.word));
    insertSlot(editor, w, slot.insert);
    if (typo) countFix();
}

function undoLastFix(editor: SlateEditor, st: EditorState) {
    const fix = currentFix(editor);
    const caret = caretPoint(editor);
    if (!fix || !caret) return false;

    const end = fix.start + fix.fixed.length + fix.sep.length;
    const range: SlateRange = { anchor: { path: caret.path, offset: fix.start }, focus: { path: caret.path, offset: end } };
    lastFixes.delete(editor);
    // pop the fix's own history entry so a later Ctrl+Z goes on to older edits instead of bringing the fix back
    if (!undoEntry(editor, fix.sep)) replaceRange(editor, range, fix.original + fix.sep);
    else if (!wordAtCaret(editor)?.before.endsWith(fix.original + fix.sep)) logger.warn("Undoing a fix left unexpected text");
    uncountFix();

    const engine = getEngine();
    if (engine?.noteRevert(fix.original, fix.fixed)) addWord(learnedForm(fix.original), settings.store.shareWithDiscord);
    (kept.get(editor) ?? kept.set(editor, new Set()).get(editor))?.add(`${fix.path}:${fix.start}:${fix.original}`);
    st.announce(`Kept ${fix.original}.`);
    return true;
}

/** After a picked suggestion's own space, punctuation replaces that space: "hello ?" becomes "hello?". */
function swallowSpace(editor: SlateEditor, key: string, space: AutoSpace | undefined) {
    if (!space || !SWALLOW_KEYS.has(key)) return false;
    const caret = caretPoint(editor);
    const w = caret && wordAtCaret(editor);
    if (!caret || !w || w.word || caret.path.join(".") !== space.path || caret.offset !== space.offset || !w.before.endsWith(" ")) return false;
    replaceRange(editor, { anchor: { path: caret.path, offset: space.offset - 1 }, focus: { path: caret.path, offset: space.offset } }, key);
    return true;
}

function autoFix(editor: SlateEditor, st: EditorState, sep: string) {
    const view = buildView(editor, st);
    const fix = view?.slots[view.primary];
    if (!view || fix?.kind !== "fix") return false;

    const w = wordAtCaret(editor);
    if (!w || w.word !== view.word) return false;
    // "well," and "were." are almost never "we'll," or "we're." so contractions of real words only happen on space
    if (sep !== " " && /['’]/.test(fix.insert) && getEngine()?.isKnown(w.word)) return false;

    replaceRange(editor, w.range, fix.insert + sep);
    lastFixes.set(editor, { path: w.path.join("."), start: w.start, original: w.word, fixed: fix.insert, sep });
    countFix();
    const marked: SlateRange = { anchor: { path: w.path, offset: w.start }, focus: { path: w.path, offset: w.start + fix.insert.length } };
    requestAnimationFrame(() => flash(editor, marked));
    st.announce(`Changed ${w.word} to ${fix.insert}. Press Backspace to undo.`);
    return true;
}

function pick(editor: SlateEditor, st: EditorState, index: number | "primary") {
    const view = buildView(editor, st);
    if (!view) return false;
    const slot = view.slots[index === "primary" ? view.primary : index];
    // Tab and the accept shortcut never undo a fix; only Backspace, Ctrl+Z, the number shortcut or a click do
    if (!slot || (index === "primary" && slot.kind === "undo")) return false;
    applySlot(editor, st, slot);
    return true;
}

function acceptKey(e: KeyboardEvent): number | "primary" | null {
    const only = (ctrl: boolean, alt: boolean) => e.ctrlKey === ctrl && e.altKey === alt && !e.metaKey && !e.shiftKey;
    if (e.key === " " && only(true, false)) return "primary";
    if (IS_MAC && e.key === "Enter" && only(true, false)) return "primary";
    // matched on the physical key so AZERTY works; on Mac, Ctrl is used because Option+digit types characters there
    if (/^Digit[1-3]$/.test(e.code) && (IS_MAC ? only(true, false) : only(false, true))) return Number(e.code.slice(5)) - 1;
    if (e.key === "Tab" && only(false, false) && settings.store.tabAccepts) return "primary";
    return null;
}

export function onKeyDown(editor: SlateEditor, e: KeyboardEvent): boolean {
    try {
        const st = editors.get(editor);
        if (!st || settings.store.mode === "off" || !isEditorAllowed(editor)) return false;
        if (e.isComposing || isComposing(editor)) return false;
        if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return false;

        const mods = e.ctrlKey || e.altKey || e.metaKey;
        const space = autoSpaces.get(editor);
        autoSpaces.delete(editor);
        if (autocompleteOpen(st)) {
            lastFixes.delete(editor);
            return false;
        }

        const undoKey = (e.key === "Backspace" && !mods && !e.shiftKey)
            || (e.key.toLowerCase() === "z" && (IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey && !e.shiftKey);
        if (undoKey && lastFixes.has(editor)) {
            if (undoLastFix(editor, st)) return true;
            lastFixes.delete(editor);
            return false;
        }

        const accept = acceptKey(e);
        if (accept !== null) {
            const done = pick(editor, st, accept);
            if (accept !== "primary" || done) lastFixes.delete(editor);
            return done;
        }

        lastFixes.delete(editor);

        if (!mods && swallowSpace(editor, e.key, space)) return true;

        if (e.key === "Escape" && !mods) {
            const view = buildView(editor, st);
            if (view) {
                st.dismissed = view.key;
                st.refresh();
            }
            return false;
        }

        if (e.key === "Enter" && !e.shiftKey) {
            kept.delete(editor);
            return false;
        }

        if (!mods && BOUNDARY_KEYS.has(e.key) && settings.store.mode === "auto") return autoFix(editor, st, e.key);
        return false;
    } catch (err) {
        logger.error("Key handling failed", err);
        return false;
    }
}

export function learnFromMessage(content: string) {
    const clean = content
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`[^`]*`/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/[@#:]\S+/g, " ");
    const pairs: [string | null, string][] = [];
    for (const sentence of clean.split(/[.!?\n]+/)) {
        let prev: string | null = null;
        for (const token of sentence.match(TOKENS) ?? []) {
            const w = token.replace(/^[_'’]+|[_'’]+$/g, "");
            if (!w || /[\d_]/.test(w)) {
                prev = null;
                continue;
            }
            pairs.push([prev, w]);
            prev = w;
        }
    }
    return pairs;
}
