/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import type { PluginNative } from "@utils/types";
import { findStoreLazy } from "@webpack";
import { FluxDispatcher } from "@webpack/common";

import { buildCoreData, buildEngineData, Engine, type EngineData } from "./engine";

export const logger = new Logger("Autocorrect");
const Native = VencordNative.pluginHelpers.Autocorrect as PluginNative<typeof import("./native")> | undefined;

const SpellcheckStore: {
    isEnabled(): boolean;
    hasLearnedWord(word: string): boolean;
} = findStoreLazy("SpellcheckStore");

const KEY = "Autocorrect_data";
const SAVE_DELAY = 4000;
const LEARN_SAVE_DELAY = 60_000;
const SYNC_CHUNK = 100;
const IMPORT_MAX = 20_000;
const WORD = /^(?=.*\p{L})[\p{L}\p{M}'’-]{1,40}$/u;

interface Saved {
    words: string[];
    blocked: string[];
    learned: ReturnType<Engine["exportLearned"]>;
    reverts?: [string, number][];
    synced?: string[];
    fixed: number;
}

export const state = {
    words: new Set<string>(),
    blocked: new Set<string>(),
    learned: { unigrams: {}, bigrams: {} } as Saved["learned"],
    reverts: [] as [string, number][],
    /** words this plugin put into Discord's dictionary, so removing one never deletes a word the user added there themselves */
    synced: new Set<string>(),
    fixed: 0,
    full: false,
    loaded: false,
    running: false,
    readError: null as string | null,
    loadError: null as string | null,
    version: 0,
};

let engine: Engine | null = null;
let engineData: EngineData | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveDue = 0;
let extraKnown: ((w: string) => boolean) | null = null;
const listeners = new Set<() => void>();

export function onWordsChange(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}

function changed() {
    state.version++;
    listeners.forEach(fn => fn());
}

export function getEngine() {
    return engine;
}

function discordKnows(word: string) {
    try {
        return SpellcheckStore.hasLearnedWord(word);
    } catch {
        return false;
    }
}

function wire(data: EngineData) {
    const next = new Engine(data);
    if (engine) {
        state.learned = engine.exportLearned();
        state.reverts = engine.exportReverts();
    }
    state.words.forEach(w => next.addUserWord(w));
    state.blocked.forEach(w => next.blockSuggestion(w));
    next.setExternalKnown(w => discordKnows(w) || !!extraKnown?.(w));
    // the starter list knows far fewer words, so only the full list decides what gets dropped
    next.importLearned(data.core ? state.learned : onlyKnown(next, state.learned));
    next.importReverts(state.reverts);
    engine = next;
    engineData = data;
    changed();
}

/**
 * Learned counts only ever cover real words. Older saves (and any import) could hold typos that were sent often
 * enough to count as known, which would stop them being fixed, so those are dropped before the engine sees them.
 */
function onlyKnown(e: Engine, learned: Saved["learned"]): Saved["learned"] {
    const unigrams: Record<string, number> = {}, bigrams: Record<string, number> = {};
    const ok = new Map<string, boolean>();
    const known = (w: string) => {
        let k = ok.get(w);
        if (k === undefined) ok.set(w, k = e.isKnown(w));
        return k;
    };
    for (const [w, n] of Object.entries(learned?.unigrams ?? {})) if (known(w)) unigrams[w] = n;
    for (const [pair, n] of Object.entries(learned?.bigrams ?? {})) {
        const sp = pair.indexOf(" ");
        if (sp > 0 && known(pair.slice(0, sp)) && known(pair.slice(sp + 1))) bigrams[pair] = n;
    }
    return { unigrams, bigrams };
}

export function setExtraKnown(fn: ((w: string) => boolean) | null) {
    extraKnown = fn;
}

function save(delay: number | "now" = SAVE_DELAY) {
    if (delay === "now") {
        void flush();
        return;
    }
    const due = Date.now() + delay;
    if (saveTimer && saveDue <= due) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveDue = due;
    saveTimer = setTimeout(flush, delay);
}

export async function flush() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    if (!state.loaded) return;
    if (engine) {
        state.learned = engine.exportLearned();
        state.reverts = engine.exportReverts();
    }
    const data: Saved = {
        words: [...state.words],
        blocked: [...state.blocked],
        learned: state.learned,
        reverts: state.reverts,
        synced: [...state.synced],
        fixed: state.fixed,
    };
    await DataStore.set(KEY, data).catch(e => logger.error("Couldn't save the word list", e));
}

const strings = (v: unknown) => Array.isArray(v) ? v.filter((w): w is string => typeof w === "string") : [];

async function readSaved() {
    if (state.loaded) return true;
    let saved: Saved | undefined;
    try {
        saved = await DataStore.get<Saved>(KEY);
    } catch (e) {
        logger.error("Couldn't read the saved word list", e);
        state.readError = "Your saved dictionary couldn't be read, so changes won't be saved for now.";
        changed();
        return false;
    }
    if (state.loaded) return true;
    state.words = new Set(strings(saved?.words));
    state.blocked = new Set(strings(saved?.blocked));
    state.learned = saved?.learned && typeof saved.learned === "object" ? saved.learned : { unigrams: {}, bigrams: {} };
    state.reverts = Array.isArray(saved?.reverts) ? saved.reverts : [];
    state.synced = new Set(strings(saved?.synced));
    state.fixed = typeof saved?.fixed === "number" ? saved.fixed : 0;
    state.loaded = true;
    state.readError = null;
    if (engine && engineData) {
        // the engine ran on an empty dictionary while the read was failing; rebuild it with what was saved
        engine = null;
        wire(engineData);
    }
    changed();
    return true;
}

let loadToken = 0;
let running = { stopped: true };

async function loadLists(signal: { stopped: boolean; }, token: number) {
    if (!Native?.getWordLists) {
        state.loadError = null;
        changed();
        return;
    }
    try {
        const lists = await Native.getWordLists();
        if (signal.stopped || token !== loadToken) return;
        if (lists.unigrams) {
            await new Promise(r => setTimeout(r, 0));
            if (signal.stopped || token !== loadToken) return;
            const started = performance.now();
            wire(buildEngineData(lists.unigrams, lists.bigrams));
            state.full = true;
            logger.info(`Full word list ready in ${Math.round(performance.now() - started)} ms`);
        }
        state.loadError = lists.error;
        if (lists.error) logger.warn("Some word lists couldn't be downloaded:", lists.error);
    } catch (e) {
        state.loadError = e instanceof Error ? e.message : String(e);
        logger.error("Couldn't load the full word list", e);
    }
    changed();
}

export async function load(signal: { stopped: boolean; }) {
    running = signal;
    state.running = true;
    const token = ++loadToken;
    const retryLists = !state.full || !!state.loadError;
    state.loadError = null;
    await readSaved();
    if (signal.stopped || token !== loadToken) return;
    // even if the read failed the engine runs; flush() refuses to write until the dictionary was read
    if (!engine) wire(buildCoreData());
    if (retryLists) await loadLists(signal, token);
}

/** Retries whatever failed: reading the saved dictionary, then the word list download. */
export function reload() {
    return running.stopped ? readSaved().then(() => undefined) : load(running);
}

/** Lets the settings page edit the dictionary while the plugin is off, without ever writing over data it hasn't read. */
export function ensureSaved() {
    return readSaved();
}

function onUnload() {
    void flush();
}

export function startSaving() {
    window.addEventListener("beforeunload", onUnload);
}

export async function unload() {
    loadToken++;
    window.removeEventListener("beforeunload", onUnload);
    await flush();
    engine = null;
    engineData = null;
    state.full = false;
    state.running = false;
    state.loadError = null;
    changed();
}

function sameWord(a: string, b: string) {
    return a.toLowerCase() === b.toLowerCase();
}

/** Sends words to Discord's spellcheck in small batches so a big list never freezes the app. */
function syncToDiscord(words: string[]) {
    const todo = words.filter(w => !discordKnows(w));
    let i = 0;
    const step = () => {
        if (!state.loaded) return;
        for (const word of todo.slice(i, i + SYNC_CHUNK)) {
            if (!state.words.has(word)) continue;
            FluxDispatcher.dispatch({ type: "SPELLCHECK_LEARN_WORD", word });
            state.synced.add(word);
        }
        i += SYNC_CHUNK;
        if (i < todo.length) setTimeout(step, 50);
        else save();
    };
    if (todo.length) step();
}

/** Shares every dictionary word Discord doesn't know yet, for when sharing gets turned on. */
export function syncAllToDiscord() {
    if (state.loaded) syncToDiscord([...state.words]);
}

export function addWords(list: string[], syncDiscord: boolean) {
    if (!state.loaded) return 0;
    const added: string[] = [];
    for (const word of list) {
        const w = word.trim();
        if (!w || /\s/.test(w) || state.words.has(w)) continue;
        state.words.add(w);
        state.blocked.delete(w.toLowerCase());
        engine?.addUserWord(w);
        engine?.unblockSuggestion(w);
        added.push(w);
    }
    if (!added.length) return 0;
    if (syncDiscord) syncToDiscord(added);
    changed();
    save("now");
    return added.length;
}

export function addWord(word: string, syncDiscord: boolean) {
    addWords([word], syncDiscord);
}

export interface ImportResult {
    added: number;
    skipped: number;
    overCap: number;
    rejected: boolean;
}

/**
 * One word per line. Only the first column counts, so lists with counts, tabs or commas work, Hunspell .dic
 * flags ("apple/SM") are dropped and a leading bullet ("- word") is skipped.
 */
export function importWords(text: string, syncDiscord: boolean): ImportResult {
    const list: string[] = [];
    let skipped = 0, overCap = 0;
    for (const line of text.split(/\r?\n/)) {
        const fields = line.trim().split(/[\t,; /]+/).filter(Boolean);
        const first = /^[-*•]+$/.test(fields[0] ?? "") ? fields[1] ?? "" : fields[0] ?? "";
        if (!first) continue;
        if (!WORD.test(first)) skipped++;
        else if (list.length < IMPORT_MAX) list.push(first);
        else overCap++;
    }
    if (!list.length || skipped > list.length * 2) return { added: 0, skipped, overCap, rejected: true };
    return { added: addWords(list, syncDiscord), skipped, overCap, rejected: false };
}

export function removeWord(word: string, syncDiscord: boolean) {
    if (!state.loaded) return;
    state.words.delete(word);
    engine?.removeUserWord(word);
    for (const other of state.words) if (sameWord(other, word)) engine?.addUserWord(other);
    if (syncDiscord && state.synced.has(word) && discordKnows(word) && ![...state.words].some(o => sameWord(o, word))) {
        FluxDispatcher.dispatch({ type: "SPELLCHECK_UNLEARN_WORD", word });
    }
    state.synced.delete(word);
    changed();
    save("now");
}

export function blockWord(word: string) {
    if (!state.loaded) return;
    const w = word.toLowerCase();
    state.blocked.add(w);
    engine?.blockSuggestion(w);
    changed();
    save("now");
}

export function unblockWord(word: string) {
    if (!state.loaded) return;
    state.blocked.delete(word);
    engine?.unblockSuggestion(word);
    changed();
    save("now");
}

/**
 * Learns which known words you use and put together. Unknown words are never learned, so a typo sent again and
 * again can't turn into a "real" word; words you want kept reach the dictionary by undoing a fix or picking them twice.
 */
export function learnText(pairs: [string | null, string][]) {
    if (!engine || !state.loaded) return;
    let skipped: string | null = null;
    for (const [prev, word] of pairs) {
        if (!engine.isKnown(word)) {
            skipped = word;
            continue;
        }
        engine.learn(prev !== null && prev === skipped ? null : prev, word);
        skipped = null;
    }
    save(LEARN_SAVE_DELAY);
}

export function countFix() {
    state.fixed++;
    save();
}

export function uncountFix() {
    state.fixed = Math.max(0, state.fixed - 1);
    save();
}

export async function forgetLearned() {
    if (!state.loaded) return;
    state.learned = { unigrams: {}, bigrams: {} };
    if (engine && engineData) {
        state.reverts = engine.exportReverts();
        engine = null;
        wire(engineData);
    }
    await flush();
}

export function knowsWord(word: string) {
    return state.words.has(word) || discordKnows(word);
}
