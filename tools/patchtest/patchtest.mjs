// Test Equicord plugin patches against the running Discord over its debug port (CDP).
// Read-only: Discord is only asked for module sources; patching and the compile check
// happen here in Node, and patched code is compiled with new Function but never called.
// The one exception is --eval, which runs the code you give it inside Discord.
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
let EQUICORD;
let esbuild;

const USAGE = `usage:
  node patchtest.mjs <plugin folder | index.tsx | patches.json> [options]
  node patchtest.mjs --keys <NAME or hashed key> [...]
  node patchtest.mjs --eval <code | file.js>

options:
  --equicord <dir>  Equicord source folder (default: found from the plugin path, or EQUICORD_DIR)
  --port <n>        Discord's debug port (default: read from Discord, then 9222; or CDP_PORT)
  --keymap <file>   hashed-key -> name JSON for --keys (default: key_map.json next to this script)
  --show            print the code around each match and the replaced result
  --context <n>     characters of context for --show (default 120)
  --verbose         list every module id a find hits
  --eval <code>     run JavaScript inside Discord like its console does (await works, let/const can be
                    reused between runs) and print the result; a path ending in .js runs that file`;

function parseArgs(argv) {
    const opts = { port: null, equicord: null, keymap: null, show: false, verbose: false, context: 120, keys: null, eval: null, target: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const value = () => {
            if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
            return argv[++i];
        };
        if (a === "--port") opts.port = value();
        else if (a === "--equicord") opts.equicord = value();
        else if (a === "--keymap") opts.keymap = value();
        else if (a === "--show") opts.show = true;
        else if (a === "--verbose") opts.verbose = true;
        else if (a === "--context") opts.context = Number(value()) || 120;
        else if (a === "--keys") opts.keys = [];
        else if (a === "--eval") opts.eval = value();
        else if (a === "-h" || a === "--help") opts.help = true;
        else if (a.startsWith("--")) throw new Error(`unknown option: ${a}`);
        else if (opts.keys) opts.keys.push(a);
        else if (!opts.target) opts.target = a;
        else throw new Error(`unexpected argument: ${a}`);
    }
    return opts;
}

// ---------- finding Equicord ----------

const isEquicord = dir => existsSync(join(dir, "src", "utils", "patches.ts")) && existsSync(join(dir, "src", "webpack", "patchWebpack.ts"));

function findEquicord(opts, targetPath) {
    const explicit = opts.equicord ?? process.env.EQUICORD_DIR;
    if (explicit) {
        const dir = resolve(explicit);
        if (!isEquicord(dir)) throw new Error(`${dir} is not an Equicord source folder (no src/utils/patches.ts)`);
        return dir;
    }
    // A plugin in Equicord/src/userplugins/<name> leads straight to its checkout.
    for (let dir = targetPath ? dirname(resolve(targetPath)) : null; dir && dir !== dirname(dir); dir = dirname(dir)) {
        if (isEquicord(dir)) return dir;
    }
    const candidates = [
        join(HERE, "..", "..", "..", "Equicord"),
        join(HERE, "..", "..", "Equicord"),
        process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Cordmuffin", "equicord"),
        join(homedir(), "Equicord"),
    ].filter(Boolean).map(c => resolve(c));
    const found = candidates.find(isEquicord);
    if (found) return found;
    throw new Error(`couldn't find an Equicord source folder; pass --equicord <dir> or set EQUICORD_DIR (looked above the plugin and in ${candidates.join(", ")})`);
}

function loadEsbuild(dir) {
    try {
        return createRequire(join(dir, "package.json"))("esbuild");
    } catch {
        throw new Error(`esbuild isn't installed in ${dir}; run "pnpm install" there first`);
    }
}

// ---------- key lookup ----------

async function lookupKeys(terms, opts) {
    if (!terms.length) throw new Error("--keys needs at least one NAME or hashed key");
    const mapPath = resolve(opts.keymap ?? join(HERE, "key_map.json"));
    const map = existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, "utf8")) : null;
    let canon = null;
    try {
        EQUICORD = findEquicord(opts, null);
        esbuild = loadEsbuild(EQUICORD);
        canon = await loadCanonicalizers();
    } catch (err) {
        if (!map) throw err;
    }
    for (const term of terms) {
        let found = false;
        if (canon && /^[A-Z0-9_]+$/.test(term)) {
            console.log(`${canon.canonicalizeMatch(`#{intl::${term}::hash}`)}  ${term}  (hashed)`);
            found = true;
        }
        if (map) {
            const lower = term.toLowerCase();
            const hits = Object.entries(map).filter(([hash, name]) => hash === term || String(name).toLowerCase().includes(lower));
            for (const [hash, name] of hits.slice(0, 50)) console.log(`${hash}  ${name}`);
            if (hits.length > 50) console.log(`... ${hits.length - 50} more for "${term}"`);
            found ||= hits.length > 0;
        } else if (!found) {
            console.log(`${term}: turning a hash back into a name needs a key map (--keymap <file>)`);
            continue;
        }
        if (!found) console.log(`${term}: no match`);
    }
}

// ---------- loading Equicord helpers and plugin patches ----------

async function importBundle(code) {
    return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

async function loadCanonicalizers() {
    const res = await esbuild.build({
        entryPoints: [join(EQUICORD, "src", "utils", "patches.ts")],
        bundle: true,
        write: false,
        format: "esm",
        platform: "node",
        logLevel: "silent",
        absWorkingDir: EQUICORD,
    });
    return importBundle(res.outputFiles[0].text);
}

// Anything a plugin imports from outside its own folder becomes this: every property, call
// and construction returns the stub again, so module-level code runs without Discord.
function makeStub() {
    const target = function () { };
    let stub;
    stub = new Proxy(target, {
        get(t, key) {
            if (key === Symbol.toPrimitive) return () => "";
            if (key === Symbol.iterator) return function* () { };
            if (key === "then") return undefined;
            if (key === "__esModule") return true;
            return stub;
        },
        apply: () => stub,
        construct: () => stub,
        getPrototypeOf: () => stub,
        has: () => true,
        set: () => true,
    });
    return stub;
}

const GLOBAL_DEFINES = {
    IS_WEB: "false", IS_EXTENSION: "false", IS_USERSCRIPT: "false", IS_STANDALONE: "false",
    IS_UPDATER_DISABLED: "false", IS_DEV: "false", IS_REPORTER: "false", IS_COMPANION_TEST: "false",
    IS_ANTI_CRASH_TEST: "false", IS_DISCORD_DESKTOP: "true", IS_VESKTOP: "false", IS_EQUIBOP: "false",
    VERSION: '"0.0.0"', BUILD_TIMESTAMP: "0",
};

async function loadPluginPatches(entry) {
    const pluginDir = dirname(entry);
    const inPlugin = p => p === pluginDir || p.startsWith(pluginDir + sep);
    const stubPlugin = {
        name: "patchtest-stub",
        setup(build) {
            build.onResolve({ filter: /.*/ }, args => {
                if (args.kind === "entry-point") return undefined;
                if (/^\.\.?([/\\]|$)/.test(args.path) && !/\.css(\?.*)?$/.test(args.path)) {
                    const abs = resolve(args.resolveDir, args.path);
                    if (inPlugin(abs)) return undefined;
                }
                return { path: args.path, namespace: "patchtest-stub" };
            });
            // definePlugin (default export of @utils/types) must hand back the real plugin object.
            build.onLoad({ filter: /.*/, namespace: "patchtest-stub" }, args => ({
                contents: /(^|[/\\@])utils[/\\]types(\.tsx?)?$/.test(args.path)
                    ? "module.exports = globalThis.__patchtestTypes;"
                    : "module.exports = globalThis.__patchtestStub;",
                loader: "js",
            }));
        },
    };

    const res = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: "esm",
        platform: "neutral",
        logLevel: "silent",
        absWorkingDir: EQUICORD,
        plugins: [stubPlugin],
        jsx: "transform",
        jsxFactory: "globalThis.__patchtestStub",
        jsxFragment: "globalThis.__patchtestStub",
        define: GLOBAL_DEFINES,
        loader: { ".png": "empty", ".svg": "empty", ".gif": "empty", ".webp": "empty" },
    });

    const stub = makeStub();
    globalThis.__patchtestStub = stub;
    // Own props get copied by esbuild's __toESM; everything else (OptionType, ...) falls through to the stub.
    globalThis.__patchtestTypes = Object.setPrototypeOf({ __esModule: true, default: p => p, definePlugin: p => p }, stub);
    for (const name of ["window", "document", "localStorage", "Vencord", "VencordNative", "DiscordNative", "webpackChunkdiscord_app"]) {
        if (!(name in globalThis)) globalThis[name] = stub;
    }

    const mod = await importBundle(res.outputFiles[0].text);
    const plugin = mod.default;
    if (!plugin || typeof plugin !== "object" || typeof plugin.name !== "string")
        throw new Error(`${relative(process.cwd(), entry)} has no definePlugin default export`);
    const patches = Array.isArray(plugin.patches) ? plugin.patches : [];
    return { name: plugin.name, patches };
}

function parseJsonMatch(value) {
    if (typeof value !== "string") return value;
    const m = /^\/(.*)\/([dgimsuvy]*)$/s.exec(value);
    return m ? new RegExp(m[1], m[2]) : value;
}

function loadJsonPatches(file) {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const list = Array.isArray(data) ? data : Array.isArray(data.patches) ? data.patches : [data];
    const name = (!Array.isArray(data) && data.name) || "PatchTest";
    const patches = list.map((p, i) => {
        if (!p || p.find == null) throw new Error(`patch ${i + 1} in ${file} has no "find"`);
        const reps = p.replacement ?? { match: p.match, replace: p.replace };
        const replacement = (Array.isArray(reps) ? reps : [reps]).map((r, j) => {
            if (r.match == null || r.replace == null)
                throw new Error(`patch ${i + 1} replacement ${j + 1} needs "match" and "replace"`);
            return { ...r, match: parseJsonMatch(r.match) };
        });
        return { ...p, find: parseJsonMatch(p.find), replacement };
    });
    return { name, patches };
}

function resolveTarget(target) {
    const abs = resolve(target);
    if (!existsSync(abs)) throw new Error(`not found: ${target}`);
    if (statSync(abs).isDirectory()) {
        for (const f of ["index.tsx", "index.ts", "index.jsx", "index.js"]) {
            if (existsSync(join(abs, f))) return { kind: "plugin", path: join(abs, f) };
        }
        throw new Error(`no index.ts(x) in ${target}`);
    }
    return { kind: extname(abs).toLowerCase() === ".json" ? "json" : "plugin", path: abs };
}

// ---------- CDP ----------

// Discord writes the port it really listens on to DevToolsActivePort in its data folder.
function candidatePorts(port) {
    if (port) return [String(port)];
    const ports = [];
    if (process.env.CDP_PORT) ports.push(process.env.CDP_PORT);
    const roots = [
        process.env.APPDATA,
        join(homedir(), ".config"),
        join(homedir(), "Library", "Application Support"),
    ].filter(Boolean);
    for (const root of roots) {
        for (const flavor of ["discord", "discordptb", "discordcanary", "discorddevelopment"]) {
            try {
                const p = readFileSync(join(root, flavor, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0].trim();
                if (/^\d+$/.test(p)) ports.push(p);
            } catch { }
        }
    }
    ports.push("9222");
    return [...new Set(ports)];
}

async function connectDiscord(port) {
    const ports = candidatePorts(port);
    let page;
    for (const p of ports) {
        try {
            const targets = await (await fetch(`http://127.0.0.1:${p}/json`, { signal: AbortSignal.timeout(3000) })).json();
            page = targets.find(t => t.type === "page" && /^https:\/\/([\w-]+\.)*discord\.com\//.test(t.url));
            if (page) break;
        } catch { }
    }
    if (!page) throw new Error(`no Discord page on debug port ${ports.join(" / ")}; start Discord with --remote-debugging-port=9222 (see README)`);

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
        ws.onopen = res;
        ws.onerror = () => rej(new Error("could not open the CDP websocket"));
    });

    let nextId = 1;
    const pending = new Map();
    ws.onmessage = ev => {
        const msg = JSON.parse(ev.data);
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        const r = msg.result;
        if (msg.error) p.reject(new Error(msg.error.message));
        else if (r.exceptionDetails) p.reject(new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
        else p.resolve(r.result.value);
    };
    ws.onclose = () => {
        for (const p of pending.values()) p.reject(new Error("CDP connection closed"));
        pending.clear();
    };

    return {
        evaluate(expression, extra = {}) {
            const id = nextId++;
            return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject });
                ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true, ...extra } }));
            });
        },
        close: () => ws.close(),
    };
}

// Runs inside Discord: reads module sources only.
function remoteFindModules(finds) {
    const w = window.Vencord?.Webpack?.wreq;
    if (!w?.m) return { error: "Vencord.Webpack.wreq.m is not available (is Equicord loaded?)" };
    const tests = finds.map(f => {
        if (f.type === "string") return s => s.includes(f.value);
        const re = new RegExp(f.source, f.flags);
        return s => (re.lastIndex = 0, re.test(s));
    });
    const hits = finds.map(() => []);
    let total = 0;
    for (const id in w.m) {
        let src;
        try { src = String(w.m[id]); } catch { continue; }
        total++;
        for (let i = 0; i < tests.length; i++) if (tests[i](src)) hits[i].push(id);
    }
    let build = -1;
    try { build = window.Vencord.WebpackPatcher.getBuildNumber(); } catch { }
    return { total, hits, build };
}

function remoteGetSources(ids) {
    const m = window.Vencord.Webpack.wreq.m;
    const out = {};
    for (const id of ids) out[id] = String(m[id]);
    return out;
}

const call = (fn, arg) => `(${fn.toString()})(${JSON.stringify(arg)})`;

// ---------- patch logic (mirrors src/webpack/patchWebpack.ts patchFactory) ----------

function countHits(code, match) {
    if (typeof match === "string") {
        if (!match) return 0;
        let n = 0;
        for (let i = code.indexOf(match); i !== -1; i = code.indexOf(match, i + match.length)) n++;
        return n;
    }
    const flags = match.flags.includes("g") ? match.flags : match.flags + "g";
    const re = new RegExp(match.source, flags);
    let n = 0;
    for (const m of code.matchAll(re)) {
        n++;
        if (m[0] === "" && n > 10000) break;
    }
    return n;
}

function firstMatchIndex(code, match) {
    if (typeof match === "string") {
        const i = code.indexOf(match);
        return i === -1 ? null : { index: i, length: match.length };
    }
    const re = new RegExp(match.source, match.flags.replace("g", ""));
    const m = re.exec(code);
    return m ? { index: m.index, length: m[0].length } : null;
}

function factoryCode(original) {
    const isArrow = original.startsWith("(");
    return "0," + (!isArrow ? "function" : "") + original.slice(original.indexOf("("));
}

function compiles(code, moduleId, pluginName) {
    const source = `// Webpack Module ${moduleId} - Patched by ${pluginName}\n${code}\n//# sourceURL=file:///WebpackModule${moduleId}`;
    try {
        new Function(source);
        return null;
    } catch (err) {
        return String(err?.message ?? err);
    }
}

function runPatchOnModule(patch, moduleId, original, pluginName, canon, opts) {
    let code = factoryCode(original);
    const rows = [];
    let groupFailed = false;

    patch.replacement.forEach((rep, j) => {
        const row = { rep: j + 1, match: rep.match, hits: 0, status: "", note: "" };
        rows.push(row);
        if (groupFailed) {
            row.status = "SKIP";
            row.note = "group undone";
            return;
        }
        if (rep.predicate) row.note = "has predicate (not evaluated)";

        const match = canon.canonicalizeMatch(rep.match);
        const replace = canon.canonicalizeReplace(rep.replace, `Vencord.Plugins.plugins[${JSON.stringify(pluginName)}]`);
        row.hits = countHits(code, match);

        let next;
        try {
            if (typeof match !== "string" && match.global) match.lastIndex = 0;
            next = code.replace(match, replace);
        } catch (err) {
            row.status = "FAIL";
            row.note = `replace threw: ${err?.message ?? err}`;
            if (patch.group) groupFailed = true;
            return;
        }

        if (next === code) {
            const quiet = patch.noWarn || rep.noWarn;
            row.status = quiet ? "WARN" : "FAIL";
            row.note = row.hits ? "replaced to identical code" : "match not found";
            if (quiet) row.note += " (noWarn)";
            if (patch.group) groupFailed = true;
            return;
        }

        const error = compiles(next, moduleId, pluginName);
        if (error) {
            row.status = "FAIL";
            row.note = `patched module does not compile: ${error}`;
            if (patch.group) groupFailed = true;
            return;
        }

        const multi = row.hits > 1 && !(typeof match !== "string" && match.global);
        row.status = multi ? "WARN" : "PASS";
        if (multi) row.note = `matches ${row.hits}x, only the first is replaced`;

        if (opts.show) {
            const at = firstMatchIndex(code, match);
            if (at) {
                const c = opts.context;
                const before = code.slice(Math.max(0, at.index - c), at.index + at.length + c);
                const delta = next.length - code.length;
                const after = next.slice(Math.max(0, at.index - c), at.index + at.length + Math.max(0, delta) + c);
                row.show = { before, after };
            }
        }
        code = next;
    });

    if (groupFailed) {
        for (const r of rows) if (r.status === "PASS" || r.status === "WARN") r.note = (r.note ? r.note + "; " : "") + "undone by group";
    }
    return rows;
}

// ---------- output ----------

const short = (v, n = 60) => {
    const s = v instanceof RegExp ? String(v) : JSON.stringify(v);
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

function printTable(rows) {
    const headers = ["#", "find", "modules", "rep", "hits", "result", "note"];
    const data = rows.map(r => headers.map(h => String(r[h] ?? "")));
    const widths = headers.map((h, i) => Math.min(Math.max(h.length, ...data.map(d => d[i].length)), i === 6 ? 200 : 64));
    const line = cells => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
    console.log(line(headers));
    console.log(line(widths.map(w => "-".repeat(w))));
    for (const d of data) console.log(line(d));
}

// ---------- --eval ----------

async function runEval(code, opts) {
    const file = resolve(code);
    if (extname(code) === ".js" && existsSync(file)) code = readFileSync(file, "utf8");
    const discord = await connectDiscord(opts.port);
    try {
        // replMode is what Discord's own console uses: top-level await, and redeclaring let/const is allowed.
        const value = await discord.evaluate(code, { replMode: true, userGesture: true });
        if (value === undefined) console.log("undefined");
        else console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    } finally {
        discord.close();
    }
}

// ---------- main ----------

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) return void console.log(USAGE);
    if (opts.keys) return lookupKeys(opts.keys, opts);
    if (opts.eval != null) return runEval(opts.eval, opts);
    if (!opts.target) {
        console.error(USAGE);
        process.exitCode = 2;
        return;
    }
    const target = resolveTarget(opts.target);
    EQUICORD = findEquicord(opts, target.path);
    esbuild = loadEsbuild(EQUICORD);
    const canon = await loadCanonicalizers();
    const { name, patches } = target.kind === "json" ? loadJsonPatches(target.path) : await loadPluginPatches(target.path);

    console.log(`${name}: ${patches.length} patch${patches.length === 1 ? "" : "es"} (${relative(process.cwd(), target.path) || target.path})`);
    if (!patches.length) {
        console.log("nothing to test (no static patches; patches built at runtime from settings can't be read here)");
        return;
    }

    const prepared = patches.map(p => ({
        ...p,
        find: canon.canonicalizeMatch(p.find),
        replacement: Array.isArray(p.replacement) ? p.replacement : [p.replacement],
    }));
    const finds = prepared.map(p => typeof p.find === "string"
        ? { type: "string", value: p.find }
        : { type: "regex", source: p.find.source, flags: p.find.flags });

    const discord = await connectDiscord(opts.port);
    try {
        const found = await discord.evaluate(call(remoteFindModules, finds));
        if (found.error) throw new Error(found.error);
        console.log(`searched ${found.total} loaded modules${found.build > 0 ? `, build ${found.build}` : ""}\n`);

        const needed = new Set();
        prepared.forEach((p, i) => {
            const ids = found.hits[i];
            if (ids.length === 1 || (p.all && ids.length)) ids.forEach(id => needed.add(id));
        });
        const sources = needed.size ? await discord.evaluate(call(remoteGetSources, [...needed])) : {};

        const table = [];
        const shows = [];
        let failed = 0;
        prepared.forEach((p, i) => {
            const ids = found.hits[i];
            const base = { "#": i + 1, find: short(p.find, 48), modules: String(ids.length) };
            const tags = [p.all && "all", p.group && "group", p.predicate && "predicate", (p.fromBuild ?? p.toBuild) != null && "build-range"].filter(Boolean);

            if (ids.length !== 1 && !(p.all && ids.length)) {
                const note = ids.length === 0
                    ? "find hits no module (wrong find, or its chunk isn't loaded yet)"
                    : `find is not unique: ${ids.slice(0, 8).join(", ")}${ids.length > 8 ? ", …" : ""}`;
                const quiet = ids.length === 0 && p.noWarn;
                table.push({ ...base, rep: "-", hits: "-", result: quiet ? "WARN" : "FAIL", note: note + (tags.length ? ` [${tags.join(",")}]` : "") });
                if (!quiet) failed++;
                return;
            }
            if (opts.verbose || ids.length > 1) base.modules = `${ids.length} (${ids.slice(0, 4).join(",")}${ids.length > 4 ? ",…" : ""})`;

            for (const id of ids) {
                const rows = runPatchOnModule(p, id, sources[id], name, canon, opts);
                rows.forEach((r, k) => {
                    const note = [ids.length > 1 ? `module ${id}` : "", r.note, k === 0 && tags.length ? `[${tags.join(",")}]` : ""].filter(Boolean).join("; ");
                    table.push({ ...(k === 0 ? base : { "#": "", find: "", modules: "" }), rep: r.rep, hits: r.hits, result: r.status, note });
                    if (r.status === "FAIL") failed++;
                    if (r.show) shows.push({ label: `#${i + 1}.${r.rep} module ${id} ${short(r.match, 80)}`, ...r.show });
                });
            }
        });

        printTable(table);
        for (const s of shows) {
            console.log(`\n${s.label}\n  before: ${s.before}\n  after:  ${s.after}`);
        }
        console.log(failed ? `\n${failed} failing` : "\nall patches pass");
        process.exitCode = failed ? 1 : 0;
    } finally {
        discord.close();
    }
}

main().catch(err => {
    console.error(`patchtest: ${err?.message ?? err}`);
    process.exitCode = 1;
});
