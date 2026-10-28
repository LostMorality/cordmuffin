/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";

import { Native, setBroken, settings } from "../settings";
import { BdApi, dataCache, DOM } from "./api";
import { clearCommands, Commands } from "./extras";
import { applyFixes } from "./fixes";
import { Buffer, clearFiles, compatProblem, loadFiles, nodeRequire, processShim } from "./node";
import { unpatchAll } from "./patcher";
import { clearWaits, makeExportsWritable } from "./webpack";

const logger = new Logger("Muffinshelf");

export interface BdMeta {
    name: string;
    version?: string;
    description?: string;
    author?: string;
    source?: string;
    website?: string;
    [key: string]: string | undefined;
}

export interface BdPlugin {
    file: string;
    code: string;
    meta: BdMeta;
    instance?: any;
    enabled: boolean;
    running: boolean;
    error?: string;
}

export const info = { bdFolder: "", bdDataFolder: "" };

const plugins = new Map<string, BdPlugin>();
const listeners = new Set<() => void>();
let started = false;
let generation = 0;

export function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}

const emit = () => listeners.forEach(l => l());

export const getAll = () => [...plugins.values()];

export function find(idOrName: string) {
    return plugins.get(idOrName) ?? getAll().find(p => p.meta.name === idOrName || p.meta.id === idOrName);
}

export function parseMeta(code: string, file: string): BdMeta {
    const meta: BdMeta = { name: file.replace(/\.plugin\.js$/, "") };
    const block = code.match(/^\s*\/\*\*([\s\S]*?)\*\//);
    if (block) {
        for (const line of block[1].split("\n")) {
            const m = line.match(/^\s*\*?\s*@(\w+)\s+(.+?)\s*$/);
            if (m) meta[m[1]] = m[2];
        }
        return meta;
    }
    const legacy = code.match(/^\s*\/\/\s*META\s*({[\s\S]*?})\s*\*\/\//);
    if (legacy) {
        try {
            Object.assign(meta, JSON.parse(legacy[1]));
        } catch { }
    }
    return meta;
}

const fileHooks = {
    files: () => [...plugins.keys()],
    read: (file: string) => find(file)?.code ?? getAll().find(p => p.file.toLowerCase() === file.toLowerCase())?.code,
    // A plugin rewriting a file (self-update, a library updater) keeps it on or off, as BetterDiscord does.
    write: (file: string, code: string) => void installBd(file, code, false).catch(e => logger.error("Plugin self-update failed", e)),
    remove: (file: string) => void removeBd(file).catch(e => logger.error("Plugin self-delete failed", e)),
};

function compile(file: string, code: string, meta: BdMeta) {
    const module = { exports: {} as any };
    const fallback = !/module\.exports|exports\.\w+\s*=|exports\[/.test(code) && /^[A-Za-z_$][\w$]*$/.test(meta.name)
        ? `\nmodule.exports = ${meta.name};`
        : "";
    const factory = (0, eval)(`(function(require, module, exports, __filename, __dirname, BdApi, global, process, Buffer) {\n${code}${fallback}\n})\n//# sourceURL=muffinshelf-bd/${encodeURIComponent(file)}`);
    const folder = info.bdFolder.replace(/\\/g, "/");
    factory(nodeRequire, module, module.exports, `${folder}/${file}`, folder, BdApi, window, processShim, Buffer);

    let exported = module.exports;
    if (exported?.__esModule && exported.default) exported = exported.default;
    if (exported && typeof exported === "object" && typeof exported[meta.name] === "function") exported = exported[meta.name];
    if (typeof exported === "function") {
        const isClass = /^class\b/.test(Function.prototype.toString.call(exported)) || typeof exported.prototype?.start === "function";
        return isClass ? new exported(meta) : exported(meta);
    }
    return exported;
}

function fail(plugin: BdPlugin, what: string, e: unknown) {
    plugin.error = errorText(e);
    logger.error(`${plugin.meta.name} ${what}`, e);
    setBroken(plugin.meta.name, { version: plugin.meta.version, reason: plugin.error });
}

function load(file: string, code: string) {
    const meta = parseMeta(code, file);
    // BetterDiscord hands plugins these along with the header fields.
    meta.id ??= meta.name;
    meta.filename = file;
    meta.slug = file.replace(/\.plugin\.js$/, "").replace(/ /g, "-");
    const plugin: BdPlugin = { file, code, meta, enabled: settings.store.bdEnabled.includes(file), running: false };
    plugins.set(file, plugin);
    try {
        const problem = compatProblem(code);
        if (problem) throw new Error(problem);
        plugin.instance = compile(file, applyFixes(meta.name, meta.version, code), meta);
        if (!plugin.instance || typeof plugin.instance !== "object") throw new Error("This file doesn't look like a BetterDiscord plugin.");
        plugin.instance.load?.();
        setBroken(meta.name, null);
    } catch (e) {
        fail(plugin, "couldn't load", e);
        return plugin;
    }
    if (plugin.enabled) start(plugin);
    return plugin;
}

function errorText(e: unknown) {
    return e instanceof Error ? e.message : String(e);
}

function start(plugin: BdPlugin) {
    if (plugin.running || !plugin.instance) return;
    try {
        plugin.instance.start?.();
        plugin.running = true;
        plugin.error = undefined;
        setBroken(plugin.meta.name, null);
    } catch (e) {
        fail(plugin, "failed to start", e);
        unpatchAll(plugin.meta.name);
        DOM.removeStyle(plugin.meta.name);
    }
}

function stop(plugin: BdPlugin) {
    if (!plugin.running) return;
    try {
        plugin.instance?.stop?.();
    } catch (e) {
        logger.error(`${plugin.meta.name} failed to stop`, e);
    }
    unpatchAll(plugin.meta.name);
    DOM.removeStyle(plugin.meta.name);
    Commands.unregisterAll(plugin.meta.name);
    plugin.running = false;
}

const FIRST_RENDER = "app_first_render_after_ready_payload";

// BetterDiscord starts plugins once Discord has drawn its app, so the modules plugins look for are loaded by then.
function appRendered() {
    if (performance.getEntriesByName(FIRST_RENDER).length) return Promise.resolve();
    return new Promise<void>(resolve => {
        const done = () => {
            observer.disconnect();
            clearTimeout(timer);
            requestIdleCallback(() => resolve(), { timeout: 2000 });
        };
        const observer = new PerformanceObserver(list => {
            if (list.getEntriesByName(FIRST_RENDER).length) done();
        });
        observer.observe({ entryTypes: ["mark", "measure"] });
        const timer = setTimeout(done, 30_000);
    });
}

export async function startRuntime() {
    if (started || !settings.store.runBetterDiscord) return;
    started = true;
    const run = ++generation;
    try {
        await appRendered();
        if (run !== generation) return;
        const nativeInfo = await Native.getInfo();
        info.bdFolder = nativeInfo.bdFolder;
        info.bdDataFolder = nativeInfo.bdDataFolder;
        const data = await Native.readAllBdData();
        const files = await Native.listBdPlugins();
        if (run !== generation) return;

        await loadFiles(info.bdFolder, fileHooks);
        makeExportsWritable();
        if (run !== generation) return;

        Object.assign(dataCache, data);
        (window as any).BdApi = BdApi;
        const present = new Set(files.map(f => f.file));
        if (settings.store.bdEnabled.some(f => !present.has(f))) settings.store.bdEnabled = settings.store.bdEnabled.filter(f => present.has(f));
        for (const { file, code } of files) load(file, code);
    } catch (e) {
        logger.error("BetterDiscord runtime failed to start", e);
        if (run === generation) started = false;
    }
    emit();
}

export function stopRuntime() {
    generation++;
    for (const plugin of plugins.values()) stop(plugin);
    plugins.clear();
    clearWaits();
    clearFiles();
    clearCommands();
    document.getElementById("vc-muffinshelf-bd-styles")?.remove();
    delete (window as any).BdApi;
    started = false;
    emit();
}

export function setEnabled(idOrName: string, enabled: boolean) {
    const plugin = find(idOrName);
    if (!plugin) return;
    const list = settings.store.bdEnabled.filter(f => f !== plugin.file);
    settings.store.bdEnabled = enabled ? [...list, plugin.file] : list;
    plugin.enabled = enabled;
    if (enabled) start(plugin);
    else stop(plugin);
    emit();
}

export function reload(idOrName: string) {
    const plugin = find(idOrName);
    if (!plugin) return;
    stop(plugin);
    load(plugin.file, plugin.code);
    emit();
}

export async function installBd(file: string, code: string, enable = true) {
    await Native.writeBdPlugin(file, code);
    if (enable && !settings.store.bdEnabled.includes(file)) settings.store.bdEnabled = [...settings.store.bdEnabled, file];
    if (!started) return;
    const old = plugins.get(file);
    if (old) stop(old);
    load(file, code);
    emit();
}

export async function removeBd(file: string) {
    const plugin = plugins.get(file);
    if (plugin) stop(plugin);
    plugins.delete(file);
    settings.store.bdEnabled = settings.store.bdEnabled.filter(f => f !== file);
    await Native.removeBdPlugin(file);
    emit();
}

export function openSettings(file: string) {
    const plugin = plugins.get(file);
    return plugin?.running ? plugin.instance?.getSettingsPanel?.() : undefined;
}
