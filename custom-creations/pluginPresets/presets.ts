/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { pluginRequiresRestart, plugins, startDependenciesRecursive, startPlugin, stopPlugin } from "@api/PluginManager";
import { PlainSettings, Settings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { OptionType } from "@utils/types";
import { useEffect, useState } from "@webpack/common";

import { PluginMeta } from "~plugins";

import { deepEqual, Json } from "./scrub";

export const SELF = "PluginPresets";
const STORE_KEY = "PluginPresets_presets";
const logger = new Logger(SELF);

export interface ImportInfo {
    unofficial: string[];
    betterDiscord: string[];
    missing: string[];
    scrubbed: Record<string, string[]>;
}

export interface Preset {
    id: string;
    name: string;
    created: number;
    /** Plugins that are on. Everything else the preset manages gets turned off. */
    enabled: string[];
    settings: Record<string, Record<string, Json>>;
    /** Muffinshelf BetterDiscord plugin files that are on, or null when Muffinshelf wasn't there. */
    bd: string[] | null;
    /** Set on presets that came from an import: they only touch official plugins. */
    imported?: ImportInfo;
}

export interface Plan {
    turnOn: string[];
    turnOff: string[];
    settingChanges: Record<string, string[]>;
    missing: string[];
    restart: string[];
    bdOn: string[];
    bdOff: string[];
    /** What Muffinshelf's BetterDiscord list becomes, or null to leave it alone. */
    bdTarget: string[] | null;
    /** Imported presets: unofficial plugins the preset lists that are already on, so they stay on. */
    keptUnofficial: string[];
    /** Imported presets: unofficial plugins the preset lists that are off or not installed. They stay off. */
    blockedUnofficial: string[];
}

export interface ApplyResult {
    plan: Plan;
    failed: string[];
    restart: string[];
}

export function isOfficial(name: string) {
    const meta = PluginMeta[name];
    return !!meta && !meta.userPlugin && /^src\/(plugins|equicordplugins)\//.test(meta.folderName);
}

/** Plugins a preset switches. Required, hidden and API/core plugins look after themselves, and this one stays on. */
export function isManaged(name: string) {
    const p = plugins[name];
    if (!p || name === SELF || p.required || p.hidden) return false;
    return !/\/_(core|api)\//.test(`${PluginMeta[name]?.folderName ?? ""}/`);
}

function toJson(value: unknown): Json | undefined {
    try {
        const text = JSON.stringify(value);
        return text === undefined ? undefined : JSON.parse(text);
    } catch {
        return undefined;
    }
}

// Plain copies only: values read through the settings proxy can't be stored or written back as they are.
function readSetting(name: string, key: string): Json | undefined {
    const plain = PlainSettings.plugins[name];
    if (plain && Object.prototype.hasOwnProperty.call(plain, key)) return toJson(plain[key]);
    return toJson(Settings.plugins[name]?.[key]);
}

// Only settings the user picks. Custom and undeclared keys are the plugin's own state (install records, counters,
// caches), and putting an old copy of those back would break the plugin.
const USER_SETTINGS = new Set([OptionType.BOOLEAN, OptionType.SELECT, OptionType.NUMBER, OptionType.SLIDER, OptionType.STRING, OptionType.BIGINT]);

function settingKeys(name: string) {
    const keys = new Set<string>();
    for (const [key, def] of Object.entries(plugins[name]?.settings?.def ?? {}))
        if (USER_SETTINGS.has(def.type)) keys.add(key);
    keys.delete("enabled");
    if (name === "Muffinshelf") keys.delete("bdEnabled");
    return [...keys];
}

function readBd(): string[] | null {
    if (!plugins.Muffinshelf) return null;
    const list = PlainSettings.plugins.Muffinshelf?.bdEnabled;
    return Array.isArray(list) ? list.map(String).sort() : [];
}

// Every installed BetterDiscord file, from Muffinshelf's runtime once it has started. Null when that can't be told.
function installedBd(): Set<string> | null {
    if (!plugins.Muffinshelf?.started) return null;
    const all = (window as any).BdApi?.Plugins?.getAll?.();
    return Array.isArray(all) ? new Set(all.map((p: any) => String(p?.filename))) : null;
}

export function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function captureCurrent(name: string): Preset {
    const enabled = Object.keys(plugins).filter(n => isManaged(n) && Settings.plugins[n]?.enabled).sort();
    const settings: Preset["settings"] = {};
    for (const n of enabled) {
        const values: Record<string, Json> = {};
        for (const key of settingKeys(n)) {
            const value = readSetting(n, key);
            if (value !== undefined) values[key] = value;
        }
        if (Object.keys(values).length) settings[n] = values;
    }
    return { id: newId(), name, created: Date.now(), enabled, settings, bd: readBd() };
}

function dependenciesOf(name: string, into: Set<string>) {
    for (const dep of plugins[name]?.dependencies ?? []) {
        if (into.has(dep) || !plugins[dep]) continue;
        into.add(dep);
        dependenciesOf(dep, into);
    }
}

export function planApply(preset: Preset): Plan {
    const { imported } = preset;
    // Imported presets may only turn on official plugins. Unofficial ones they list stay on only if they already are.
    const allowedOn = (n: string) => !imported || isOfficial(n);

    const missing = preset.enabled.filter(n => !plugins[n]);
    const want = new Set(preset.enabled.filter(n => plugins[n] && isManaged(n) && allowedOn(n)));
    const listedUnofficial = imported?.unofficial ?? [];
    const keptUnofficial = listedUnofficial.filter(n => plugins[n] && isManaged(n) && !isOfficial(n) && Settings.plugins[n]?.enabled);
    const blockedUnofficial = listedUnofficial.filter(n => !keptUnofficial.includes(n));
    keptUnofficial.forEach(n => want.add(n));

    // Dependencies of plugins that stay on (including required ones the preset can't touch) are kept on too.
    const deps = new Set<string>();
    want.forEach(n => dependenciesOf(n, deps));
    Object.keys(plugins).filter(n => !isManaged(n) && Settings.plugins[n]?.enabled).forEach(n => dependenciesOf(n, deps));
    deps.forEach(d => { if (isManaged(d)) want.add(d); });

    const scope = Object.keys(plugins).filter(isManaged).sort();
    const turnOn = scope.filter(n => want.has(n) && !Settings.plugins[n]?.enabled && allowedOn(n));
    const turnOff = scope.filter(n => !want.has(n) && Settings.plugins[n]?.enabled);

    const restart = new Set<string>();
    for (const n of turnOn) {
        const p = plugins[n];
        const deps = new Set<string>();
        dependenciesOf(n, deps);
        if (pluginRequiresRestart(p) || [...deps].some(d => !Settings.plugins[d]?.enabled && pluginRequiresRestart(plugins[d]))) restart.add(n);
    }
    for (const n of turnOff) if (pluginRequiresRestart(plugins[n])) restart.add(n);

    const settingChanges: Plan["settingChanges"] = {};
    for (const n of want) {
        const saved = preset.settings[n];
        if (!saved) continue;
        const defs = plugins[n].settings?.def ?? {};
        const known = new Set(settingKeys(n));
        const changed = Object.keys(saved).filter(key =>
            known.has(key) && (!imported || Object.prototype.hasOwnProperty.call(defs, key)) && !deepEqual(readSetting(n, key), saved[key]));
        if (!changed.length) continue;
        settingChanges[n] = changed;
        if (!restart.has(n) && changed.some(key => defs[key]?.restartNeeded)) restart.add(`${n} (settings)`);
    }

    // BetterDiscord plugins: a saved preset sets the list exactly, minus files that were deleted since; an imported
    // one only keeps those it lists that are on.
    const current = readBd();
    const installed = imported ? null : installedBd();
    const bdTarget = !current ? null
        : imported ? current.filter(f => imported.betterDiscord.includes(f))
            : installed && preset.bd ? preset.bd.filter(f => installed.has(f) || current.includes(f))
                : preset.bd;
    if (bdTarget && preset.bd && !imported) missing.push(...preset.bd.filter(f => !bdTarget.includes(f)));
    const bdOn = bdTarget && current ? bdTarget.filter(f => !current.includes(f)) : [];
    const bdOff = bdTarget && current ? current.filter(f => !bdTarget.includes(f)) : [];
    if (bdOn.length || bdOff.length) restart.add("Muffinshelf BetterDiscord plugins");

    return { turnOn, turnOff, settingChanges, missing, restart: [...restart], bdOn, bdOff, bdTarget, keptUnofficial, blockedUnofficial };
}

export function applyPreset(preset: Preset): ApplyResult {
    const plan = planApply(preset);
    const failed: string[] = [];
    const restart = new Set(plan.restart);

    for (const n of plan.turnOff) {
        const p = plugins[n];
        try {
            if (!pluginRequiresRestart(p) && p.started && !stopPlugin(p)) {
                failed.push(`${n} couldn't stop, so it stays running until Discord restarts`);
                restart.add(n);
            }
        } catch (e) {
            logger.error(`Failed to stop ${n}`, e);
            restart.add(n);
        }
        Settings.plugins[n].enabled = false;
    }

    for (const [n, keys] of Object.entries(plan.settingChanges)) {
        for (const key of keys) {
            try {
                Settings.plugins[n][key] = toJson(preset.settings[n][key]);
            } catch (e) {
                logger.error(`Failed to set ${n}.${key}`, e);
                failed.push(`${n}: couldn't change the "${key}" setting`);
            }
        }
    }

    for (const n of plan.turnOn) {
        const p = plugins[n];
        try {
            const { restartNeeded, failures } = startDependenciesRecursive(p);
            if (failures.length) {
                failed.push(`${n} needs ${failures.join(", ")}, which failed to start, so it was left off`);
                continue;
            }
            if (restartNeeded || pluginRequiresRestart(p)) {
                Settings.plugins[n].enabled = true;
                restart.add(n);
                continue;
            }
            if (!p.started && !startPlugin(p)) {
                failed.push(`${n} failed to start, so it was left off`);
                continue;
            }
            Settings.plugins[n].enabled = true;
        } catch (e) {
            logger.error(`Failed to start ${n}`, e);
            failed.push(`${n} failed to start, so it was left off`);
        }
    }

    if ((plan.bdOn.length || plan.bdOff.length) && plan.bdTarget)
        Settings.plugins.Muffinshelf.bdEnabled = [...plan.bdTarget];

    return { plan, failed, restart: [...restart] };
}

const NAME_RE = /^[\w .+\-()]{1,80}$/;
const BD_RE = /^[\w .+\-()[\]]{1,120}\.plugin\.js$/i;
// Muffinshelf's own file rule, for the local list: any name it can install has to survive a restart.
const BD_FILE_RE = /^[^\\/:*?"<>|\p{C}]{1,120}\.plugin\.js$/u;

function strings(value: unknown, re: RegExp, max = 2000) {
    return Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === "string" && re.test(v)))].slice(0, max) : [];
}

// Anything read back from storage gets the same shape checks as an import, so a damaged store can't break the page.
function cleanStored(value: unknown): Preset[] {
    if (!Array.isArray(value)) return [];
    const out: Preset[] = [];
    for (const raw of value) {
        if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || typeof raw.name !== "string") continue;
        const settings = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
        const imported = raw.imported && typeof raw.imported === "object" ? {
            unofficial: strings(raw.imported.unofficial, NAME_RE),
            betterDiscord: strings(raw.imported.betterDiscord, BD_RE),
            missing: strings(raw.imported.missing, NAME_RE),
            scrubbed: raw.imported.scrubbed && typeof raw.imported.scrubbed === "object" ? raw.imported.scrubbed : {},
        } : undefined;
        out.push({
            id: raw.id,
            name: raw.name.slice(0, 64),
            created: typeof raw.created === "number" ? raw.created : Date.now(),
            enabled: strings(raw.enabled, NAME_RE),
            settings,
            bd: raw.bd === null || raw.bd === undefined ? null : strings(raw.bd, BD_FILE_RE),
            ...(imported && { imported }),
        });
    }
    return out;
}

export { BD_RE, NAME_RE };

let cache: Preset[] | null = null;
let loading: Promise<Preset[]> | null = null;
const listeners = new Set<(list: Preset[]) => void>();

export function loadPresets() {
    if (cache) return Promise.resolve(cache);
    return loading ??= DataStore.get(STORE_KEY)
        .then(value => (cache = cleanStored(value)))
        .catch(e => {
            logger.error("Couldn't read saved presets", e);
            return (cache = []);
        })
        .finally(() => { loading = null; });
}

async function store(next: Preset[]) {
    await DataStore.set(STORE_KEY, next);
    cache = next;
    listeners.forEach(l => l(next));
}

export async function savePreset(preset: Preset) {
    const list = await loadPresets();
    const same = list.findIndex(p => p.name.toLowerCase() === preset.name.toLowerCase());
    await store(same === -1 ? [...list, preset] : list.map((p, i) => i === same ? { ...preset, id: p.id } : p));
}

/** Adds a preset and never replaces a saved one: a name that's taken gets a number, like "Gaming (2)". */
export async function addPreset(preset: Preset) {
    const list = await loadPresets();
    const taken = new Set(list.map(p => p.name.toLowerCase()));
    let { name } = preset;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${preset.name.slice(0, 57)} (${i})`;
    await store([...list, { ...preset, name }]);
    return name;
}

export async function renamePreset(id: string, name: string) {
    const list = await loadPresets();
    await store(list.map(p => p.id === id ? { ...p, name } : p));
}

export async function deletePreset(id: string) {
    const list = await loadPresets();
    await store(list.filter(p => p.id !== id));
}

export function usePresets() {
    const [list, setList] = useState<Preset[] | null>(cache);
    useEffect(() => {
        listeners.add(setList);
        loadPresets().then(setList);
        return () => void listeners.delete(setList);
    }, []);
    return list;
}
