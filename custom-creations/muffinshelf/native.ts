/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import { spawn } from "child_process";
import { app, dialog, IpcMainInvokeEvent, shell } from "electron";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from "fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "fs/promises";
import originalFs from "original-fs";
import { basename, dirname, join, relative, resolve } from "path";
import { promisify } from "util";
import { inflateRaw } from "zlib";

const SHELF_DIR = join(DATA_DIR, "muffinshelf");
const BD_PLUGINS = join(SHELF_DIR, "bd", "plugins");
const BD_DATA = join(SHELF_DIR, "bd", "data");
const SAVED_USERPLUGINS = join(SHELF_DIR, "userplugins");
const MARKER = ".muffinshelf.json";
const WORK_FOLDER = ".muffinshelf-work";

const MAX_RESPONSE = 30 * 1024 * 1024;
const MAX_PLUGIN_FILES = 400;
const MAX_FILE = 20 * 1024 * 1024;
const BUILD_TIMEOUT = 15 * 60 * 1000;
const REPO_CACHE_MS = 10 * 60 * 1000;
const REPO_CACHE_MAX = 4;

const FOLDER_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const BD_FILE = /^[^\\/:*?"<>|]{1,120}\.plugin\.js$/;
const DEFINE_NAME = /definePlugin\(\s*{[\s\S]{0,4000}?\n\s*name:\s*["'`]([^"'`]+)["'`]/;

const inflate = promisify(inflateRaw);
const copyTree = (from: string, to: string) => originalFs.promises.cp(from, to, { recursive: true, force: true });
const removeTree = (path: string) => originalFs.promises.rm(path, { recursive: true, force: true });

const distDir = ["desktop", "equibop", "vesktop"].includes(basename(__dirname)) ? dirname(__dirname) : __dirname;

export type BuildMode =
    | { kind: "source"; root: string; }
    | { kind: "cordmuffin"; root: string; work: string; node: string; }
    | { kind: "none"; reason: string; };

export interface UserpluginMarker {
    folder: string;
    pluginName?: string;
    owner: string;
    repo: string;
    ref: string;
    path: string;
    sourceId: string;
    entryKey: string;
    version?: string;
    installedAt: number;
}

export interface InstallRequest {
    folder: string;
    owner: string;
    repo: string;
    ref?: string;
    path: string;
    sourceId: string;
    entryKey: string;
    version?: string;
}

function isEquicordSource(dir: string) {
    try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        return /equicord|vencord/i.test(pkg.name ?? "") && existsSync(join(dir, "src", "plugins"));
    } catch {
        return false;
    }
}

function findNode(work: string) {
    const root = join(work, "node");
    try {
        for (const entry of readdirSync(root)) {
            if (existsSync(join(root, entry, "node.exe"))) return join(root, entry);
        }
    } catch { }
    return null;
}

function detectBuild(): BuildMode {
    const parent = dirname(distDir);
    if (isEquicordSource(parent)) return { kind: "source", root: parent };

    const work = join(process.env.LOCALAPPDATA ?? "", "Cordmuffin");
    const src = join(work, "equicord");
    if (process.env.LOCALAPPDATA && resolve(distDir) === resolve(work, "dist") && isEquicordSource(src)) {
        const node = findNode(work);
        if (node) return { kind: "cordmuffin", root: src, work, node };
        return { kind: "none", reason: "Cordmuffin's copy of Node.js is missing. Run the Cordmuffin installer again to fix it." };
    }

    return {
        kind: "none",
        reason: "This Equicord wasn't built from source on this PC (for example it came from the official installer), so Equicord plugins can't be added. BetterDiscord plugins still work."
    };
}

function readBanner() {
    try {
        const fd = openSync(join(__dirname, "renderer.js"), "r");
        try {
            const buf = Buffer.alloc(512);
            return buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, 0));
        } finally {
            closeSync(fd);
        }
    } catch {
        return "";
    }
}

const userpluginsDir = (mode: BuildMode) => mode.kind === "none" ? null : join(mode.root, "src", "userplugins");
const workDir = (mode: Exclude<BuildMode, { kind: "none"; }>) => join(mode.root, WORK_FOLDER);

function childOf(parent: string, name: string) {
    if (!FOLDER_NAME.test(name)) throw new Error(`"${name}" can't be used as a folder name`);
    const path = resolve(parent, name);
    if (dirname(path) !== resolve(parent)) throw new Error(`"${name}" can't be used as a folder name`);
    return path;
}

function requireBuild() {
    const mode = detectBuild();
    if (mode.kind === "none") throw new Error(mode.reason);
    return mode;
}

async function readJson<T>(file: string): Promise<T | null> {
    try {
        return JSON.parse(await readFile(file, "utf8"));
    } catch {
        return null;
    }
}

async function boundedFetch(url: string, init: RequestInit = {}) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000), redirect: "follow" });
    const tooBig = () => new Error(`The download from ${new URL(url).host} is too big`);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_RESPONSE) throw tooBig();

    const chunks: Uint8Array[] = [];
    let size = 0;
    if (res.body) {
        const reader = res.body.getReader();
        for (let r = await reader.read(); !r.done; r = await reader.read()) {
            size += r.value.length;
            if (size > MAX_RESPONSE) {
                await reader.cancel();
                throw tooBig();
            }
            chunks.push(r.value);
        }
    }
    return { res, body: Buffer.concat(chunks) };
}

function checkUrl(url: string, allowHttp = false) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:"))
        throw new Error(`Only ${allowHttp ? "http and https" : "https"} links are allowed`);
    return parsed;
}

export function getInfo(_: IpcMainInvokeEvent) {
    const mode = detectBuild();
    return {
        build: mode.kind === "none"
            ? { kind: mode.kind, reason: mode.reason }
            : { kind: mode.kind, root: mode.root, userplugins: userpluginsDir(mode) },
        bdFolder: BD_PLUGINS,
        bdDataFolder: BD_DATA,
    };
}

export async function fetchText(_: IpcMainInvokeEvent, url: string, accept?: string) {
    checkUrl(url);
    const headers: Record<string, string> = { "User-Agent": "Muffinshelf" };
    if (accept) headers.Accept = accept;
    const { res, body } = await boundedFetch(url, { headers });
    return { ok: res.ok, status: res.status, text: body.toString("utf8") };
}

export interface NetRequest {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    bodyBase64?: string;
}

export async function netFetch(_: IpcMainInvokeEvent, url: string, req: NetRequest = {}) {
    checkUrl(url, true);
    const body = req.bodyBase64 != null ? Buffer.from(req.bodyBase64, "base64") : req.body;
    const { res, body: data } = await boundedFetch(url, { method: req.method ?? "GET", headers: req.headers, body });
    return {
        status: res.status,
        statusText: res.statusText,
        url: res.url,
        headers: [...res.headers.entries()],
        bodyBase64: data.toString("base64"),
    };
}

interface ZipEntry {
    method: number;
    size: number;
    data: Buffer;
}

interface RepoArchive {
    commit: string | null;
    entries: Map<string, ZipEntry>;
}

const archiveCache = new Map<string, { at: number; promise: Promise<RepoArchive>; }>();

function readZip(zip: Buffer): RepoArchive {
    let eocd = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
        if (zip.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd === -1) throw new Error("GitHub sent a broken download");

    const count = zip.readUInt16LE(eocd + 10);
    const comment = zip.toString("utf8", eocd + 22, eocd + 22 + zip.readUInt16LE(eocd + 20)).trim();
    const entries = new Map<string, ZipEntry>();
    let offset = zip.readUInt32LE(eocd + 16);

    for (let i = 0; i < count; i++) {
        if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("GitHub sent a broken download");
        const method = zip.readUInt16LE(offset + 10);
        const compressed = zip.readUInt32LE(offset + 20);
        const size = zip.readUInt32LE(offset + 24);
        const nameLength = zip.readUInt16LE(offset + 28);
        const local = zip.readUInt32LE(offset + 42);
        const name = zip.toString("utf8", offset + 46, offset + 46 + nameLength);
        offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);

        if (name.endsWith("/") || (method !== 0 && method !== 8)) continue;
        if (local + 30 > zip.length) throw new Error("GitHub sent a broken download");
        const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
        if (start + compressed > zip.length) throw new Error("GitHub sent a broken download");
        entries.set(name.split("/").slice(1).join("/"), { method, size, data: zip.subarray(start, start + compressed) });
    }

    return { commit: /^[0-9a-f]{40}$/.test(comment) ? comment : null, entries };
}

async function unpack(entry: ZipEntry) {
    if (entry.size > MAX_FILE) throw new Error("A file in that repo is too big");
    if (entry.method === 0) return entry.data;
    return inflate(entry.data, { maxOutputLength: entry.size });
}

async function downloadRepo(owner: string, repo: string, ref: string) {
    const { res, body } = await boundedFetch(`https://codeload.github.com/${owner}/${repo}/zip/${encodeURIComponent(ref)}`, { headers: { "User-Agent": "Muffinshelf" } });
    if (res.status === 404) throw new Error(`github.com/${owner}/${repo} doesn't exist or isn't public`);
    if (!res.ok) throw new Error(`GitHub answered with ${res.status}`);
    return readZip(body);
}

function getRepo(owner: string, repo: string, ref = "HEAD", force = false) {
    if (!GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo) || !/^[\w./-]{1,200}$/.test(ref) || ref.includes(".."))
        throw new Error("That GitHub link doesn't look right");

    const now = Date.now();
    for (const [key, value] of archiveCache) if (now - value.at > REPO_CACHE_MS) archiveCache.delete(key);

    const key = `${owner}/${repo}@${ref}`.toLowerCase();
    const cached = archiveCache.get(key);
    if (cached && !force) return cached.promise;

    const promise = downloadRepo(owner, repo, ref);
    archiveCache.delete(key);
    archiveCache.set(key, { at: now, promise });
    while (archiveCache.size > REPO_CACHE_MAX) archiveCache.delete(archiveCache.keys().next().value as string);
    promise.catch(() => archiveCache.delete(key));
    return promise;
}

const SCAN_TEXT = /(^|\/)index\.(t|j)sx?$|\.plugin\.js$|(^|\/)manifest\.json$|(^|\/)plugins\.json$/;

export async function scanRepo(_: IpcMainInvokeEvent, owner: string, repo: string, ref?: string, force = false) {
    const archive = await getRepo(owner, repo, ref || "HEAD", force);
    const texts: Record<string, string> = {};
    let budget = 8 * 1024 * 1024;
    for (const [path, entry] of archive.entries) {
        if (!SCAN_TEXT.test(path) || path.includes("node_modules/") || entry.size > budget) continue;
        budget -= entry.size;
        texts[path] = (await unpack(entry)).toString("utf8");
    }
    return { commit: archive.commit, files: [...archive.entries.keys()], texts };
}

function cleanRepoPath(path: string) {
    const parts = path.split("/").filter(Boolean);
    if (parts.some(p => p === ".." || p === "." || p.includes("\\") || p.includes(":")))
        throw new Error("That plugin path doesn't look right");
    return parts.join("/");
}

async function backupFolder(mode: Exclude<BuildMode, { kind: "none"; }>, folder: string) {
    const backup = childOf(join(workDir(mode), "backup"), folder);
    if (existsSync(backup)) return;
    await mkdir(backup, { recursive: true });
    const target = childOf(userpluginsDir(mode) as string, folder);
    const saved = childOf(SAVED_USERPLUGINS, folder);
    if (existsSync(target)) await rename(target, join(backup, "source"));
    if (existsSync(saved)) await copyTree(saved, join(backup, "saved"));
}

export async function installUserplugin(_: IpcMainInvokeEvent, req: InstallRequest): Promise<UserpluginMarker> {
    const mode = requireBuild();
    const dir = userpluginsDir(mode) as string;
    const target = childOf(dir, req.folder);
    const saved = childOf(SAVED_USERPLUGINS, req.folder);

    if (existsSync(target)) {
        const existing = await readJson<UserpluginMarker>(join(target, MARKER));
        if (!existing) throw new Error(`You already have a plugin folder called "${req.folder}" that Muffinshelf didn't add. Muffinshelf won't overwrite it.`);
        if (existing.entryKey !== req.entryKey) throw new Error(`A different plugin called "${req.folder}" is already installed from github.com/${existing.owner}/${existing.repo}. Remove it first.`);
    }

    const path = cleanRepoPath(req.path);
    const archive = await getRepo(req.owner, req.repo, req.ref || "HEAD", true);
    const prefix = path ? path + "/" : "";
    const files = [...archive.entries].filter(([p]) => p.startsWith(prefix) && !p.includes("node_modules/"));
    if (!files.length) throw new Error("Couldn't find that plugin's files in the repo");
    if (files.length > MAX_PLUGIN_FILES) throw new Error(`That plugin has ${files.length} files, which is more than a plugin should have`);
    const index = files.find(([p]) => /^index\.(t|j)sx?$/.test(p.slice(prefix.length)));
    if (!index) throw new Error("That folder has no index.ts or index.tsx, so it isn't an Equicord plugin");
    const pluginName = (await unpack(index[1])).toString("utf8").match(DEFINE_NAME)?.[1];

    const staging = childOf(join(workDir(mode), "staging"), req.folder);
    await removeTree(staging);
    try {
        for (const [p, entry] of files) {
            const dest = join(staging, ...cleanRepoPath(p.slice(prefix.length)).split("/"));
            if (relative(staging, dest).startsWith("..")) throw new Error("That plugin path doesn't look right");
            await mkdir(dirname(dest), { recursive: true });
            await writeFile(dest, await unpack(entry));
        }

        const marker: UserpluginMarker = {
            folder: req.folder,
            pluginName,
            owner: req.owner,
            repo: req.repo,
            ref: archive.commit ?? req.ref ?? "HEAD",
            path,
            sourceId: req.sourceId,
            entryKey: req.entryKey,
            version: req.version,
            installedAt: Date.now(),
        };
        await writeFile(join(staging, MARKER), JSON.stringify(marker, null, 4));

        await backupFolder(mode, req.folder);
        await removeTree(target);
        await mkdir(dir, { recursive: true });
        await rename(staging, target);
        await removeTree(saved);
        await copyTree(target, saved);
        return marker;
    } finally {
        await removeTree(staging);
    }
}

export async function removeUserplugin(_: IpcMainInvokeEvent, folder: string) {
    const mode = requireBuild();
    const target = childOf(userpluginsDir(mode) as string, folder);
    if (existsSync(target) && !existsSync(join(target, MARKER))) throw new Error("Muffinshelf only removes plugins it added");
    await backupFolder(mode, folder);
    await removeTree(target);
    await removeTree(childOf(SAVED_USERPLUGINS, folder));
}

export async function rollbackUserplugins(_: IpcMainInvokeEvent, folders: string[]) {
    const mode = requireBuild();
    for (const folder of folders) {
        const backup = childOf(join(workDir(mode), "backup"), folder);
        if (!existsSync(backup)) continue;
        const target = childOf(userpluginsDir(mode) as string, folder);
        const saved = childOf(SAVED_USERPLUGINS, folder);
        await removeTree(target);
        await removeTree(saved);
        if (existsSync(join(backup, "source"))) await rename(join(backup, "source"), target);
        if (existsSync(join(backup, "saved"))) await copyTree(join(backup, "saved"), saved);
        await removeTree(backup);
    }
    await cleanWork(mode);
}

export async function commitUserplugins(_: IpcMainInvokeEvent, folders: string[]) {
    const mode = requireBuild();
    for (const folder of folders) await removeTree(childOf(join(workDir(mode), "backup"), folder));
    await cleanWork(mode);
}

async function cleanWork(mode: Exclude<BuildMode, { kind: "none"; }>) {
    const work = workDir(mode);
    for (const sub of ["backup", "staging"]) {
        const path = join(work, sub);
        if (existsSync(path) && !(await readdir(path)).length) await removeTree(path);
    }
    if (existsSync(work) && !(await readdir(work)).length) await removeTree(work);
}

export async function listUserplugins(_: IpcMainInvokeEvent) {
    const dir = userpluginsDir(detectBuild());
    const result: (UserpluginMarker & { missing: boolean; })[] = [];
    const seen = new Set<string>();

    if (dir && existsSync(dir)) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const marker = await readJson<UserpluginMarker>(join(dir, entry.name, MARKER));
            if (!marker) continue;
            seen.add(entry.name);
            result.push({ ...marker, folder: entry.name, missing: false });
        }
    }

    if (existsSync(SAVED_USERPLUGINS)) {
        for (const entry of await readdir(SAVED_USERPLUGINS, { withFileTypes: true })) {
            if (!entry.isDirectory() || seen.has(entry.name)) continue;
            const marker = await readJson<UserpluginMarker>(join(SAVED_USERPLUGINS, entry.name, MARKER));
            if (marker) result.push({ ...marker, folder: entry.name, missing: true });
        }
    }

    return result;
}

async function restoreSaved(mode: Exclude<BuildMode, { kind: "none"; }>) {
    const dir = userpluginsDir(mode) as string;
    if (!existsSync(SAVED_USERPLUGINS)) return;
    await mkdir(dir, { recursive: true });
    for (const entry of await readdir(SAVED_USERPLUGINS, { withFileTypes: true })) {
        if (entry.isDirectory() && FOLDER_NAME.test(entry.name) && !existsSync(join(dir, entry.name)))
            await copyTree(join(SAVED_USERPLUGINS, entry.name), join(dir, entry.name));
    }
}

function killTree(pid: number | undefined) {
    if (!pid) return;
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-pid, "SIGKILL");
}

function run(command: string, args: string[], cwd: string, env: Record<string, string>, useShell: boolean) {
    return new Promise<{ code: number | null; log: string; }>(done => {
        let log = "";
        const add = (chunk: Buffer) => {
            log += chunk.toString("utf8");
            if (log.length > 400_000) log = log.slice(-200_000);
        };

        const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, shell: useShell, windowsHide: true, detached: process.platform !== "win32" });
        const timer = setTimeout(() => {
            log += "\nThe build took longer than 15 minutes and was stopped.";
            killTree(child.pid);
        }, BUILD_TIMEOUT);

        child.stdout?.on("data", add);
        child.stderr?.on("data", add);
        child.on("error", err => {
            clearTimeout(timer);
            done({ code: -1, log: log + "\n" + String(err) });
        });
        child.on("close", code => {
            clearTimeout(timer);
            done({ code, log });
        });
    });
}

type BuildResult = { ok: boolean; log: string; };

async function doBuild(): Promise<BuildResult> {
    const mode = detectBuild();
    if (mode.kind === "none") return { ok: false, log: mode.reason };

    await restoreSaved(mode);
    const banner = readBanner();

    if (mode.kind === "source") {
        const flags = ["build"];
        if (/Updater Disabled: true/.test(banner)) flags.push("--disable-updater");
        if (/Standalone: true/.test(banner)) flags.push("--standalone");
        if (IS_DEV) flags.push("--dev");

        const dist = join(mode.root, "dist");
        const backup = join(workDir(mode), "dist-backup");
        await removeTree(backup);
        if (existsSync(dist)) await copyTree(dist, backup);
        try {
            const { code, log } = await run("pnpm", flags, mode.root, {}, true);
            if (code === 0) return { ok: true, log };
            if (existsSync(backup)) await copyTree(backup, dist);
            if (/not recognized|command not found|ENOENT/i.test(log))
                return { ok: false, log: "pnpm wasn't found. Install it with \"npm i -g pnpm\" and try again.\n\n" + log };
            return { ok: false, log };
        } finally {
            await removeTree(backup);
        }
    }

    const corepack = join(mode.node, "node_modules", "corepack", "dist", "corepack.js");
    const { code, log } = await run(join(mode.node, "node.exe"), [corepack, "pnpm", "build", "--disable-updater"], mode.root, {
        PATH: `${mode.node};${process.env.PATH ?? ""}`,
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        COREPACK_HOME: join(mode.work, "corepack"),
        EQUICORD_HASH: banner.match(/\/\/ Equicord ([0-9a-f]{7,40})/)?.[1] ?? "unknown",
        EQUICORD_REMOTE: "Equicord/Equicord",
        CI: "true",
    }, false);
    if (code !== 0) return { ok: false, log };

    await copyTree(join(mode.root, "dist", "desktop"), join(mode.work, "dist"));
    return { ok: true, log };
}

let running: Promise<BuildResult> | null = null;
let queued: Promise<BuildResult> | null = null;

function startBuild() {
    running = doBuild()
        .catch(e => ({ ok: false, log: e instanceof Error ? e.message : String(e) }))
        .finally(() => running = null);
    return running;
}

export function build(_: IpcMainInvokeEvent) {
    if (!running) return startBuild();
    queued ??= running.then(() => {
        queued = null;
        return startBuild();
    });
    return queued;
}

export const isBuilding = (_: IpcMainInvokeEvent) => running !== null;

export function relaunch(_: IpcMainInvokeEvent) {
    app.relaunch();
    app.exit(0);
}

export async function listBdPlugins(_: IpcMainInvokeEvent) {
    await mkdir(BD_PLUGINS, { recursive: true });
    const out: { file: string; code: string; }[] = [];
    for (const file of (await readdir(BD_PLUGINS)).sort()) {
        if (!BD_FILE.test(file)) continue;
        out.push({ file, code: await readFile(join(BD_PLUGINS, file), "utf8") });
    }
    return out;
}

export async function listBdFiles(_: IpcMainInvokeEvent) {
    if (!existsSync(BD_PLUGINS)) return [];
    return (await readdir(BD_PLUGINS)).filter(f => BD_FILE.test(f));
}

export async function writeBdPlugin(_: IpcMainInvokeEvent, file: string, code: string) {
    if (!BD_FILE.test(file)) throw new Error("BetterDiscord plugin files must end in .plugin.js");
    await mkdir(BD_PLUGINS, { recursive: true });
    await writeFile(join(BD_PLUGINS, file), code);
}

export async function removeBdPlugin(_: IpcMainInvokeEvent, file: string) {
    if (!BD_FILE.test(file)) throw new Error("Bad file name");
    await rm(join(BD_PLUGINS, file), { force: true });
}

const MAX_TREE_FILES = 4000;
const MAX_TREE_BYTES = 64 * 1024 * 1024;

export interface BdTreeEntry {
    path: string;
    dir: boolean;
    data?: string;
    mtime: number;
}

// BetterDiscord plugins expect synchronous fs calls, so the renderer keeps a copy of the plugin folder in memory
// and sends writes back here. Top-level .plugin.js files are left out: the runtime already has them.
export async function readBdTree(_: IpcMainInvokeEvent) {
    await mkdir(BD_PLUGINS, { recursive: true });
    const out: BdTreeEntry[] = [];
    let bytes = 0;
    const walk = async (dir: string) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (out.length >= MAX_TREE_FILES) return;
            const full = join(dir, entry.name);
            const rel = relative(BD_PLUGINS, full).replace(/\\/g, "/");
            if (entry.isDirectory()) {
                out.push({ path: rel, dir: true, mtime: 0 });
                await walk(full);
            } else if (entry.isFile() && !(dir === BD_PLUGINS && BD_FILE.test(entry.name))) {
                const data = await readFile(full);
                if (bytes + data.length > MAX_TREE_BYTES) continue;
                bytes += data.length;
                const { mtimeMs } = await originalFs.promises.stat(full);
                out.push({ path: rel, dir: false, data: data.toString("base64"), mtime: mtimeMs });
            }
        }
    };
    await walk(BD_PLUGINS);
    return out;
}

function bdPath(rel: string) {
    const full = resolve(BD_PLUGINS, rel);
    const inside = relative(BD_PLUGINS, full);
    if (!inside || inside.startsWith("..") || /^[A-Za-z]:/.test(inside)) throw new Error(`"${rel}" is outside the BetterDiscord plugins folder`);
    if (!inside.includes("\\") && !inside.includes("/") && BD_FILE.test(inside)) throw new Error("Plugin files are installed through Muffinshelf");
    return full;
}

export async function bdFsWrite(_: IpcMainInvokeEvent, rel: string, base64: string) {
    const data = Buffer.from(base64, "base64");
    if (data.length > MAX_FILE) throw new Error("File is too big");
    const full = bdPath(rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
}

export async function bdFsMkdir(_: IpcMainInvokeEvent, rel: string) {
    await mkdir(bdPath(rel), { recursive: true });
}

export async function bdFsRemove(_: IpcMainInvokeEvent, rel: string) {
    await rm(bdPath(rel), { recursive: true, force: true });
}

export async function bdFsRename(_: IpcMainInvokeEvent, from: string, to: string) {
    const target = bdPath(to);
    await mkdir(dirname(target), { recursive: true });
    await rename(bdPath(from), target);
}

export async function bdShowPath(_: IpcMainInvokeEvent, rel: string, reveal: boolean) {
    const full = rel ? bdPath(rel) : BD_PLUGINS;
    if (reveal) shell.showItemInFolder(full);
    else await shell.openPath(full);
}

export async function readAllBdData(_: IpcMainInvokeEvent) {
    await mkdir(BD_DATA, { recursive: true });
    const out: Record<string, any> = {};
    for (const file of await readdir(BD_DATA)) {
        const name = file.match(/^(.+)\.config\.json$/)?.[1];
        if (!name) continue;
        const data = await readJson(join(BD_DATA, file));
        if (data && typeof data === "object") out[name] = data;
    }
    return out;
}

export async function writeBdData(_: IpcMainInvokeEvent, name: string, json: string) {
    if (!/^[^\\/:*?"<>|]{1,120}$/.test(name) || /^\.+$/.test(name)) throw new Error("Bad plugin name");
    await mkdir(BD_DATA, { recursive: true });
    await writeFile(join(BD_DATA, `${name}.config.json`), json);
}

export async function openFolder(_: IpcMainInvokeEvent, which: "bd" | "data" | "userplugins") {
    const target = which === "bd" ? BD_PLUGINS : which === "data" ? BD_DATA : userpluginsDir(detectBuild());
    if (!target) return;
    await mkdir(target, { recursive: true });
    await shell.openPath(target);
}

export async function showDialog(_: IpcMainInvokeEvent, options: Record<string, any>) {
    const opts = {
        title: options.title,
        defaultPath: options.defaultPath,
        buttonLabel: options.buttonLabel,
        filters: options.filters,
        properties: [] as any[],
    };
    if (options.mode === "save") {
        const res = await dialog.showSaveDialog(opts);
        return { cancelled: res.canceled, filePath: res.filePath };
    }
    if (options.openDirectory) opts.properties.push("openDirectory");
    if (options.openFile !== false) opts.properties.push("openFile");
    if (options.multiSelections) opts.properties.push("multiSelections");
    if (options.showHiddenFiles) opts.properties.push("showHiddenFiles");
    const res = await dialog.showOpenDialog(opts);
    return { cancelled: res.canceled, filePaths: res.filePaths };
}
