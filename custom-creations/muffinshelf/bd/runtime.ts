/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { copyToClipboard } from "@utils/clipboard";
import { Logger } from "@utils/Logger";

import { Native, settings } from "../settings";
import { BdApi, dataCache, DOM, Net } from "./api";
import { unpatchAll } from "./patcher";
import { clearWaits } from "./webpack";

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

const sep = (p: string) => p.replace(/\\/g, "/");
const baseName = (p: string) => sep(p).split("/").pop() ?? "";
const dirName = (p: string) => sep(p).split("/").slice(0, -1).join("/");

const pathShim = {
    sep: "/",
    delimiter: ";",
    join: (...parts: string[]) => sep(parts.filter(Boolean).join("/")).replace(/\/+/g, "/"),
    resolve: (...parts: string[]) => sep(parts.filter(Boolean).join("/")).replace(/\/+/g, "/"),
    normalize: (p: string) => sep(p).replace(/\/+/g, "/"),
    basename: (p: string, ext?: string) => {
        const b = baseName(p);
        return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
    },
    dirname: dirName,
    extname: (p: string) => baseName(p).match(/\.[^.]*$/)?.[0] ?? "",
    isAbsolute: (p: string) => /^([A-Za-z]:)?[\\/]/.test(p),
};

function inPluginFolder(p: string) {
    return sep(dirName(p)).toLowerCase() === sep(info.bdFolder).toLowerCase() && /\.plugin\.js$/.test(p);
}

function unsupported(name: string): never {
    throw new Error(`Muffinshelf doesn't give BetterDiscord plugins ${name}`);
}

const fsShim = {
    existsSync: (p: string) => sep(p).toLowerCase() === sep(info.bdFolder).toLowerCase() || (inPluginFolder(p) && plugins.has(baseName(p))),
    readFileSync(p: string) {
        const plugin = inPluginFolder(p) ? plugins.get(baseName(p)) : undefined;
        if (!plugin) unsupported(`file access outside its plugin folder (${baseName(p)})`);
        return plugin.code;
    },
    writeFileSync(p: string, data: string) {
        if (!inPluginFolder(p)) unsupported(`file writes outside its plugin folder (${baseName(p)})`);
        installBd(baseName(p), String(data)).catch(e => logger.error("Plugin self-update failed", e));
    },
    writeFile(p: string, data: string, ...rest: any[]) {
        const cb = rest.find(r => typeof r === "function");
        try {
            fsShim.writeFileSync(p, data);
            cb?.(null);
        } catch (e) {
            cb?.(e);
        }
    },
    readdirSync: (p: string) => sep(p).toLowerCase() === sep(info.bdFolder).toLowerCase() ? [...plugins.keys()] : [],
    mkdirSync() { },
    statSync: (p: string) => ({ isDirectory: () => !/\.\w+$/.test(p), isFile: () => /\.\w+$/.test(p), mtimeMs: Date.now(), size: 0 }),
    unlinkSync(p: string) {
        if (!inPluginFolder(p)) unsupported("file deletes outside its plugin folder");
        removeBd(baseName(p));
    },
    promises: {} as Record<string, any>,
};
fsShim.promises = {
    readFile: async (p: string) => fsShim.readFileSync(p),
    writeFile: async (p: string, d: string) => fsShim.writeFileSync(p, d),
};

function request(options: string | Record<string, any>, callback?: (err: any, res?: any, body?: any) => void) {
    const opts = typeof options === "string" ? { url: options } : options;
    const url = opts.url ?? opts.uri;
    Net.fetch(url, { method: opts.method, headers: opts.headers, body: opts.body })
        .then(async res => {
            const body = opts.encoding === null ? new Uint8Array(await res.arrayBuffer()) : await res.text();
            const headers: Record<string, string> = {};
            res.headers.forEach((v, k) => headers[k] = v);
            callback?.(null, { statusCode: res.status, statusMessage: res.statusText, headers }, body);
        })
        .catch(e => callback?.(e));
}
request.get = (o: any, cb?: any) => request(typeof o === "string" ? { url: o } : { ...o, method: "GET" }, cb);
request.post = (o: any, cb?: any) => request(typeof o === "string" ? { url: o, method: "POST" } : { ...o, method: "POST" }, cb);

const processShim = {
    platform: navigator.userAgent.includes("Windows") ? "win32" : navigator.userAgent.includes("Mac") ? "darwin" : "linux",
    env: {} as Record<string, string>,
    versions: {},
    cwd: () => "/",
};

function bdRequire(id: string) {
    switch (id.replace(/^node:/, "")) {
        case "path": return pathShim;
        case "fs": return fsShim;
        case "request": return request;
        case "process": return processShim;
        case "electron": return {
            shell: { openExternal: (url: string) => VencordNative.native.openExternal(url) },
            clipboard: { writeText: (t: string) => copyToClipboard(t) },
        };
        default: return unsupported(`require("${id}")`);
    }
}

function compile(file: string, code: string, meta: BdMeta) {
    const module = { exports: {} as any };
    const fallback = !/module\.exports|exports\.\w+\s*=|exports\[/.test(code) && /^[A-Za-z_$][\w$]*$/.test(meta.name)
        ? `\nmodule.exports = ${meta.name};`
        : "";
    const factory = (0, eval)(`(function(require, module, exports, __filename, __dirname, BdApi, global, process) {\n${code}${fallback}\n})\n//# sourceURL=muffinshelf-bd/${encodeURIComponent(file)}`);
    factory(bdRequire, module, module.exports, `${sep(info.bdFolder)}/${file}`, sep(info.bdFolder), BdApi, window, processShim);

    let exported = module.exports;
    if (exported?.__esModule && exported.default) exported = exported.default;
    if (exported && typeof exported === "object" && typeof exported[meta.name] === "function") exported = exported[meta.name];
    if (typeof exported === "function") {
        const isClass = /^class\b/.test(Function.prototype.toString.call(exported)) || typeof exported.prototype?.start === "function";
        return isClass ? new exported(meta) : exported(meta);
    }
    return exported;
}

function load(file: string, code: string) {
    const meta = parseMeta(code, file);
    const plugin: BdPlugin = { file, code, meta, enabled: settings.store.bdEnabled.includes(file), running: false };
    plugins.set(file, plugin);
    try {
        plugin.instance = compile(file, code, meta);
        if (!plugin.instance || typeof plugin.instance !== "object") throw new Error("This file doesn't look like a BetterDiscord plugin.");
        plugin.instance.load?.();
    } catch (e) {
        plugin.error = errorText(e);
        logger.error(`Couldn't load ${file}`, e);
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
    } catch (e) {
        plugin.error = errorText(e);
        logger.error(`${plugin.meta.name} failed to start`, e);
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
    plugin.running = false;
}

export async function startRuntime() {
    if (started || !settings.store.runBetterDiscord) return;
    started = true;
    const run = ++generation;
    try {
        const nativeInfo = await Native.getInfo();
        info.bdFolder = nativeInfo.bdFolder;
        info.bdDataFolder = nativeInfo.bdDataFolder;
        const data = await Native.readAllBdData();
        const files = await Native.listBdPlugins();
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
