/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CspPolicies } from "@main/csp";
import { RendererSettings } from "@main/settings";
import { DATA_DIR } from "@main/utils/constants";
import { createHash, createPublicKey, verify } from "crypto";
import { app, IpcMainInvokeEvent, session } from "electron";
import { unzipSync } from "fflate";
import { existsSync, readFileSync } from "fs";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";

// Discrub's Chrome Web Store ID. The download must be signed by the key this ID comes from.
const STORE_ID = "plhdclenpaecffbcefjmpkkbdpkmhhbj";
const HASHES_URL = (version: string) => `https://raw.githubusercontent.com/pratherbytecraft/discrub/v${version}/store/chrome/hashes.json`;
const LAUNCHER_PREF = "discrub-launcher-preference";

const ROOT = join(DATA_DIR, "discrubLoader");
const VERSIONS = join(ROOT, "versions");
const EXT = join(ROOT, "extension");
const EXT_MARKER = join(ROOT, "extension.version");
const STATE_FILE = join(ROOT, "state.json");

const MAX_CRX = 60 * 1024 * 1024;
const MAX_UNPACKED = 200 * 1024 * 1024;
const MAX_FILES = 1000;
const TIMEOUT = 60_000;

const VERSION = /^\d{1,5}(\.\d{1,5}){1,3}$/;
const DOWNLOAD_HOSTS = [".googleusercontent.com", ".google.com", ".gvt1.com"];

export type View = "web" | "classic";

interface State {
    active?: string;
    previous?: string;
    staged?: string;
    justUpdated?: string;
    bad: string[];
    latest?: string;
    lastCheck?: number;
    lastError?: string;
}

export interface Status {
    installed: string | null;
    previous: string | null;
    staged: string | null;
    latest: string | null;
    lastCheck: number | null;
    lastError: string | null;
    justUpdated: string | null;
    loaded: string | null;
    bad: string[];
}

interface Release {
    version: string;
    url: string;
    sha256: string;
    size: number;
}

interface Hashes {
    name: string;
    version: string;
    algorithm: string;
    files: Record<string, string>;
}

const state: State = readState();
let loaded: { id: string; version: string; } | null = null;
let lastRelease: Release | null = null;
let busy: Promise<unknown> = Promise.resolve();

function readState(): State {
    try {
        const raw = JSON.parse(readFileSync(STATE_FILE, "utf8"));
        return { ...raw, bad: Array.isArray(raw.bad) ? raw.bad.filter((v: unknown) => typeof v === "string") : [] };
    } catch {
        return { bad: [] };
    }
}

async function saveState() {
    await mkdir(ROOT, { recursive: true });
    const tmp = STATE_FILE + ".tmp";
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, STATE_FILE);
}

// One download, swap or load at a time.
function serial<T>(job: () => Promise<T>): Promise<T> {
    const run = busy.then(job, job);
    busy = run.catch(() => { });
    return run;
}

function compareVersions(a: string, b: string) {
    const x = a.split(".").map(Number), y = b.split(".").map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] ?? 0) - (y[i] ?? 0);
        if (d) return Math.sign(d);
    }
    return 0;
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

function extensions() {
    return session.defaultSession.extensions ?? session.defaultSession;
}

function status(): Status {
    return {
        installed: state.active ?? null,
        previous: state.previous ?? null,
        staged: state.staged ?? null,
        latest: state.latest ?? null,
        lastCheck: state.lastCheck ?? null,
        lastError: state.lastError ?? null,
        justUpdated: state.justUpdated ?? null,
        loaded: loaded?.version ?? null,
        bad: [...state.bad],
    };
}

async function fetchChecked(url: string, max: number) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("Refused a download that isn't HTTPS.");
    const res = await fetch(parsed, { signal: AbortSignal.timeout(TIMEOUT), headers: { "User-Agent": `Electron ${process.versions.electron}` } });
    if (!res.ok) throw new Error(`${parsed.host} answered ${res.status}.`);
    const final = new URL(res.url || url);
    if (final.protocol !== "https:") throw new Error("The download was redirected away from HTTPS.");
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > max) throw new Error("The download is far bigger than Discrub should be.");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > max) throw new Error("The download is far bigger than Discrub should be.");
    return { buf, final };
}

function attr(tag: string, name: string) {
    return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

async function fetchLatest(): Promise<Release> {
    const url = "https://clients2.google.com/service/update2/crx?response=updatecheck&acceptformat=crx3"
        + `&prodversion=${encodeURIComponent(process.versions.chrome)}&x=${encodeURIComponent(`id=${STORE_ID}&v=0.0.0&uc`)}`;
    const xml = (await fetchChecked(url, 1024 * 1024)).buf.toString("utf8");
    const appTag = /<app\s[^>]*appid="([a-p]{32})"[^>]*>/.exec(xml);
    const check = /<updatecheck\s[^>]*>/.exec(xml)?.[0];
    if (appTag?.[1] !== STORE_ID || !check) throw new Error("The Chrome Web Store didn't return Discrub.");
    if (attr(check, "status") !== "ok") throw new Error(`The Chrome Web Store said "${attr(check, "status") ?? "no status"}".`);

    const version = attr(check, "version") ?? "";
    const codebase = attr(check, "codebase")?.replace(/&amp;/g, "&") ?? "";
    const hash = attr(check, "hash_sha256") ?? "";
    const size = Number(attr(check, "size"));
    if (!VERSION.test(version) || !/^[0-9a-f]{64}$/.test(hash) || !Number.isFinite(size)) throw new Error("The Chrome Web Store's answer was incomplete.");
    const { host } = new URL(codebase);
    if (!DOWNLOAD_HOSTS.some(h => host.endsWith(h))) throw new Error(`Refused a download from ${host}.`);

    return { version, url: codebase, sha256: hash, size };
}

// ---- CRX3 container (https://source.chromium.org/chromium/chromium/src/+/main:components/crx_file/crx3.proto)

function* protoFields(buf: Buffer): Generator<[number, Buffer]> {
    let i = 0;
    const varint = () => {
        let value = 0, scale = 1, byte: number;
        do {
            if (i >= buf.length) throw new Error("The download's signature block is damaged.");
            byte = buf[i++];
            value += (byte & 0x7f) * scale;
            scale *= 128;
        } while (byte & 0x80);
        return value;
    };
    while (i < buf.length) {
        const tag = varint();
        if ((tag & 7) !== 2) throw new Error("The download's signature block is damaged.");
        const len = varint();
        if (i + len > buf.length) throw new Error("The download's signature block is damaged.");
        yield [Math.floor(tag / 8), buf.subarray(i, i + len)];
        i += len;
    }
}

const idFromBytes = (bytes: Buffer) => [...bytes.subarray(0, 16)].map(b => "abcdefghijklmnop"[b >> 4] + "abcdefghijklmnop"[b & 15]).join("");

// Returns the zip inside the CRX after checking it is signed by the key Discrub's store ID belongs to.
function openCrx(buf: Buffer) {
    if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "Cr24" || buf.readUInt32LE(4) !== 3) throw new Error("The download isn't a Chrome extension package.");
    const headerLen = buf.readUInt32LE(8);
    if (12 + headerLen > buf.length) throw new Error("The download is cut off.");
    const header = buf.subarray(12, 12 + headerLen);
    const archive = buf.subarray(12 + headerLen);

    let signedData: Buffer | undefined;
    const rsaProofs: { key: Buffer; sig: Buffer; }[] = [];
    for (const [field, value] of protoFields(header)) {
        if (field === 10000) signedData = value;
        else if (field === 2) {
            let key: Buffer | undefined, sig: Buffer | undefined;
            for (const [f, v] of protoFields(value)) {
                if (f === 1) key = v;
                else if (f === 2) sig = v;
            }
            if (key && sig) rsaProofs.push({ key, sig });
        }
    }
    if (!signedData) throw new Error("The download has no signature.");
    const crxId = [...protoFields(signedData)].find(([f]) => f === 1)?.[1];
    if (!crxId || idFromBytes(crxId) !== STORE_ID) throw new Error("The download belongs to a different extension.");

    const len = Buffer.alloc(4);
    len.writeUInt32LE(signedData.length);
    const signedBytes = Buffer.concat([Buffer.from("CRX3 SignedData\0", "latin1"), len, signedData, archive]);
    const developerSigned = rsaProofs.some(({ key, sig }) => {
        if (idFromBytes(createHash("sha256").update(key).digest()) !== STORE_ID) return false;
        try {
            return verify("sha256", signedBytes, createPublicKey({ key, format: "der", type: "spki" }), sig);
        } catch {
            return false;
        }
    });
    if (!developerSigned) throw new Error("The download isn't signed by Discrub's developer key.");
    return archive;
}

function safeName(name: string) {
    if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[a-z]:/i.test(name)) return false;
    return name.split("/").every(part => part && part !== "." && part !== "..");
}

// Unpacks the store package and checks every file against the SHA-256 list Discrub publishes on GitHub for that version.
function checkedFiles(archive: Buffer, hashes: Hashes) {
    let count = 0, total = 0;
    const raw = unzipSync(archive, {
        filter: file => {
            if (++count > MAX_FILES) throw new Error("The package has far more files than Discrub should.");
            total += file.originalSize;
            if (total > MAX_UNPACKED) throw new Error("The package unpacks far bigger than Discrub should.");
            return true;
        }
    });

    const files = new Map<string, Uint8Array>();
    for (const [name, data] of Object.entries(raw)) {
        if (name.endsWith("/") || name.startsWith("_metadata/")) continue;
        if (!safeName(name)) throw new Error(`The package has a file with an unsafe name: ${name}`);
        files.set(name, data);
    }

    // The store adds "update_url" to manifest.json; without it the file is byte-for-byte the one Discrub built.
    const manifestRaw = files.get("manifest.json");
    if (!manifestRaw) throw new Error("The package has no manifest.json.");
    const manifest = JSON.parse(Buffer.from(manifestRaw).toString("utf8"));
    delete manifest.update_url;
    files.set("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));

    const extra = [...files.keys()].filter(n => !Object.hasOwn(hashes.files, n));
    if (extra.length) throw new Error(`The package has files GitHub doesn't list: ${extra.slice(0, 3).join(", ")}`);
    for (const [name, expected] of Object.entries(hashes.files)) {
        const data = files.get(name);
        if (!data) throw new Error(`The package is missing ${name}.`);
        if (sha256(data) !== expected) throw new Error(`${name} doesn't match the copy Discrub published on GitHub.`);
    }
    if (manifest.version !== hashes.version) throw new Error("The package's version doesn't match GitHub's list.");
    return files;
}

async function fetchHashes(version: string): Promise<Hashes> {
    let buf: Buffer;
    try {
        buf = (await fetchChecked(HASHES_URL(version), 2 * 1024 * 1024)).buf;
    } catch (e) {
        throw new Error(`Couldn't get GitHub's file list for v${version} (${e instanceof Error ? e.message : e}). Discrub may not have published it yet.`);
    }
    const hashes = JSON.parse(buf.toString("utf8")) as Hashes;
    if (hashes?.name !== "discrub" || hashes.version !== version || hashes.algorithm !== "sha256" || typeof hashes.files !== "object" || !hashes.files)
        throw new Error(`GitHub's file list for v${version} doesn't look right.`);
    for (const [name, hash] of Object.entries(hashes.files)) {
        if (!safeName(name) || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) throw new Error(`GitHub's file list for v${version} doesn't look right.`);
    }
    return hashes;
}

async function writeTree(dir: string, files: Map<string, Uint8Array>) {
    const root = resolve(dir);
    for (const [name, data] of files) {
        const path = resolve(root, name);
        if (!path.startsWith(root + "\\") && !path.startsWith(root + "/")) throw new Error(`Unsafe path: ${name}`);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, data);
    }
}

async function treeMatches(dir: string, hashes: Hashes) {
    try {
        for (const [name, expected] of Object.entries(hashes.files)) {
            if (sha256(await readFile(join(dir, name))) !== expected) return false;
        }
        return true;
    } catch {
        return false;
    }
}

const versionDir = (version: string) => join(VERSIONS, version);
const hashesFile = (version: string) => join(VERSIONS, `${version}.hashes.json`);

async function savedHashes(version: string): Promise<Hashes> {
    return JSON.parse(await readFile(hashesFile(version), "utf8"));
}

async function removeTree(path: string) {
    for (let i = 0; i < 5; i++) {
        try {
            return await rm(path, { recursive: true, force: true });
        } catch (e) {
            if (i === 4) throw e;
            await new Promise(r => setTimeout(r, 300));
        }
    }
}

async function prune() {
    const keep = new Set([state.active, state.previous, state.staged].filter(Boolean) as string[]);
    for (const entry of await readdir(VERSIONS).catch(() => [] as string[])) {
        const version = entry.replace(/\.hashes\.json$/, "");
        if (!keep.has(version)) await removeTree(join(VERSIONS, entry)).catch(() => { });
    }
}

async function unloadNow() {
    if (!loaded) return;
    try {
        extensions().removeExtension(loaded.id);
    } catch { }
    loaded = null;
}

// Copies the active version into the fixed extension folder (so Discrub's own storage keeps the same ID) and loads it.
async function loadActive() {
    const version = state.active;
    if (!version) return;
    const hashes = await savedHashes(version);
    const marker = existsSync(EXT_MARKER) ? readFileSync(EXT_MARKER, "utf8").trim() : "";
    if (marker !== version || !await treeMatches(EXT, hashes)) {
        if (!await treeMatches(versionDir(version), hashes)) throw new Error(`The saved copy of v${version} was changed on disk.`);
        await unloadNow();
        await removeTree(EXT);
        await mkdir(ROOT, { recursive: true });
        const tmp = `${EXT}.tmp`;
        await removeTree(tmp);
        await cp(versionDir(version), tmp, { recursive: true });
        await rename(tmp, EXT);
        await writeFile(EXT_MARKER, version);
    }
    if (loaded?.version === version) return;
    await unloadNow();
    const ext = await extensions().loadExtension(EXT);
    loaded = { id: ext.id, version };
}

// The active version failed: mark it bad and go back to the one before it.
async function rollbackNow(reason: string) {
    if (!state.previous || !state.active) throw new Error(reason);
    state.bad = [...new Set([...state.bad, state.active])];
    state.lastError = `Discrub v${state.active} didn't start (${reason}). Went back to v${state.previous}.`;
    state.active = state.previous;
    state.previous = undefined;
    state.justUpdated = undefined;
    await saveState();
    await loadActive();
}

async function promoteStaged() {
    if (!state.staged) return;
    state.previous = state.active;
    state.active = state.staged;
    state.staged = undefined;
    state.justUpdated = state.active;
    await saveState();
}

async function boot() {
    // Discrub's window is a chrome-extension:// frame; Discord's own page rules don't list that.
    CspPolicies["chrome-extension:"] = ["frame-src", "img-src"];
    if (!state.active && !state.staged) return;
    await promoteStaged();
    try {
        await loadActive();
    } catch (e) {
        await rollbackNow(e instanceof Error ? e.message : String(e));
    }
    await prune();
}

if (RendererSettings.store.plugins?.DiscrubLoader?.enabled) {
    app.whenReady().then(() => serial(boot)).catch(e => {
        state.lastError = `Couldn't load Discrub: ${e instanceof Error ? e.message : e}`;
        saveState().catch(() => { });
        console.error("[DiscrubLoader]", e);
    });
}

// ---- IPC

export function getStatus(_: IpcMainInvokeEvent) {
    return status();
}

export function start(_: IpcMainInvokeEvent) {
    return serial(async () => {
        CspPolicies["chrome-extension:"] = ["frame-src", "img-src"];
        if (!loaded && state.active) {
            try {
                await loadActive();
            } catch (e) {
                await rollbackNow(e instanceof Error ? e.message : String(e));
            }
        }
        return status();
    });
}

export function stop(_: IpcMainInvokeEvent) {
    return serial(async () => {
        await unloadNow();
        return status();
    });
}

export function checkLatest(_: IpcMainInvokeEvent) {
    return serial(async () => {
        try {
            lastRelease = await fetchLatest();
            state.latest = lastRelease.version;
            state.lastError = undefined;
        } catch (e) {
            state.lastError = `Update check failed: ${e instanceof Error ? e.message : e}`;
        }
        state.lastCheck = Date.now();
        await saveState();
        return status();
    });
}

export function install(_: IpcMainInvokeEvent, version: string) {
    return serial(async () => {
        if (typeof version !== "string" || !VERSION.test(version)) throw new Error("That isn't a Discrub version.");
        if (state.active === version || state.staged === version) return status();
        try {
            if (lastRelease?.version !== version) lastRelease = await fetchLatest();
            const release = lastRelease;
            if (release.version !== version) throw new Error(`The Chrome Web Store now has v${release.version}, not v${version}. Check again.`);
            if (state.active && compareVersions(version, state.active) < 0) throw new Error("That's older than the installed version.");

            const hashes = await fetchHashes(version);
            const { buf } = await fetchChecked(release.url, MAX_CRX);
            if (buf.length !== release.size || sha256(buf) !== release.sha256) throw new Error("The download doesn't match what the Chrome Web Store announced.");
            const files = checkedFiles(openCrx(buf), hashes);

            await mkdir(VERSIONS, { recursive: true });
            const tmp = join(VERSIONS, `.tmp-${version}`);
            await removeTree(tmp);
            await writeTree(tmp, files);
            await removeTree(versionDir(version));
            await rename(tmp, versionDir(version));
            await writeFile(hashesFile(version), JSON.stringify(hashes));

            state.bad = state.bad.filter(v => v !== version);
            state.lastError = undefined;
            if (!state.active) {
                state.active = version;
                await saveState();
                await loadActive();
            } else {
                state.staged = version;
                await saveState();
            }
            await prune();
        } catch (e) {
            state.lastError = `Couldn't install v${version}: ${e instanceof Error ? e.message : e}`;
            await saveState();
            throw new Error(state.lastError);
        }
        return status();
    });
}

// Swaps in the downloaded update now. The page still has to reload for Discrub's scripts to run.
export function applyStaged(_: IpcMainInvokeEvent) {
    return serial(async () => {
        if (!state.staged) return status();
        await promoteStaged();
        try {
            await loadActive();
        } catch (e) {
            await rollbackNow(e instanceof Error ? e.message : String(e));
        }
        await prune();
        return status();
    });
}

export function rollback(_: IpcMainInvokeEvent, reason: string) {
    return serial(async () => {
        await rollbackNow(String(reason).slice(0, 200));
        return status();
    });
}

export function confirmStarted(_: IpcMainInvokeEvent) {
    return serial(async () => {
        if (state.justUpdated) {
            state.justUpdated = undefined;
            await saveState();
        }
        return status();
    });
}

// Picks New or Classic on Discrub's own start screen, the same as choosing it in the dropdown and pressing Launch.
export async function chooseView(e: IpcMainInvokeEvent, view: View) {
    if (view !== "web" && view !== "classic") return false;
    const id = loaded?.id;
    if (!id) return false;
    const launcher = `chrome-extension://${id}/launcher.html`;
    const script = `(async () => {
        const view = ${JSON.stringify(view)};
        await chrome.storage.local.set({ ${JSON.stringify(LAUNCHER_PREF)}: view });
        const select = document.getElementById("version-select");
        const button = document.getElementById("launch-btn");
        if (!select || !button) return false;
        select.value = view;
        select.dispatchEvent(new Event("change"));
        for (let i = 0; i < 20 && button.disabled; i++) await new Promise(r => setTimeout(r, 100));
        if (button.disabled) return false;
        button.click();
        return true;
    })()`;

    for (let i = 0; i < 40; i++) {
        const frame = e.sender.mainFrame.framesInSubtree.find(f => f.url.startsWith(launcher));
        if (frame) {
            // Give the start screen a moment to read its saved choice first.
            await new Promise(r => setTimeout(r, 250));
            try {
                return Boolean(await frame.executeJavaScript(script, true));
            } catch {
                return false;
            }
        }
        await new Promise(r => setTimeout(r, 100));
    }
    return false;
}
