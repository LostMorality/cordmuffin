/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Settings } from "@api/Settings";

import { enableBd, installBd, removeBd } from "./bd/runtime";
import { librariesUsedBy } from "./libraries";
import { Native, setBdOrigin, settings } from "./settings";
import { fetchBdCode, ShelfEntry } from "./sources";

const REBUILD_STEP = "Rebuilding Equicord. This usually takes under a minute...";

export async function installBdEntry(entry: ShelfEntry) {
    if (!entry.bd) return [];
    const code = await fetchBdCode(entry.bd.url);
    if (/^\s*</.test(code) || !/@name|module\.exports/.test(code)) throw new Error("That download isn't a BetterDiscord plugin file.");

    const present = new Set(await Native.listBdFiles());
    const added: string[] = [];
    const willRun = !present.has(entry.bd.file) || settings.store.bdEnabled.includes(entry.bd.file);
    for (const lib of librariesUsedBy(code, entry.bd.file)) {
        // A library that is turned off hides its globals, so the plugin wouldn't find it.
        if (present.has(lib.file)) {
            if (willRun) enableBd(lib.file);
        } else {
            await installBd(lib.file, await fetchBdCode(lib.url));
            added.push(lib.file);
        }
    }

    await installBd(entry.bd.file, code, !present.has(entry.bd.file));
    setBdOrigin(entry.bd.file, { key: entry.key, url: entry.bd.url, version: entry.version });
    return added;
}

export async function removeBdFile(file: string) {
    await removeBd(file);
    setBdOrigin(file, null);
}

export interface BuildResult {
    ok: boolean;
    log: string;
}

async function buildOrRollBack(folders: string[], onStep: (text: string) => void): Promise<BuildResult> {
    onStep(REBUILD_STEP);
    const result = await Native.build();
    if (result.ok) await Native.commitUserplugins(folders);
    else await Native.rollbackUserplugins(folders);
    return result;
}

export async function installUserpluginEntries(entries: ShelfEntry[], onStep: (text: string) => void): Promise<BuildResult> {
    const touched: string[] = [];
    const names: string[] = [];

    try {
        for (const entry of entries) {
            const up = entry.userplugin;
            if (!up) continue;
            onStep(`Downloading ${entry.name}...`);
            touched.push(up.folder);
            const marker = await Native.installUserplugin({
                folder: up.folder,
                owner: up.owner,
                repo: up.repo,
                ref: up.ref,
                path: up.path,
                sourceId: entry.sourceId,
                entryKey: entry.key,
                version: entry.version,
                fingerprint: up.fingerprint,
            });
            if (marker.pluginName) names.push(marker.pluginName);
        }
    } catch (e) {
        await Native.rollbackUserplugins(touched);
        throw e;
    }

    const result = await buildOrRollBack(touched, onStep);
    if (result.ok) {
        for (const name of names) {
            if (Settings.plugins[name]) Settings.plugins[name].enabled = true;
            else Settings.plugins[name] = { enabled: true };
        }
    }
    return result;
}

export async function removeUserplugin(folder: string, onStep: (text: string) => void): Promise<BuildResult> {
    await Native.removeUserplugin(folder);
    return buildOrRollBack([folder], onStep);
}

export async function rebuild(onStep: (text: string) => void): Promise<BuildResult> {
    onStep(REBUILD_STEP);
    return Native.build();
}
