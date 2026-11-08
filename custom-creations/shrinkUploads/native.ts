/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import { type ChildProcess, execFile, spawn } from "child_process";
import { createHash, randomUUID } from "crypto";
import { app, type IpcMainInvokeEvent, type WebContents } from "electron";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { appendFile, open, stat } from "fs/promises";
import { setPriority, tmpdir } from "os";
import { join } from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { createGunzip } from "zlib";

import { correctKbps, firstGifStep, type GifStep, type MediaInfo, nextGifStep, parseProbe, planAudio, planVideo, seconds } from "./plan";

const ROOT = join(DATA_DIR, "shrinkUploads");
const BIN = join(ROOT, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const READY = join(ROOT, "ffmpeg.ready");
const WORK = join(tmpdir(), "shrink-uploads");
const NULL_OUT = process.platform === "win32" ? "NUL" : "/dev/null";

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
}

const jobs = new Map<string, Job>();
const watched = new WeakSet<WebContents>();
let system: Promise<string | null> | null = null;
let installing: Promise<void> | null = null;
let download: { received: number; total: number; } | null = null;
let installError = "";

function run(file: string, args: string[], job?: Job) {
    return new Promise<{ code: number; out: string; err: string; }>(resolve => {
        const child = execFile(file, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, out, err) => {
            if (job) job.proc = undefined;
            resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, out, err });
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
    const { out } = await run(file, ["-hide_banner", "-encoders"]);
    return /\blibx264\b/.test(out) && /\blibopus\b/.test(out) ? file : null;
}

async function ffmpegPath() {
    if (existsSync(READY) && existsSync(BIN)) return BIN;
    system ??= capable("ffmpeg");
    return system;
}

export async function getTools(_: IpcMainInvokeEvent) {
    const path = await ffmpegPath();
    return {
        ready: path != null,
        source: path == null ? null : path === BIN ? "downloaded" : "system",
        supported: BUILD != null,
        sizeMb: BUILD?.mb ?? 0,
        installing: installing != null,
        download,
        error: installError,
    };
}

async function fetchBinary() {
    if (!BUILD) throw new Error("There is no ready made ffmpeg for this system. Install ffmpeg yourself and restart Discord.");
    mkdirSync(ROOT, { recursive: true });
    const res = await fetch(RELEASE + BUILD.file, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`);

    download = { received: 0, total: Number(res.headers.get("content-length")) || BUILD.mb * 1024 * 1024 };
    const hash = createHash("sha256");
    const meter = new Transform({
        transform(chunk: Buffer, _enc, done) {
            hash.update(chunk);
            if (download) download.received += chunk.length;
            done(null, chunk);
        }
    });
    const partial = `${BIN}.${process.pid}.${randomUUID()}.part`;
    try {
        await pipeline(Readable.fromWeb(res.body as import("stream/web").ReadableStream<Uint8Array>), meter, createGunzip(), createWriteStream(partial));
        if (hash.digest("hex") !== BUILD.sha256) throw new Error("The download did not match the expected checksum, so it was thrown away.");
        if (process.platform !== "win32") chmodSync(partial, 0o755);
        try {
            renameSync(partial, BIN);
        } catch (e) {
            if (!existsSync(READY)) throw e;
        }
        if (!await capable(BIN)) throw new Error("The downloaded ffmpeg does not run on this system.");
        writeFileSync(READY, BUILD.sha256);
    } catch (e) {
        rmSync(partial, { force: true });
        throw e;
    }
}

export function installTools(_: IpcMainInvokeEvent) {
    installError = "";
    installing ??= fetchBinary()
        .catch(e => { installError = String(e?.message ?? e); throw e; })
        .finally(() => { installing = null; download = null; });
    return installing;
}

export function removeTools(_: IpcMainInvokeEvent) {
    rmSync(READY, { force: true });
    rmSync(BIN, { force: true });
    system = null;
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

export function startJob(e: IpcMainInvokeEvent, name: string) {
    sweep();
    watch(e.sender);
    const id = randomUUID();
    const dir = join(WORK, id);
    mkdirSync(dir, { recursive: true });
    const ext = (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? "bin").toLowerCase();
    jobs.set(id, { owner: e.sender.id, dir, input: join(dir, `in.${ext}`), cancelled: false, phase: "Reading file", percent: 0 });
    return id;
}

function getJob(id: string) {
    const job = jobs.get(id);
    if (!job) throw new Error("This shrink job no longer exists.");
    return job;
}

export function writeChunk(_: IpcMainInvokeEvent, id: string, data: Uint8Array) {
    return appendFile(getJob(id).input, data);
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
            if (m && duration > 0) job.percent = Math.min(99, from + span * Math.min(1, Number(m[1]) / 1e6 / duration));
        });
        proc.on("error", reject);
        proc.on("close", code => {
            job.proc = undefined;
            if (job.cancelled) reject(new Error("Cancelled"));
            else if (code === 0) resolve();
            else reject(new Error(tail.trim().split(/\r?\n/).filter(l => !/^\s*$/.test(l)).slice(-2).join(" ") || `ffmpeg exited with code ${code}`));
        });
    });
}

async function probe(job: Job, bin: string) {
    const info = parseProbe((await run(bin, ["-hide_banner", "-i", job.input], job)).err);
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

async function encodeVideo(job: Job, bin: string, info: MediaInfo, target: number, opts: JobOptions, withAudio: boolean): Promise<JobResult> {
    const out = join(job.dir, "out.mp4");
    const log = join(job.dir, "pass");
    let plan = planVideo({ ...info, hasAudio: withAudio && info.hasAudio }, target, opts.maxFps);
    if (!plan.ok) throw new Error(plan.reason);
    let kbps = plan.videoKbps;
    let best: { path: string; size: number; note: string; } | null = null;
    let raised = false;

    for (let attempt = 0; attempt < 3; attempt++) {
        const filters = [scaleFilter(info, plan.shortSide)];
        if (info.fps > 0 && plan.fps < info.fps - 0.5) filters.unshift(`fps=${plan.fps}`);
        const base = [
            "-i", job.input, "-map", "0:v:0",
            "-vf", [...filters, "format=yuv420p"].join(","),
            "-c:v", "libx264", "-preset", SPEED[opts.speed], "-b:v", `${kbps}k`, "-profile:v", "high",
            "-passlogfile", log,
            ...(opts.keepMetadata ? [] : ["-map_metadata", "-1"]),
        ];
        job.phase = attempt ? "Fine tuning size (pass 1 of 2)" : "Analyzing video";
        await ffmpeg(job, bin, [...base, "-pass", "1", "-an", "-f", "null", NULL_OUT], info.duration, 0, 40);
        job.phase = attempt ? "Fine tuning size (pass 2 of 2)" : "Encoding video";
        const audio = plan.audioKbps > 0 ? ["-map", "0:a:0", "-c:a", "aac", "-b:a", `${plan.audioKbps}k`, "-ac", String(plan.audioChannels)] : ["-an"];
        await ffmpeg(job, bin, [...base, "-pass", "2", ...audio, "-movflags", "+faststart", out], info.duration, 40, 60);

        const { size } = await stat(out);
        const note = `${plan.shortSide}p ${Math.round(plan.fps)} fps`;
        if (size <= target && (!best || size > best.size)) {
            const kept = join(job.dir, `best${attempt}.mp4`);
            renameSync(out, kept);
            best = { path: kept, size, note };
        }
        if (best?.size === size && size >= target * 0.9) break;
        const next = Math.floor(kbps - (size - target * 0.98) * 8 / 1000 / info.duration);
        if (size <= target && (raised || next <= kbps * 1.03)) break;
        if (next < 40) break;
        raised ||= next > kbps;
        kbps = next;
        plan = { ...plan, ...planForKbps(info, kbps, plan) };
    }

    if (!best) throw new Error("Could not get it under the limit. Trim it or try again with a smaller target.");
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
        job.phase = attempt ? "Fine tuning size" : "Encoding audio";
        await ffmpeg(job, bin, [
            "-i", job.input, "-map", "0:a:0", "-vn", "-c:a", "libopus", "-b:a", `${plan.kbps}k`, "-ac", String(plan.channels),
            ...(opts.keepMetadata ? [] : ["-map_metadata", "-1"]), out
        ], info.duration, 0, 100);
        const { size } = await stat(out);
        if (size <= target) {
            job.output = out;
            return { size, ext: "ogg", mime: "audio/ogg", note: `${plan.kbps} kbps` };
        }
        plan = { ...plan, kbps: correctKbps(plan.kbps, target, size) };
        if (plan.kbps < 6) break;
    }
    throw new Error("Could not get it under the limit. Trim it first.");
}

async function encodeGif(job: Job, bin: string, info: MediaInfo, target: number): Promise<JobResult> {
    const out = join(job.dir, "out.gif");
    const inputSize = (await stat(job.input)).size;
    let step: GifStep | null = firstGifStep(inputSize, target, info.fps);
    for (let attempt = 0; step && attempt < 8; attempt++) {
        job.phase = `Rebuilding GIF (try ${attempt + 1})`;
        const width = Math.max(16, Math.floor(info.width * step.scale / 2) * 2);
        const fps = info.fps > 0 && step.fps < info.fps - 0.5 ? `fps=${step.fps},` : "";
        await ffmpeg(job, bin, [
            "-i", job.input,
            "-filter_complex", `[0:v]${fps}scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${step.colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
            "-map_metadata", "-1", out
        ], info.duration, 0, 100);
        const { size } = await stat(out);
        if (size <= target) {
            job.output = out;
            return { size, ext: "gif", mime: "image/gif", note: `${width}px wide` };
        }
        step = nextGifStep(step, target, size);
    }
    throw new Error("Could not get this GIF under the limit. Try turning on GIF to video.");
}

export async function runJob(_: IpcMainInvokeEvent, id: string, kind: Kind, target: number, opts: JobOptions): Promise<JobResult> {
    const job = getJob(id);
    const bin = await ffmpegPath();
    if (!bin) throw new Error("Video tools are not installed yet.");
    job.phase = "Reading file";
    const info = await probe(job, bin);
    if (job.cancelled) throw new Error("Cancelled");
    if (kind === "video" && !info.hasVideo && info.hasAudio) kind = "audio";
    if (!info.duration || (kind !== "audio" && !info.hasVideo) || (kind === "audio" && !info.hasAudio))
        throw new Error("This file could not be read as media.");

    if (kind === "audio") return encodeAudio(job, bin, info, target, opts);
    if (kind === "gif" && !opts.gifToVideo) return encodeGif(job, bin, info, target);
    return encodeVideo(job, bin, info, target, opts, kind === "video");
}
