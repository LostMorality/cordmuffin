/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { plugins } from "@api/PluginManager";
import { openPluginModal } from "@components/settings";
import { ContextMenuApi, Menu, useEffect, useLayoutEffect, useReducer, useRef, useState } from "@webpack/common";

import type { Field } from "./field";
import { ACCEPT_HINT, anchorRect, applySlot, buildView, editors, type EditorState, learnedForm, pickHint, type Slot } from "./logic";
import { cl, settings } from "./settings";
import { type SlateEditor, slateField } from "./slate";
import { addWord, blockWord, knowsWord, onWordsChange } from "./words";

export interface StripProps {
    editorRef: { current?: { ref?: { current?: { getSlateEditor?(): SlateEditor | undefined; }; }; } | null; };
    autocompleteRef: EditorState["autocompleteRef"];
    textValue: string;
}

const KEY_HINT: Partial<Record<Slot["kind"], string>> = { fix: "Space", undo: "Backspace" };

function openSlotMenu(e: React.MouseEvent, slot: Slot, editor: Field) {
    const close = () => {
        ContextMenuApi.closeContextMenu();
        requestAnimationFrame(() => editor.focus());
    };
    const w = slot.label;
    const stored = learnedForm(w);
    const canAdd = (slot.kind === "literal" || slot.kind === "undo") && !knowsWord(w) && !knowsWord(stored);
    const canBlock = slot.kind === "fix" || slot.kind === "suggestion" || slot.kind === "prediction";

    ContextMenuApi.openContextMenu(e, () => (
        <Menu.Menu navId="vc-autocorrect" onClose={close} aria-label="Autocorrect">
            {canAdd && (
                <Menu.MenuItem id="vc-ac-add" label={`Add “${stored}” to dictionary`} action={() => addWord(stored, settings.store.shareWithDiscord)} />
            )}
            {canBlock && (
                <Menu.MenuItem id="vc-ac-block" label={`Never suggest “${w}”`} action={() => blockWord(w)} />
            )}
            <Menu.MenuItem id="vc-ac-settings" label="Autocorrect settings" action={() => {
                const plugin = plugins?.Autocorrect;
                if (plugin) openPluginModal(plugin);
            }} />
        </Menu.Menu>
    ));
}

interface ViewProps {
    editor: Field | null;
    autocompleteRef: EditorState["autocompleteRef"];
    onRender?(): void;
}

/** The suggestion strip for one text box. It sits inside a positioned parent and floats just above it. */
export function StripView({ editor, autocompleteRef, onRender }: ViewProps) {
    const [, refresh] = useReducer((n: number) => n + 1, 0);
    const [announcement, setAnnouncement] = useState("");
    const { position, keyHints } = settings.use(["position", "keyHints", "mode", "sensitivity", "nextWord", "capitalizeSentences", "editMessages"]);
    const stRef = useRef<EditorState | null>(null);
    const liveRef = useRef<HTMLSpanElement | null>(null);
    const stripRef = useRef<HTMLDivElement | null>(null);

    // a repeated message gets a zero width space so the live region changes and screen readers say it again
    const announce = (text: string) => setAnnouncement(old => old === text ? text + "​" : text);
    stRef.current ??= { autocompleteRef, dismissed: null, refresh, announce };
    const st = stRef.current;
    st.autocompleteRef = autocompleteRef;

    useEffect(() => {
        if (!editor) return;
        editors.set(editor, st);
        return () => void (editors.get(editor) === st && editors.delete(editor));
    }, [editor]);

    useEffect(() => {
        let frame = 0;
        const schedule = () => {
            if (frame) return;
            frame = requestAnimationFrame(() => {
                frame = 0;
                refresh();
            });
        };
        // popout chat windows have their own document, so listen on the one this strip is rendered in
        const doc = liveRef.current?.ownerDocument ?? document;
        doc.addEventListener("selectionchange", schedule);
        doc.addEventListener("focusin", schedule);
        doc.addEventListener("focusout", schedule);
        const off = onWordsChange(schedule);
        const unsubscribe = editor?.subscribe?.(schedule);
        return () => {
            cancelAnimationFrame(frame);
            doc.removeEventListener("selectionchange", schedule);
            doc.removeEventListener("focusin", schedule);
            doc.removeEventListener("focusout", schedule);
            off();
            unsubscribe?.();
        };
    }, [editor]);

    useEffect(() => {
        if (!announcement) return;
        const t = setTimeout(() => setAnnouncement(""), 4000);
        return () => clearTimeout(t);
    }, [announcement]);

    const view = editor && editor.focused() ? buildView(editor, st) : null;
    if (view && st.dismissed && st.dismissed !== view.key) st.dismissed = null;

    // "word" position: centre the highlighted chip over the word being typed, kept inside the text box
    useLayoutEffect(() => {
        onRender?.();
        const strip = stripRef.current;
        if (!strip) return;
        if (position !== "word" || !editor || !view) {
            strip.style.left = "";
            return;
        }
        const parent = strip.offsetParent as HTMLElement | null;
        const word = anchorRect(editor);
        if (!parent || !word) {
            strip.style.left = "";
            return;
        }
        const box = parent.getBoundingClientRect();
        const primary = strip.children[view.primary] as HTMLElement | undefined;
        const chipCentre = primary ? primary.offsetLeft + primary.offsetWidth / 2 : strip.offsetWidth / 2;
        const wanted = word.left + word.width / 2 - box.left - chipCentre;
        const max = Math.max(8, box.width - strip.offsetWidth - 8);
        strip.style.left = `${Math.round(Math.min(Math.max(wanted, 8), max))}px`;
    });

    return (
        <>
            <span ref={liveRef} className={cl("sr")} aria-live="polite">{announcement}</span>
            {view && editor && (
                <div
                    ref={stripRef}
                    className={cl("strip", `strip-${position}`)}
                    role="listbox"
                    aria-label="Spelling suggestions"
                    aria-orientation="horizontal"
                    onMouseDown={e => e.preventDefault()}
                >
                    {view.slots.map((slot, i) => {
                        const primary = i === view.primary;
                        const hint = KEY_HINT[slot.kind] ?? (primary && slot.kind !== "typed" ? ACCEPT_HINT : null);
                        return (
                            <div
                                key={`${slot.kind}:${slot.label}`}
                                role="option"
                                aria-selected={primary}
                                tabIndex={-1}
                                className={cl("chip", `chip-${slot.kind}`, primary && "chip-primary")}
                                title={`${slot.kind === "undo" ? "Undo, keep" : "Use"} “${slot.label}” (${pickHint(i + 1)})`}
                                onClick={() => {
                                    applySlot(editor, st, slot);
                                    editor.focus();
                                }}
                                onContextMenu={e => openSlotMenu(e, slot, editor)}
                            >
                                {slot.kind === "undo" && <span className={cl("undo-icon")} aria-hidden>↶</span>}
                                <span className={cl("label")}>
                                    {slot.kind === "literal" || slot.kind === "undo" ? `“${slot.label}”` : slot.label}
                                </span>
                                {keyHints && primary && hint && <kbd className={cl("hint")}>{hint}</kbd>}
                            </div>
                        );
                    })}
                </div>
            )}
        </>
    );
}

/** The strip in Discord's chat box, rendered as the first child of the chat box itself. */
export function Strip({ editorRef, autocompleteRef }: StripProps) {
    const editor = editorRef?.current?.ref?.current?.getSlateEditor?.();
    return <StripView editor={editor ? slateField(editor) : null} autocompleteRef={autocompleteRef} />;
}
