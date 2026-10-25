/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { FormSwitch } from "@components/FormSwitch";
import { HeadingSecondary, HeadingTertiary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import { escapeRegExp } from "@utils/text";
import type { RenderModalProps } from "@vencord/discord-types";
import { Alerts, Modal, openModal, Select, showToast, TextInput, useEffect, useMemo, useState } from "@webpack/common";

import { BdApi, toNode } from "./bd/api";
import * as Runtime from "./bd/runtime";
import { BuildResult, installBdEntry, installUserpluginEntries, rebuild, removeBdFile, removeUserplugin } from "./install";
import { getBdOrigin, Native, settings } from "./settings";
import { allSources, checkSourceUrl, customSource, equicordEquivalent, loadSource, ShelfEntry, SourceDef } from "./sources";

const cl = classNameFactory("vc-muffinshelf-");
const PAGE_SIZE = 60;
const SOURCE_KEYS: ("customSources" | "disabledSources")[] = ["customSources", "disabledSources"];
const RUN_KEYS: "runBetterDiscord"[] = ["runBetterDiscord"];

const TABS = { browse: "Browse", installed: "Installed", sources: "Sources", about: "How it works" } as const;
type Tab = keyof typeof TABS;

const KIND_LABEL = { userplugin: "Equicord plugin", bd: "BetterDiscord plugin", browse: "Can't run here" } as const;
const LIBRARY_FILES = new Set(["0PluginLibrary.plugin.js", "0BDFDB.plugin.js", "1XenoLib.plugin.js"]);

type Info = Awaited<ReturnType<typeof Native.getInfo>>;
type InstalledUserplugin = Awaited<ReturnType<typeof Native.listUserplugins>>[number];
type SourceState = { entries?: ShelfEntry[]; error?: string; loading: boolean; };

const status = { step: null as string | null, restartPending: false };
const statusListeners = new Set<() => void>();

function setStatus(update: Partial<typeof status>) {
    Object.assign(status, update);
    statusListeners.forEach(l => l());
}

function useStatus() {
    const [, setTick] = useState(0);
    useEffect(() => {
        const listener = () => setTick(t => t + 1);
        statusListeners.add(listener);
        return () => void statusListeners.delete(listener);
    }, []);
    return status;
}

function useRuntimeTick() {
    const [tick, setTick] = useState(0);
    useEffect(() => Runtime.subscribe(() => setTick(t => t + 1)), []);
    return tick;
}

const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const openLink = (url: string) => /^https?:\/\//.test(url) && VencordNative.native.openExternal(url);

function isNewer(installed: string, available: string) {
    const semver = /^\d+(\.\d+)*$/;
    if (semver.test(installed) && semver.test(available)) return BdApi.Utils.semverCompare(installed, available) > 0;
    return installed !== available;
}

function openBdSettings(file: string) {
    const panel = Runtime.openSettings(file);
    if (!panel) return;
    const plugin = Runtime.find(file);
    openModal(props => (
        <ErrorBoundary>
            <Modal {...props} size="lg" title={`${plugin?.meta.name ?? file} settings`} actions={[{ text: "Done", variant: "primary", onClick: props.onClose }]}>
                {toNode(panel)}
            </Modal>
        </ErrorBoundary>
    ));
}

function confirm(title: string, body: string, confirmText: string) {
    return new Promise<boolean>(resolve => Alerts.show({ title, body, confirmText, cancelText: "Cancel", onConfirm: () => resolve(true), onCancel: () => resolve(false) }));
}

function showBuildError(result: BuildResult) {
    Alerts.show({
        title: "The rebuild didn't work",
        body: (
            <div>
                <Paragraph>Your plugins were put back the way they were, so Discord keeps working as before. The end of the build log is below.</Paragraph>
                <pre className={cl("log")}>{result.log.slice(-3000)}</pre>
            </div>
        ),
        confirmText: "Close",
    });
}

async function runBuild(task: (step: (t: string) => void) => Promise<BuildResult>) {
    try {
        const result = await task(step => setStatus({ step }));
        if (result.ok) {
            setStatus({ restartPending: true });
            showToast({ text: "Done. Restart Discord to load the change.", variant: "success" });
        } else {
            showBuildError(result);
        }
    } catch (e) {
        showToast({ text: errorText(e), variant: "critical" });
    } finally {
        setStatus({ step: null });
    }
}

function StatusBanners() {
    const { step, restartPending } = useStatus();
    return (
        <>
            {step && <div className={cl("banner", "banner-busy")}><Paragraph>{step}</Paragraph></div>}
            {restartPending && !step && (
                <div className={cl("banner")}>
                    <Paragraph>Equicord was rebuilt. Restart Discord to load the change.</Paragraph>
                    <Button size="small" variant="positive" onClick={() => Native.relaunch()}>Restart Discord</Button>
                </div>
            )}
        </>
    );
}

interface CardProps {
    entry: ShelfEntry;
    source?: SourceDef;
    installed: InstalledUserplugin[];
    bdFiles: Set<string>;
    busy: boolean;
    onInstall(entry: ShelfEntry): void;
}

function EntryCard({ entry, source, installed, bdFiles, busy, onInstall }: CardProps) {
    const upInstalled = entry.userplugin ? installed.find(p => p.entryKey === entry.key) : undefined;
    const bdInstalled = entry.bd ? bdFiles.has(entry.bd.file) : false;
    const isInstalled = !!upInstalled || bdInstalled;
    const installedVersion = entry.bd
        ? Runtime.find(entry.bd.file)?.meta.version ?? getBdOrigin(entry.bd.file)?.version
        : upInstalled?.version;
    const hasUpdate = !!(isInstalled && entry.version && installedVersion && isNewer(installedVersion, entry.version));
    const builtIn = isInstalled ? undefined : equicordEquivalent(entry.name);
    const meta = [entry.author && `by ${entry.author}`, entry.version && (/^[0-9a-f]{7}$/.test(entry.version) ? entry.version : `v${entry.version}`), entry.downloads ? `${entry.downloads.toLocaleString()} downloads` : null].filter(Boolean).join(" · ");

    return (
        <div className={cl("card", `card-${entry.kind}`)}>
            {entry.image && <img className={cl("thumb")} src={entry.image} loading="lazy" alt="" />}
            <div className={cl("card-head")}>
                <HeadingTertiary className={cl("card-title")}>{entry.name}</HeadingTertiary>
                <span className={cl("badge", `badge-${entry.kind}`)}>{KIND_LABEL[entry.kind]}</span>
            </div>
            {meta && <Paragraph size="xs" className={cl("meta")}>{meta}</Paragraph>}
            <Paragraph size="sm" className={cl("desc")}>{entry.description || "No description."}</Paragraph>
            {builtIn && <Paragraph size="xs" className={cl("builtin")}>Equicord already has this as {builtIn}. Turn it on in Equicord's Plugins page.</Paragraph>}
            <Paragraph size="xs" className={cl("meta")}>From {source?.name ?? entry.sourceId}</Paragraph>
            <div className={cl("card-actions")}>
                {entry.kind !== "browse" && (
                    <Button
                        size="small"
                        variant={hasUpdate ? "positive" : isInstalled ? "secondary" : "primary"}
                        disabled={busy || (isInstalled && !hasUpdate)}
                        onClick={() => onInstall(entry)}
                    >
                        {hasUpdate ? "Update" : isInstalled ? "Installed" : "Install"}
                    </Button>
                )}
                {entry.homepage && (
                    <Button size="small" variant="secondary" onClick={() => openLink(entry.homepage as string)}>
                        {entry.kind === "browse" ? "Open page" : "Source"}
                    </Button>
                )}
            </div>
        </div>
    );
}

const SORTS = [
    { label: "Most downloaded", value: "popular" },
    { label: "Recently updated", value: "updated" },
    { label: "Name", value: "name" },
];

const KINDS = [
    { label: "New to Equicord", value: "new" },
    { label: "Runs on Equicord", value: "runnable" },
    { label: "Already in Equicord", value: "builtin" },
    { label: "Everything", value: "all" },
    { label: "Equicord plugins", value: "userplugin" },
    { label: "BetterDiscord plugins", value: "bd" },
    { label: "Can't run here", value: "browse" },
];

interface BrowseProps {
    states: Record<string, SourceState>;
    sources: SourceDef[];
    installed: InstalledUserplugin[];
    bdFiles: Set<string>;
    info: Info | null;
    busy: boolean;
    onInstall(e: ShelfEntry): void;
}

function BrowseTab({ states, sources, installed, bdFiles, info, busy, onInstall }: BrowseProps) {
    const [query, setQuery] = useState("");
    const [sourceId, setSourceId] = useState("");
    const [kind, setKind] = useState("new");
    const [sort, setSort] = useState("popular");
    const [limit, setLimit] = useState(PAGE_SIZE);

    const { entries, hiddenBuiltIn } = useMemo(() => {
        const q = query.trim().toLowerCase();
        const word = q ? new RegExp(`\\b${escapeRegExp(q)}`, "i") : null;
        const ours = (e: ShelfEntry) => e.bd ? bdFiles.has(e.bd.file) : installed.some(p => p.entryKey === e.key);
        const isBuiltIn = (e: ShelfEntry) => !ours(e) && !!equicordEquivalent(e.name);
        const nameHit = (e: ShelfEntry) => !q || e.name.toLowerCase().includes(q);
        const matches = (e: ShelfEntry) => !word || nameHit(e) || e.author.toLowerCase().includes(q) || word.test(e.description);

        let hidden = 0;
        const list = sources.flatMap(s => states[s.id]?.entries ?? []).filter(e => {
            if (e.hidden || (sourceId && e.sourceId !== sourceId)) return false;
            if (kind === "new" || kind === "builtin") {
                if (e.kind === "browse") return false;
                if (isBuiltIn(e) !== (kind === "builtin")) {
                    if (kind === "new" && q && matches(e)) hidden++;
                    return false;
                }
            } else if (kind === "runnable" ? e.kind === "browse" : kind !== "all" && e.kind !== kind) return false;
            return matches(e);
        });

        list.sort((a, b) =>
            (q ? Number(nameHit(b)) - Number(nameHit(a)) : 0)
            || (sort === "name" ? a.name.localeCompare(b.name)
                : sort === "updated" ? (b.updated ?? 0) - (a.updated ?? 0)
                    : (b.downloads ?? 0) - (a.downloads ?? 0) || a.name.localeCompare(b.name)));
        return { entries: list, hiddenBuiltIn: hidden };
    }, [states, sources, installed, bdFiles, query, sourceId, kind, sort]);

    useEffect(() => setLimit(PAGE_SIZE), [query, sourceId, kind, sort]);

    const loading = sources.some(s => states[s.id]?.loading);
    const failed = sources.filter(s => states[s.id]?.error);
    const bySource = Object.fromEntries(sources.map(s => [s.id, s]));

    return (
        <>
            <div className={cl("toolbar")}>
                <div className={cl("search")}>
                    <TextInput value={query} onChange={setQuery} placeholder="Search plugins, descriptions and authors" autoFocus />
                </div>
                <div className={cl("select")}>
                    <Select options={[{ label: "All sources", value: "" }, ...sources.map(s => ({ label: s.name, value: s.id }))]} select={setSourceId} isSelected={v => v === sourceId} serialize={String} />
                </div>
                <div className={cl("select")}>
                    <Select options={KINDS} select={setKind} isSelected={v => v === kind} serialize={String} />
                </div>
                <div className={cl("select")}>
                    <Select options={SORTS} select={setSort} isSelected={v => v === sort} serialize={String} />
                </div>
            </div>
            {info?.build.kind === "none" && (
                <div className={cl("note")}>
                    <Paragraph size="sm">{info.build.reason}</Paragraph>
                </div>
            )}
            {failed.map(s => (
                <div key={s.id} className={cl("note", "note-error")}>
                    <Paragraph size="sm">{s.name} didn't load: {states[s.id].error}</Paragraph>
                </div>
            ))}
            {hiddenBuiltIn > 0 && (
                <div className={cl("note")}>
                    <Paragraph size="sm">{hiddenBuiltIn} more {hiddenBuiltIn === 1 ? "match is" : "matches are"} already in Equicord, so {hiddenBuiltIn === 1 ? "it's" : "they're"} hidden.</Paragraph>
                    <Button size="small" variant="secondary" onClick={() => setKind("builtin")}>Show {hiddenBuiltIn === 1 ? "it" : "them"}</Button>
                </div>
            )}
            {entries.length
                ? (
                    <div className={cl("grid")}>
                        {entries.slice(0, limit).map(e => <EntryCard key={e.key} entry={e} source={bySource[e.sourceId]} installed={installed} bdFiles={bdFiles} busy={busy} onInstall={onInstall} />)}
                    </div>
                )
                : <Paragraph className={cl("empty")}>{loading ? "Loading plugins..." : "No plugins match."}</Paragraph>}
            {limit < entries.length && (
                <div className={cl("more")}>
                    <Button variant="secondary" onClick={() => setLimit(l => l + PAGE_SIZE)}>Show more ({(entries.length - limit).toLocaleString()} left)</Button>
                </div>
            )}
        </>
    );
}

function InstalledTab({ installed, info, busy }: { installed: InstalledUserplugin[]; info: Info | null; busy: boolean; }) {
    useRuntimeTick();
    const bdPlugins = Runtime.getAll();
    const { runBetterDiscord } = settings.use(RUN_KEYS);
    const missing = installed.filter(p => p.missing);

    return (
        <>
            <HeadingSecondary>Equicord plugins added by Muffinshelf</HeadingSecondary>
            {info?.build.kind === "none" && <Paragraph size="sm" className={cl("meta")}>{info.build.reason}</Paragraph>}
            {missing.length > 0 && (
                <div className={cl("note")}>
                    <Paragraph size="sm">An Equicord update removed {missing.length} of your plugins. Rebuild to put {missing.length === 1 ? "it" : "them"} back.</Paragraph>
                    <Button size="small" disabled={busy} onClick={() => runBuild(rebuild)}>Rebuild</Button>
                </div>
            )}
            {installed.length
                ? installed.map(p => (
                    <div key={p.folder} className={cl("row")}>
                        <div className={cl("row-text")}>
                            <Paragraph weight="semibold">{p.pluginName ?? p.folder}{p.missing ? " (removed by an update)" : ""}</Paragraph>
                            <Paragraph size="xs" className={cl("meta")}>github.com/{p.owner}/{p.repo}{p.path ? `/${p.path}` : ""} · src/userplugins/{p.folder}</Paragraph>
                        </div>
                        <Button
                            size="small"
                            variant="dangerSecondary"
                            disabled={busy}
                            onClick={async () => {
                                setStatus({ step: "Waiting for you to confirm..." });
                                const ok = await confirm(`Remove ${p.pluginName ?? p.folder}?`, "Muffinshelf deletes its folder and rebuilds Equicord. Discord needs a restart after.", "Remove");
                                if (ok) await runBuild(step => removeUserplugin(p.folder, step));
                                else setStatus({ step: null });
                            }}
                        >
                            Remove
                        </Button>
                    </div>
                ))
                : <Paragraph size="sm" className={cl("meta")}>None yet.</Paragraph>}

            <HeadingSecondary className={cl("section")}>BetterDiscord plugins</HeadingSecondary>
            <FormSwitch
                title="Run BetterDiscord plugins"
                description="Turning this off stops every BetterDiscord plugin right away. Their files are kept."
                value={runBetterDiscord}
                onChange={v => settings.store.runBetterDiscord = v}
            />
            <div className={cl("row-buttons")}>
                <Button size="small" variant="secondary" onClick={() => Native.openFolder("bd")}>Open plugin folder</Button>
                <Button size="small" variant="secondary" disabled={!runBetterDiscord} onClick={() => { Runtime.stopRuntime(); Runtime.startRuntime(); }}>Reload all</Button>
            </div>
            {!runBetterDiscord && <Paragraph size="sm" className={cl("meta")}>Turned off. Turn it on to see and use your BetterDiscord plugins.</Paragraph>}
            {runBetterDiscord && (bdPlugins.length
                ? bdPlugins.map(p => (
                    <div key={p.file} className={cl("row")}>
                        <div className={cl("row-text")}>
                            <Paragraph weight="semibold">{p.meta.name}{p.meta.version ? ` v${p.meta.version}` : ""}{LIBRARY_FILES.has(p.file) ? " (library)" : ""}</Paragraph>
                            <Paragraph size="xs" className={cl("meta")}>{p.meta.author ? `by ${p.meta.author} · ` : ""}{p.file}</Paragraph>
                            {p.error && <Paragraph size="xs" className={cl("error")}>{p.error}</Paragraph>}
                        </div>
                        {p.running && typeof p.instance?.getSettingsPanel === "function" && (
                            <Button size="small" variant="secondary" onClick={() => openBdSettings(p.file)}>Settings</Button>
                        )}
                        <FormSwitch title="" value={p.enabled} onChange={v => Runtime.setEnabled(p.file, v)} hideBorder />
                        <Button
                            size="small"
                            variant="dangerSecondary"
                            onClick={async () => {
                                if (!await confirm(`Remove ${p.meta.name}?`, "Muffinshelf stops it and deletes its file. Its saved settings are kept.", "Remove")) return;
                                try {
                                    await removeBdFile(p.file);
                                } catch (e) {
                                    showToast({ text: errorText(e), variant: "critical" });
                                }
                            }}
                        >
                            Remove
                        </Button>
                    </div>
                ))
                : <Paragraph size="sm" className={cl("meta")}>None yet.</Paragraph>)}
        </>
    );
}

function SourcesTab({ states, reload }: { states: Record<string, SourceState>; reload(source: SourceDef): void; }) {
    const { customSources, disabledSources } = settings.use(SOURCE_KEYS);
    const [url, setUrl] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [checking, setChecking] = useState(false);
    const sources = allSources();

    const add = async () => {
        const link = url.trim();
        const problem = checkSourceUrl(link);
        if (problem) return setError(problem);
        if (customSources.includes(link)) return setError("That source is already added.");
        setChecking(true);
        setError(null);
        try {
            const entries = await loadSource(customSource(link), true);
            const count = entries.filter(e => !e.hidden).length;
            if (!count) throw new Error("Nothing Muffinshelf can list was found there.");
            settings.store.customSources = [...customSources, link];
            setUrl("");
            showToast({ text: `Added. Found ${count} ${count === 1 ? "plugin" : "plugins"}.`, variant: "success" });
        } catch (e) {
            setError(errorText(e));
        } finally {
            setChecking(false);
        }
    };

    return (
        <>
            <HeadingSecondary>Add your own source</HeadingSecondary>
            <Paragraph size="sm" className={cl("meta")}>
                Paste a GitHub repo (or a folder in one), a venpm plugins.json link, or a link to a single .plugin.js file.
            </Paragraph>
            <div className={cl("toolbar")}>
                <div className={cl("search")}>
                    <TextInput value={url} onChange={setUrl} placeholder="https://github.com/someone/their-plugins" onKeyDown={e => {
                        if (e.key === "Enter" && !checking && url.trim()) add();
                    }} />
                </div>
                <Button disabled={checking || !url.trim()} onClick={add}>{checking ? "Checking..." : "Add"}</Button>
            </div>
            {error && <Paragraph size="sm" className={cl("error")}>{error}</Paragraph>}

            <HeadingSecondary className={cl("section")}>Where plugins come from</HeadingSecondary>
            {sources.map(s => {
                const state = states[s.id];
                const count = state?.entries?.filter(e => !e.hidden).length;
                const on = !disabledSources.includes(s.id);
                const status = !on ? "off" : state?.loading ? "loading" : state?.error ? `failed: ${state.error}` : count != null ? `${count} ${count === 1 ? "plugin" : "plugins"}` : "not loaded";
                return (
                    <div key={s.id} className={cl("row")}>
                        <div className={cl("row-text")}>
                            <Paragraph weight="semibold">{s.name}{s.custom ? " (yours)" : ""}</Paragraph>
                            <Paragraph size="xs" className={cl("meta")}>{s.what}</Paragraph>
                            <Paragraph size="xs" className={cl(state?.error && on ? "error" : "meta")}>{s.url} · {status}</Paragraph>
                        </div>
                        <Button size="small" variant="secondary" disabled={!on || state?.loading} onClick={() => reload(s)}>{state?.error ? "Try again" : "Refresh"}</Button>
                        {s.custom && (
                            <Button size="small" variant="dangerSecondary" onClick={() => settings.store.customSources = customSources.filter(c => `custom:${c}` !== s.id)}>Remove</Button>
                        )}
                        <FormSwitch
                            title=""
                            value={on}
                            hideBorder
                            onChange={v => settings.store.disabledSources = v ? disabledSources.filter(d => d !== s.id) : [...disabledSources, s.id]}
                        />
                    </div>
                );
            })}
        </>
    );
}

function AboutTab({ info }: { info: Info | null; }) {
    const build = info?.build;
    return (
        <div className={cl("about")}>
            <HeadingSecondary>What Muffinshelf does</HeadingSecondary>
            <Paragraph>
                Muffinshelf is a plugin store for things Equicord doesn't ship: community Equicord and Vencord userplugins, and BetterDiscord plugins.
                It also lists plugins from shelter, Moonlight, Replugged and Evi so you can find them, even though those can't run on Equicord.
            </Paragraph>

            <HeadingSecondary className={cl("section")}>How installing works</HeadingSecondary>
            <Paragraph>
                <b>Equicord plugins</b> are source code, so they have to be built into Equicord. Muffinshelf downloads the plugin's folder from GitHub into
                your Equicord source's userplugins folder, rebuilds Equicord, and turns the plugin on. Restart Discord afterwards to load it.
                If anything goes wrong, your plugins are put back the way they were and Discord keeps working as before.
            </Paragraph>
            <Paragraph>
                <b>BetterDiscord plugins</b> are single .plugin.js files. Muffinshelf saves the file and runs it through its own BetterDiscord layer,
                which provides the BdApi these plugins expect. No rebuild or restart is needed. Plugins that need ZeresPluginLibrary, BDFDB or XenoLib
                get that library installed with them. Most BetterDiscord plugins work, but ones that dig into BetterDiscord's own internals or need Node file access may not.
            </Paragraph>
            <Paragraph>
                <b>shelter, Moonlight, Replugged and Evi</b> plugins are built for different mods with different ways of changing Discord. Nothing can run them on Equicord,
                so Muffinshelf only links to them.
            </Paragraph>

            <HeadingSecondary className={cl("section")}>Where everything comes from</HeadingSecondary>
            <ul className={cl("list")}>
                {allSources().map(s => <li key={s.id}><Paragraph size="sm"><b>{s.name}</b>: {s.url}</Paragraph></li>)}
            </ul>
            <Paragraph size="sm" className={cl("meta")}>
                Downloads come straight from GitHub and the stores above. Muffinshelf has no server of its own and sends nothing anywhere else.
                You can turn any source off or add your own in the Sources tab.
            </Paragraph>

            <HeadingSecondary className={cl("section")}>Where files go</HeadingSecondary>
            <ul className={cl("list")}>
                <li><Paragraph size="sm"><b>Equicord plugins:</b> {build && build.kind !== "none" ? build.userplugins : "unavailable on this install"}</Paragraph></li>
                <li><Paragraph size="sm"><b>BetterDiscord plugins:</b> {info?.bdFolder}</Paragraph></li>
                <li><Paragraph size="sm"><b>BetterDiscord plugin settings:</b> {info?.bdDataFolder}</Paragraph></li>
            </ul>
            <Paragraph size="sm" className={cl("meta")}>
                {build?.kind === "source" && "Equicord was found as a source checkout, so rebuilds use your own pnpm."}
                {build?.kind === "cordmuffin" && "Equicord was installed by Cordmuffin, so rebuilds use Cordmuffin's own Node.js and copy the result into place."}
                {build?.kind === "none" && build.reason}
            </Paragraph>

            <HeadingSecondary className={cl("section")}>Before you install</HeadingSecondary>
            <Paragraph>
                Plugins are code that runs inside your Discord with full access to your account. Only install ones from people you trust, and check the Source button if you're unsure.
            </Paragraph>
        </div>
    );
}

function Shelf({ modalProps }: { modalProps: RenderModalProps; }) {
    const { customSources, disabledSources } = settings.use(SOURCE_KEYS);
    const { step } = useStatus();
    const runtimeTick = useRuntimeTick();
    const [tab, setTab] = useState<Tab>("browse");
    const [states, setStates] = useState<Record<string, SourceState>>({});
    const [info, setInfo] = useState<Info | null>(null);
    const [installed, setInstalled] = useState<InstalledUserplugin[]>([]);
    const [bdFiles, setBdFiles] = useState<Set<string>>(new Set());

    const customKey = customSources.join("\n");
    const disabledKey = disabledSources.join("\n");
    const sources = useMemo(() => allSources().filter(s => !disabledSources.includes(s.id)), [customKey, disabledKey]);
    const busy = !!step;

    const load = (source: SourceDef, force = false) => {
        setStates(s => ({ ...s, [source.id]: { ...s[source.id], loading: true, error: undefined } }));
        loadSource(source, force).then(
            entries => setStates(s => ({ ...s, [source.id]: { entries, loading: false } })),
            e => setStates(s => ({ ...s, [source.id]: { loading: false, error: errorText(e) } }))
        );
    };

    useEffect(() => {
        Native.getInfo().then(setInfo);
        Native.isBuilding().then(running => running && !status.step && setStatus({ step: "A rebuild is still running..." }));
    }, []);

    useEffect(() => {
        if (!step) Native.listUserplugins().then(setInstalled);
    }, [step]);

    useEffect(() => {
        Native.listBdFiles().then(files => setBdFiles(new Set(files)));
    }, [runtimeTick, step]);

    useEffect(() => {
        for (const s of sources) if (!(s.id in states)) load(s);
    }, [sources]);

    const install = async (entry: ShelfEntry) => {
        if (entry.bd) {
            setStatus({ step: `Installing ${entry.name}...` });
            try {
                const libs = await installBdEntry(entry);
                const extra = libs.length ? ` and ${libs.join(", ")}` : "";
                showToast(settings.store.runBetterDiscord
                    ? { text: `Installed ${entry.name}${extra}.`, variant: "success" }
                    : { text: `Saved ${entry.name}${extra}. Turn on "Run BetterDiscord plugins" in the Installed tab to use it.`, variant: "default" });
            } catch (e) {
                showToast({ text: errorText(e), variant: "critical" });
            } finally {
                setStatus({ step: null });
            }
            return;
        }

        if (!entry.userplugin) return;
        if (info?.build.kind === "none") {
            Alerts.show({ title: "Can't add Equicord plugins here", body: info.build.reason, confirmText: "Okay" });
            return;
        }
        setStatus({ step: "Waiting for you to confirm..." });
        const pool = Object.values(states).flatMap(s => s.entries ?? []);
        const deps = entry.userplugin.dependencies
            .map(name => pool.find(e => e.sourceId === entry.sourceId && e.name === name))
            .filter((e): e is ShelfEntry => !!e && !installed.some(p => p.entryKey === e.key && !p.missing));
        const up = entry.userplugin;
        const ok = await confirm(
            `Install ${entry.name}?`,
            `Muffinshelf downloads it from github.com/${up.owner}/${up.repo}${deps.length ? `, along with ${deps.map(d => d.name).join(", ")} which it needs,` : ""} into your Equicord source and rebuilds Equicord. Discord needs a restart after.`,
            "Install"
        );
        if (ok) await runBuild(s => installUserpluginEntries([...deps, entry], s));
        else setStatus({ step: null });
    };

    let installable = 0;
    for (const s of sources) {
        for (const e of states[s.id]?.entries ?? []) if (!e.hidden && e.kind !== "browse" && !equicordEquivalent(e.name)) installable++;
    }
    const installedCount = installed.filter(p => !p.missing).length + [...bdFiles].filter(f => !LIBRARY_FILES.has(f)).length;

    return (
        <Modal
            {...modalProps}
            size="xxl"
            title="Muffinshelf"
            subtitle={installable ? `${installable.toLocaleString()} plugins Equicord doesn't ship` : "Plugins Equicord doesn't ship"}
        >
            <div className={cl("body")}>
                <div className={cl("tabs")}>
                    {(Object.keys(TABS) as Tab[]).map(key => (
                        <Button key={key} size="small" variant={tab === key ? "primary" : "secondary"} onClick={() => setTab(key)}>
                            {TABS[key]}{key === "installed" && installedCount ? ` (${installedCount})` : ""}
                        </Button>
                    ))}
                </div>
                <StatusBanners />
                {tab === "browse" && <BrowseTab states={states} sources={sources} installed={installed} bdFiles={bdFiles} info={info} busy={busy} onInstall={install} />}
                {tab === "installed" && <InstalledTab installed={installed} info={info} busy={busy} />}
                {tab === "sources" && <SourcesTab states={states} reload={s => load(s, true)} />}
                {tab === "about" && <AboutTab info={info} />}
            </div>
        </Modal>
    );
}

export function openShelf() {
    openModal(props => (
        <ErrorBoundary>
            <Shelf modalProps={props} />
        </ErrorBoundary>
    ));
}
