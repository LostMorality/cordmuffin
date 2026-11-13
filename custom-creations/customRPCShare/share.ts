/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import { UserStore } from "@webpack/common";

/** Where CustomRPC keeps its presets. Owned by CustomRPC; this plugin only reads it and adds to it. */
export const PRESETS_KEY = "CustomRPC_presets";

const FORMAT = "cordmuffin.customRpcPresets";
const VERSION = 1;
const CODE_PREFIX = "RPC1.";
const MAX_TEXT = 500_000;
const MAX_PRESETS = 200;
const NAME_MAX = 200;
const DEFAULT_NAME = "Imported preset";

export type Json = string | number;

export interface RpcPreset {
    name: string;
    config: Record<string, unknown>;
}

export interface SharedFile {
    format: typeof FORMAT;
    version: typeof VERSION;
    presets: { name: string; config: Record<string, Json>; }[];
}

export interface Dropped {
    preset: string;
    field: string;
    reason: string;
}

export interface CheckedPreset {
    name: string;
    config: Record<string, Json>;
}

type Rule =
    | { kind: "text"; max: number; }
    | { kind: "url"; }
    | { kind: "appId"; }
    | { kind: "image"; }
    | { kind: "stream"; }
    | { kind: "int"; }
    | { kind: "enum"; values: number[]; };

const text128: Rule = { kind: "text", max: 128 };
const url: Rule = { kind: "url" };
const int: Rule = { kind: "int" };

/** Every field CustomRPC saves in a preset, with the same limits CustomRPC's own inputs use. */
export const FIELDS: Record<string, Rule> = Object.assign(Object.create(null), {
    appID: { kind: "appId" },
    appName: text128,
    details: text128,
    detailsURL: url,
    state: text128,
    stateURL: url,
    type: { kind: "enum", values: [0, 1, 2, 3, 5] },
    streamLink: { kind: "stream" },
    timestampMode: { kind: "enum", values: [0, 1, 2, 3] },
    startTime: int,
    endTime: int,
    imageBig: { kind: "image" },
    imageBigURL: url,
    imageBigTooltip: text128,
    imageSmall: { kind: "image" },
    imageSmallURL: url,
    imageSmallTooltip: text128,
    buttonOneText: { kind: "text", max: 31 },
    buttonOneURL: url,
    buttonTwoText: { kind: "text", max: 31 },
    buttonTwoURL: url,
    partySize: int,
    partyMaxSize: int,
});

const isField = (key: string) => Object.hasOwn(FIELDS, key);

/** What a field is set to when a shared preset doesn't have it, so loading the preset fully replaces the old one. */
function emptyValue(rule: Rule): Json {
    return rule.kind === "int" || rule.kind === "enum" ? 0 : "";
}

/** Plugin switches CustomRPC stores next to the preset fields. They aren't part of a preset's look, so they're never shared. */
const SWITCHES = new Set(["enabled", "enablePresence", "config"]);

const TOKEN_RE = /(?:mfa\.[\w-]{60,})|(?:[\w-]{23,28}\.[\w-]{6,7}\.[\w-]{25,})/;

function privacyProblem(value: string) {
    if (TOKEN_RE.test(value)) return "looks like a Discord login token";
    const me = UserStore?.getCurrentUser?.()?.id;
    if (me && value.includes(me)) return "contains your user ID";
    return null;
}

function fieldProblem(rule: Rule, value: unknown, config: Record<string, unknown>): string | null {
    switch (rule.kind) {
        case "int":
            if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return "must be a whole number, 0 or more";
            return null;
        case "enum":
            if (typeof value !== "number" || !rule.values.includes(value)) return "isn't one of CustomRPC's choices";
            return null;
    }

    if (typeof value !== "string") return "must be text";
    if (!value) return null;
    switch (rule.kind) {
        case "text":
            return value.length > rule.max ? `longer than ${rule.max} characters` : null;
        case "appId":
            return /^\d{16,21}$/.test(value) ? null : "isn't a valid application ID";
        case "url":
            if (value.length > 2048) return "longer than 2048 characters";
            return /^https?:\/\/.+/.test(value) ? null : "isn't a web link (http:// or https://)";
        case "stream":
            if (value.length > 512) return "longer than 512 characters";
            if (config.type === 1 && !/https?:\/\/(www\.)?(twitch\.tv|youtube\.com)\/\w+/.test(value)) return "isn't a Twitch or YouTube link";
            return null;
        case "image":
            if (value.length > 2048) return "longer than 2048 characters";
            if (/https?:\/\/(cdn|media)\.discordapp\.(com|net)\//.test(value)) return "is a Discord link, which CustomRPC doesn't allow";
            if (/https?:\/\/(?!i\.)?imgur\.com\//.test(value)) return "is an Imgur page, not a direct image link";
            if (/https?:\/\/(?!media\.)?tenor\.com\//.test(value)) return "is a Tenor page, not a direct image link";
            return null;
    }
}

export function cleanName(raw: unknown) {
    const name = typeof raw === "string" ? raw.replace(/[\p{Cc}]/gu, "").trim().slice(0, NAME_MAX) : "";
    return name || DEFAULT_NAME;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Keeps only CustomRPC's own fields, drops anything that fails CustomRPC's limits or could identify the account.
 * Used both ways, so an export always imports cleanly and an import can't carry anything an export wouldn't.
 */
export function checkPreset(name: unknown, config: unknown, dropped: Dropped[]): CheckedPreset {
    const clean = cleanName(name);
    const out: Record<string, Json> = {};
    if (!isRecord(config)) throw new Error(`"${clean}" has no settings in it.`);

    const nameProblem = privacyProblem(clean);
    const finalName = nameProblem ? DEFAULT_NAME : clean;
    if (nameProblem) dropped.push({ preset: DEFAULT_NAME, field: "name", reason: `${nameProblem}, renamed` });

    for (const [key, value] of Object.entries(config)) {
        if (SWITCHES.has(key) || value === undefined || value === null) continue;
        const rule = isField(key) ? FIELDS[key] : undefined;
        if (!rule) {
            dropped.push({ preset: finalName, field: key.slice(0, 40), reason: "not a CustomRPC field" });
            continue;
        }
        const problem = fieldProblem(rule, value, config) ?? (typeof value === "string" ? privacyProblem(value) : null);
        if (problem) {
            dropped.push({ preset: finalName, field: key, reason: problem });
            continue;
        }
        out[key] = value as Json;
    }

    if (!Object.keys(out).length) throw new Error(`"${finalName}" has no usable CustomRPC settings.`);
    return { name: finalName, config: out };
}

export async function loadPresets(): Promise<RpcPreset[]> {
    const stored = await DataStore.get<unknown>(PRESETS_KEY);
    if (!Array.isArray(stored)) return [];
    return stored.filter((p): p is RpcPreset => isRecord(p) && typeof p.name === "string" && isRecord(p.config));
}

export function buildExport(presets: RpcPreset[]) {
    const dropped: Dropped[] = [];
    const skipped: string[] = [];
    const out: SharedFile["presets"] = [];
    for (const p of presets) {
        try {
            out.push(checkPreset(p.name, p.config, dropped));
        } catch (e) {
            skipped.push(e instanceof Error ? e.message : String(e));
        }
    }
    const data: SharedFile = { format: FORMAT, version: VERSION, presets: out };
    return { data, dropped, skipped };
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

export const toCode = (data: SharedFile) => CODE_PREFIX + toBase64(JSON.stringify(data));
export const toFileText = (data: SharedFile) => JSON.stringify(data, null, 4);

export function fileNameFor(data: SharedFile) {
    const base = data.presets.length === 1
        ? data.presets[0].name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 40)
        : "";
    return `${base || "presets"}.customrpc.json`;
}

export interface ImportCheck {
    presets: CheckedPreset[];
    dropped: Dropped[];
    rejected: string[];
}

/**
 * Reads a code (RPC1.…), one of our .json files, or a raw CustomRPC preset / preset list and checks every field.
 * Throws an Error with a plain message when nothing in it can be used.
 */
export function parseImport(text: string): ImportCheck {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Paste a preset code or choose a file first.");
    if (trimmed.length > MAX_TEXT) throw new Error("That's far too big to be a CustomRPC preset.");

    let raw: unknown;
    try {
        raw = JSON.parse(trimmed.startsWith(CODE_PREFIX) ? fromBase64(trimmed.slice(CODE_PREFIX.length).replace(/\s+/g, "")) : trimmed);
    } catch {
        throw new Error(trimmed.startsWith(CODE_PREFIX)
            ? "That code is cut off or broken. Copy the whole code again."
            : "That isn't a CustomRPC preset code. Codes start with RPC1. and files are .json.");
    }

    let list: unknown[];
    if (isRecord(raw) && raw.format !== undefined) {
        if (raw.format !== FORMAT) throw new Error("That's a share code for something else, not CustomRPC presets.");
        if (typeof raw.version !== "number" || raw.version > VERSION) throw new Error("This was made by a newer CustomRPCShare. Update and try again.");
        if (!Array.isArray(raw.presets)) throw new Error("The preset list in this file is broken.");
        list = raw.presets;
    } else if (Array.isArray(raw)) {
        list = raw;
    } else if (isRecord(raw) && isRecord(raw.config)) {
        list = [raw];
    } else if (isRecord(raw) && Object.keys(raw).some(isField)) {
        list = [{ name: raw.appName, config: raw }];
    } else {
        throw new Error("That isn't a CustomRPC preset.");
    }

    if (!list.length) throw new Error("There are no presets in that.");
    if (list.length > MAX_PRESETS) throw new Error(`That has ${list.length} presets. The most you can import at once is ${MAX_PRESETS}.`);

    const dropped: Dropped[] = [];
    const rejected: string[] = [];
    const presets: CheckedPreset[] = [];
    const seen = new Set<string>();
    list.forEach((entry, i) => {
        try {
            if (!isRecord(entry)) throw new Error(`Preset ${i + 1} is broken.`);
            const checked = checkPreset(entry.name, entry.config, dropped);
            for (const key of Object.keys(FIELDS)) checked.config[key] ??= emptyValue(FIELDS[key]);
            checked.name = uniqueName(checked.name, seen);
            seen.add(checked.name.toLowerCase());
            presets.push(checked);
        } catch (e) {
            rejected.push(e instanceof Error ? e.message : String(e));
        }
    });

    if (!presets.length) throw new Error(rejected.length === 1 ? rejected[0] : `None of the ${list.length} presets could be used. ${rejected[0]}`);
    return { presets, dropped, rejected };
}

function uniqueName(name: string, taken: Set<string>) {
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; ; n++) {
        const suffix = ` (${n})`;
        const candidate = name.slice(0, NAME_MAX - suffix.length) + suffix;
        if (!taken.has(candidate.toLowerCase())) return candidate;
    }
}

export interface ImportResult {
    added: string[];
    replaced: string[];
    renamed: { from: string; to: string; }[];
}

/**
 * Adds checked presets to CustomRPC's list in one transaction. Existing presets are never touched unless
 * `replace` is true, in which case only presets with the exact same name (any case) get the new settings.
 */
export async function savePresets(incoming: CheckedPreset[], replace: boolean): Promise<ImportResult> {
    const result: ImportResult = { added: [], replaced: [], renamed: [] };
    await DataStore.update<unknown>(PRESETS_KEY, old => {
        const list: unknown[] = Array.isArray(old) ? [...old] : [];
        const nameOf = (p: unknown) => isRecord(p) && typeof p.name === "string" ? p.name : null;
        result.added = []; result.replaced = []; result.renamed = [];

        for (const preset of incoming) {
            // Prefer the exact name, since CustomRPC itself matches names exactly; fall back to any case.
            let index = list.findIndex(p => nameOf(p) === preset.name);
            if (index === -1) index = list.findIndex(p => nameOf(p)?.toLowerCase() === preset.name.toLowerCase());
            if (index !== -1 && replace) {
                list[index] = { name: nameOf(list[index]), config: { ...preset.config } };
                result.replaced.push(nameOf(list[index])!);
                continue;
            }
            let { name } = preset;
            if (index !== -1) {
                const taken = new Set(list.map(nameOf).filter((n): n is string => !!n).map(n => n.toLowerCase()));
                name = uniqueName(name, taken);
                result.renamed.push({ from: preset.name, to: name });
            }
            list.push({ name, config: { ...preset.config } });
            result.added.push(name);
        }

        return list.sort((a, b) => (nameOf(a) ?? "").localeCompare(nameOf(b) ?? ""));
    });
    return result;
}

export function conflictsWith(existing: RpcPreset[], incoming: CheckedPreset[]) {
    const names = new Set(existing.map(p => p.name.toLowerCase()));
    return incoming.filter(p => names.has(p.name.toLowerCase())).map(p => p.name);
}
