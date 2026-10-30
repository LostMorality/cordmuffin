/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { plugins } from "@api/PluginManager";

import { BD_RE, isManaged, isOfficial, NAME_RE, newId, Preset } from "./presets";
import { Json, Removed, scrubSettings, valueProblem } from "./scrub";

const FORMAT = "cordmuffin.pluginPreset";
const VERSION = 1;
const CODE_PREFIX = "PP1.";
const MAX_TEXT = 1_000_000;
const DEFAULT_NAME = "Shared preset";

export interface SharedPreset {
    format: typeof FORMAT;
    version: typeof VERSION;
    name: string;
    /** Official Equicord/Vencord plugins to turn on. */
    enabled: string[];
    settings: Record<string, Record<string, Json>>;
    /** Userplugins (cordmuffin plugins and others) that were on. Names only, never turned on by an import. */
    unofficial: string[];
    /** Muffinshelf BetterDiscord plugins that were on. Names only, never turned on by an import. */
    betterDiscord: string[];
    /** Settings left out of the export, so the person importing keeps their own values. */
    scrubbed: Record<string, string[]>;
}

export interface ImportReport {
    preset: Preset;
    enable: string[];
    missing: string[];
    unofficial: string[];
    betterDiscord: string[];
    ignored: Removed[];
    scrubbed: Record<string, string[]>;
}

function cleanName(raw: unknown) {
    const name = typeof raw === "string" ? raw.replace(/[\p{C}]/gu, "").trim().slice(0, 64) : "";
    return name || DEFAULT_NAME;
}

export function buildExport(preset: Preset) {
    const removed: Removed[] = [];
    const settings: SharedPreset["settings"] = {};
    const scrubbed: SharedPreset["scrubbed"] = {};
    const enabled: string[] = [];
    const unofficial = new Set(preset.imported?.unofficial ?? []);

    for (const name of preset.enabled) {
        if (!isOfficial(name)) {
            unofficial.add(name);
            if (preset.settings[name] && Object.keys(preset.settings[name]).length)
                removed.push({ plugin: name, setting: "all settings", reason: "not an official plugin, so only its name is shared" });
            continue;
        }
        enabled.push(name);
        const values = preset.settings[name];
        if (!values) continue;
        const result = scrubSettings(name, values);
        if (Object.keys(result.kept).length) settings[name] = result.kept;
        if (result.removed.length) {
            removed.push(...result.removed);
            scrubbed[name] = result.removed.map(r => r.setting);
        }
    }

    let name = cleanName(preset.name);
    const nameProblem = valueProblem(name);
    if (nameProblem) {
        removed.push({ plugin: "Preset name", setting: name, reason: `${nameProblem}, shared as "${DEFAULT_NAME}"` });
        name = DEFAULT_NAME;
    }

    const data: SharedPreset = {
        format: FORMAT,
        version: VERSION,
        name,
        enabled,
        settings,
        unofficial: [...unofficial].filter(n => NAME_RE.test(n)).sort(),
        betterDiscord: [...new Set([...preset.bd ?? [], ...preset.imported?.betterDiscord ?? []])].filter(f => BD_RE.test(f)).sort(),
        scrubbed,
    };
    return { data, removed };
}

function toBase64(text: string) {
    let binary = "";
    for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64(code: string) {
    const b64 = code.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(b64 + "=".repeat((4 - b64.length % 4) % 4));
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
}

export const toCode = (data: SharedPreset) => CODE_PREFIX + toBase64(JSON.stringify(data));
export const toFileText = (data: SharedPreset) => JSON.stringify(data, null, 4);

export function fileNameFor(name: string) {
    return `${name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 40) || "preset"}.preset.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function list(value: unknown, re: RegExp, max = 2000) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error("A plugin list in the preset is broken.");
    return [...new Set(value.filter((v): v is string => typeof v === "string" && re.test(v)))].slice(0, max);
}

/** Reads a preset code or .json file and checks its shape. Throws an Error with a plain message when it's not usable. */
export function parseShared(text: string) {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Paste a preset code or choose a file first.");
    if (trimmed.length > MAX_TEXT) throw new Error("That's far too big to be a preset.");

    let raw: unknown;
    try {
        raw = JSON.parse(trimmed.startsWith(CODE_PREFIX) ? fromBase64(trimmed.slice(CODE_PREFIX.length).replace(/\s+/g, "")) : trimmed);
    } catch {
        throw new Error("That isn't a preset code. Codes start with PP1. and files are .json.");
    }

    if (!isRecord(raw) || raw.format !== FORMAT) throw new Error("That isn't a PluginPresets preset.");
    if (typeof raw.version !== "number" || raw.version > VERSION) throw new Error("This preset was made by a newer PluginPresets. Update and try again.");
    if (raw.settings !== undefined && !isRecord(raw.settings)) throw new Error("The settings in this preset are broken.");

    const scrubbed: Record<string, string[]> = {};
    if (isRecord(raw.scrubbed)) {
        for (const [plugin, keys] of Object.entries(raw.scrubbed))
            if (NAME_RE.test(plugin) && Array.isArray(keys)) scrubbed[plugin] = keys.filter((k): k is string => typeof k === "string" && /^[\w$]{1,80}$/.test(k));
    }

    return {
        name: cleanName(raw.name),
        enabled: list(raw.enabled, NAME_RE),
        settings: (raw.settings ?? {}) as Record<string, unknown>,
        unofficial: list(raw.unofficial, NAME_RE),
        betterDiscord: list(raw.betterDiscord, BD_RE),
        scrubbed,
    };
}

/**
 * Turns a checked preset into a local one that only ever enables official plugins the importer has. Settings go
 * through the same scrubber as exports, so a hand-made preset can't point the importer's plugins at someone's
 * server or slip in an ID list. Anything unknown is skipped and reported.
 */
export function prepareImport(text: string): ImportReport {
    const shared = parseShared(text);
    const enable: string[] = [];
    const missing: string[] = [];
    const unofficial = new Set<string>();
    const ignored: Removed[] = [];
    const settings: Preset["settings"] = {};

    for (const name of shared.enabled) {
        if (!plugins[name]) missing.push(name);
        else if (!isOfficial(name)) unofficial.add(name);
        else if (isManaged(name)) enable.push(name);
    }
    for (const name of shared.unofficial) if (!isOfficial(name)) unofficial.add(name);
    // A plugin the sharer marked as unofficial is listed with those, even when the importer doesn't have it.
    for (let i = missing.length - 1; i >= 0; i--) if (unofficial.has(missing[i])) missing.splice(i, 1);

    for (const [name, values] of Object.entries(shared.settings)) {
        if (!enable.includes(name)) continue;
        if (!isRecord(values)) {
            ignored.push({ plugin: name, setting: "all settings", reason: "broken in the preset" });
            continue;
        }
        const result = scrubSettings(name, values as Record<string, Json>);
        if (Object.keys(result.kept).length) settings[name] = result.kept;
        ignored.push(...result.removed);
    }

    const report = {
        enable,
        missing,
        unofficial: [...unofficial].sort(),
        betterDiscord: shared.betterDiscord,
        ignored,
        scrubbed: shared.scrubbed,
    };

    return {
        ...report,
        preset: {
            id: newId(),
            name: shared.name,
            created: Date.now(),
            enabled: enable,
            settings,
            bd: null,
            imported: { unofficial: report.unofficial, betterDiscord: report.betterDiscord, missing, scrubbed: report.scrubbed },
        },
    };
}
