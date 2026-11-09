/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import { type ChildProcess, execFile, spawn } from "child_process";
import { createHash, randomUUID } from "crypto";
import { app, BrowserWindow, dialog, type IpcMainInvokeEvent, net, type OpenDialogOptions, type WebContents } from "electron";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { appendFile, open, stat, statfs } from "fs/promises";
import { homedir, setPriority, tmpdir } from "os";
import { delimiter, join } from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { createGunzip } from "zlib";

import { correctKbps, firstGifStep, type GifStep, type MediaInfo, nextGifStep, parseProbe, planAudio, planVideo, seconds } from "./plan";

const ROOT = join(DATA_DIR, "shrinkUploads");
const WIN = process.platform === "win32";
const EXE = WIN ? "ffmpeg.exe" : "ffmpeg";
const BIN = join(ROOT, EXE);
const READY = join(ROOT, "ffmpeg.ready");
const WORK = process.platform === "linux" ? join(ROOT, "work") : join(tmpdir(), "shrink-uploads");
const NULL_OUT = WIN ? "NUL" : "/dev/null";
const STALL_MS = 30_000;
const CHECK_MS = 60_000;

const RELEASE = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/";
const BUILDS: Record<string, { file: string; sha256: string; mb: number; }> = {
    "win32-x64": { file: "ffmpeg-win32-x64.gz", sha256: "8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77", mb: 29 },
    "linux-x64": { file: "ffmpeg-linux-x64.gz", sha256: "bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa", mb: 29 },
    "linux-arm64": { file: "ffmpeg-linux-arm64.gz", sha256: "754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0", mb: 25 },
    "linux-arm": { file: "ffmpeg-linux-arm.gz", sha256: "64b115a12f0ab77c277e3c418aae8b40ef881e75e746a0e2d066a206b9bc5172", mb: 19 },
    "linux-ia32": { file: "ffmpeg-linux-ia32.gz", sha256: "169b27c078a8ecedb814cac67afccf15a9868d63e9d74ef86088adefaa500d00", mb: 22 },
    "darwin-x64": { file: "ffmpeg-darwin-x64.gz", sha256: "929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106", mb: 25 },
    "darwin-arm64": { file: "ffmpeg-darwin-arm64.gz", sha256: "8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa", mb: 19 },
};
const BUILD = BUILDS[`${process.platform}-${process.platform === "win32" ? "x64" : process.arch}`];

const TONEMAP = "setparams=color_primaries=bt2020:colorspace=bt2020nc,zscale=t=linear:npl=203,format=gbrpf32le,zscale=p=bt709,tonemap=mobius:desat=0,zscale=t=bt709:m=bt709:r=tv";
const DEINTERLACE = "bwdif=mode=send_frame:deint=interlaced";
const GIF_VIDEO_BPP = 0.12;

const SPEED = { fast: "veryfast", balanced: "medium", best: "slow" } as const;
export type Speed = keyof typeof SPEED;
export type Kind = "video" | "audio" | "gif";

export interface JobOptions {
    speed: Speed;
    maxFps: number;
    gifToVideo: boolean;
    keepMetadata: boolean;
}

export interface JobResult {
    size: number;
    ext: string;
    mime: string;
    note: string;
}

interface Job {
    owner: number;
    dir: string;
    input: string;
    output?: string;
    proc?: ChildProcess;
    cancelled: boolean;
    phase: string;
    percent: number;
    reserve: number;
}

interface RunResult {
    code: number;
    out: string;
    err: string;
    spawnFailed: boolean;
}

const jobs = new Map<string, Job>();
const watched = new WeakSet<WebContents>();
const filterSupport = new Map<string, Promise<boolean>>();
let system: Promise<string | null> | null = null;
let custom = "";
let customError = "";
let installing: Promise<void> | null = null;
let download: { received: number; total: number; } | null = null;
let installError = "";

const DISK_FULL = "Your disk is full. Free up some space and try again.";
const BLOCKED = "A file was blocked, maybe by antivirus. Try again.";
const DAMAGED = "This file looks damaged or isn't a normal video or audio file.";
const NO_NET = "Couldn't download the video tool. Check your internet and try again.";

function plain(raw: string, code = "") {
    console.error("[ShrinkUploads]", code, raw);
    if (code === "ENOSPC" || /No space left|not enough space|ENOSPC/i.test(raw)) return DISK_FULL;
    if (["EPERM", "EACCES", "EBUSY"].includes(code) || /EPERM|EACCES|EBUSY|Permission denied|Access is denied/i.test(raw)) return BLOCKED;
    if (/Invalid data found|moov atom not found|could not find codec|does not contain any stream|Error while decoding/i.test(raw)) return DAMAGED;
    return "Something went wrong while shrinking. Try again, or trim the file first.";
}

function friendly(e: any): never {
    const raw = String(e?.message ?? e);
    if (e?.code || /[\\/]/.test(raw)) throw new Error(plain(raw, e?.code));
    throw e;
}

function run(file: string, args: string[], job?: Job, timeout = 0) {
    return new Promise<RunResult>(resolve => {
        const child = execFile(file, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout }, (error, out, err) => {
            if (job) job.proc = undefined;
            const spawnFailed = !!error && typeof error.code === "string" && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
            resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, out: out ?? "", err: err ?? "", spawnFailed });
        });
        if (job) {
            job.proc = child;
            lowerPriority(child);
        }
    });
}

function lowerPriority(child: ChildProcess) {
    try {
        if (child.pid) setPriority(child.pid, 10);
    } catch { }
}

function removeDir(dir: string) {
    try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch { }
}

async function capable(file: string) {
    const { out } = await run(file, ["-hide_banner", "-encoders"], undefined, CHECK_MS);
    if (!/\blibx264\b/.test(out) || !/\blibopus\b/.test(out)) return null;
    const dir = join(WORK, `check-${randomUUID()}`);
    try {
        mkdirSync(dir, { recursive: true });
        const test = join(dir, "t.mp4");
        const { code } = await run(file, [
            "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-f", "lavfi", "-i", "color=c=black:s=64x64:d=0.2", "-f", "lavfi", "-i", "sine=d=0.2",
            "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "libopus", test
        ], undefined, CHECK_MS);
        return code === 0 && statSync(test, { throwIfNoEntry: false })?.size ? file : null;
    } catch {
        return null;
    } finally {
        removeDir(dir);
    }
}

function canTonemap(bin: string) {
    let p = filterSupport.get(bin);
    if (!p) filterSupport.set(bin, p = run(bin, ["-hide_banner", "-filters"], undefined, CHECK_MS).then(r => /\bzscale\b/.test(r.out) && /\btonemap\b/.test(r.out)));
    return p;
}

function unshim(file: string) {
    const shim = file.replace(/\.exe$/i, ".shim");
    if (shim === file || !existsSync(shim)) return file;
    try {
        const target = /^\s*path\s*=\s*"?([^"\r\n]+?)"?\s*$/m.exec(readFileSync(shim, "utf8"))?.[1];
        return target && existsSync(target) ? target : file;
    } catch {
        return file;
    }
}

function isFile(file: string) {
    try {
        return statSync(file).isFile();
    } catch {
        return false;
    }
}

function knownPlaces() {
    const { env } = process;
    const home = homedir();
    const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).map(d => d.trim().replace(/^"|"$/g, "")).filter(Boolean);
    if (WIN) {
        const data = env.ProgramData || "C:\\ProgramData";
        dirs.push(
            join(env.SCOOP || join(home, "scoop"), "shims"),
            join(env.SCOOP_GLOBAL || join(data, "scoop"), "shims"),
            join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Microsoft", "WinGet", "Links"),
            join(data, "chocolatey", "lib", "ffmpeg", "tools", "ffmpeg", "bin"),
            join(data, "chocolatey", "lib", "ffmpeg-full", "tools", "ffmpeg", "bin"),
            join(data, "chocolatey", "bin"),
            join(env.ProgramFiles || "C:\\Program Files", "ffmpeg", "bin"),
            "C:\\ffmpeg\\bin",
        );
    } else {
        dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin", join(home, ".local", "bin"));
    }
    const seen = new Set<string>();
    const found: string[] = [];
    for (const dir of dirs) {
        const file = join(dir, EXE);
        if (!isFile(file)) continue;
        const real = unshim(file);
        const key = WIN ? real.toLowerCase() : real;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(real);
    }
    return found;
}

async function findSystem() {
    for (const file of knownPlaces()) if (await capable(file)) return file;
    return null;
}

async function ffmpegPath() {
    if (custom) return custom;
    if (existsSync(READY) && existsSync(BIN)) return BIN;
    system ??= findSystem();
    return system;
}

export async function useTool(_: IpcMainInvokeEvent, file: string, saved = false) {
    let path = String(file ?? "").trim().replace(/^"|"$/g, "");
    if (!path) {
        custom = "";
        customError = "";
        return "";
    }
    if (!isFile(path)) path = [join(path, EXE), join(path, "bin", EXE)].find(isFile) ?? "";
    const real = path && unshim(path);
    const problem = !real
        ? "The ffmpeg you picked isn't there anymore. Pick it again, or go back to automatic."
        : !await capable(real)
            ? "The ffmpeg you picked didn't pass the test. It needs a full build with libx264 and libopus."
            : "";
    if (problem) {
        if (saved) {
            custom = "";
            customError = problem;
        }
        throw new Error(problem);
    }
    custom = real;
    customError = "";
    return real;
}

export async function pickTool(e: IpcMainInvokeEvent) {
    const win = BrowserWindow.fromWebContents(e.sender);
    const options: OpenDialogOptions = {
        title: "Choose ffmpeg",
        properties: ["openFile"],
        filters: WIN ? [{ name: "ffmpeg", extensions: ["exe"] }] : [],
    };
    const r = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));
    return r.canceled ? "" : r.filePaths[0] ?? "";
}

export async function getTools(_: IpcMainInvokeEvent) {
    const path = await ffmpegPath();
    return {
        ready: path != null,
        source: path == null ? null : path === custom ? "custom" : path === BIN ? "downloaded" : "system",
        path: path ?? "",
        customError,
        supported: BUILD != null,
        sizeMb: BUILD?.mb ?? 0,
        installing: installing != null,
        download,
        error: installError,
    };
}

function clearPartials() {
    if (!existsSync(ROOT)) return;
    for (const f of readdirSync(ROOT)) {
        if (!f.endsWith(".part")) continue;
        try {
            if (Date.now() - statSync(join(ROOT, f)).mtimeMs > 600_000) rmSync(join(ROOT, f), { force: true });
        } catch { }
    }
}

async function fetchBinary() {
    if (!BUILD) throw new Error("There's no ready-made video tool for this system. Install ffmpeg yourself, then restart Discord.");
    mkdirSync(ROOT, { recursive: true });
    clearPartials();
    const ctrl = new AbortController();
    let stall = setTimeout(() => ctrl.abort(), STALL_MS);
    const poke = () => {
        clearTimeout(stall);
        stall = setTimeout(() => ctrl.abort(), STALL_MS);
    };
    const partial = `${BIN}.${process.pid}.${randomUUID()}.part`;
    try {
        const res = await net.fetch(RELEASE + BUILD.file, { signal: ctrl.signal }).catch(() => { throw new Error(NO_NET); });
        if (!res.ok || !res.body) throw new Error(`The video tool download failed (error ${res.status}). Try again later.`);
        poke();
        download = { received: 0, total: Number(res.headers.get("content-length")) || BUILD.mb * 1024 * 1024 };
        const hash = createHash("sha256");
        const meter = new Transform({
            transform(chunk: Buffer, _enc, done) {
                poke();
                hash.update(chunk);
                if (download) download.received += chunk.length;
                done(null, chunk);
            }
        });
        await pipeline(Readable.fromWeb(res.body as import("stream/web").ReadableStream<Uint8Array>), meter, createGunzip(), createWriteStream(partial))
            .catch(e => { throw ctrl.signal.aborted ? new Error("The download stopped. Check your internet and try again.") : /^Z_/.test(e?.code ?? "") ? new Error("The download was damaged, so it was thrown away. Try again.") : e; });
        if (hash.digest("hex") !== BUILD.sha256) throw new Error("The download was damaged, so it was thrown away. Try again.");
        if (!WIN) chmodSync(partial, 0o755);
        try {
            renameSync(partial, BIN);
        } catch (e) {
            if (!existsSync(READY)) throw e;
            rmSync(partial, { force: true });
        }
        if (!await capable(BIN)) throw new Error("The video tool wouldn't start. Your antivirus may have blocked it.");
        writeFileSync(READY, BUILD.sha256);
    } catch (e) {
        rmSync(partial, { force: true });
        throw e;
    } finally {
        clearTimeout(stall);
    }
}

export function installTools(_: IpcMainInvokeEvent) {
    installError = "";
    installing ??= fetchBinary()
        .catch(e => {
            const raw = String(e?.message ?? e);
            installError = e?.name === "AbortError" || /fetch failed|terminated|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR|ERR_NAME|ERR_INTERNET|ERR_CONNECTION|socket|network/i.test(raw)
                ? NO_NET
                : e?.code || /[\\/]/.test(raw) ? plain(raw, e?.code) : raw;
            throw new Error(installError);
        })
        .finally(() => { installing = null; download = null; });
    return installing;
}

export function removeTools(_: IpcMainInvokeEvent) {
    if (jobs.size || installing) throw new Error("Wait until shrinking is done, then try again.");
    try {
        rmSync(BIN, { force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
        throw new Error("The video tool is in use. Restart Discord and try again.");
    }
    rmSync(READY, { force: true });
    system = null;
    filterSupport.clear();
}

function sweep() {
    if (!existsSync(WORK)) return;
    for (const name of readdirSync(WORK)) {
        const dir = join(WORK, name);
        try {
            if (jobs.has(name)) continue;
            const newest = Math.max(statSync(dir).mtimeMs, ...readdirSync(dir).map(f => statSync(join(dir, f)).mtimeMs));
            if (Date.now() - newest > 3600_000) removeDir(dir);
        } catch { }
    }
}

function dropJob(id: string) {
    const job = jobs.get(id);
    if (!job) return;
    job.cancelled = true;
    job.proc?.kill("SIGKILL");
    jobs.delete(id);
    removeDir(job.dir);
}

function dropOwner(owner: number) {
    for (const [id, job] of jobs) if (job.owner === owner) dropJob(id);
}

function watch(sender: WebContents) {
    if (watched.has(sender)) return;
    watched.add(sender);
    const { id } = sender;
    sender.once("destroyed", () => dropOwner(id));
    sender.on("render-process-gone", () => dropOwner(id));
    sender.on("did-navigate", () => dropOwner(id));
}

app.once("will-quit", () => [...jobs.keys()].forEach(dropJob));
sweep();

export async function startJob(e: IpcMainInvokeEvent, name: string, size = 0, target = 0) {
    sweep();
    watch(e.sender);
    const id = randomUUID();
    const dir = join(WORK, id);
    mkdirSync(dir, { recursive: true });
    const need = Math.max(0, size) + Math.max(0, target) * 3 + 256 * 1024 * 1024;
    const pending = [...jobs.values()].reduce((sum, j) => sum + j.reserve, 0);
    const free = await statfs(dir).then(s => s.bavail * s.bsize, () => Infinity);
    if (free - pending < need) {
        removeDir(dir);
        const gb = Math.max(1, Math.ceil((need - (free - pending)) / 1024 ** 3));
        throw new Error(`Not enough free disk space. Free up about ${gb} GB and try again.`);
    }
    const ext = (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? "bin").toLowerCase();
    jobs.set(id, { owner: e.sender.id, dir, input: join(dir, `in.${ext}`), cancelled: false, phase: "Reading file", percent: 0, reserve: need });
    return id;
}

function getJob(id: string) {
    const job = jobs.get(id);
    if (!job) throw new Error("Cancelled");
    return job;
}

export function writeChunk(_: IpcMainInvokeEvent, id: string, data: Uint8Array) {
    return appendFile(getJob(id).input, data).catch(friendly);
}

export function getProgress(_: IpcMainInvokeEvent, id: string) {
    const job = jobs.get(id);
    return job ? { phase: job.phase, percent: job.percent } : null;
}

export async function readChunk(_: IpcMainInvokeEvent, id: string, offset: number, length: number) {
    const job = getJob(id);
    if (!job.output) throw new Error("Nothing to read yet.");
    const file = await open(job.output, "r");
    try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await file.read(buf, 0, length, offset);
        return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
    } finally {
        await file.close();
    }
}

export function cancelJob(_: IpcMainInvokeEvent, id: string) {
    const job = jobs.get(id);
    if (!job) return;
    job.cancelled = true;
    job.proc?.kill("SIGKILL");
}

export function finishJob(_: IpcMainInvokeEvent, id: string) {
    dropJob(id);
}

function ffmpeg(job: Job, bin: string, args: string[], duration: number, from: number, span: number) {
    return new Promise<void>((resolve, reject) => {
        if (job.cancelled) return reject(new Error("Cancelled"));
        const proc = spawn(bin, ["-hide_banner", "-nostdin", "-y", "-nostats", "-progress", "pipe:1", ...args], { windowsHide: true });
        job.proc = proc;
        lowerPriority(proc);
        let tail = "";
        proc.stderr.on("data", (d: Buffer) => { tail = (tail + d.toString()).slice(-4000); });
        proc.stdout.on("data", (d: Buffer) => {
            const m = /out_time_(?:us|ms)=(\d+)/.exec(d.toString());
            if (m && duration > 0) job.percent = Math.max(job.percent, Math.min(99, from + span * Math.min(1, Number(m[1]) / 1e6 / duration)));
        });
        proc.on("error", (e: NodeJS.ErrnoException) => {
            console.error("[ShrinkUploads] ffmpeg failed to start", e);
            reject(new Error(bin === BIN
                ? "The video tool couldn't start. Remove it in the ShrinkUploads settings and download it again."
                : bin === custom
                    ? "The ffmpeg you picked couldn't start. Pick it again in the ShrinkUploads settings, or go back to automatic."
                    : "The ffmpeg on this computer couldn't start. Reinstall it, or remove it so the plugin can download its own."));
        });
        proc.on("close", code => {
            job.proc = undefined;
            if (job.cancelled) reject(new Error("Cancelled"));
            else if (code === 0) resolve();
            else reject(new Error(plain(tail.trim().split(/\r?\n/).filter(l => !/^\s*$/.test(l)).slice(-3).join(" ") || `ffmpeg exited with code ${code}`)));
        });
    });
}

async function probe(job: Job, bin: string) {
    const first = await run(bin, ["-hide_banner", "-i", job.input], job);
    if (first.spawnFailed && !job.cancelled) {
        if (bin === BIN) rmSync(READY, { force: true });
        if (bin === custom) {
            custom = "";
            customError = "The ffmpeg you picked couldn't start, so the plugin went back to automatic.";
        }
        system = null;
        throw new Error("The video tool couldn't start, maybe because antivirus blocked it. Get it again in the ShrinkUploads settings.");
    }
    const info = parseProbe(first.err);
    if (!info.duration && (info.hasVideo || info.hasAudio) && !job.cancelled) {
        job.phase = "Measuring length";
        const { err } = await run(bin, ["-hide_banner", "-i", job.input, "-map", "0:v:0?", "-map", "0:a:0?", "-c", "copy", "-f", "null", NULL_OUT], job);
        const times = [...err.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
        const last = times[times.length - 1];
        if (last) info.duration = seconds(last[1], last[2], last[3]);
    }
    return info;
}

function scaleFilter(info: MediaInfo, shortSide: number) {
    if (shortSide >= Math.min(info.width, info.height)) return "scale=trunc(iw/2)*2:trunc(ih/2)*2";
    return `scale='if(gte(iw,ih),-2,${shortSide})':'if(gte(iw,ih),${shortSide},-2)':flags=lanczos`;
}

function attemptRange(attempt: number) {
    return attempt ? { from: 90 + Math.min(attempt - 1, 3) * 2, span: 2 } : { from: 0, span: 100 };
}

async function retryOnce(job: Job, run: () => Promise<void>) {
    try {
        await run();
    } catch (e: any) {
        if (job.cancelled || [DISK_FULL, BLOCKED, DAMAGED].includes(e?.message) || /couldn't start/.test(e?.message ?? "")) throw e;
        console.warn("[ShrinkUploads] encode failed once, trying again", e);
        await run();
    }
}

async function encodeVideo(job: Job, bin: string, info: MediaInfo, target: number, opts: JobOptions, withAudio: boolean, fromGif = false): Promise<JobResult> {
    const out = join(job.dir, "out.mp4");
    const log = join(job.dir, "pass");
    let plan = planVideo({ ...info, hasAudio: withAudio && info.hasAudio }, target, opts.maxFps);
    if (!plan.ok) throw new Error(plan.reason);
    const tonemap = info.hdr && await canTonemap(bin);
    const aspect = Math.max(info.width, info.height) / Math.max(2, Math.min(info.width, info.height));
    const ceiling = (p: { shortSide: number; fps: number; }) => fromGif ? Math.max(200, Math.ceil(GIF_VIDEO_BPP * p.shortSide * p.shortSide * aspect * p.fps / 1000)) : Infinity;
    let kbps = Math.min(plan.videoKbps, ceiling(plan));
    let best: { path: string; size: number; note: string; } | null = null;
    let raised = false;

    for (let attempt = 0; attempt < 3; attempt++) {
        const filters = [scaleFilter(info, plan.shortSide)];
        if (info.fps > 0 && plan.fps < info.fps - 0.5) filters.unshift(`fps=${plan.fps}`);
        if (info.interlaced) filters.unshift(DEINTERLACE);
        if (tonemap) filters.push(TONEMAP);
        const base = [
            "-i", job.input, "-map", "0:v:0",
            "-vf", [...filters, "format=yuv420p"].join(","),
            "-c:v", "libx264", "-preset", SPEED[opts.speed], "-b:v", `${kbps}k`, "-profile:v", "high",
            "-passlogfile", log,
            ...(opts.keepMetadata ? [] : ["-map_metadata", "-1"]),
        ];
        const { from, span } = attemptRange(attempt);
        const audio = plan.audioKbps > 0 ? ["-map", "0:a:0", "-c:a", "aac", "-b:a", `${plan.audioKbps}k`, "-ac", String(plan.audioChannels)] : ["-an"];
        await retryOnce(job, async () => {
            job.phase = attempt ? "Getting the size just right" : "Checking the video";
            await ffmpeg(job, bin, [...base, "-pass", "1", "-an", "-f", "null", NULL_OUT], info.duration, from, span * 0.4);
            job.phase = attempt ? "Getting the size just right" : "Shrinking video";
            await ffmpeg(job, bin, [...base, "-pass", "2", ...audio, "-movflags", "+faststart", out], info.duration, from + span * 0.4, span * 0.6);
        });

        const { size } = await stat(out);
        const note = `${plan.shortSide}p`;
        if (size <= target && (!best || size > best.size)) {
            const kept = join(job.dir, `best${attempt}.mp4`);
            renameSync(out, kept);
            best = { path: kept, size, note };
        }
        if (best?.size === size && (size >= target * 0.9 || kbps >= ceiling(plan))) break;
        const next = Math.min(Math.floor(kbps - (size - target * 0.98) * 8 / 1000 / info.duration), ceiling(plan));
        if (size <= target && (raised || next <= kbps * 1.03)) break;
        if (next < 40) break;
        raised ||= next > kbps;
        kbps = next;
        plan = { ...plan, ...planForKbps(info, kbps, plan) };
        kbps = Math.min(kbps, ceiling(plan));
    }

    if (!best) throw new Error("It wouldn't fit under the limit. Trim it, or try a bigger size.");
    job.output = best.path;
    return { size: best.size, ext: "mp4", mime: "video/mp4", note: best.note };
}

function planForKbps(info: MediaInfo, kbps: number, current: { shortSide: number; fps: number; }) {
    const pixels = (kbps * 1000) / (0.075 * current.fps);
    const aspect = Math.max(info.width, info.height) / Math.max(2, Math.min(info.width, info.height));
    const side = Math.sqrt(pixels / aspect);
    return { shortSide: side < current.shortSide * 0.9 ? Math.max(144, Math.floor(side / 2) * 2) : current.shortSide };
}

async function encodeAudio(job: Job, bin: string, info: MediaInfo, target: number, opts: JobOptions): Promise<JobResult> {
    const out = join(job.dir, "out.ogg");
    let plan = planAudio(info, target);
    if (!plan.ok) throw new Error(plan.reason);
    for (let attempt = 0; attempt < 3; attempt++) {
        job.phase = attempt ? "Getting the size just right" : "Shrinking audio";
        await ffmpeg(job, bin, [
            "-i", job.input, "-map", "0:a:0", "-vn", "-c:a", "libopus", "-b:a", `${plan.kbps}k`, "-ac", String(plan.channels),
            ...(opts.keepMetadata ? [] : ["-map_metadata", "-1"]), out
        ], info.duration, attemptRange(attempt).from, attemptRange(attempt).span);
        const { size } = await stat(out);
        if (size <= target) {
            job.output = out;
            return { size, ext: "ogg", mime: "audio/ogg", note: "" };
        }
        plan = { ...plan, kbps: correctKbps(plan.kbps, target, size) };
        if (plan.kbps < 6) break;
    }
    throw new Error("It wouldn't fit under the limit. Trim it first.");
}

async function encodeGif(job: Job, bin: string, info: MediaInfo, target: number): Promise<JobResult> {
    const out = join(job.dir, "out.gif");
    const inputSize = (await stat(job.input)).size;
    let step: GifStep | null = firstGifStep(inputSize, target, info.fps);
    for (let attempt = 0; step && attempt < 8; attempt++) {
        job.phase = attempt ? "Getting the size just right" : "Shrinking GIF";
        const width = Math.max(16, Math.floor(info.width * step.scale / 2) * 2);
        const fps = info.fps > 0 && step.fps < info.fps - 0.5 ? `fps=${step.fps},` : "";
        await ffmpeg(job, bin, [
            "-i", job.input,
            "-filter_complex", `[0:v]${fps}scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${step.colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
            "-map_metadata", "-1", out
        ], info.duration, attemptRange(attempt).from, attemptRange(attempt).span);
        const { size } = await stat(out);
        if (size <= target) {
            job.output = out;
            return { size, ext: "gif", mime: "image/gif", note: `${width}px wide` };
        }
        step = nextGifStep(step, target, size);
    }
    throw new Error("This GIF wouldn't fit under the limit. Turn on \"GIFs as video\" in the settings and try again.");
}

export async function runJob(_: IpcMainInvokeEvent, id: string, kind: Kind, target: number, opts: JobOptions): Promise<JobResult> {
    const job = getJob(id);
    const bin = await ffmpegPath();
    if (!bin) throw new Error("The video tool isn't installed yet.");
    job.phase = "Reading file";
    const info = await probe(job, bin);
    if (job.cancelled) throw new Error("Cancelled");
    if (kind === "video" && !info.hasVideo && info.hasAudio) kind = "audio";
    if (!info.duration || (kind !== "audio" && !info.hasVideo) || (kind === "audio" && !info.hasAudio))
        throw new Error(DAMAGED);

    try {
        if (kind === "audio") return await encodeAudio(job, bin, info, target, opts);
        if (kind === "gif" && !opts.gifToVideo) return await encodeGif(job, bin, info, target);
        return await encodeVideo(job, bin, info, target, opts, kind === "video", kind === "gif");
    } catch (e) {
        friendly(e);
    }
}
