/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { escapeRegExp } from "@utils/text";
import { cache, fluxStores, moduleListeners, wreq } from "@webpack";

type Filter = ((exports: any, module?: any, id?: PropertyKey) => boolean) & { classKeys?: string[]; exact?: Filter; };

interface SearchOptions {
    first?: boolean;
    defaultExport?: boolean;
    searchExports?: boolean;
    searchDefault?: boolean;
    raw?: boolean;
    signal?: AbortSignal;
    target?: any;
}

const fnSource = (fn: any) => {
    try {
        return Function.prototype.toString.call(fn);
    } catch {
        return "";
    }
};

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
    byProps: (...keys: string[]): Filter => Filters.byKeys(...keys),
    byPrototypeKeys: (...keys: string[]): Filter => m => m?.prototype != null && keys.every(k => k in m.prototype),
    byPrototypeFields: (...keys: string[]): Filter => Filters.byPrototypeKeys(...keys),
    byStrings: (...strings: string[]): Filter => m => {
        if (typeof m !== "function") return false;
        const src = fnSource(m);
        return strings.every(s => src.includes(s));
    },
    byRegex: (regex: RegExp): Filter => m => typeof m === "function" && regex.test(fnSource(m)),
    bySource: (...search: (string | RegExp)[]): Filter => (_, module) => {
        const factory = module?.id != null ? wreq.m[module.id] : null;
        if (!factory) return false;
        const src = fnSource(factory);
        return search.every(s => typeof s === "string" ? src.includes(s) : s.test(src));
    },
    byDisplayName: (name: string): Filter => m => m?.displayName === name,
    byStoreName: (name: string): Filter => m => m?._dispatchToken != null && m?.getName?.() === name,
    byComponentType: (filter: Filter): Filter => m => m?.$$typeof != null && filter(m.type ?? m.render),
    combine: (...filters: Filter[]): Filter => (e, m, i) => filters.every(f => f(e, m, i)),
    not: (filter: Filter): Filter => (e, m, i) => !filter(e, m, i),
};

const safe = (filter: Filter): Filter => Object.assign((e: any, m?: any, i?: PropertyKey) => {
    try {
        return !!filter(e, m, i);
    } catch {
        return false;
    }
}, { classKeys: filter.classKeys });

function search(filter: Filter, opts: SearchOptions) {
    const found: any[] = [];
    for (const id in cache) {
        const module = cache[id];
        if (!module?.loaded && !module?.exports) continue;
        const match = check(module, id, filter, opts);
        if (match === undefined) continue;
        if (opts.first !== false) return [match];
        found.push(match);
    }
    return found;
}

const CATCH_ALL_PROBE = "__muffinshelfProbe__";

function skip(exports: any) {
    if (exports == null || exports === window || exports === document || exports === document.documentElement) return true;
    try {
        const tag = exports[Symbol.toStringTag];
        if (tag === "DOMTokenList" || (typeof tag === "string" && tag.endsWith("Proxy"))) return true;
        return (typeof exports === "object" || typeof exports === "function") && (CATCH_ALL_PROBE in exports || "$$loader" in exports);
    } catch {
        return true;
    }
}

function check(module: any, id: PropertyKey, filter: Filter, opts: SearchOptions): any {
    let found: any;
    try {
        found = checkRaw(module, id, filter, opts);
    } catch {
        return undefined;
    }
    return filter.classKeys && found !== undefined && !opts.raw ? demangle(found, filter.classKeys) : found;
}

function checkRaw(module: any, id: PropertyKey, filter: Filter, opts: SearchOptions): any {
    const { exports } = module;
    if (skip(exports)) return undefined;
    const { defaultExport = true, searchExports = false, searchDefault = true, raw = false } = opts;

    if (searchExports && typeof exports === "object") {
        for (const key in exports) {
            let value: any;
            try {
                value = exports[key];
            } catch {
                continue;
            }
            if (!skip(value) && filter(value, module, id)) return raw ? module : value;
        }
        return undefined;
    }

    if (filter(exports, module, id)) return raw ? module : exports;
    if (searchDefault && (typeof exports === "object" || typeof exports === "function")) {
        for (const key of ["A", "Ay", "default", "Z", "ZP"]) {
            if (!(key in exports)) continue;
            const value = exports[key];
            if (!skip(value) && filter(value, module, id)) return raw ? module : defaultExport ? value : exports;
        }
    }
    return undefined;
}

export function getModule(filter: Filter, opts: SearchOptions = {}) {
    if (typeof filter !== "function") return opts.first === false ? [] : undefined;
    let found = filter.exact ? search(safe(filter.exact), opts) : [];
    if (!found.length) found = search(safe(filter), opts);
    return opts.first === false ? found : found[0];
}

function splitOptions(args: any[]): [string[], SearchOptions] {
    const last = args[args.length - 1];
    if (last && typeof last === "object" && !Array.isArray(last) && !(last instanceof RegExp)) return [args.slice(0, -1), last];
    return [args, {}];
}

const waiting = new Set<(exports: any, id: PropertyKey) => void>();

export function clearWaits() {
    for (const listener of waiting) moduleListeners.delete(listener);
    waiting.clear();
}

export function waitForModule(filter: Filter, opts: SearchOptions = {}) {
    const existing = getModule(filter, { ...opts, first: true });
    if (existing !== undefined) return Promise.resolve(existing);

    const wrapped = safe(filter.exact ?? filter);
    return new Promise<any>((resolve, reject) => {
        const done = () => {
            moduleListeners.delete(listener);
            waiting.delete(listener);
        };
        const listener = (_exports: any, id: PropertyKey) => {
            const module = cache[id as any];
            if (!module) return;
            const match = check(module, id, wrapped, opts) ?? (filter.exact ? check(module, id, safe(filter), opts) : undefined);
            if (match === undefined) return;
            done();
            resolve(match);
        };
        moduleListeners.add(listener);
        waiting.add(listener);
        opts.signal?.addEventListener("abort", () => {
            done();
            reject(new Error("Aborted"));
        }, { once: true });
    });
}

function getStore(name: string) {
    return fluxStores.get(name) ?? getModule(Filters.byStoreName(name));
}

export const Webpack = {
    Filters,
    get modules() {
        return wreq.m;
    },
    get require() {
        return wreq;
    },
    getModule,
    getModules: (filter: Filter, opts: SearchOptions = {}) => getModule(filter, { ...opts, first: false }),
    waitForModule,
    getBulk: (...queries: (SearchOptions & { filter: Filter; })[]) => queries.map(q => getModule(q.filter, q)),
    getByKeys: (...args: any[]) => {
        const [keys, opts] = splitOptions(args);
        return getModule(Filters.byKeys(...keys), opts);
    },
    getAllByKeys: (...args: any[]) => {
        const [keys, opts] = splitOptions(args);
        return getModule(Filters.byKeys(...keys), { ...opts, first: false });
    },
    getByPrototypeKeys: (...args: any[]) => {
        const [keys, opts] = splitOptions(args);
        return getModule(Filters.byPrototypeKeys(...keys), opts);
    },
    getAllByPrototypeKeys: (...args: any[]) => {
        const [keys, opts] = splitOptions(args);
        return getModule(Filters.byPrototypeKeys(...keys), { ...opts, first: false });
    },
    getByStrings: (...args: any[]) => {
        const [strings, opts] = splitOptions(args);
        return getModule(Filters.byStrings(...strings), opts);
    },
    getAllByStrings: (...args: any[]) => {
        const [strings, opts] = splitOptions(args);
        return getModule(Filters.byStrings(...strings), { ...opts, first: false });
    },
    getBySource: (...args: any[]) => {
        const [search, opts] = splitOptions(args);
        return getModule(Filters.bySource(...search), opts);
    },
    getAllBySource: (...args: any[]) => {
        const [search, opts] = splitOptions(args);
        return getModule(Filters.bySource(...search), { ...opts, first: false });
    },
    getByRegex: (regex: RegExp, opts: SearchOptions = {}) => getModule(Filters.byRegex(regex), opts),
    getByDisplayName: (name: string, opts: SearchOptions = {}) => getModule(Filters.byDisplayName(name), opts),
    getStore,
    Stores: new Proxy({} as Record<string, any>, { get: (_, name) => typeof name === "string" ? getStore(name) : undefined }),
    getWithKey(filter: Filter, opts: SearchOptions = {}) {
        const wrapped = safe(filter);
        const target = opts.target ?? getModule(exports => {
            if (exports == null || typeof exports !== "object") return false;
            for (const key in exports) {
                try {
                    if (wrapped(exports[key])) return true;
                } catch { }
            }
            return false;
        }, { searchDefault: false });
        if (!target) return [undefined, undefined];
        for (const key in target) {
            if (wrapped(target[key])) return [target, key];
        }
        return [undefined, undefined];
    },
    getMangled(filter: Filter | string | RegExp, mappers: Record<string, Filter>, opts: SearchOptions = {}) {
        const moduleFilter: Filter = typeof filter === "function" ? filter : Filters.bySource(filter);
        const module = getModule(moduleFilter, { ...opts, raw: true, searchExports: false, searchDefault: false });
        const result: Record<string, any> = {};
        const exports = module?.exports;
        if (!exports) return result;
        for (const [name, mapper] of Object.entries(mappers)) {
            const wrapped = safe(mapper);
            for (const key in exports) {
                let value: any;
                try {
                    value = exports[key];
                } catch {
                    continue;
                }
                if (wrapped(value)) {
                    Object.defineProperty(result, name, { get: () => exports[key], set: v => exports[key] = v, enumerable: true, configurable: true });
                    break;
                }
            }
        }
        return result;
    },
    getById: (id: PropertyKey, opts: SearchOptions = {}) => {
        const module = cache[id as any];
        if (!module) return undefined;
        return opts.raw ? module : module.exports;
    },
};
