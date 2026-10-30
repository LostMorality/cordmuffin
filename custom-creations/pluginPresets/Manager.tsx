/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { plugins } from "@api/PluginManager";
import { Settings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Heading } from "@components/Heading";
import { Notice } from "@components/Notice";
import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import { copyWithToast } from "@utils/discord";
import { chooseFile, saveFile } from "@utils/web";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, showToast, TextArea, TextInput, useMemo, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { applyPreset, ApplyResult, captureCurrent, deletePreset, isManaged, planApply, Preset, renamePreset, savePreset, usePresets } from "./presets";
import { Removed } from "./scrub";
import { buildExport, fileNameFor, ImportReport, prepareImport, toCode, toFileText } from "./share";

const cl = classNameFactory("vc-pp-");

function plural(n: number, word: string) {
    return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

function cleanInput(text: string) {
    return text.replace(/[\p{C}]/gu, "").slice(0, 64);
}

function Names({ title, names, tone = "plain" }: { title: string; names: string[]; tone?: "plain" | "on" | "off" | "warn"; }) {
    if (!names.length) return null;
    return (
        <div className={cl("names")}>
            <Heading tag="h5">{title} ({names.length})</Heading>
            <div className={cl("chips")}>
                {names.map(n => <span key={n} className={cl("chip", `chip-${tone}`)}>{n}</span>)}
            </div>
        </div>
    );
}

function RemovedList({ items }: { items: Removed[]; }) {
    const groups = useMemo(() => {
        const map = new Map<string, Removed[]>();
        for (const r of items) map.set(r.plugin, [...map.get(r.plugin) ?? [], r]);
        return [...map.entries()];
    }, [items]);
    if (!items.length) return null;
    return (
        <div className={cl("removed")}>
            {groups.map(([plugin, rows]) => (
                <div key={plugin} className={cl("removed-group")}>
                    <strong>{plugin}</strong>
                    <ul>
                        {rows.map(r => <li key={r.setting}><code>{r.setting}</code>: {r.reason}</li>)}
                    </ul>
                </div>
            ))}
        </div>
    );
}

function RestartNotice({ names }: { names: string[]; }) {
    if (!names.length) return null;
    return (
        <>
            <Notice.Warning className={cl("notice")}>
                Discord needs a restart for {names.length === 1 ? "this" : `these ${names.length}`} to take effect.
            </Notice.Warning>
            <Names title="Waiting for a restart" names={names} tone="warn" />
        </>
    );
}

function PreviewModal({ modalProps, preset }: { modalProps: RenderModalProps; preset: Preset; }) {
    const plan = useMemo(() => planApply(preset), [preset]);
    const [result, setResult] = useState<ApplyResult | null>(null);
    const changedSettings = Object.entries(plan.settingChanges).map(([n, keys]) => `${n} (${keys.length})`);
    const nothing = !plan.turnOn.length && !plan.turnOff.length && !changedSettings.length && !plan.bdOn.length && !plan.bdOff.length;

    function apply() {
        try {
            setResult(applyPreset(preset));
        } catch (e) {
            showToast({ text: `Couldn't apply the preset: ${e instanceof Error ? e.message : String(e)}`, variant: "critical" });
        }
    }

    if (result) {
        return (
            <Modal
                {...modalProps}
                size="md"
                title={`Applied "${preset.name}"`}
                actions={[
                    ...result.restart.length ? [{ text: "Restart Now", variant: "primary", onClick: () => location.reload() }] : [],
                    { text: result.restart.length ? "Later" : "Done", variant: "secondary", onClick: modalProps.onClose },
                ]}
            >
                {!result.failed.length && !result.restart.length && (
                    <Notice.Positive className={cl("notice")}>Everything is switched over. No restart needed.</Notice.Positive>
                )}
                {result.failed.length > 0 && (
                    <Notice.Danger className={cl("notice")}>
                        <ul className={cl("list")}>{result.failed.map(f => <li key={f}>{f}</li>)}</ul>
                    </Notice.Danger>
                )}
                <RestartNotice names={result.restart} />
            </Modal>
        );
    }

    return (
        <Modal
            {...modalProps}
            size="md"
            title={`Apply "${preset.name}"?`}
            subtitle={preset.imported
                ? "This preset was imported. It turns on the official plugins it lists and turns everything else off, including your own userplugins and BetterDiscord plugins. It never turns on a plugin that isn't official."
                : "Turns on exactly the plugins in this preset and turns the rest off. Required and core plugins aren't touched."}
            actions={[
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
                { text: "Apply", variant: "primary", onClick: apply, disabled: nothing },
            ]}
        >
            {nothing && <Notice.Info className={cl("notice")}>Your plugins already match this preset.</Notice.Info>}
            <Names title="Turns on" names={plan.turnOn} tone="on" />
            <Names title="Turns off" names={plan.turnOff} tone="off" />
            <Names title="Changes settings in" names={changedSettings} />
            <Names title="BetterDiscord plugins on" names={plan.bdOn} tone="on" />
            <Names title="BetterDiscord plugins off" names={plan.bdOff} tone="off" />
            <Names title="Not installed, skipped" names={plan.missing} tone="warn" />
            {preset.imported && preset.imported.unofficial.length + preset.imported.betterDiscord.length > 0 && (
                <Notice.Warning className={cl("notice")}>
                    The preset also had plugins on that aren't official Equicord or Vencord plugins. An import never turns
                    them on. If you already have one of them on, it stays on; install and turn the others on yourself only
                    if you trust them.
                </Notice.Warning>
            )}
            <Names title="Not official, already on, stays on" names={plan.keptUnofficial} />
            <Names title="Not official, stays off" names={plan.blockedUnofficial} tone="warn" />
            {preset.imported && (
                <Names
                    title="BetterDiscord plugins, stay off"
                    names={preset.imported.betterDiscord.filter(f => !plan.bdTarget?.includes(f))}
                    tone="warn"
                />
            )}
            {plan.restart.length > 0 && (
                <>
                    <Notice.Warning className={cl("notice")}>
                        {plural(plan.restart.length, "change")} only take effect after Discord restarts. You can apply now and restart when it suits you.
                    </Notice.Warning>
                    <Names title="Need a restart" names={plan.restart} tone="warn" />
                </>
            )}
        </Modal>
    );
}

function ExportModal({ modalProps, preset }: { modalProps: RenderModalProps; preset: Preset; }) {
    const { data, removed } = useMemo(() => buildExport(preset), [preset]);
    const code = useMemo(() => toCode(data), [data]);

    function saveJson() {
        const bytes = new TextEncoder().encode(toFileText(data));
        const name = fileNameFor(data.name);
        if (IS_DISCORD_DESKTOP) DiscordNative.fileManager.saveWithDialog(bytes, name);
        else saveFile(new File([bytes], name, { type: "application/json" }));
    }

    return (
        <Modal
            {...modalProps}
            size="md"
            title={`Export "${data.name}"`}
            subtitle={`${plural(data.enabled.length, "official plugin")} with their settings${data.unofficial.length + data.betterDiscord.length ? `, plus ${plural(data.unofficial.length + data.betterDiscord.length, "other plugin")} by name only` : ""}.`}
            actions={[
                { text: "Close", variant: "secondary", onClick: modalProps.onClose },
                { text: "Save .json File", variant: "secondary", onClick: saveJson },
                { text: "Copy Code", variant: "primary", onClick: () => copyWithToast(code, "Preset code copied.") },
            ]}
        >
            {removed.length
                ? (
                    <Notice.Info className={cl("notice")}>
                        Left out so nothing private is shared ({plural(removed.length, "item")}). Whoever imports this keeps their own values for these.
                    </Notice.Info>
                )
                : <Notice.Positive className={cl("notice")}>Nothing private found, so nothing was left out.</Notice.Positive>}
            <RemovedList items={removed} />
            <Heading tag="h5" className={cl("label")}>Preset code</Heading>
            <TextArea value={code} onChange={() => { }} readOnly rows={4} className={cl("code")} />
        </Modal>
    );
}

function ImportModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const [text, setText] = useState("");
    const [report, setReport] = useState<ImportReport | null>(null);
    const [error, setError] = useState<string | null>(null);

    function check(value = text) {
        try {
            setReport(prepareImport(value));
            setError(null);
        } catch (e) {
            setReport(null);
            setError(e instanceof Error ? e.message : String(e));
        }
    }

    async function pickFile() {
        try {
            let content: string | null = null;
            if (IS_DISCORD_DESKTOP) {
                const [file] = await DiscordNative.fileManager.openFiles({
                    filters: [{ name: "Plugin preset", extensions: ["json"] }, { name: "all", extensions: ["*"] }]
                });
                if (file) content = new TextDecoder().decode(file.data);
            } else {
                const file = await chooseFile("application/json");
                if (file) content = await file.text();
            }
            if (content === null) return;
            setText(content.length > 20000 ? content.slice(0, 20000) + "\n..." : content);
            check(content);
        } catch (e) {
            setError(`Couldn't read that file: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    async function save() {
        if (!report) return;
        await savePreset(report.preset);
        showToast({ text: `Imported "${report.preset.name}".`, variant: "success" });
        modalProps.onClose();
    }

    const scrubbedNames = report ? Object.entries(report.scrubbed).filter(([, k]) => k.length).map(([p, k]) => `${p} (${k.length})`) : [];

    return (
        <Modal
            {...modalProps}
            size="md"
            title="Import a Preset"
            subtitle="Paste a preset code or choose a .json file. Importing only saves it; you can look it over before applying."
            actions={[
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
                report
                    ? { text: "Save Preset", variant: "primary", onClick: save }
                    : { text: "Check", variant: "primary", onClick: () => check(), disabled: !text.trim() },
            ]}
        >
            <div className={cl("import-row")}>
                <TextArea
                    value={text}
                    onChange={v => { setText(v); setReport(null); setError(null); }}
                    placeholder="PP1...."
                    rows={4}
                    className={cl("code")}
                />
                <Button size="small" variant="secondary" onClick={pickFile}>Choose File</Button>
            </div>
            {error && <Notice.Danger className={cl("notice")}>{error}</Notice.Danger>}
            {report && (
                <>
                    <Paragraph className={cl("label")}>"{report.preset.name}"</Paragraph>
                    <Names title="Official plugins it turns on" names={report.enable} tone="on" />
                    {report.unofficial.length + report.betterDiscord.length > 0 && (
                        <Notice.Warning className={cl("notice")}>
                            These aren't official Equicord or Vencord plugins. They will NOT be turned on, even though the
                            preset has them on (one you already have on stays on). Only install and turn them on yourself
                            if you trust where they come from.
                        </Notice.Warning>
                    )}
                    <Names title="Not official, never turned on" names={report.unofficial} tone="warn" />
                    <Names title="BetterDiscord plugins, never turned on" names={report.betterDiscord} tone="warn" />
                    {report.enable.length > 0 && (
                        <Paragraph className={cl("hint")}>
                            Applying it later turns off every other plugin you have on, your own userplugins and BetterDiscord plugins included.
                        </Paragraph>
                    )}
                    <Names title="You don't have these, skipped" names={report.missing} tone="warn" />
                    <Names title="Private settings removed by the sharer (you keep yours)" names={scrubbedNames} />
                    {report.ignored.length > 0 && (
                        <>
                            <Notice.Info className={cl("notice")}>
                                Skipped {plural(report.ignored.length, "setting")} that can't be checked as safe. You keep your own values for these.
                            </Notice.Info>
                            <RemovedList items={report.ignored} />
                        </>
                    )}
                </>
            )}
        </Modal>
    );
}

function RenameModal({ modalProps, preset }: { modalProps: RenderModalProps; preset: Preset; }) {
    const [name, setName] = useState(preset.name);
    const trimmed = name.trim();
    return (
        <Modal
            {...modalProps}
            size="sm"
            title="Rename Preset"
            actions={[
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
                { text: "Save", variant: "primary", disabled: !trimmed, onClick: () => renamePreset(preset.id, trimmed).then(modalProps.onClose) },
            ]}
        >
            <TextInput value={name} onChange={v => setName(cleanInput(v))} placeholder="Preset name" autoFocus />
        </Modal>
    );
}

function DeleteModal({ modalProps, preset }: { modalProps: RenderModalProps; preset: Preset; }) {
    return (
        <Modal
            {...modalProps}
            size="sm"
            title={`Delete "${preset.name}"?`}
            subtitle="This only removes the saved preset. Your plugins stay as they are."
            actions={[
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
                { text: "Delete", variant: "critical-primary", onClick: () => deletePreset(preset.id).then(modalProps.onClose) },
            ]}
        />
    );
}

function open(render: (props: RenderModalProps) => ReactNode) {
    openModal(props => <ErrorBoundary>{render(props)}</ErrorBoundary>);
}

function PresetRow({ preset }: { preset: Preset; }) {
    const settingsCount = Object.keys(preset.settings).length;
    const extra = preset.imported
        ? `imported${preset.imported.unofficial.length + preset.imported.betterDiscord.length ? `, ${preset.imported.unofficial.length + preset.imported.betterDiscord.length} unofficial left off` : ""}`
        : `saved ${new Date(preset.created).toLocaleDateString()}`;
    return (
        <div className={cl("row")}>
            <div className={cl("row-text")}>
                <div className={cl("row-name")}>{preset.name}</div>
                <div className={cl("row-meta")}>
                    {plural(preset.enabled.length, "plugin")} on · {settingsCount.toLocaleString()} with settings · {extra}
                </div>
            </div>
            <div className={cl("row-buttons")}>
                <Button size="small" onClick={() => open(p => <PreviewModal modalProps={p} preset={preset} />)}>Preview & Apply</Button>
                <Button size="small" variant="secondary" onClick={() => open(p => <ExportModal modalProps={p} preset={preset} />)}>Export</Button>
                <Button size="small" variant="secondary" onClick={() => open(p => <RenameModal modalProps={p} preset={preset} />)}>Rename</Button>
                <Button size="small" variant="dangerSecondary" onClick={() => open(p => <DeleteModal modalProps={p} preset={preset} />)}>Delete</Button>
            </div>
        </div>
    );
}

export function Manager() {
    const presets = usePresets();
    const [name, setName] = useState("");
    const [saving, setSaving] = useState(false);
    const trimmed = name.trim();
    const replaces = !!trimmed && !!presets?.some(p => p.name.toLowerCase() === trimmed.toLowerCase());

    const managed = Object.keys(plugins).filter(isManaged);
    const onCount = managed.filter(n => Settings.plugins[n]?.enabled).length;

    async function save() {
        if (!trimmed) return;
        setSaving(true);
        try {
            await savePreset(captureCurrent(trimmed));
            showToast({ text: `Saved "${trimmed}".`, variant: "success" });
            setName("");
        } catch (e) {
            showToast({ text: `Couldn't save: ${e instanceof Error ? e.message : String(e)}`, variant: "critical" });
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className={cl("manager")}>
            <Paragraph>
                {onCount.toLocaleString()} of {managed.length.toLocaleString()} plugins are on right now. Saving a preset keeps which
                plugins are on and all their settings on this computer, secrets included. Exports leave private settings out.
            </Paragraph>
            <div className={cl("save-row")}>
                <TextInput value={name} onChange={v => setName(cleanInput(v))} placeholder="Preset name, e.g. minimal" />
                <Button size="small" disabled={!trimmed || saving} onClick={save}>{replaces ? "Replace" : "Save Current"}</Button>
                <Button size="small" variant="secondary" onClick={() => open(p => <ImportModal modalProps={p} />)}>Import</Button>
            </div>
            {replaces && <Paragraph className={cl("hint")}>A preset with this name exists. Saving replaces it with what's on now.</Paragraph>}
            {presets === null
                ? <Paragraph>Loading presets...</Paragraph>
                : presets.length
                    ? <div className={cl("rows")}>{presets.map(p => <PresetRow key={p.id} preset={p} />)}</div>
                    : <Paragraph className={cl("hint")}>No presets yet. Name one above and press Save Current.</Paragraph>}
        </div>
    );
}
