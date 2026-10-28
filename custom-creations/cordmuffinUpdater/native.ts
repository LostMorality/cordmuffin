/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import { spawn } from "child_process";
import type { IpcMainInvokeEvent } from "electron";
import { existsSync, readdirSync, readFileSync, rmSync } from "fs";
import { join, resolve } from "path";

const REPO = "LostMorality/cordmuffin";
const EQUICORD = "Equicord/Equicord";
const UPDATE_TIMEOUT_MS = 30 * 60_000;
const EXIT_OK = 0;
const EXIT_BUSY = 10;
const EXIT_UP_TO_DATE = 11;

const work = join(process.env.LOCALAPPDATA ?? "", "Cordmuffin");
const muffinshelfSaved = join(DATA_DIR, "muffinshelf", "userplugins");
const GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
// Only ever set when testing against a stand-in server; normal installs talk to GitHub.
const api = (process.env.CORDMUFFIN_GITHUB_API || "https://api.github.com").replace(/\/+$/, "");

interface State {
    version: string;
    equicord: string;
    cordmuffin: string;
    plugins: string[];
    updater: string;
    builtAt?: string;
    skippedRelease?: string;
}

export interface Info {
    supported: boolean;
    reason?: string;
    version?: string;
    equicord?: string;
    cordmuffin?: string;
    plugins?: string[];
    builtAt?: string;
    muffinshelf?: string[];
    changelog?: ChangelogSection[];
}

export interface ChangelogSection {
    title: string;
    items: string[];
}

export interface CheckResult extends Info {
    equicordOutdated?: boolean;
    plugins?: string[];
    changedPlugins?: string[];
    changedMuffinshelf?: string[];
    installer?: string | null;
    // Changelog lines on GitHub that the installed version doesn't have yet.
    whatsNew?: ChangelogSection[];
    error?: string;
}

export interface UpdateResult {
    ok: boolean;
    upToDate?: boolean;
    needsRestart?: boolean;
    updated?: string[];
    skipped?: string[];
    error?: string;
    partial?: boolean;
}

// Tolerates the byte-order mark some Windows editors put at the start of a file.
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));

function readState(): State | null {
    try {
        const state = readJson(join(work, "state.json"));
        if (typeof state?.equicord !== "string" || typeof state?.updater !== "string") return null;
        return { ...state, version: typeof state.version === "string" ? state.version : "", plugins: Array.isArray(state.plugins) ? state.plugins : [] };
    } catch {
        return null;
    }
}

function getState(): { state: State; } | { reason: string; } {
    if (!process.env.LOCALAPPDATA || resolve(__dirname) !== resolve(work, "dist"))
        return { reason: "This Equicord wasn't installed by the Cordmuffin installer, so there's nothing here for CordmuffinUpdater to update." };
    const state = readState();
    if (!state) return { reason: "Cordmuffin's install record is missing. Run Cordmuffin Equicord Installer once to fix it." };
    return { state };
}

async function github(path: string, accept = "application/vnd.github+json") {
    const res = await fetch(api + path, {
        headers: { Accept: accept, "User-Agent": "cordmuffin-updater" },
        signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 403 || res.status === 429)
        throw new Error("GitHub's hourly limit for update checks was reached. It tries again later by itself.");
    return res;
}

function newer(a: string, b: string) {
    const pa = a.replace(/^v/, "").split(".").map(n => parseInt(n, 10) || 0);
    const pb = b.replace(/^v/, "").split(".").map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
    }
    return false;
}

interface MuffinshelfPlugin {
    name: string;
    owner: string;
    repo: string;
    ref: string;
    path: string;
    track: string;
    // Installs from before Muffinshelf recorded the branch only follow commits that build on the installed one.
    sameBranch: boolean;
    // Newest commit the installer skipped because the plugin had left its folder in the repo.
    skipped: string;
}

// Plugins installed with Muffinshelf from GitHub repos, from the install record Muffinshelf keeps in each folder.
function muffinshelfPlugins(): MuffinshelfPlugin[] {
    if (!existsSync(muffinshelfSaved)) return [];
    const plugins: MuffinshelfPlugin[] = [];
    for (const entry of readdirSync(muffinshelfSaved, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
            const m = readJson(join(muffinshelfSaved, entry.name, ".muffinshelf.json"));
            if (!GITHUB_NAME.test(m.owner) || !GITHUB_NAME.test(m.repo)) continue;
            plugins.push({
                name: m.pluginName || entry.name,
                owner: m.owner,
                repo: m.repo,
                ref: typeof m.ref === "string" ? m.ref : "",
                path: typeof m.path === "string" ? m.path : "",
                track: m.track || "HEAD",
                sameBranch: !m.track,
                skipped: typeof m.skippedRef === "string" ? m.skippedRef : "",
            });
        } catch { }
    }
    return plugins;
}

const CHANGELOG = "CHANGELOG.md";
const CHANGELOG_SECTIONS = 3;
const CHANGELOG_ITEMS = 12;

// "## Title" starts a section, "- " starts an item; a line indented under an item continues it.
function parseChangelog(text: string): ChangelogSection[] {
    const sections: ChangelogSection[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (raw.startsWith("## ")) sections.push({ title: line.slice(3).trim(), items: [] });
        else if (!sections.length || !line) continue;
        else if (line.startsWith("- ")) sections.at(-1)!.items.push(line.slice(2).trim());
        else if (/^\s/.test(raw) && sections.at(-1)!.items.length) {
            const { items } = sections.at(-1)!;
            items[items.length - 1] += " " + line;
        }
    }
    // Markdown marks read fine on GitHub but not as plain text on the page.
    return sections
        .map(s => ({ ...s, items: s.items.map(i => i.replace(/\*\*|`/g, "")) }))
        .filter(s => s.items.length);
}

// The installer keeps the cordmuffin source it built from; its changelog is the installed one.
function installedChangelogText(state: State) {
    const dir = join(work, "cordmuffin");
    try {
        if (readFileSync(join(dir, ".commit"), "utf8").trim() !== state.cordmuffin) return null;
        return existsSync(join(dir, CHANGELOG)) ? readFileSync(join(dir, CHANGELOG), "utf8") : "";
    } catch {
        return null;
    }
}

async function changelogAt(ref: string) {
    const res = await github(`/repos/${REPO}/contents/${CHANGELOG}?ref=${ref}`, "application/vnd.github.raw");
    if (res.status === 404) return "";
    if (!res.ok) throw new Error(`GitHub didn't send the changelog (${res.status}).`);
    return res.text();
}

// Never stops a check: without notes, the update is still offered.
async function whatsNew(state: State): Promise<ChangelogSection[]> {
    try {
        const latest = parseChangelog(await changelogAt("main"));
        let installedText = installedChangelogText(state);
        if (installedText === null && SHA.test(state.cordmuffin)) installedText = await changelogAt(state.cordmuffin);
        const installed = new Set(parseChangelog(installedText ?? "").flatMap(s => s.items));
        let left = CHANGELOG_ITEMS;
        return latest
            .map(s => ({ title: s.title, items: s.items.filter(i => !installed.has(i)) }))
            .filter(s => s.items.length)
            .slice(0, CHANGELOG_SECTIONS)
            .map(s => {
                const items = s.items.slice(0, Math.max(left, 0));
                left -= items.length;
                return { ...s, items };
            })
            .filter(s => s.items.length);
    } catch {
        return [];
    }
}

function baseInfo(state: State): Info {
    return {
        supported: true,
        version: state.version,
        equicord: state.equicord,
        cordmuffin: state.cordmuffin,
        plugins: state.plugins,
        builtAt: state.builtAt,
        muffinshelf: muffinshelfPlugins().map(p => p.name),
        changelog: parseChangelog(installedChangelogText(state) ?? "").slice(0, CHANGELOG_SECTIONS),
    };
}

export function getInfo(_: IpcMainInvokeEvent): Info {
    const got = getState();
    if ("reason" in got) return { supported: false, reason: got.reason };
    return baseInfo(got.state);
}

// One lookup per repo and branch. A repo that can't be checked (deleted, renamed, rate limit) is skipped,
// so one bad source never stops the other updates.
async function changedMuffinshelf() {
    const plugins = muffinshelfPlugins();
    const latest = new Map<string, Promise<string | null>>();
    const lookup = (p: MuffinshelfPlugin) => {
        const key = `${p.owner}/${p.repo}@${p.track}`;
        if (!latest.has(key)) {
            latest.set(key, github(`/repos/${p.owner}/${p.repo}/commits/${p.track.split("/").map(encodeURIComponent).join("/")}`, "application/vnd.github.sha")
                .then(async res => {
                    const sha = res.ok ? (await res.text()).trim() : "";
                    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
                })
                .catch(() => null));
        }
        return latest.get(key)!;
    };
    const results = await Promise.all(plugins.map(async p => {
        const sha = await lookup(p);
        if (!sha || sha === p.ref || sha === p.skipped) return null;
        const from = SHA.test(p.skipped) ? p.skipped : p.ref;
        if (!SHA.test(from)) return p.name;
        return await pathChanged(p, from, sha).catch(() => false) ? p.name : null;
    }));
    return results.filter((name): name is string => !!name);
}

// Only changes to the plugin's own folder count, so a repo with many plugins doesn't update all of them at once.
async function pathChanged(p: MuffinshelfPlugin, from: string, sha: string) {
    const sameBranch = p.sameBranch && from === p.ref;
    const res = await github(`/repos/${p.owner}/${p.repo}/compare/${from}...${sha}`);
    // The installed commit is gone (history rewritten); the installer compares the files instead.
    if (res.status === 404) return !sameBranch;
    if (!res.ok) return false;
    const data = await res.json();
    if (sameBranch && data.status !== "ahead") return false;
    const files: { filename?: string; previous_filename?: string; }[] = data.files ?? [];
    // GitHub lists at most 300 files; past that, assume the plugin is among them.
    if (files.length >= 300) return true;
    const prefix = p.path.replace(/^\/+|\/+$/g, "").toLowerCase();
    return files.some(f => [f.filename, f.previous_filename].some(n => n && (!prefix || n.toLowerCase().startsWith(prefix + "/"))));
}

async function equicordOutdated(state: State) {
    const res = await github(`/repos/${EQUICORD}/commits/main`, "application/vnd.github.sha");
    if (!res.ok) throw new Error(`GitHub didn't say which Equicord version is newest (${res.status}).`);
    const sha = (await res.text()).trim();
    return /^[0-9a-f]{40}$/.test(sha) && sha !== state.equicord;
}

// Which of the installed cordmuffin plugins have files that changed since the build.
async function changedPlugins(state: State) {
    if (!/^[0-9a-f]{40}$/.test(state.cordmuffin)) return state.plugins;
    const res = await github(`/repos/${REPO}/compare/${state.cordmuffin}...main`);
    // An unknown commit (say, after a history rewrite) can't be compared, so the installer works it out itself.
    if (res.status === 404) return state.plugins;
    if (!res.ok) throw new Error(`GitHub couldn't compare cordmuffin versions (${res.status}).`);
    const data = await res.json();
    // GitHub lists at most 300 files; past that, the installer works it out itself.
    if ((data.files ?? []).length >= 300) return state.plugins;
    const files: string[] = (data.files ?? []).map((f: { filename?: string; previous_filename?: string; }) => [f.filename, f.previous_filename]).flat().filter(Boolean);
    return state.plugins.filter(name => {
        const prefix = `custom-creations/${name}/`.toLowerCase();
        return files.some(f => f.toLowerCase().startsWith(prefix));
    });
}

async function newerInstaller(state: State) {
    const res = await github(`/repos/${REPO}/releases/latest`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub didn't list cordmuffin's releases (${res.status}).`);
    const tag: string = (await res.json()).tag_name ?? "";
    const version = tag.replace(/^v/, "");
    return tag && newer(tag, state.version) && version !== state.skippedRelease ? version : null;
}

export async function check(_: IpcMainInvokeEvent, includeMuffinshelf: boolean, includeEquicord: boolean): Promise<CheckResult> {
    const got = getState();
    if ("reason" in got) return { supported: false, reason: got.reason };
    const { state } = got;
    const base = baseInfo(state);
    try {
        const [eq, changed, installer, muffinshelf] = await Promise.all([
            includeEquicord ? equicordOutdated(state) : Promise.resolve(false),
            changedPlugins(state),
            newerInstaller(state),
            includeMuffinshelf ? changedMuffinshelf() : Promise.resolve([]),
        ]);
        // Only fetched when cordmuffin has something new, to stay well under GitHub's hourly limit.
        const notes = changed.length || installer ? await whatsNew(state) : [];
        return { ...base, equicordOutdated: eq, changedPlugins: changed, installer, changedMuffinshelf: muffinshelf, whatsNew: notes };
    } catch (e) {
        return { ...base, error: e instanceof Error ? e.message : String(e) };
    }
}

const names = (v: unknown) => Array.isArray(v) ? v.filter((n): n is string => typeof n === "string") : undefined;

function readResult(): UpdateResult | null {
    try {
        const r = readJson(join(work, "update-result.json"));
        if (typeof r?.ok !== "boolean") return null;
        return { ...r, updated: names(r.updated), skipped: names(r.skipped), error: typeof r.error === "string" ? r.error : undefined };
    } catch {
        return null;
    }
}

async function doUpdate(includeMuffinshelf: boolean, includeEquicord: boolean): Promise<UpdateResult> {
    const got = getState();
    if ("reason" in got) return { ok: false, error: got.reason };
    const exe = got.state.updater;
    if (!exe || !existsSync(exe))
        return { ok: false, error: "Cordmuffin's updater is missing. Run Cordmuffin Equicord Installer once to fix it." };

    rmSync(join(work, "update-result.json"), { force: true });
    const code = await new Promise<number>(done => {
        // Detached, so closing Discord in the middle doesn't cut the build off; it finishes and is used next start.
        const args = ["/update", ...(includeMuffinshelf ? [] : ["/no-muffinshelf"]), ...(includeEquicord ? [] : ["/no-equicord"])];
        const child = spawn(exe, args, { cwd: work, windowsHide: true, detached: true, stdio: "ignore" });
        // The installer runs node and pnpm (and maybe a newer copy of itself), so the whole tree is stopped.
        const timer = setTimeout(() => {
            if (child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
            else child.kill();
        }, UPDATE_TIMEOUT_MS);
        child.on("error", () => { clearTimeout(timer); done(-1); });
        child.on("exit", c => { clearTimeout(timer); done(c ?? -1); });
    });

    if (code === EXIT_BUSY) return { ok: false, error: "The Cordmuffin installer or Muffinshelf is busy building right now. It tries again later." };
    const result = readResult();
    if (result) return result;
    // The installer only logs it when it can't save its result; its exit code still says how it went.
    if (code === EXIT_OK) return { ok: true, needsRestart: true, updated: [] };
    if (code === EXIT_UP_TO_DATE) return { ok: true, upToDate: true };
    return { ok: false, error: `The updater stopped without saying why (code ${code}). Its log is at ${join(work, "update.log")}` };
}

let running: Promise<UpdateResult> | null = null;

export function runUpdate(_: IpcMainInvokeEvent, includeMuffinshelf: boolean, includeEquicord: boolean) {
    running ??= doUpdate(includeMuffinshelf === true, includeEquicord === true).finally(() => running = null);
    return running;
}

export function logPath(_: IpcMainInvokeEvent) {
    return join(work, "update.log");
}
