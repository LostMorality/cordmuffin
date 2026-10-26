/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { popNotice, showNotice } from "@api/Notices";
import { Settings } from "@api/Settings";
import { escapeRegExp } from "@utils/text";
import { cache, fluxStores, moduleListeners, wreq } from "@webpack";

// Follows BetterDiscord's own lookup rules (src/betterdiscord/webpack), so plugins find the same modules they would there.

type Filter = ((exports: any, module?: any, id?: PropertyKey) => boolean) & { classKeys?: string[]; exact?: Filter; };

interface SearchOptions {
    first?: boolean;
    defaultExport?: boolean;
    searchExports?: boolean;
    searchDefault?: boolean;
    raw?: boolean;
    fatal?: boolean;
    withKey?: boolean;
    all?: boolean;
    map?: Record<string, Filter>;
    firstId?: PropertyKey;
    signal?: AbortSignal;
    target?: any;
    typeofIsObject?: boolean;
    declarationFilter?: Filter;
    mapDeclarations?: boolean;
}

type Query = SearchOptions & { filter: Filter; };

// String(fn) like BetterDiscord: Equicord wraps many module factories and answers toString() with the real source.
const fnSource = (fn: any) => {
    try {
        return String(fn);
    } catch {
        try {
            return Function.prototype.toString.call(fn);
        } catch {
            return "";
        }
    }
};

const makeException = () => new Error("Module search failed!");

// --- Discord renamed CSS class module keys (foo -> a1b2c3); plugins asking for "foo" still get it ---

const demangled = new WeakMap<object, Record<string, any>>();
const classPatterns = (keys: string[]) => keys.map(k => [k, new RegExp(`(?:^|\\s)${escapeRegExp(k)}_[\\w-]+(?=$|\\s)`)] as const);

function demangle(m: any, keys: string[]) {
    if (keys.every(k => k in m)) return m;
    const mapped = demangled.get(m) ?? { ...m };
    demangled.set(m, mapped);
    const values = Object.values(m);
    for (const [k, re] of classPatterns(keys)) mapped[k] ??= values.find(v => typeof v === "string" && re.test(v));
    return mapped;
}

// Discord's CSS modules now use short keys ({ kL: "container__5e434" }), which breaks filters like m => m.container && m.panels.
// This view adds the readable names back ({ container: "container__5e434", ... }) next to the real keys.
const classViews = new WeakMap<object, Record<string, any> | null>();
const CLASS_NAME = /^([A-Za-z][\w-]*?)_{1,2}[0-9a-f]{4,}$/i;

function classView(exports: any): Record<string, any> | null {
    if (!exports || typeof exports !== "object") return null;
    if (classViews.has(exports)) return classViews.get(exports)!;
    let view: Record<string, any> | null = null;
    try {
        const entries = Object.entries(exports);
        if (entries.length && entries.every(([, v]) => typeof v === "string")) {
            const mapped: Record<string, any> = { ...exports };
            for (const [, value] of entries) {
                const name = (value as string).split(" ")[0].match(CLASS_NAME)?.[1];
                if (name && !(name in mapped)) mapped[name] = value;
            }
            if (Object.keys(mapped).length > entries.length) view = mapped;
        }
    } catch {
        view = null;
    }
    classViews.set(exports, view);
    return view;
}

// Discord defines module exports as getters only, so plugins that assign to them (module.A = patched) throw.
// BetterDiscord plugins expect to be able to, so every configurable getter-only export gets a setter that swaps in the new value.
// Webpack's export getters are () => localName, so they also give the names the module uses for its exports.
// BetterDiscord exposes those as module.declarations ({ localName: value }) and some plugins search by them.
const localNames = new WeakMap<object, Record<string, string>>();
const GETTER_NAME = /^\(\)\s*=>\s*\(?([\w$]+)\)?$/;

function recordNames(exports: any) {
    if (localNames.has(exports)) return;
    const names: Record<string, string> = {};
    for (const key of Object.keys(exports)) {
        const get = Object.getOwnPropertyDescriptor(exports, key)?.get;
        const name = get && fnSource(get).match(GETTER_NAME)?.[1];
        if (name) names[name] = key;
    }
    localNames.set(exports, names);
}

const FALLBACK = Symbol("Muffinshelf.exportedOnly");

function declarationsOf(module: any) {
    const exports = module?.exports;
    const declarations: Record<string, any> = {};
    Object.defineProperty(declarations, FALLBACK, { value: true });
    if (!exports || (typeof exports !== "object" && typeof exports !== "function")) return declarations;
    recordNames(exports);
    for (const [name, key] of Object.entries(localNames.get(exports)!)) {
        Object.defineProperty(declarations, name, { get: () => exports[key], set: v => exports[key] = v, enumerable: true, configurable: true });
    }
    return declarations;
}

function addDeclarations(module: any) {
    if (!module || typeof module !== "object" || Object.prototype.hasOwnProperty.call(module, "declarations")) return;
    let cached: Record<string, any> | undefined;
    Object.defineProperty(module, "declarations", {
        get: () => {
            learnModule(module.id);
            return cached ??= declarationsOf(module);
        },
        configurable: true,
    });
}

// --- Learning which modules plugins want private variables from ---
// The module gets a unique string from its own source as its Equicord patch "find"; after a restart the patch
// (see declarations.ts) makes it expose all of its top-level variables.

export const DECLARATION_FINDS_KEY = "bdDeclarationFinds";
const MAX_FINDS = 300;
const learnedIds = new Set<PropertyKey>();
let restartNoticeShown = false;

// Plain text strings outlast Discord updates better than fragments of minified code.
const READABLE = /^"[\w .,:'!?#/-]+"$/;

function uniqueFind(id: PropertyKey) {
    const source = fnSource(wreq.m[id as any]);
    const candidates = [...new Set([...source.matchAll(/"[^"\\\n]{12,80}"/g)].map(m => m[0]))].sort((a, b) => Number(READABLE.test(b)) - Number(READABLE.test(a)) || b.length - a.length).slice(0, 15);
    if (!candidates.length) return null;
    const others = Object.keys(wreq.m).filter(k => k !== String(id)).map(k => fnSource(wreq.m[k]));
    return candidates.find(c => !others.some(o => o.includes(c))) ?? null;
}

function learnModule(id: PropertyKey) {
    if (id == null || learnedIds.has(id)) return;
    learnedIds.add(id);
    setTimeout(() => {
        try {
            const find = uniqueFind(id);
            const store = Settings.plugins.Muffinshelf as Record<string, any>;
            const finds: string[] = Array.isArray(store[DECLARATION_FINDS_KEY]) ? store[DECLARATION_FINDS_KEY] : [];
            if (!find || finds.includes(find)) return;
            store[DECLARATION_FINDS_KEY] = [...finds, find].slice(-MAX_FINDS);
            if (restartNoticeShown) return;
            restartNoticeShown = true;
            showNotice("A BetterDiscord plugin needs one Discord restart to reach the parts of Discord it uses.", "Restart", () => {
                popNotice();
                location.reload();
            });
        } catch { }
    }, 0);
}

function getDeclaration(module: any, filter: Filter, withKey: boolean) {
    const declarations = module.declarations ?? declarationsOf(module);
    for (const name of Object.keys(declarations)) {
        let hit = false;
        try {
            hit = !!filter(declarations[name]);
        } catch { }
        if (hit) return withKey ? [declarations, name] : declarations[name];
    }
    return undefined;
}

function writableExports(exports: any) {
    if (!exports || (typeof exports !== "object" && typeof exports !== "function") || skip(exports)) return;
    recordNames(exports);
    for (const key of Object.keys(exports)) {
        const desc = Object.getOwnPropertyDescriptor(exports, key);
        if (!desc?.get || desc.set || !desc.configurable) continue;
        Object.defineProperty(exports, key, {
            get: desc.get,
            set(value) {
                Object.defineProperty(exports, key, { value, writable: true, configurable: true, enumerable: desc.enumerable });
            },
            configurable: true,
            enumerable: desc.enumerable,
        });
    }
}

const onModuleLoaded = (exports: any, id: PropertyKey) => {
    try {
        addDeclarations(cache[id as any]);
        writableExports(exports);
    } catch { }
};
let exportsHooked = false;

export function makeExportsWritable() {
    if (exportsHooked) return;
    exportsHooked = true;
    for (const id of Object.keys(cache)) {
        try {
            addDeclarations(cache[id]);
            writableExports(cache[id]?.exports);
        } catch { }
    }
    moduleListeners.add(onModuleLoaded);
}

// --- React element types, unwrapped like BetterDiscord's getType ---

const MEMO = Symbol.for("react.memo");
const FORWARD_REF = Symbol.for("react.forward_ref");
const LAZY = Symbol.for("react.lazy");

function getType(type: any) {
    for (let i = 0; i < 10 && type; i++) {
        if (type.$$typeof === MEMO) type = type.type;
        else if (type.$$typeof === FORWARD_REF) type = type.render;
        else if (type.$$typeof === LAZY && type._payload?._status === 1) type = type._payload._result?.default;
        else break;
    }
    return type;
}

// --- Filters ---

function byKeys(...keys: string[]): Filter {
    const patterns = classPatterns(keys);
    const exact: Filter = m => m != null && (typeof m === "object" || typeof m === "function") && keys.every(k => k in m);
    const byClass: Filter = m => {
        if (m == null || typeof m !== "object") return false;
        const values = Object.values(m).filter((v): v is string => typeof v === "string");
        return values.length > 0 && patterns.every(([k, re]) => values.some(v => v.includes(k) && re.test(v)));
    };
    return Object.assign((m: any) => exact(m) || byClass(m), { classKeys: keys, exact });
}

export const Filters = {
    byKeys,
    byProps: (...keys: string[]): Filter => byKeys(...keys),
    byPrototypeKeys: (...keys: string[]): Filter => m => m != null && (typeof m === "object" || typeof m === "function") && m.prototype != null && keys.every(k => k in m.prototype),
    byPrototypeFields: (...keys: string[]): Filter => Filters.byPrototypeKeys(...keys),
    byStrings: (...strings: string[]): Filter => m => {
        if (typeof m !== "function") return false;
        const src = fnSource(m);
        return strings.every(s => src.includes(s));
    },
    byRegex: (regex: RegExp): Filter => m => !!m && fnSource(m).search(regex) !== -1,
    bySource: (...search: (string | RegExp)[]): Filter => (_, module) => {
        const factory = module?.id != null ? wreq.m[module.id] : null;
        if (!factory) return false;
        const src = fnSource(factory);
        return !!src && search.every(s => typeof s === "string" ? src.includes(s) : s.test(src));
    },
    byDisplayName: (name: string): Filter => m => m?.displayName === name,
    byStoreName: (name: string): Filter => m => m?._dispatchToken != null && m?.getName?.() === name,
    byDestructure: (...properties: string[]): Filter => m => {
        if (typeof m !== "function") return false;
        const str = fnSource(m);
        for (let end = str.indexOf("}="); end !== -1; end = str.indexOf("}=", end + 2)) {
            const start = str.lastIndexOf("{", end);
            if (start === -1) continue;
            const names = str.substring(start + 1, end).split(",").map(p => p.split(":")[0].split("=")[0].trim());
            if (properties.every(p => names.includes(p))) return true;
        }
        return false;
    },
    byComponentType: (filter: Filter): Filter => m => {
        const component = getType(m);
        return typeof component === "function" && filter(component);
    },
    combine: (...filters: Filter[]): Filter => (e, m, i) => filters.every(f => f(e, m, i)),
    not: (filter: Filter): Filter => (e, m, i) => !filter(e, m, i),
};

function wrap(filter: Filter): Filter {
    return Object.assign((exports: any, module?: any, id?: PropertyKey) => {
        try {
            if (exports instanceof Window) return false;
            // Never hand plugins the token or email stores.
            if (exports?.getToken || exports?.getEmail || exports?.showToken || exports?.default?.getToken || exports?.default?.getEmail) return false;
            return !!filter(exports, module, id);
        } catch {
            return false;
        }
    }, { classKeys: filter.classKeys });
}

const CATCH_ALL_PROBE = "__muffinshelfProbe__";
const TypedArray = Object.getPrototypeOf(Uint8Array);

function skip(exports: any) {
    if (!(typeof exports === "object" || typeof exports === "function") || !exports) return true;
    try {
        if (exports === window || exports === document || exports === document.documentElement || exports === Symbol) return true;
        if (exports instanceof Window || exports instanceof TypedArray) return true;
        const tag = exports[Symbol.toStringTag];
        if (tag === "DOMTokenList" || (typeof tag === "string" && tag.endsWith("Proxy"))) return true;
        if (exports.TypedArray || (exports.$$loader && exports.$$baseObject)) return true;
        return CATCH_ALL_PROBE in exports || "$$loader" in exports;
    } catch {
        return true;
    }
}

function defaultKey(exports: any) {
    for (const key of ["A", "Ay"]) if (key in exports) return key;
    if (exports.__esModule && "default" in exports) return "default";
    for (const key of ["Z", "ZP"]) if (key in exports) return key;
    return undefined;
}

export function mapObject(module: any, mappers: Record<string, Filter>) {
    const mapped: Record<string, any> = Object.create(null);
    if (module == null) return mapped;
    const keys = Object.keys(mappers);
    for (const searchKey of Object.keys(module)) {
        for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(mapped, key)) continue;
            let value: any;
            try {
                value = module[searchKey];
            } catch {
                continue;
            }
            let hit = false;
            try {
                hit = !!mappers[key](value);
            } catch { }
            if (hit) {
                Object.defineProperty(mapped, key, {
                    get: () => module[searchKey],
                    set: v => module[searchKey] = v,
                    enumerable: true,
                    configurable: true,
                });
            }
        }
    }
    return mapped;
}

function matchedRaw(module: any, filter: Filter, opts: SearchOptions): any {
    const { exports } = module;
    if (skip(exports)) return undefined;
    const { defaultExport = true, searchExports = false, searchDefault = true, raw = false, withKey = false, map, declarationFilter, mapDeclarations } = opts;
    const { id } = module;

    if (filter(exports, module, id)) {
        if (declarationFilter) return getDeclaration(module, declarationFilter, withKey);
        if (map) return mapObject(mapDeclarations ? module.declarations ?? declarationsOf(module) : exports, map);
        return raw ? module : withKey ? [module, "exports"] : exports;
    }
    const view = classView(exports);
    if (view && filter(view, module, id)) return raw ? module : withKey ? [module, "exports"] : view;
    if (!searchExports && !searchDefault) return undefined;

    let defKey: string | undefined;
    const keys: string[] = [];
    if (searchExports) {
        try {
            keys.push(...Object.keys(exports));
        } catch {
            return undefined;
        }
    } else if ((defKey = defaultKey(exports))) keys.push(defKey);

    for (const key of keys) {
        let value: any;
        try {
            value = exports[key];
        } catch {
            continue;
        }
        if (skip(value) || !filter(value, module, id)) continue;
        if (declarationFilter) return getDeclaration(module, declarationFilter, withKey);
        if (map) return mapObject(raw ? exports : mapDeclarations ? module.declarations ?? declarationsOf(module) : value, map);
        if (raw) return module;
        if (!defaultExport && defKey === key) return withKey ? [module, "exports"] : exports;
        return withKey ? [exports, key] : value;
    }
    return undefined;
}

function matched(module: any, filter: Filter, opts: SearchOptions) {
    const found = matchedRaw(module, filter, opts);
    if (found === undefined || !filter.classKeys || opts.raw || opts.map || opts.withKey) return found;
    return typeof found === "object" ? demangle(found, filter.classKeys) : found;
}

function loadedModules() {
    return Object.keys(cache).map(id => cache[id]).filter(m => m && (m.loaded || m.exports));
}

function findFirst(filter: Filter, opts: SearchOptions) {
    if (opts.firstId != null && cache[opts.firstId as any]) {
        const hit = matched(cache[opts.firstId as any], filter, opts);
        if (hit !== undefined) return hit;
    }
    for (const module of loadedModules()) {
        const hit = matched(module, filter, opts);
        if (hit !== undefined) return hit;
    }
    return undefined;
}

export function getModule(filter: Filter, opts: SearchOptions = {}): any {
    if (typeof filter !== "function") return opts.first === false ? [] : undefined;
    if (opts.first === false) return getAllModules(filter, opts);
    // Exact key matches win over the class-name fallback, so "foo" doesn't pick a module that only has "foo_x1y2" classes.
    let found = filter.exact ? findFirst(wrap(filter.exact), opts) : undefined;
    if (found === undefined) found = findFirst(wrap(filter), opts);
    if (found === undefined && opts.fatal) throw makeException();
    return found;
}

export function getAllModules(filter: Filter, opts: SearchOptions = {}) {
    if (typeof filter !== "function") return [];
    const wrapped = wrap(filter);
    const { searchExports = false, searchDefault = true, defaultExport = true, raw = false, withKey = false, map } = opts;
    const out: any[] = [];
    for (const module of loadedModules()) {
        const { exports } = module;
        if (skip(exports)) continue;
        const view = classView(exports);
        if (wrapped(exports, module, module.id)) {
            out.push(map ? mapObject(exports, map) : raw ? module : withKey ? [module, "exports"] : exports);
        } else if (view && wrapped(view, module, module.id)) {
            out.push(raw ? module : withKey ? [module, "exports"] : view);
        }
        if (!searchExports && !searchDefault) continue;
        let defKey: string | undefined;
        const keys: string[] = [];
        if (searchExports) {
            try {
                keys.push(...Object.keys(exports));
            } catch {
                continue;
            }
        } else if ((defKey = defaultKey(exports))) keys.push(defKey);
        for (const key of keys) {
            let value: any;
            try {
                value = exports[key];
            } catch {
                continue;
            }
            if (skip(value) || !wrapped(value, module, module.id)) continue;
            if (!defaultExport && defKey === key) out.push(map ? mapObject(exports, map) : withKey ? [module, "exports"] : exports);
            else out.push(map ? mapObject(raw ? exports : value, map) : raw ? module : withKey ? [exports, key] : value);
        }
    }
    if (opts.fatal && !out.length) throw makeException();
    return out;
}

export function getBulk(...queries: Query[]) {
    return queries.map(q => {
        if (!q || typeof q.filter !== "function") return undefined;
        if (q.all) return getAllModules(q.filter, q);
        const found = getModule(q.filter, { ...q, fatal: false });
        if (found !== undefined) return found;
        if (q.fatal) throw makeException();
        return q.map ? {} : undefined;
    });
}

const waiting = new Set<(exports: any, id: PropertyKey) => void>();

export function clearWaits() {
    for (const listener of waiting) moduleListeners.delete(listener);
    waiting.clear();
}

export function waitForModule(filter: Filter, opts: SearchOptions = {}) {
    const existing = getModule(filter, { ...opts, first: true, fatal: false });
    if (existing !== undefined) return Promise.resolve(existing);
    if (opts.signal?.aborted) return opts.fatal ? Promise.reject(makeException()) : Promise.resolve(undefined);

    const exact = filter.exact ? wrap(filter.exact) : null;
    const full = wrap(filter);
    return new Promise<any>((resolve, reject) => {
        const done = () => {
            moduleListeners.delete(listener);
            waiting.delete(listener);
        };
        const listener = (_exports: any, id: PropertyKey) => {
            const module = cache[id as any];
            if (!module) return;
            const match = (exact ? matched(module, exact, opts) : undefined) ?? matched(module, full, opts);
            if (match === undefined) return;
            done();
            resolve(match);
        };
        moduleListeners.add(listener);
        waiting.add(listener);
        opts.signal?.addEventListener("abort", () => {
            done();
            if (opts.fatal) reject(makeException());
            else resolve(undefined);
        }, { once: true });
    });
}

function getStore(name: string) {
    return fluxStores.get(name) ?? getModule(Filters.byStoreName(name));
}

function getById(id: PropertyKey, opts: SearchOptions = {}) {
    const module = cache[id as any];
    if (module && !skip(module.exports)) return opts.raw ? module : module.exports;
    if (opts.fatal) throw makeException();
    return undefined;
}

function getMangled(filter: Filter | string | RegExp | (string | RegExp)[] | number, mappers: Record<string, Filter>, opts: SearchOptions = {}) {
    const moduleFilter = typeof filter === "string" || filter instanceof RegExp ? Filters.bySource(filter)
        : Array.isArray(filter) ? Filters.bySource(...filter)
            : filter;
    const raw = opts.raw ?? opts.mapDeclarations ?? false;
    const search = { ...opts, raw, map: undefined, mapDeclarations: undefined, first: true };
    let module = typeof moduleFilter === "number" ? getById(moduleFilter, search) : getModule(moduleFilter, search);
    if (!module) {
        if (opts.fatal) throw makeException();
        return {};
    }
    if (raw) module = opts.mapDeclarations ? module.declarations ?? declarationsOf(module) : module.exports;
    return mapObject(module, mappers);
}

// A stand-in that looks up the real module the first time it's used.
function lazyProxy(resolve: () => any, typeofIsObject = false) {
    let value: any;
    let done = false;
    const get = () => {
        if (!done) {
            value = resolve();
            done = true;
        }
        return value;
    };
    const target = typeofIsObject ? {} : function () { };
    return new Proxy(target, {
        get: (_, key) => get()?.[key],
        set: (_, key, v) => Reflect.set(get(), key, v),
        has: (_, key) => key in Object(get()),
        ownKeys: () => {
            const keys = Reflect.ownKeys(Object(get()));
            return typeofIsObject || keys.includes("prototype") ? keys : [...keys, "prototype"];
        },
        // A function target's "prototype" can't be reported any other way, so it always comes from the target itself.
        getOwnPropertyDescriptor: (t, key) => {
            if (key === "prototype" && !typeofIsObject) return Reflect.getOwnPropertyDescriptor(t, key);
            const desc = Reflect.getOwnPropertyDescriptor(Object(get()), key);
            return desc ? { ...desc, configurable: true } : undefined;
        },
        apply: (_, thisArg, args) => Reflect.apply(get(), thisArg, args),
        construct: (_, args) => Reflect.construct(get(), args),
        getPrototypeOf: () => Reflect.getPrototypeOf(Object(get())),
    });
}

function splitOptions(args: any[]): [any[], SearchOptions] {
    const last = args[args.length - 1];
    if (args.length > 1 && last && typeof last === "object" && !Array.isArray(last) && !(last instanceof RegExp)) return [args.slice(0, -1), last];
    return [args, {}];
}

function byArgs(make: (...a: any[]) => Filter, all = false) {
    return (...args: any[]) => {
        const [values, opts] = splitOptions(args);
        return getModule(make(...values), all ? { ...opts, first: false } : opts);
    };
}

export const Webpack = {
    Filters,
    get modules() {
        return wreq.m;
    },
    get require() {
        return wreq;
    },
    Stores: new Proxy({} as Record<string, any>, { get: (_, name) => typeof name === "string" ? getStore(name) : undefined }),
    getModule,
    getModules: (filter: Filter, opts: SearchOptions = {}) => getAllModules(filter, opts),
    waitForModule,
    getBulk,
    getBulkKeyed(queries: Record<string, Query>) {
        const keys = Object.keys(queries);
        const found = getBulk(...keys.map(k => queries[k]));
        return Object.fromEntries(keys.map((k, i) => [k, found[i]]));
    },
    getByKeys: byArgs(byKeys),
    getAllByKeys: byArgs(byKeys, true),
    getByPrototypeKeys: byArgs(Filters.byPrototypeKeys),
    getAllByPrototypeKeys: byArgs(Filters.byPrototypeKeys, true),
    getByStrings: byArgs(Filters.byStrings),
    getAllByStrings: byArgs(Filters.byStrings, true),
    getBySource: byArgs(Filters.bySource),
    getAllBySource: byArgs(Filters.bySource, true),
    getByRegex: (regex: RegExp, opts: SearchOptions = {}) => getModule(Filters.byRegex(regex), opts),
    getAllByRegex: (regex: RegExp, opts: SearchOptions = {}) => getModule(Filters.byRegex(regex), { ...opts, first: false }),
    getByDisplayName: (name: string, opts: SearchOptions = {}) => getModule(Filters.byDisplayName(name), opts),
    getStore,
    getById,
    getMangled,
    getProxy: (filter: Filter, opts: SearchOptions = {}) => lazyProxy(() => getModule(filter, { ...opts, fatal: true }), opts.typeofIsObject),
    getMangledProxy: (filter: any, mappers: Record<string, Filter>, opts: SearchOptions = {}) => lazyProxy(() => getMangled(filter, mappers, { ...opts, fatal: true }), true),
    // Destructures like BetterDiscord's generator: const [module, key] = getWithKey(filter).
    getWithKey(filter: Filter, opts: SearchOptions = {}): [any, string | undefined] {
        const wrapped = wrap(filter);
        const target = opts.target ?? getModule(exports => {
            if (exports == null || typeof exports !== "object") return false;
            return Object.keys(exports).some(key => {
                try {
                    return wrapped(exports[key]);
                } catch {
                    return false;
                }
            });
        }, { ...opts, searchDefault: false });
        if (!target) return [undefined, undefined];
        return [target, Object.keys(target).find(key => wrapped(target[key]))];
    },
};

// --- Utils.forceLoad / Utils.loadEntry: load a lazy chunk's modules, ported from BetterDiscord's webpack/lazy.ts ---

const CHUNK_ID = /.\.e\("(\d+)"\)/g;
const FINAL_MODULE_ID = /.\.bind\(.,\s*(\d+)\s*\)/g;
const CREATE_PROMISE_ID = /createPromise:\s*\(\)\s*=>\s*([^}]+)\.then\(.\.bind\(.,\s*(\d+)\)\)/g;
const LAZY_CHUNK = /Promise\.all\(\[((?:\w\.e\("?\d+"?\),?)+)\]\)\.then\(\w(?:\.\w)?\.bind\(\w,\s*"?(\d+)"?\)\)/g;
const workerChunks = new Map<string, Promise<boolean>>();
const req = wreq as any;

export async function forceLoad(id: string | number) {
    if (req.m[id] === undefined) return [];
    const text = fnSource(req.m[id]);
    const loaded: any[] = [];

    for (const [, body, bindId] of text.matchAll(CREATE_PROMISE_ID)) {
        const chunkIds = [...body.matchAll(CHUNK_ID)].map(m => m[1]);
        await Promise.all(chunkIds.map(cid => req.e(cid)));
        loaded.push(req(parseInt(bindId, 10)));
    }

    const chunkIds = [...text.matchAll(CHUNK_ID)].map(m => m[1]);
    for (const [, bindId] of text.matchAll(FINAL_MODULE_ID)) {
        await Promise.all(chunkIds.map(cid => req.e(cid)));
        loaded.push(req(bindId));
    }
    return loaded;
}

export async function loadEntry(fn: ((...args: any[]) => any) | string) {
    const source = fn ? String(fn).replace(/\s+/g, "") : "";
    const chunks = [...source.matchAll(LAZY_CHUNK)];
    if (!chunks.length) return null;

    const entries: string[] = [];
    await Promise.all(chunks.map(async ([, rawIds, entry]) => {
        const chunkIds = [...rawIds.matchAll(CHUNK_ID)].map(m => m[1]);
        await Promise.all(chunkIds.map(async id => {
            const path = req.u?.(id);
            if (path == null || path.includes("undefined.js")) return;
            try {
                // Worker chunks can't be loaded into the page.
                let isWorker = workerChunks.get(id);
                if (!isWorker) {
                    isWorker = fetch(req.p + path).then(r => r.text()).then(t => /importScripts\(|self\.postMessage/.test(t));
                    workerChunks.set(id, isWorker);
                }
                if (!await isWorker) await req.e(id);
            } catch { }
        }));
        if (req.m[entry]) {
            req(entry);
            entries.push(entry);
        }
    }));
    return entries.map(x => req(x));
}
