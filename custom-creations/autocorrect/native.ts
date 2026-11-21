/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import { createHash } from "crypto";
import { type IpcMainInvokeEvent, net } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

import { SOURCES } from "./sources";

const ROOT = join(DATA_DIR, "autocorrect");
const STALL_MS = 30_000;

type SourceName = keyof typeof SOURCES;

export interface WordLists {
    unigrams: string | null;
    bigrams: string | null;
    error: string | null;
}

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
const fileFor = (name: SourceName) => join(ROOT, `${name}-${SOURCES[name].sha256.slice(0, 12)}.txt`);

/** The cached copy if it is intact; any problem reading it (locked, corrupt, can't delete) falls back to a fresh download. */
function readVerified(name: SourceName): string | null {
    const file = fileFor(name);
    try {
        if (!existsSync(file)) return null;
        const buf = readFileSync(file);
        if (sha256(buf) === SOURCES[name].sha256) return buf.toString("utf8");
        rmSync(file, { force: true });
    } catch (e) {
        console.warn(`[Autocorrect] Couldn't use the cached ${name}, downloading it again:`, e);
    }
    return null;
}

// Electron's fetch follows Discord's proxy settings; Node's global fetch is only the fallback
const get: typeof fetch = typeof net?.fetch === "function" ? net.fetch.bind(net) as unknown as typeof fetch : fetch;

/** Slow connections are fine as long as bytes keep arriving; it only gives up after STALL_MS with nothing new. */
async function download(name: SourceName): Promise<string> {
    const { url, sha256: expected } = SOURCES[name];
    const ctrl = new AbortController();
    let stall = setTimeout(() => ctrl.abort(), STALL_MS);
    const poke = () => {
        clearTimeout(stall);
        stall = setTimeout(() => ctrl.abort(), STALL_MS);
    };
    let buf: Buffer;
    try {
        const res = await get(url, { redirect: "follow", headers: { "User-Agent": "Autocorrect" }, signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`${name}: HTTP ${res.status}`);
        poke();
        const chunks: Uint8Array[] = [];
        const reader = res.body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            poke();
            chunks.push(value);
        }
        buf = Buffer.concat(chunks);
    } catch (e) {
        throw ctrl.signal.aborted ? new Error(`${name}: the download stopped (no data for ${STALL_MS / 1000} s)`) : e;
    } finally {
        clearTimeout(stall);
    }
    if (sha256(buf) !== expected) throw new Error(`${name}: the downloaded file didn't match its checksum`);

    // a failed cache write (full disk, read only folder, antivirus lock) must not throw away a good download
    const file = fileFor(name);
    try {
        mkdirSync(ROOT, { recursive: true });
        writeFileSync(file + ".part", buf);
        renameSync(file + ".part", file);
    } catch (e) {
        console.warn(`[Autocorrect] Couldn't cache ${name}, using it for this session only:`, e);
        try { rmSync(file + ".part", { force: true }); } catch { }
    }
    return buf.toString("utf8");
}

let pending: Promise<WordLists> | null = null;

async function load(): Promise<WordLists> {
    const out: WordLists = { unigrams: null, bigrams: null, error: null };
    const errors: string[] = [];

    for (const name of Object.keys(SOURCES) as SourceName[]) {
        try {
            out[name] = readVerified(name) ?? await download(name);
        } catch (e) {
            errors.push(e instanceof Error ? e.message : String(e));
        }
    }

    if (errors.length) out.error = errors.join("; ");
    return out;
}

export function getWordLists(_: IpcMainInvokeEvent): Promise<WordLists> {
    pending ??= load().finally(() => { pending = null; });
    return pending;
}

export function hasWordLists(_: IpcMainInvokeEvent): boolean {
    return (Object.keys(SOURCES) as SourceName[]).every(name => existsSync(fileFor(name)));
}
