/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { copyToClipboard } from "@utils/clipboard";
import { Logger } from "@utils/Logger";

import { Native } from "../settings";
import { Net } from "./api";

const logger = new Logger("Muffinshelf");

// The modules BetterDiscord's own require() hands to plugins. Anything else fails the same way it would in BetterDiscord.
export const NODE_MODULES = ["path", "fs", "original-fs", "request", "https", "events", "electron", "process", "vm", "module", "buffer", "crypto", "util"];

// Finds require() calls for modules nobody can provide. Bundled copies (browserify's {name: id} maps) don't count.
export function compatProblem(code: string): string | null {
    for (const m of code.matchAll(/\brequire\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
        const id = m[1].replace(/^node:/, "");
        if (NODE_MODULES.includes(id) || id.startsWith(".")) continue;
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`["']?${escaped}["']?\\s*:\\s*\\[?\\s*\\d`).test(code)) continue;
        return `It needs the Node.js module "${id}", which Muffinshelf can't give plugins.`;
    }
    return null;
}

export function unsupported(name: string): never {
    throw new Error(`Muffinshelf doesn't give BetterDiscord plugins ${name}`);
}

export class EventEmitter {
    static EventEmitter = EventEmitter;
    static defaultMaxListeners = 10;
    private _events = new Map<string | symbol, ((...args: any[]) => void)[]>();
    private _max = EventEmitter.defaultMaxListeners;

    on(event: string | symbol, listener: (...args: any[]) => void) {
        this.emit("newListener", event, listener);
        this._events.set(event, [...(this._events.get(event) ?? []), listener]);
        return this;
    }

    addListener(event: string | symbol, listener: (...args: any[]) => void) {
        return this.on(event, listener);
    }

    prependListener(event: string | symbol, listener: (...args: any[]) => void) {
        this._events.set(event, [listener, ...(this._events.get(event) ?? [])]);
        return this;
    }

    once(event: string | symbol, listener: (...args: any[]) => void) {
        const wrapped = (...args: any[]) => {
            this.off(event, wrapped);
            listener.apply(this, args);
        };
        (wrapped as any).listener = listener;
        return this.on(event, wrapped);
    }

    prependOnceListener(event: string | symbol, listener: (...args: any[]) => void) {
        const wrapped = (...args: any[]) => {
            this.off(event, wrapped);
            listener.apply(this, args);
        };
        (wrapped as any).listener = listener;
        return this.prependListener(event, wrapped);
    }

    off(event: string | symbol, listener: (...args: any[]) => void) {
        const list = this._events.get(event);
        if (!list) return this;
        const i = list.findIndex(l => l === listener || (l as any).listener === listener);
        if (i === -1) return this;
        const next = [...list.slice(0, i), ...list.slice(i + 1)];
        if (next.length) this._events.set(event, next);
        else this._events.delete(event);
        this.emit("removeListener", event, listener);
        return this;
    }

    removeListener(event: string | symbol, listener: (...args: any[]) => void) {
        return this.off(event, listener);
    }

    removeAllListeners(event?: string | symbol) {
        if (event === undefined) this._events.clear();
        else this._events.delete(event);
        return this;
    }

    emit(event: string | symbol, ...args: any[]) {
        const list = this._events.get(event);
        if (!list?.length) {
            if (event === "error") throw args[0] instanceof Error ? args[0] : new Error(`Unhandled error: ${String(args[0])}`);
            return false;
        }
        for (const listener of list) listener.apply(this, args);
        return true;
    }

    listeners(event: string | symbol) {
        return (this._events.get(event) ?? []).map(l => (l as any).listener ?? l);
    }

    rawListeners(event: string | symbol) {
        return [...(this._events.get(event) ?? [])];
    }

    listenerCount(event: string | symbol) {
        return this._events.get(event)?.length ?? 0;
    }

    eventNames() {
        return [...this._events.keys()];
    }

    setMaxListeners(n: number) {
        this._max = n;
        return this;
    }

    getMaxListeners() {
        return this._max;
    }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fromBase64(s: string) {
    const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
    const bin = atob(clean.length % 4 === 1 ? clean.slice(0, -1) : clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function toBase64(bytes: Uint8Array) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

function encode(str: string, encoding = "utf8"): Uint8Array {
    switch (encoding.toLowerCase().replace("-", "")) {
        case "base64": return fromBase64(str);
        case "base64url": return fromBase64(str.replace(/-/g, "+").replace(/_/g, "/"));
        case "hex": return Uint8Array.from(str.match(/[0-9a-f]{2}/gi) ?? [], h => parseInt(h, 16));
        case "latin1":
        case "binary":
        case "ascii": return Uint8Array.from(str, c => c.charCodeAt(0) & 0xff);
        default: return encoder.encode(str);
    }
}

function decode(bytes: Uint8Array, encoding = "utf8"): string {
    switch (encoding.toLowerCase().replace("-", "")) {
        case "base64": return toBase64(bytes);
        case "base64url": return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        case "hex": return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
        case "latin1":
        case "binary":
        case "ascii": {
            let s = "";
            for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            return s;
        }
        default: return decoder.decode(bytes);
    }
}

// A small Buffer: enough for plugins that read files, base64 or hex data. It's a real Uint8Array underneath.
export class Buffer extends Uint8Array {
    static from(value: any, encodingOrOffset?: any, length?: number): Buffer {
        if (typeof value === "string") {
            const bytes = encode(value, encodingOrOffset);
            return new Buffer(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.length);
        }
        if (value instanceof ArrayBuffer) return new Buffer(value, encodingOrOffset ?? 0, length ?? value.byteLength - (encodingOrOffset ?? 0));
        if (ArrayBuffer.isView(value)) return new Buffer(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer);
        if (value?.type === "Buffer" && Array.isArray(value.data)) return new Buffer(value.data);
        return new Buffer(Array.from(value ?? []));
    }

    static alloc(size: number, fill?: number | string) {
        const buf = new Buffer(size);
        if (typeof fill === "number") buf.fill(fill);
        else if (typeof fill === "string" && fill) {
            const bytes = encode(fill);
            for (let i = 0; i < size; i++) buf[i] = bytes[i % bytes.length];
        }
        return buf;
    }

    static allocUnsafe(size: number) {
        return new Buffer(size);
    }

    static isBuffer(value: unknown): value is Buffer {
        return value instanceof Buffer;
    }

    static isEncoding(encoding: string) {
        return ["utf8", "utf-8", "base64", "base64url", "hex", "latin1", "binary", "ascii"].includes(String(encoding).toLowerCase());
    }

    static byteLength(value: string | ArrayBufferView | ArrayBuffer, encoding?: string) {
        return typeof value === "string" ? encode(value, encoding).length : value.byteLength;
    }

    static concat(list: Uint8Array[], total?: number) {
        const size = total ?? list.reduce((n, b) => n + b.length, 0);
        const out = new Buffer(size);
        let offset = 0;
        for (const b of list) {
            if (offset >= size) break;
            out.set(b.subarray(0, size - offset), offset);
            offset += b.length;
        }
        return out;
    }

    toString(encoding?: string, start = 0, end = this.length) {
        return decode(this.subarray(start, end), encoding);
    }

    toJSON() {
        return { type: "Buffer", data: Array.from(this) };
    }

    equals(other: Uint8Array) {
        return this.length === other.length && this.every((b, i) => b === other[i]);
    }

    write(str: string, offset = 0, length?: number, encoding?: string) {
        const bytes = encode(str, encoding).subarray(0, length ?? this.length - offset);
        this.set(bytes.subarray(0, this.length - offset), offset);
        return Math.min(bytes.length, this.length - offset);
    }

    copy(target: Uint8Array, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
        const part = this.subarray(sourceStart, sourceEnd).subarray(0, target.length - targetStart);
        target.set(part, targetStart);
        return part.length;
    }
}

const toBytes = (data: any): Uint8Array =>
    typeof data === "string" ? encoder.encode(data)
        : data instanceof Uint8Array ? data
            : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : data instanceof ArrayBuffer ? new Uint8Array(data)
                    : encoder.encode(String(data));

const encodingOf = (opts: any): string | undefined => typeof opts === "string" ? opts : opts?.encoding ?? undefined;

export const util = {
    inherits(ctor: any, superCtor: any) {
        Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
        Object.setPrototypeOf(ctor, superCtor);
        ctor.super_ = superCtor;
    },
    promisify(fn: (...args: any[]) => void) {
        return (...args: any[]) => new Promise((resolve, reject) => fn(...args, (err: any, value: any) => err ? reject(err) : resolve(value)));
    },
    deprecate: <T>(fn: T) => fn,
    format: (...args: any[]) => args.map(a => typeof a === "string" ? a : util.inspect(a)).join(" "),
    inspect(value: any) {
        try {
            return typeof value === "object" ? JSON.stringify(value) : String(value);
        } catch {
            return String(value);
        }
    },
    isDeepStrictEqual: (a: any, b: any) => util.inspect(a) === util.inspect(b),
    types: {
        isPromise: (v: any) => v instanceof Promise,
        isDate: (v: any) => v instanceof Date,
        isRegExp: (v: any) => v instanceof RegExp,
        isUint8Array: (v: any) => v instanceof Uint8Array,
        isTypedArray: (v: any) => ArrayBuffer.isView(v) && !(v instanceof DataView),
    },
    TextEncoder,
    TextDecoder,
};

export const vm = {
    compileFunction(code: string, params: string[] = []) {
        return new Function(...params, code);
    },
    runInThisContext(code: string) {
        return (0, eval)(code);
    },
};

export class Module {
    static Module = Module;
    static _extensions = {};
    static _load(name: string): never {
        return unsupported(`require("${name}")`);
    }
}

export const crypto = {
    randomBytes: (size: number) => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(size))),
    randomUUID: () => globalThis.crypto.randomUUID(),
    getRandomValues: <T extends ArrayBufferView>(array: T) => globalThis.crypto.getRandomValues(array as any) as T,
    createHash: () => unsupported("crypto.createHash"),
};

export const https = {
    get(url: string, options?: any, callback?: (res: EventEmitter) => void) {
        if (typeof options === "function") {
            callback = options;
            options = {};
        }
        const emitter = new EventEmitter();
        callback?.(emitter);
        Net.fetch(url, { headers: options?.headers })
            .then(async res => {
                const body = Buffer.from(new Uint8Array(await res.arrayBuffer()));
                const headers: Record<string, string> = {};
                res.headers.forEach((v, k) => headers[k] = v);
                emitter.emit("data", body);
                emitter.emit("end", { statusCode: res.status, statusMessage: res.statusText, headers });
            })
            .catch(e => emitter.emit("error", e));
        return emitter;
    },
};

export function request(options: string | Record<string, any>, callback?: (err: any, res?: any, body?: any) => void) {
    const opts = typeof options === "string" ? { url: options } : options;
    const url = opts.url ?? opts.uri;
    Net.fetch(url, { method: opts.method, headers: opts.headers, body: opts.body })
        .then(async res => {
            const body = opts.encoding === null ? Buffer.from(new Uint8Array(await res.arrayBuffer())) : await res.text();
            const headers: Record<string, string> = {};
            res.headers.forEach((v, k) => headers[k] = v);
            callback?.(null, { statusCode: res.status, statusMessage: res.statusText, headers }, body);
        })
        .catch(e => callback?.(e));
}
request.get = (o: any, cb?: any) => request(typeof o === "string" ? { url: o } : { ...o, method: "GET" }, cb);
request.post = (o: any, cb?: any) => request(typeof o === "string" ? { url: o, method: "POST" } : { ...o, method: "POST" }, cb);

export const processShim = {
    platform: navigator.userAgent.includes("Windows") ? "win32" : navigator.userAgent.includes("Mac") ? "darwin" : "linux",
    env: {} as Record<string, string>,
    versions: {} as Record<string, string>,
    cwd: () => "/",
    nextTick: (fn: (...args: any[]) => void, ...args: any[]) => queueMicrotask(() => fn(...args)),
};

// --- fs: a copy of the BetterDiscord plugins folder kept in memory, with every change written back to disk ---

export interface PluginFileHooks {
    files(): string[];
    read(file: string): string | undefined;
    write(file: string, code: string): void;
    remove(file: string): void;
}

interface Entry {
    name: string;
    dir: boolean;
    data?: Uint8Array;
    mtime: number;
}

const PLUGIN_FILE = /^[^/]+\.plugin\.js$/;
const entries = new Map<string, Entry>();
const watchers = new Set<{ dir: string; cb: (event: string, file: string) => void; }>();
let root = "";
let hooks: PluginFileHooks;
let queue: Promise<unknown> = Promise.resolve();

const slash = (p: string) => p.replace(/\\/g, "/");
const key = (rel: string) => rel.toLowerCase();
const parentOf = (rel: string) => rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
const nameOf = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1);

function normalize(path: string) {
    const parts: string[] = [];
    for (const part of slash(path).split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") parts.pop();
        else parts.push(part);
    }
    return (/^[A-Za-z]:/.test(path) ? "" : slash(path).startsWith("/") ? "/" : "") + parts.join("/");
}

export const pathShim = {
    sep: "/",
    delimiter: ";",
    join: (...parts: string[]) => normalize(parts.filter(Boolean).join("/")) || ".",
    resolve(...parts: string[]) {
        let out = "";
        for (const part of parts.filter(Boolean)) out = /^([A-Za-z]:)?[\\/]/.test(part) ? part : `${out}/${part}`;
        return normalize(/^([A-Za-z]:)?[\\/]/.test(out) ? out : `${root}/${out}`);
    },
    normalize,
    basename(p: string, ext?: string) {
        const b = nameOf(normalize(p));
        return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
    },
    dirname: (p: string) => parentOf(normalize(p)) || (/^[A-Za-z]:/.test(p) ? normalize(p).slice(0, 2) : "/"),
    extname: (p: string) => nameOf(normalize(p)).match(/.(\.[^.]*)$/)?.[1] ?? "",
    isAbsolute: (p: string) => /^([A-Za-z]:)?[\\/]/.test(p),
    relative: (from: string, to: string) => {
        const a = normalize(from).split("/");
        const b = normalize(to).split("/");
        let i = 0;
        while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
        return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
    },
    parse(p: string) {
        const base = pathShim.basename(p);
        const ext = pathShim.extname(p);
        return { root: "", dir: pathShim.dirname(p), base, ext, name: ext ? base.slice(0, -ext.length) : base };
    },
    get posix() {
        return pathShim;
    },
    get win32() {
        return pathShim;
    },
};

// Returns the path relative to the plugins folder, "" for the folder itself, or null when it's somewhere else.
function relOf(path: unknown): string | null {
    const p = pathShim.resolve(String(path instanceof URL ? decodeURIComponent(path.pathname.replace(/^\/([A-Za-z]:)/, "$1")) : path));
    const base = normalize(root);
    if (p.toLowerCase() === base.toLowerCase()) return "";
    return p.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? p.slice(base.length + 1) : null;
}

function fsError(code: string, syscall: string, path: unknown, detail?: string) {
    const messages: Record<string, string> = {
        ENOENT: "no such file or directory",
        EEXIST: "file already exists",
        EISDIR: "illegal operation on a directory",
        ENOTDIR: "not a directory",
        ENOTEMPTY: "directory not empty",
        EACCES: "permission denied",
    };
    const err = new Error(`${code}: ${detail ?? messages[code] ?? "error"}, ${syscall} '${String(path)}'`) as Error & Record<string, unknown>;
    err.code = code;
    err.errno = -1;
    err.syscall = syscall;
    err.path = String(path);
    return err;
}

function inside(path: unknown, syscall: string) {
    const rel = relOf(path);
    if (rel === null) throw fsError(syscall.startsWith("read") || syscall === "stat" || syscall === "scandir" || syscall === "access" ? "ENOENT" : "EACCES", syscall, path,
        "Muffinshelf only lets BetterDiscord plugins use files inside their plugins folder");
    return rel;
}

function persist(job: () => Promise<unknown>) {
    queue = queue.then(job).catch(e => logger.error("Couldn't save a BetterDiscord plugin file", e));
}

function notify(rel: string, event: "change" | "rename") {
    const dir = key(parentOf(rel));
    for (const w of watchers) {
        if (w.dir === dir) setTimeout(() => w.cb(event, nameOf(rel)), 0);
    }
}

const isPluginFile = (rel: string) => PLUGIN_FILE.test(rel);

function lookup(rel: string): Entry | undefined {
    if (rel === "") return { name: "", dir: true, mtime: 0 };
    if (isPluginFile(rel)) {
        const code = hooks.read(rel);
        return code === undefined ? undefined : { name: hooks.files().find(f => key(f) === key(rel)) ?? rel, dir: false, data: encoder.encode(code), mtime: Date.now() };
    }
    return entries.get(key(rel));
}

function children(rel: string) {
    const dir = key(rel);
    const names = [...entries.entries()].filter(([k]) => parentOf(k) === dir).map(([, e]) => e.name);
    return rel === "" ? [...hooks.files(), ...names] : names;
}

function ensureDir(rel: string) {
    if (!rel) return;
    const existing = entries.get(key(rel));
    if (existing?.dir) return;
    if (existing) throw fsError("ENOTDIR", "mkdir", rel);
    ensureDir(parentOf(rel));
    entries.set(key(rel), { name: nameOf(rel), dir: true, mtime: Date.now() });
}

function stats(entry: Entry) {
    const time = new Date(entry.mtime || Date.now());
    return {
        isFile: () => !entry.dir,
        isDirectory: () => entry.dir,
        isSymbolicLink: () => false,
        size: entry.data?.length ?? 0,
        mtimeMs: time.getTime(),
        ctimeMs: time.getTime(),
        birthtimeMs: time.getTime(),
        atimeMs: time.getTime(),
        mtime: time,
        ctime: time,
        birthtime: time,
        atime: time,
        mode: entry.dir ? 0o40755 : 0o100644,
    };
}

function writeFileSync(path: unknown, data: any, opts?: any) {
    const rel = inside(path, "open");
    if (rel === "") throw fsError("EISDIR", "open", path);
    if (isPluginFile(rel)) return hooks.write(nameOf(rel), decode(toBytes(data)));
    if (lookup(rel)?.dir) throw fsError("EISDIR", "open", path);
    const bytes = typeof data === "string" ? encode(data, encodingOf(opts)) : toBytes(data).slice();
    ensureDir(parentOf(rel));
    const existed = entries.has(key(rel));
    entries.set(key(rel), { name: nameOf(rel), dir: false, data: bytes, mtime: Date.now() });
    persist(() => Native.bdFsWrite(rel, toBase64(bytes)));
    notify(rel, existed ? "change" : "rename");
}

function readFileSync(path: unknown, opts?: any) {
    const rel = inside(path, "open");
    const entry = lookup(rel);
    if (!entry) throw fsError("ENOENT", "open", path);
    if (entry.dir) throw fsError("EISDIR", "read", path);
    const enc = encodingOf(opts);
    return enc ? decode(entry.data!, enc) : Buffer.from(entry.data!);
}

function removeEntry(rel: string, path: unknown, recursive: boolean, syscall: string) {
    const entry = lookup(rel);
    if (!entry) throw fsError("ENOENT", syscall, path);
    if (rel === "") throw fsError("EACCES", syscall, path);
    if (isPluginFile(rel)) return hooks.remove(nameOf(rel));
    const k = key(rel);
    if (entry.dir) {
        const nested = [...entries.keys()].filter(e => e.startsWith(`${k}/`));
        if (nested.length && !recursive) throw fsError("ENOTEMPTY", syscall, path);
        nested.forEach(e => entries.delete(e));
    }
    entries.delete(k);
    persist(() => Native.bdFsRemove(rel));
    notify(rel, "rename");
}

function renameSync(from: unknown, to: unknown) {
    const a = inside(from, "rename");
    const b = inside(to, "rename");
    const entry = lookup(a);
    if (!entry) throw fsError("ENOENT", "rename", from);
    if (isPluginFile(a) || isPluginFile(b)) {
        if (!isPluginFile(a) || !isPluginFile(b)) throw fsError("EACCES", "rename", from);
        hooks.write(nameOf(b), decode(entry.data!));
        hooks.remove(nameOf(a));
        return;
    }
    const ka = key(a);
    const moved = [...entries.entries()].filter(([k]) => k === ka || k.startsWith(`${ka}/`));
    ensureDir(parentOf(b));
    for (const [k, e] of moved) {
        entries.delete(k);
        entries.set(key(b) + k.slice(ka.length), { ...e, name: k === ka ? nameOf(b) : e.name });
    }
    persist(() => Native.bdFsRename(a, b));
    notify(a, "rename");
    notify(b, "rename");
}

function mkdirSync(path: unknown, opts?: any) {
    const rel = inside(path, "mkdir");
    const existing = lookup(rel);
    if (existing) {
        if (opts?.recursive && existing.dir) return undefined;
        throw fsError("EEXIST", "mkdir", path);
    }
    const recursive = typeof opts === "object" && opts?.recursive;
    if (!recursive && !lookup(parentOf(rel))?.dir) throw fsError("ENOENT", "mkdir", path);
    ensureDir(rel);
    persist(() => Native.bdFsMkdir(rel));
    notify(rel, "rename");
    return recursive ? pathShim.resolve(root, rel) : undefined;
}

function readdirSync(path: unknown, opts?: any) {
    const rel = inside(path, "scandir");
    const entry = lookup(rel);
    if (!entry) throw fsError("ENOENT", "scandir", path);
    if (!entry.dir) throw fsError("ENOTDIR", "scandir", path);
    const names = children(rel);
    if (!opts?.withFileTypes) return names;
    return names.map(name => {
        const child = lookup(rel ? `${rel}/${name}` : name);
        return { name, isFile: () => !child?.dir, isDirectory: () => !!child?.dir, isSymbolicLink: () => false };
    });
}

function statSync(path: unknown, opts?: any) {
    const rel = relOf(path);
    const entry = rel === null ? undefined : lookup(rel);
    if (!entry) {
        if (opts?.throwIfNoEntry === false) return undefined;
        throw fsError("ENOENT", "stat", path);
    }
    return stats(entry);
}

function existsSync(path: unknown) {
    const rel = relOf(path);
    return rel !== null && !!lookup(rel);
}

function copyFileSync(from: unknown, to: unknown) {
    writeFileSync(to, readFileSync(from));
}

function appendFileSync(path: unknown, data: any, opts?: any) {
    const rel = inside(path, "open");
    const old = lookup(rel);
    const add = typeof data === "string" ? encode(data, encodingOf(opts)) : toBytes(data);
    writeFileSync(path, old?.data ? Buffer.concat([old.data, add]) : add);
}

function accessSync(path: unknown) {
    if (!existsSync(path)) throw fsError("ENOENT", "access", path);
}

function watch(path: unknown, opts?: any, cb?: (event: string, file: string) => void) {
    const listener = typeof opts === "function" ? opts : cb;
    const rel = relOf(path);
    const emitter = new EventEmitter();
    if (rel === null) return Object.assign(emitter, { close() { } });
    const w = { dir: key(rel), cb: (event: string, file: string) => { listener?.(event, file); emitter.emit("change", event, file); } };
    watchers.add(w);
    return Object.assign(emitter, { close: () => void watchers.delete(w) });
}

function createWriteStream(path: unknown) {
    const chunks: Uint8Array[] = [];
    const stream = new EventEmitter() as EventEmitter & Record<string, any>;
    stream.write = (chunk: any, ...rest: any[]) => {
        chunks.push(toBytes(chunk));
        rest.find(r => typeof r === "function")?.();
        return true;
    };
    stream.end = (chunk?: any, ...rest: any[]) => {
        if (chunk !== undefined && typeof chunk !== "function") chunks.push(toBytes(chunk));
        try {
            writeFileSync(path, Buffer.concat(chunks));
            [chunk, ...rest].find(r => typeof r === "function")?.();
            setTimeout(() => {
                stream.emit("finish");
                stream.emit("close");
            }, 0);
        } catch (e) {
            setTimeout(() => stream.emit("error", e), 0);
        }
        return stream;
    };
    stream.close = stream.end;
    return stream;
}

const sync = {
    readFileSync, writeFileSync, appendFileSync, existsSync, statSync, lstatSync: statSync, readdirSync, mkdirSync,
    renameSync, copyFileSync, accessSync, realpathSync: (p: unknown) => pathShim.resolve(String(p)),
    unlinkSync: (p: unknown) => removeEntry(inside(p, "unlink"), p, false, "unlink"),
    rmSync(p: unknown, opts?: any) {
        const rel = relOf(p);
        if (rel === null || !lookup(rel)) {
            if (opts?.force) return;
            throw fsError("ENOENT", "rm", p);
        }
        removeEntry(rel, p, !!opts?.recursive, "rm");
    },
    rmdirSync: (p: unknown, opts?: any) => removeEntry(inside(p, "rmdir"), p, !!opts?.recursive, "rmdir"),
};

// Node-style callbacks: the last function argument gets (err, result).
function callbackStyle<T extends (...args: any[]) => any>(fn: T) {
    return (...args: any[]) => {
        const cb = typeof args[args.length - 1] === "function" ? args.pop() : undefined;
        let result: any;
        try {
            result = fn(...args);
        } catch (e) {
            if (cb) setTimeout(() => cb(e), 0);
            return;
        }
        if (cb) setTimeout(() => cb(null, result), 0);
    };
}

function promiseStyle<T extends (...args: any[]) => any>(fn: T) {
    return async (...args: Parameters<T>) => fn(...args) as ReturnType<T>;
}

export const fsShim: Record<string, any> = {
    ...sync,
    watch,
    createWriteStream,
    readFile: callbackStyle(readFileSync),
    writeFile: callbackStyle(writeFileSync),
    appendFile: callbackStyle(appendFileSync),
    mkdir: callbackStyle(mkdirSync),
    readdir: callbackStyle(readdirSync),
    stat: callbackStyle(statSync),
    lstat: callbackStyle(statSync),
    rename: callbackStyle(renameSync),
    copyFile: callbackStyle(copyFileSync),
    unlink: callbackStyle(sync.unlinkSync),
    rm: callbackStyle(sync.rmSync),
    rmdir: callbackStyle(sync.rmdirSync),
    realpath: callbackStyle(sync.realpathSync),
    access: callbackStyle(accessSync),
    exists: callbackStyle(existsSync),
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
    promises: {
        readFile: promiseStyle(readFileSync),
        writeFile: promiseStyle(writeFileSync),
        appendFile: promiseStyle(appendFileSync),
        mkdir: promiseStyle(mkdirSync),
        readdir: promiseStyle(readdirSync),
        stat: promiseStyle(statSync),
        lstat: promiseStyle(statSync),
        rename: promiseStyle(renameSync),
        copyFile: promiseStyle(copyFileSync),
        unlink: promiseStyle(sync.unlinkSync),
        rm: promiseStyle(sync.rmSync),
        rmdir: promiseStyle(sync.rmdirSync),
        access: promiseStyle(accessSync),
        realpath: promiseStyle(sync.realpathSync),
    },
};

export async function loadFiles(folder: string, pluginHooks: PluginFileHooks) {
    root = slash(folder);
    hooks = pluginHooks;
    entries.clear();
    watchers.clear();
    for (const item of await Native.readBdTree()) {
        entries.set(key(item.path), { name: nameOf(item.path), dir: item.dir, data: item.data !== undefined ? fromBase64(item.data) : undefined, mtime: item.mtime });
    }
}

export function clearFiles() {
    entries.clear();
    watchers.clear();
}

export const electronShim = {
    shell: {
        openExternal: (url: string) => VencordNative.native.openExternal(url),
        async openPath(path: string) {
            const rel = relOf(path);
            if (rel === null) return "Muffinshelf only opens folders inside the BetterDiscord plugins folder";
            await queue;
            await Native.bdShowPath(rel, false);
            return "";
        },
        showItemInFolder(path: string) {
            const rel = relOf(path);
            if (rel !== null) queue.then(() => Native.bdShowPath(rel, true));
        },
    },
    clipboard: {
        writeText: (t: string) => copyToClipboard(t),
        readText: () => "",
    },
};

export function nodeRequire(id: string) {
    if (typeof id === "string" && (id.startsWith("./") || id.startsWith("../"))) return undefined;
    switch (String(id).replace(/^node:/, "")) {
        case "path": return pathShim;
        case "fs":
        case "original-fs": return fsShim;
        case "request": return request;
        case "https": return https;
        case "events": return EventEmitter;
        case "electron": return electronShim;
        case "process": return processShim;
        case "vm": return vm;
        case "module": return Module;
        case "buffer": return { Buffer };
        case "crypto": return crypto;
        case "util": return util;
        default: return unsupported(`require("${id}")`);
    }
}
