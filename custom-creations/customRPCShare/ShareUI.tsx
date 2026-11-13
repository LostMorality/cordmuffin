/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Heading } from "@components/Heading";
import { Notice } from "@components/Notice";
import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import { copyWithToast } from "@utils/discord";
import { useAwaiter } from "@utils/react";
import { chooseFile, saveFile } from "@utils/web";
import type { ModalAction, RenderModalProps } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { Modal, openModal, Select, showToast as equicordShowToast, TextArea, useMemo, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { buildExport, conflictsWith, Dropped, fileNameFor, ImportCheck, loadPresets, parseImport, savePresets, toCode, toFileText } from "./share";

// Discord's toast function, found directly. Equicord's own lookup broke once in November 2026 and then quietly logs
// instead of throwing, so it's only the fallback. A failed toast must never break what the plugin was doing.
const discordToast: typeof equicordShowToast = findByCodeLazy("currentToastMap.get(", "toastKey");

function showToast(options: Parameters<typeof equicordShowToast>[0]) {
    for (const show of [discordToast, equicordShowToast]) {
        try {
            show(options);
            return;
        } catch { }
    }
}

const cl = classNameFactory("vc-rpcshare-");
const ALL = "\u0000all";

function plural(n: number, word: string) {
    return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

function errorText(e: unknown) {
    return e instanceof Error ? e.message : String(e);
}

function open(render: (props: RenderModalProps) => ReactNode) {
    openModal(props => <ErrorBoundary>{render(props)}</ErrorBoundary>);
}

function DroppedList({ items }: { items: Dropped[]; }) {
    const groups = useMemo(() => {
        const map = new Map<string, Dropped[]>();
        for (const d of items) map.set(d.preset, [...map.get(d.preset) ?? [], d]);
        return [...map.entries()];
    }, [items]);
    if (!items.length) return null;
    return (
        <div className={cl("dropped")}>
            {groups.map(([preset, rows]) => (
                <div key={preset}>
                    <strong>{preset}</strong>
                    <ul>
                        {rows.map((r, i) => <li key={`${r.field}-${i}`}><code>{r.field}</code>: {r.reason}</li>)}
                    </ul>
                </div>
            ))}
        </div>
    );
}

function ExportModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const [presets, , pending] = useAwaiter(loadPresets, { fallbackValue: [] });
    const [choice, setChoice] = useState(ALL);

    const picked = choice === ALL ? presets : presets.filter(p => p.name === choice);
    const { data, dropped, skipped } = useMemo(() => buildExport(picked), [picked]);
    const code = useMemo(() => toCode(data), [data]);
    const empty = !data.presets.length;

    async function saveJson() {
        try {
            const bytes = new TextEncoder().encode(toFileText(data));
            const name = fileNameFor(data);
            if (IS_DISCORD_DESKTOP) await DiscordNative.fileManager.saveWithDialog(bytes, name);
            else saveFile(new File([bytes], name, { type: "application/json" }));
        } catch (e) {
            showToast({ text: `Couldn't save the file: ${errorText(e)}`, variant: "critical" });
        }
    }

    return (
        <Modal
            {...modalProps}
            size="md"
            title="Export CustomRPC Presets"
            subtitle="Share them as a code to paste or a .json file. Only what you typed into the presets is shared."
            actions={[
                { text: "Close", variant: "secondary", onClick: modalProps.onClose },
                { text: "Save File", variant: "secondary", onClick: saveJson, disabled: empty },
                { text: "Copy Code", variant: "primary", onClick: () => copyWithToast(code, "Preset code copied."), disabled: empty },
            ]}
        >
            {pending
                ? <Paragraph>Loading presets...</Paragraph>
                : !presets.length
                    ? <Notice.Info className={cl("notice")}>You have no saved CustomRPC presets yet. Save one in CustomRPC's settings first.</Notice.Info>
                    : (
                        <>
                            <Heading tag="h5" className={cl("label")}>What to export</Heading>
                            <Select
                                options={[
                                    { label: `All presets (${presets.length})`, value: ALL },
                                    ...presets.map(p => ({ label: p.name, value: p.name })),
                                ]}
                                closeOnSelect={true}
                                select={setChoice}
                                isSelected={v => v === choice}
                                serialize={String}
                            />
                            {dropped.length
                                ? <Notice.Info className={cl("notice")}>Left out {plural(dropped.length, "field")} so nothing about your account is shared:</Notice.Info>
                                : !empty && <Notice.Positive className={cl("notice")}>Nothing private found, so nothing was left out.</Notice.Positive>}
                            <DroppedList items={dropped} />
                            {skipped.map(s => <Notice.Warning key={s} className={cl("notice")}>Not exported: {s}</Notice.Warning>)}
                            {!empty && (
                                <>
                                    <Heading tag="h5" className={cl("label")}>
                                        Code for {plural(data.presets.length, "preset")}
                                    </Heading>
                                    <TextArea value={code} onChange={() => { }} readOnly rows={4} className={cl("code")} />
                                </>
                            )}
                        </>
                    )}
        </Modal>
    );
}

function ImportModal({ modalProps, onImported }: { modalProps: RenderModalProps; onImported?(): void; }) {
    const [existing] = useAwaiter(loadPresets, { fallbackValue: [] });
    const [text, setText] = useState("");
    // A big file is shown cut short; this keeps the whole text so a check never runs on the cut copy.
    const [fileText, setFileText] = useState<string | null>(null);
    const [check, setCheck] = useState<ImportCheck | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    function run(value: string) {
        if (!value.trim()) {
            setCheck(null);
            setError(null);
            return;
        }
        try {
            setCheck(parseImport(value));
            setError(null);
        } catch (e) {
            setCheck(null);
            setError(errorText(e));
        }
    }

    async function pickFile() {
        try {
            let content: string | null = null;
            if (IS_DISCORD_DESKTOP) {
                const [file] = await DiscordNative.fileManager.openFiles({
                    filters: [{ name: "CustomRPC presets", extensions: ["json"] }, { name: "all", extensions: ["*"] }]
                });
                if (file) content = new TextDecoder().decode(file.data);
            } else {
                const file = await chooseFile("application/json");
                if (file) content = await file.text();
            }
            if (content === null) return;
            const cut = content.length > 20000;
            setText(cut ? content.slice(0, 20000) + "\n..." : content);
            setFileText(cut ? content : null);
            run(content);
        } catch (e) {
            setCheck(null);
            setError(`Couldn't read that file: ${errorText(e)}`);
        }
    }

    const conflicts = check ? conflictsWith(existing, check.presets) : [];

    async function save(replace: boolean) {
        if (!check || busy) return;
        setBusy(true);
        try {
            const result = await savePresets(check.presets, replace);
            const parts = [
                result.added.length && `added ${plural(result.added.length, "preset")}`,
                result.replaced.length && `replaced ${result.replaced.length}`,
                result.renamed.length && `${result.renamed.length} renamed to keep yours`,
            ].filter(Boolean);
            showToast({ text: `Imported: ${parts.join(", ")}.`, variant: "success" });
            onImported?.();
            modalProps.onClose();
        } catch (e) {
            showToast({ text: `Couldn't import: ${errorText(e)}`, variant: "critical" });
        } finally {
            setBusy(false);
        }
    }

    const actions: ModalAction[] = [{ text: "Cancel", variant: "secondary", onClick: modalProps.onClose }];
    if (check && conflicts.length) {
        actions.push(
            { text: "Replace Same Names", variant: "critical-primary", onClick: () => save(true), disabled: busy },
            { text: "Keep Both", variant: "primary", onClick: () => save(false), disabled: busy },
        );
    } else {
        actions.push({ text: "Import", variant: "primary", onClick: () => save(false), disabled: !check || busy });
    }

    return (
        <Modal
            {...modalProps}
            size="md"
            title="Import CustomRPC Presets"
            subtitle="Paste a preset code or choose a .json file. They're added to your presets; nothing is loaded until you pick one."
            actions={actions}
        >
            <div className={cl("import-row")}>
                <TextArea
                    value={text}
                    onChange={v => { setText(v); setFileText(null); run(v); }}
                    readOnly={fileText !== null}
                    placeholder="RPC1...."
                    rows={4}
                    className={cl("code")}
                />
                <Button size="small" variant="secondary" onClick={pickFile}>Choose File</Button>
            </div>
            {fileText !== null && (
                <div className={cl("file-note")}>
                    <Paragraph className={cl("hint")}>Showing the start of a big file.</Paragraph>
                    <Button size="small" variant="secondary" onClick={() => { setText(""); setFileText(null); run(""); }}>Clear</Button>
                </div>
            )}
            {error && <Notice.Danger className={cl("notice")}>{error}</Notice.Danger>}
            {check && (
                <>
                    <Heading tag="h5" className={cl("label")}>{plural(check.presets.length, "preset")} found</Heading>
                    <div className={cl("chips")}>
                        {check.presets.map(p => (
                            <span key={p.name} className={cl("chip", conflicts.includes(p.name) && "chip-warn")}>{p.name}</span>
                        ))}
                    </div>
                    {conflicts.length > 0 && (
                        <Notice.Warning className={cl("notice")}>
                            You already have {conflicts.length === 1 ? "a preset" : `${conflicts.length} presets`} with the same name.
                            Keep Both saves the new {conflicts.length === 1 ? "one" : "ones"} as "Name (2)". Replace Same Names
                            overwrites yours and can't be undone.
                        </Notice.Warning>
                    )}
                    {check.dropped.length > 0 && (
                        <>
                            <Notice.Info className={cl("notice")}>Skipped {plural(check.dropped.length, "field")} that didn't pass CustomRPC's checks:</Notice.Info>
                            <DroppedList items={check.dropped} />
                        </>
                    )}
                    {check.rejected.map(r => <Notice.Warning key={r} className={cl("notice")}>Skipped: {r}</Notice.Warning>)}
                </>
            )}
        </Modal>
    );
}

export function openExport() {
    open(p => <ExportModal modalProps={p} />);
}

export function openImport(onImported?: () => void) {
    open(p => <ImportModal modalProps={p} onImported={onImported} />);
}

export function SharePanel({ onImported, note }: { onImported?(): void; note?: ReactNode; }) {
    return (
        <div className={cl("panel")}>
            <div className={cl("panel-text")}>
                <Heading tag="h5">Share Presets</Heading>
                <Paragraph className={cl("hint")}>{note ?? "Export your presets as a code or file, or import someone else's."}</Paragraph>
            </div>
            <div className={cl("panel-buttons")}>
                <Button size="small" variant="secondary" onClick={openExport}>Export Presets</Button>
                <Button size="small" variant="secondary" onClick={() => openImport(onImported)}>Import Presets</Button>
            </div>
        </div>
    );
}
