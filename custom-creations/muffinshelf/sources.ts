/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { plugins } from "@api/PluginManager";

import { parseMeta } from "./bd/runtime";
import { Native, settings } from "./settings";

export type EntryKind = "userplugin" | "bd" | "browse";

export interface GithubPath {
    owner: string;
    repo: string;
    ref?: string;
    path: string;
}

export interface ShelfEntry {
    key: string;
    sourceId: string;
    name: string;
    description: string;
    author: string;
    version?: string;
    kind: EntryKind;
    updated?: number;
    downloads?: number;
    image?: string;
    homepage?: string;
    hidden?: boolean;
    userplugin?: GithubPath & { folder: string; dependencies: string[]; };
    bd?: { url: string; file: string; };
}

export interface SourceDef {
    id: string;
    name: string;
    url: string;
    what: string;
    custom?: boolean;
    load(force: boolean): Promise<ShelfEntry[]>;
}

const CACHE_MS = 15 * 60 * 1000;

const EQUICORD_ALIASES: Record<string, string> = {
    AllCallTimeCounter: "CallTimer",
    CallTimeCounter: "CallTimer",
    CharCounter: "CharacterCounter",
    CompleteTimestamps: "CustomTimestamps",
    CustomStatusPresets: "StatusPresets",
    DoNotTrack: "NoTrack",
    "Extended Typing Sounds": "KeyboardSounds",
    FreeEmojis: "FakeNitro",
    GoogleSearchReplace: "ReplaceGoogleSearch",
    "Hide Chat Icons": "HideChatButtons",
    HideIconBadge: "NoSystemBadge",
    InsertTimestamps: "SendTimestamps",
    InvisibleTyping: "SilentTyping",
    LastFMRichPresence: "MusicRichPresence",
    MemberCounter: "MemberCount",
    MoreQuickReacts: "MoreQuickReactions",
    MoreRoleColors: "RoleColorEverywhere",
    NoReplyPing: "NoReplyMention",
    NotificationSounds: "CustomSounds",
    OnlineFriendCount: "ServerListIndicators",
    PingNotification: "PingNotifications",
    RemovedConnectionAlerts: "RelationshipNotifier",
    ReplaceTimestamps: "SendTimestamps",
    SendStickersAsLinks: "FakeNitro",
    ServerCounter: "ServerListIndicators",
    ServerDetails: "ServerInfo",
    ServerHider: "HideServers",
    ShowSpectators: "WhosWatching",
    SpotifyControls: "MusicControls",
    SpotifyListenAlong: "SpotifyCrack",
    StaffTag: "MoreUserTags",
    Translator: "Translate",
    "Uncompressed Images": "FixImagesQuality",
    BetterVolume: "VolumeBooster",
    ViewProfilePicture: "ViewIcons",
    VoiceActivity: "UserVoiceShow",
};

const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/(v\d+|redux)$/, "");
let equicordIndex: Map<string, string> | null = null;

export function equicordEquivalent(name: string) {
    const alias = EQUICORD_ALIASES[name];
    if (alias && alias in plugins) return alias;
    equicordIndex ??= new Map(Object.keys(plugins).filter(n => !n.endsWith("API")).map(n => [normName(n), n]));
    return equicordIndex.get(normName(name));
}
const cache = new Map<string, { at: number; promise: Promise<ShelfEntry[]>; }>();

async function getText(url: string, accept?: string) {
    const res = await Native.fetchText(url, accept);
    if (!res.ok) {
        if (res.status === 403 && url.includes("api.github.com")) throw new Error("GitHub's hourly limit for browsing without an account was reached. Try again in a bit.");
        throw new Error(`${new URL(url).host} answered with ${res.status}`);
    }
    return res.text;
}

const getJson = async (url: string, accept?: string) => JSON.parse(await getText(url, accept));

export function parseGithub(input: string): GithubPath | null {
    let url: URL;
    try {
        url = new URL(input.trim().replace(/\.git$/, ""));
    } catch {
        return null;
    }
    let parts: string[];
    try {
        parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
        return null;
    }
    if (url.hostname === "github.com" && parts.length >= 2) {
        const [owner, repo, kind, ref, ...rest] = parts;
        if ((kind === "tree" || kind === "blob") && ref) return { owner, repo, ref, path: rest.join("/") };
        return { owner, repo, path: "" };
    }
    if (url.hostname === "raw.githubusercontent.com" && parts.length >= 3) {
        const [owner, repo, ref, ...rest] = parts;
        return { owner, repo, ref, path: rest.join("/") };
    }
    return null;
}

const folderName = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "").replace(/^[.-]+/, "").slice(0, 64) || "plugin";
const rawUrl = (g: GithubPath, ref: string, path: string) => `https://raw.githubusercontent.com/${g.owner}/${g.repo}/${ref}/${path.split("/").map(encodeURIComponent).join("/")}`;

export function toRawGithub(url: string) {
    const gh = parseGithub(url);
    if (!gh || new URL(url).hostname !== "github.com" || !gh.ref || !gh.path) return url;
    return rawUrl(gh, gh.ref, gh.path);
}

export function webLink(url: unknown) {
    if (typeof url !== "string") return undefined;
    const clean = url.replace(/^git\+/, "").replace(/\.git$/, "");
    return /^https:\/\//.test(clean) ? clean : undefined;
}

const names = (value: unknown) => [value].flat().map(a => typeof a === "string" ? a : (a as { name?: string; } | null)?.name).filter(Boolean).join(", ");

function readPluginInfo(code: string) {
    const block = code.match(/definePlugin\(\s*{([\s\S]{0,4000})/)?.[1] ?? "";
    const str = (key: string) => block.match(new RegExp(`(?:^|\\n)\\s*${key}:\\s*(["'\`])((?:\\\\.|(?!\\1).)*)\\1`))?.[2];
    return { name: str("name"), description: str("description") };
}

async function loadVenpmIndex(sourceId: string, url: string): Promise<ShelfEntry[]> {
    const json = await getJson(url);
    if (!json?.plugins || typeof json.plugins !== "object") throw new Error("That link isn't a plugins.json index");
    const fallbackAuthor = json.name ?? "";
    return Object.entries<any>(json.plugins).filter(([, p]) => p && typeof p === "object").map(([name, p]) => {
        const gh = typeof p.source?.git === "string" ? parseGithub(p.source.git) : null;
        return {
            key: `${sourceId}:${name}`,
            sourceId,
            name,
            description: typeof p.description === "string" ? p.description : "",
            author: names(p.authors) || fallbackAuthor,
            version: p.version,
            kind: gh ? "userplugin" : "browse",
            hidden: name.startsWith("_"),
            homepage: gh ? `https://github.com/${gh.owner}/${gh.repo}/tree/HEAD/${p.source.path ?? ""}` : webLink(p.source?.git ?? p.source?.tarball),
            userplugin: gh ? { ...gh, ref: p.source.ref ?? p.source.tag, path: p.source.path ?? gh.path, folder: folderName(name), dependencies: Array.isArray(p.dependencies) ? p.dependencies : [] } : undefined,
        } satisfies ShelfEntry;
    });
}

async function loadGithubRepo(sourceId: string, gh: GithubPath, force: boolean): Promise<ShelfEntry[]> {
    const ref = gh.ref ?? "HEAD";
    const { commit, files, texts } = await Native.scanRepo(gh.owner, gh.repo, ref, force);
    const scope = gh.path ? gh.path.replace(/\/$/, "") + "/" : "";
    const isModSource = files.includes("package.json") && files.some(p => p.startsWith("src/plugins/"));
    const inScope = (p: string) => p.startsWith(scope) && !p.includes("node_modules/") && (!isModSource || p.startsWith("src/userplugins/"));

    const roots: string[] = [];
    for (const path of files.filter(p => inScope(p) && /(^|\/)index\.(t|j)sx?$/.test(p)).sort((a, b) => a.split("/").length - b.split("/").length)) {
        const dir = path.split("/").slice(0, -1).join("/");
        if (roots.some(r => r === "" || dir === r || dir.startsWith(r + "/"))) continue;
        roots.push(dir);
    }

    const userplugins = roots.map(dir => {
        const index = files.find(p => p.startsWith(dir ? dir + "/" : "") && /^index\.(t|j)sx?$/.test(p.slice(dir ? dir.length + 1 : 0)));
        const info: { name?: string; description?: string; } = index && texts[index] ? readPluginInfo(texts[index]) : {};
        const folder = folderName(dir.split("/").pop() || gh.repo);
        return {
            key: `${sourceId}:${dir || gh.repo}`,
            sourceId,
            name: info.name ?? folder,
            description: info.description ?? "",
            author: gh.owner,
            version: commit?.slice(0, 7),
            kind: "userplugin",
            hidden: folder.startsWith("_"),
            homepage: `https://github.com/${gh.owner}/${gh.repo}/tree/${ref}/${dir}`,
            userplugin: { owner: gh.owner, repo: gh.repo, ref, path: dir, folder, dependencies: [] },
        } satisfies ShelfEntry;
    });

    const bds = files.filter(p => inScope(p) && p.endsWith(".plugin.js")).map(path => {
        const file = path.split("/").pop() ?? path;
        const meta = parseMeta(texts[path] ?? "", file);
        return {
            key: `${sourceId}:${path}`,
            sourceId,
            name: meta.name,
            description: meta.description ?? "",
            author: meta.author ?? gh.owner,
            version: meta.version,
            kind: "bd",
            homepage: `https://github.com/${gh.owner}/${gh.repo}/blob/${ref}/${path}`,
            bd: { url: rawUrl(gh, commit ?? ref, path), file },
        } satisfies ShelfEntry;
    });

    return [...userplugins, ...bds];
}

async function loadSinglePlugin(sourceId: string, url: string): Promise<ShelfEntry[]> {
    url = toRawGithub(url);
    const file = new URL(url).pathname.split("/").pop()?.replace(/%20/g, " ") ?? "plugin.plugin.js";
    const meta = parseMeta(await getText(url), file);
    return [{
        key: `${sourceId}:${file}`,
        sourceId,
        name: meta.name,
        description: meta.description ?? "",
        author: meta.author ?? new URL(url).host,
        version: meta.version,
        kind: "bd",
        homepage: webLink(meta.website) ?? webLink(meta.source) ?? url,
        bd: { url, file },
    }];
}

export const BUILT_IN: SourceDef[] = [
    {
        id: "bd-store",
        name: "BetterDiscord store",
        url: "https://betterdiscord.app/plugins",
        what: "Every plugin on the official BetterDiscord store. These run through Muffinshelf's BetterDiscord layer with no rebuild.",
        async load() {
            const list: any[] = await getJson("https://api.betterdiscord.app/v3/store/plugins");
            return list.filter(p => p?.id && p.file_name && p.latest_source_url).map(p => ({
                key: `bd-store:${p.id}`,
                sourceId: "bd-store",
                name: p.name,
                description: p.description ?? "",
                author: p.author?.display_name ?? p.author?.github_name ?? "",
                version: p.version,
                kind: "bd",
                updated: Date.parse(p.latest_release_date) || undefined,
                downloads: p.downloads,
                image: p.thumbnail_url ? `https://betterdiscord.app${p.thumbnail_url}` : undefined,
                homepage: `https://betterdiscord.app/plugin/${encodeURIComponent(p.name)}`,
                bd: { url: p.latest_source_url, file: p.file_name },
            }) satisfies ShelfEntry);
        },
    },
    {
        id: "venpm-kamaras",
        name: "kamaras userplugins",
        url: "https://github.com/theokyr/vencord-plugins",
        what: "A venpm plugin index of Vencord userplugins by kamaras. These get added to your Equicord and need a rebuild.",
        load: () => loadVenpmIndex("venpm-kamaras", "https://raw.githubusercontent.com/theokyr/vencord-plugins/main/plugins.json"),
    },
    {
        id: "shelter",
        name: "shelter plugins",
        url: "https://shindex.uwu.network",
        what: "Plugins made for shelter. Listed so you can find ideas and their authors. They can't run on Equicord.",
        async load() {
            const repos: any[] = await getJson("https://shindex.uwu.network/data");
            return repos.flatMap(r => (Array.isArray(r?.plugins) ? r.plugins : []).filter(Boolean).map((p: any) => ({
                key: `shelter:${p.url}`,
                sourceId: "shelter",
                name: p.name,
                description: p.description ?? "",
                author: names(p.author) || r.name,
                kind: "browse",
                homepage: webLink(p.url),
            }) satisfies ShelfEntry));
        },
    },
    {
        id: "moonlight",
        name: "Moonlight extensions",
        url: "https://moonlight-mod.github.io/extensions-dist/",
        what: "Extensions made for Moonlight. Listed so you can find ideas and their authors. They can't run on Equicord.",
        async load() {
            const list: any[] = await getJson("https://moonlight-mod.github.io/extensions-dist/repo.json");
            return list.filter(e => e?.id).map(e => ({
                key: `moonlight:${e.id}`,
                sourceId: "moonlight",
                name: e.meta?.name ?? e.id,
                description: e.meta?.tagline ?? e.meta?.description ?? "",
                author: names(e.meta?.authors ?? []),
                version: e.version,
                kind: "browse",
                homepage: webLink(e.meta?.source),
            }) satisfies ShelfEntry);
        },
    },
    {
        id: "replugged",
        name: "Replugged store",
        url: "https://replugged.dev/store/plugins",
        what: "Plugins made for Replugged. Listed so you can find ideas and their authors. They can't run on Equicord.",
        async load() {
            const page = (n: number) => getJson(`https://replugged.dev/api/store/list/plugin?page=${n}&items=100`);
            const first = await page(1);
            const pages = Math.min(10, Math.max(1, Number(first.numPages) || 1));
            const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => page(i + 2)));
            return [first, ...rest].flatMap(p => Array.isArray(p?.results) ? p.results : []).filter((p: any) => p?.id).map((p: any) => ({
                key: `replugged:${p.id}`,
                sourceId: "replugged",
                name: p.name,
                description: p.description ?? "",
                author: names(p.author),
                version: p.version,
                kind: "browse",
                image: webLink(Array.isArray(p.image) ? p.image[0] : p.image),
                homepage: webLink(p.source),
            }) satisfies ShelfEntry);
        },
    },
    {
        id: "evi",
        name: "Evi plugins",
        url: "https://github.com/BleedDev/evi",
        what: "Plugins made for Evi. Listed so you can find ideas and their authors. They can't run on Equicord.",
        async load() {
            const { texts } = await Native.scanRepo("BleedDev", "evi", "HEAD", false);
            const list = Object.entries(texts).filter(([p]) => /^plugins\/[^/]+\/manifest\.json$/.test(p)).map(([, t]) => {
                try {
                    return JSON.parse(t);
                } catch {
                    return null;
                }
            });
            return list.filter(m => m?.id).map(m => ({
                key: `evi:${m.id}`,
                sourceId: "evi",
                name: m.name ?? m.id,
                description: m.description ?? "",
                author: names(m.authors ?? []),
                version: m.version,
                kind: "browse",
                homepage: `https://github.com/BleedDev/evi/tree/main/plugins/${m.id}`,
            }) satisfies ShelfEntry);
        },
    },
];

export function customSource(url: string): SourceDef {
    const id = `custom:${url}`;
    const gh = parseGithub(url);
    const isJson = /\.json(\?|$)/i.test(url);
    const isBdFile = /\.plugin\.js(\?|$)/i.test(url);
    return {
        id,
        name: gh ? `${gh.owner}/${gh.repo}${gh.path && !isJson && !isBdFile ? `/${gh.path}` : ""}` : new URL(url).host,
        url,
        custom: true,
        what: isJson
            ? "A plugins.json index you added."
            : isBdFile
                ? "A single BetterDiscord plugin file you added."
                : "A GitHub repo you added. Muffinshelf lists every folder with an index.ts or index.tsx as an Equicord plugin, and every .plugin.js file as a BetterDiscord plugin.",
        load: (force: boolean) => isJson
            ? loadVenpmIndex(id, toRawGithub(url))
            : isBdFile
                ? loadSinglePlugin(id, url)
                : gh
                    ? loadGithubRepo(id, gh, force)
                    : Promise.reject(new Error("Muffinshelf can read GitHub repos, plugins.json indexes and .plugin.js links")),
    };
}

export function checkSourceUrl(url: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return "That isn't a link.";
    }
    if (parsed.protocol !== "https:") return "The link has to start with https://.";
    if (/\.json(\?|$)/i.test(url) || /\.plugin\.js(\?|$)/i.test(url)) return null;
    if (!parseGithub(url)) return "Use a GitHub repo link, a plugins.json link, or a .plugin.js link.";
    return null;
}

export function allSources() {
    return [...BUILT_IN, ...settings.store.customSources.map(customSource)];
}

export function loadSource(source: SourceDef, force = false) {
    const cached = cache.get(source.id);
    if (cached && !force && Date.now() - cached.at < CACHE_MS) return cached.promise;
    const promise = source.load(force);
    cache.set(source.id, { at: Date.now(), promise });
    promise.catch(() => cache.delete(source.id));
    return promise;
}

export async function fetchBdCode(url: string) {
    return getText(toRawGithub(url));
}
