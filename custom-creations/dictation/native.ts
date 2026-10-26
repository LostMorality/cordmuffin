/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import { type ChildProcess, execFile, spawn } from "child_process";
import { app, type IpcMainInvokeEvent } from "electron";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { createServer } from "net";
import { cpus, totalmem } from "os";
import { dirname, join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

const ROOT = join(DATA_DIR, "dictation");
const PLATFORM = `${process.platform}-${process.arch}`;
const IS_WIN = process.platform === "win32";
const SAMPLE_RATE = 16000;
const IDLE_MS = 5 * 60_000;
const CORES = Math.max(1, Math.floor(cpus().length / 2));
const RAM_GB = totalmem() / 1024 ** 3;

const SHERPA_VERSION = "v2.0.0";
const SHERPA_BUILDS: Record<string, string> = {
    "win32-x64": "win-x64-shared-MD-Release-no-tts",
    "win32-arm64": "win-arm64-shared-MD-Release-no-tts",
    "linux-x64": "linux-x64-shared-no-tts",
    "linux-arm64": "linux-aarch64-shared-cpu",
    "darwin-x64": "osx-universal2-shared-no-tts",
    "darwin-arm64": "osx-universal2-shared-no-tts",
};
const SHERPA_DIR = SHERPA_BUILDS[PLATFORM] && `sherpa-onnx-${SHERPA_VERSION}-${SHERPA_BUILDS[PLATFORM]}`;

const LLAMA_VERSION = "b11881";
const LLAMA_BUILDS: Record<string, string> = {
    "win32-x64": "win-vulkan-x64.zip",
    "win32-arm64": "win-vulkan-arm64.zip",
    "linux-x64": "ubuntu-vulkan-x64.tar.gz",
    "linux-arm64": "ubuntu-vulkan-arm64.tar.gz",
    "darwin-x64": "macos-x64.tar.gz",
    "darwin-arm64": "macos-arm64.tar.gz",
};
const LLAMA_DIR = `llama-${LLAMA_VERSION}`;

export type SpeechModel = "cohere" | "parakeet";
export type Download = "cohere" | "parakeet" | "grammar";

const SPEECH: Record<SpeechModel, { dir: string; sizeMb: number; args(dir: string): string[]; }> = {
    cohere: {
        dir: "sherpa-onnx-cohere-transcribe-14-lang-int8-2026-04-01",
        sizeMb: 1621,
        args: dir => [
            `--cohere-transcribe-encoder=${join(dir, "encoder.int8.onnx")}`,
            `--cohere-transcribe-decoder=${join(dir, "decoder.int8.onnx")}`,
            `--tokens=${join(dir, "tokens.txt")}`,
            "--cohere-transcribe-language=en",
            "--cohere-transcribe-use-punct=true",
            "--cohere-transcribe-use-itn=true",
        ],
    },
    parakeet: {
        dir: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
        sizeMb: 460,
        args: dir => [
            `--encoder=${join(dir, "encoder.int8.onnx")}`,
            `--decoder=${join(dir, "decoder.int8.onnx")}`,
            `--joiner=${join(dir, "joiner.int8.onnx")}`,
            `--tokens=${join(dir, "tokens.txt")}`,
            "--model-type=nemo_transducer",
        ],
    },
};

const GRAMMAR = {
    large: {
        file: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        sizeMb: 2381,
    },
    small: {
        file: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
        url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
        sizeMb: 1066,
    },
};

const GRAMMAR_PROMPT = [
    "You fix dictated text. Correct grammar, punctuation (especially commas), capitalization, spelling and apostrophes.",
    "Keep the speaker's words, meaning, tone and slang as much as possible. Do not add, remove or reorder ideas, and never answer or comment on the text.",
    "Reply with the corrected text only.",
].join(" ");

interface Engine {
    key: string;
    port: number;
    proc: ChildProcess;
    ready: Promise<void>;
    idle?: NodeJS.Timeout;
}

let download: { label: string; received: number; total: number; } | null = null;
let installing: Promise<void> | null = null;
let speech: Engine | null = null;
let grammar: Engine | null = null;
let gpuVendors: Promise<number[]> | null = null;

const ready = (dir: string) => existsSync(join(ROOT, dir, ".ready"));
const exe = (name: string) => IS_WIN ? `${name}.exe` : name;

function findFile(dir: string, name: string): string | null {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (entry === name) return path;
        if (statSync(path).isDirectory()) {
            const found = findFile(path, name);
            if (found) return found;
        }
    }
    return null;
}

function hasStrongGpu() {
    gpuVendors ??= app.getGPUInfo("basic")
        .then(info => ((info as { gpuDevice?: { vendorId: number; }[]; }).gpuDevice ?? []).map(d => d.vendorId))
        .catch(() => []);
    return gpuVendors.then(v => v.includes(0x10de) || v.includes(0x1002) || PLATFORM === "darwin-arm64");
}

async function grammarTier() {
    return RAM_GB >= 8 && (CORES >= 4 || await hasStrongGpu()) ? "large" : "small";
}

export function recommendedSpeechModel(): SpeechModel {
    return RAM_GB >= 8 && CORES >= 4 ? "cohere" : "parakeet";
}

function assertSpeech(model: string): asserts model is SpeechModel {
    if (!(model in SPEECH)) throw new Error(`Unknown model: ${model}`);
}

export async function getStatus(_: IpcMainInvokeEvent, model: string) {
    assertSpeech(model);
    const engineMb = SHERPA_DIR && ready(SHERPA_DIR) ? 0 : 30;
    const llamaMb = ready(LLAMA_DIR) ? 0 : 60;
    const tier = GRAMMAR[await grammarTier()];
    return {
        supported: !!SHERPA_DIR,
        grammarSupported: !!LLAMA_BUILDS[PLATFORM],
        speechInstalled: !!SHERPA_DIR && ready(SHERPA_DIR) && ready(SPEECH[model].dir),
        speechSizeMb: SPEECH[model].sizeMb + engineMb,
        grammarInstalled: ready(LLAMA_DIR) && ready(tier.file + ".d"),
        grammarSizeMb: tier.sizeMb + llamaMb,
        download: download && { ...download },
    };
}

async function fetchTo(url: string, label: string, file: string) {
    const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Dictation" } });
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`);
    download = { label, received: 0, total: Number(res.headers.get("content-length")) || 0 };
    const body = Readable.fromWeb(res.body as ReadableStream<Uint8Array> as import("stream/web").ReadableStream<Uint8Array>);
    body.on("data", (chunk: Buffer) => { if (download) download.received += chunk.length; });
    await pipeline(body, createWriteStream(file));
    download = { label, received: 0, total: 0 };
}

async function fetchArchive(url: string, label: string, dir: string, into = ROOT) {
    const archive = join(ROOT, `${dir}.part`);
    await fetchTo(url, label, archive);
    rmSync(join(ROOT, dir), { recursive: true, force: true });
    mkdirSync(into, { recursive: true });

    const tar = IS_WIN ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
    await new Promise<void>((resolve, reject) => {
        const proc = spawn(tar, ["-xf", archive, "-C", into], { windowsHide: true });
        let err = "";
        proc.stderr.on("data", d => err += d);
        proc.on("error", reject);
        proc.on("close", code => code === 0 ? resolve() : reject(new Error(`Unpacking failed: ${err.trim() || code}`)));
    }).finally(() => rmSync(archive, { force: true }));
    writeFileSync(join(ROOT, dir, ".ready"), "");
}

export function install(_: IpcMainInvokeEvent, what: string) {
    if (what !== "grammar") assertSpeech(what);

    installing ??= (async () => {
        mkdirSync(ROOT, { recursive: true });
        try {
            if (what === "grammar") {
                if (!LLAMA_BUILDS[PLATFORM]) throw new Error("Grammar fixing isn't available on this kind of computer.");
                if (!ready(LLAMA_DIR)) {
                    const url = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}/llama-${LLAMA_VERSION}-bin-${LLAMA_BUILDS[PLATFORM]}`;
                    await fetchArchive(url, "grammar engine", LLAMA_DIR, join(ROOT, LLAMA_DIR));
                }
                const tier = GRAMMAR[await grammarTier()];
                if (!ready(tier.file + ".d")) {
                    const dir = join(ROOT, tier.file + ".d");
                    rmSync(dir, { recursive: true, force: true });
                    mkdirSync(dir, { recursive: true });
                    await fetchTo(tier.url, "grammar model", join(dir, `${tier.file}.part`));
                    renameSync(join(dir, `${tier.file}.part`), join(dir, tier.file));
                    writeFileSync(join(dir, ".ready"), "");
                }
            } else {
                if (!SHERPA_DIR) throw new Error("Dictation isn't available on this kind of computer yet.");
                if (!ready(SHERPA_DIR)) await fetchArchive(`https://github.com/k2-fsa/sherpa-onnx/releases/download/${SHERPA_VERSION}/${SHERPA_DIR}.tar.bz2`, "speech engine", SHERPA_DIR);
                if (!ready(SPEECH[what].dir)) await fetchArchive(`https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${SPEECH[what].dir}.tar.bz2`, "speech model", SPEECH[what].dir);
            }
        } finally {
            download = null;
            installing = null;
        }
    })();

    return installing;
}

function freePort() {
    return new Promise<number>((resolve, reject) => {
        const srv = createServer();
        srv.unref();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const { port } = srv.address() as { port: number; };
            srv.close(() => resolve(port));
        });
    });
}

function stopEngine(engine: Engine | null) {
    if (!engine) return;
    clearTimeout(engine.idle);
    engine.proc.kill();
    if (speech === engine) speech = null;
    if (grammar === engine) grammar = null;
}

function touch(engine: Engine) {
    clearTimeout(engine.idle);
    engine.idle = setTimeout(() => stopEngine(engine), IDLE_MS);
}

function launch(key: string, name: string, file: string, args: (port: number) => string[], probe: (port: number) => Promise<boolean>) {
    return freePort().then(port => {
        const libDir = join(dirname(file), "..", "lib");
        const libPath = [dirname(file), libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
        const proc = spawn(file, args(port), {
            cwd: dirname(file),
            windowsHide: true,
            stdio: ["ignore", "ignore", "pipe"],
            env: { ...process.env, LD_LIBRARY_PATH: libPath, DYLD_LIBRARY_PATH: libPath },
        });

        let stderr = "";
        proc.stderr?.on("data", d => stderr = (stderr + d).slice(-4000));
        const exited = new Promise<never>((_, reject) => {
            proc.on("error", reject);
            proc.on("exit", code => reject(new Error(`The ${name} stopped (code ${code}). ${stderr.trim().split("\n").slice(-2).join(" ")}`)));
        });
        exited.catch(() => { });

        const engine: Engine = {
            key,
            port,
            proc,
            ready: (async () => {
                const deadline = Date.now() + 180_000;
                while (Date.now() < deadline) {
                    if (await Promise.race([probe(port).catch(() => false), exited])) return;
                    await new Promise(r => setTimeout(r, 300));
                }
                proc.kill();
                throw new Error(`The ${name} took too long to start.`);
            })(),
        };
        proc.on("exit", () => {
            if (speech === engine) speech = null;
            if (grammar === engine) grammar = null;
        });
        touch(engine);
        return engine;
    });
}

function openSocket(port: number) {
    return new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.binaryType = "arraybuffer";
        ws.onopen = () => resolve(ws);
        ws.onerror = () => reject(new Error("connect failed"));
    });
}

let speechStarting: { model: SpeechModel; promise: Promise<Engine>; } | null = null;

// Live previews and the warm up can ask at the same time, so they share one start.
function startSpeech(model: SpeechModel) {
    if (speechStarting?.model !== model) {
        if (speech?.key === model) return Promise.resolve(speech);
        const promise = launchSpeech(model).finally(() => {
            if (speechStarting?.promise === promise) speechStarting = null;
        });
        speechStarting = { model, promise };
    }
    return speechStarting.promise;
}

async function launchSpeech(model: SpeechModel) {
    stopEngine(speech);
    if (!SHERPA_DIR || !ready(SHERPA_DIR) || !ready(SPEECH[model].dir)) throw new Error("The speech model isn't downloaded yet.");

    const file = join(ROOT, SHERPA_DIR, "bin", exe("sherpa-onnx-offline-websocket-server"));
    const engine = await launch(model, "speech engine", file, port => [
        ...SPEECH[model].args(join(ROOT, SPEECH[model].dir)),
        `--port=${port}`,
        `--num-threads=${Math.max(2, Math.min(8, CORES))}`,
        "--num-work-threads=1",
        "--max-batch-size=1",
    ], port => openSocket(port).then(ws => (ws.close(), true)));
    speech = engine;
    await engine.ready.catch(e => {
        stopEngine(engine);
        throw e;
    });
    return engine;
}

function listGpus(file: string) {
    return new Promise<{ name: string; freeMb: number; }[]>(resolve => {
        execFile(file, ["--list-devices"], { cwd: dirname(file), windowsHide: true, timeout: 30_000 }, (_, stdout, stderr) => {
            const devices = [...`${stdout}\n${stderr}`.matchAll(/^\s*((?:Vulkan|Metal|CUDA)\d*):.*?\((\d+) MiB, (\d+) MiB free\)/gm)];
            resolve(devices.map(m => ({ name: m[1], freeMb: Number(m[3]) })));
        });
    });
}

async function startGrammar() {
    const tier = GRAMMAR[await grammarTier()];
    if (grammar?.key === tier.file) return grammar;
    stopEngine(grammar);
    if (!ready(LLAMA_DIR) || !ready(tier.file + ".d")) throw new Error("The grammar model isn't downloaded yet.");

    const file = findFile(join(ROOT, LLAMA_DIR), exe("llama-server"));
    if (!file) throw new Error("The grammar engine files are missing. Turn grammar fixing off and on to download them again.");

    const gpu = (await listGpus(file)).sort((a, b) => b.freeMb - a.freeMb)[0];
    const useGpu = gpu && gpu.freeMb >= tier.sizeMb + 1024;
    const base = [
        "-m", join(ROOT, tier.file + ".d", tier.file),
        "--host", "127.0.0.1",
        "-c", "2048",
        "-t", String(Math.max(2, Math.min(16, CORES))),
    ];
    const probe = (port: number) => fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok);

    let engine = await launch(tier.file, "grammar engine", file, port => [...base, "--port", String(port), ...useGpu ? ["--device", gpu.name, "-ngl", "999"] : ["--device", "none", "-ngl", "0"]], probe);
    grammar = engine;
    try {
        await engine.ready;
    } catch (e) {
        stopEngine(engine);
        if (!useGpu) throw e;
        engine = await launch(tier.file, "grammar engine", file, port => [...base, "--port", String(port), "--device", "none", "-ngl", "0"], probe);
        grammar = engine;
        await engine.ready.catch(err => {
            stopEngine(engine);
            throw err;
        });
    }
    return engine;
}

export async function warmUp(_: IpcMainInvokeEvent, model: string, withGrammar: boolean) {
    assertSpeech(model);
    await Promise.all([startSpeech(model), withGrammar && startGrammar()]);
}

async function decode(port: number, samples: Float32Array) {
    const ws = await openSocket(port);
    try {
        const header = new Uint8Array(8);
        const view = new DataView(header.buffer);
        view.setInt32(0, SAMPLE_RATE, true);
        view.setInt32(4, samples.byteLength, true);
        const body = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);

        const reply = new Promise<string>((resolve, reject) => {
            ws.onmessage = ev => resolve(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8"));
            ws.onclose = () => reject(new Error("The speech engine closed the connection."));
            ws.onerror = () => reject(new Error("The speech engine connection failed."));
        });

        const payload = new Uint8Array(header.length + body.length);
        payload.set(header, 0);
        payload.set(body, header.length);
        const CHUNK = 1 << 16;
        for (let i = 0; i < payload.length; i += CHUNK) ws.send(payload.subarray(i, i + CHUNK));

        const raw = await reply;
        ws.send("Done");
        try {
            const parsed = JSON.parse(raw);
            return typeof parsed?.text === "string" ? parsed.text : raw;
        } catch {
            return raw;
        }
    } finally {
        ws.onclose = null;
        ws.close();
    }
}

function splitAtPauses(samples: Float32Array, maxSec = 25, minSec = 12) {
    const pieces: Float32Array[] = [];
    const win = SAMPLE_RATE / 10;
    let start = 0;

    while (samples.length - start > maxSec * SAMPLE_RATE) {
        let best = start + maxSec * SAMPLE_RATE;
        let bestEnergy = Infinity;
        for (let pos = start + minSec * SAMPLE_RATE; pos + win <= start + maxSec * SAMPLE_RATE; pos += win / 2) {
            let energy = 0;
            for (let i = pos; i < pos + win; i++) energy += samples[i] * samples[i];
            if (energy < bestEnergy) {
                bestEnergy = energy;
                best = pos + win / 2;
            }
        }
        pieces.push(samples.subarray(start, best));
        start = best;
    }
    pieces.push(samples.subarray(start));
    return pieces;
}

export async function transcribe(_: IpcMainInvokeEvent, model: string, samples: Float32Array) {
    assertSpeech(model);
    if (!(samples instanceof Float32Array)) throw new Error("Bad audio data.");
    if (samples.length < SAMPLE_RATE / 4) return "";

    const engine = await startSpeech(model);
    const parts: string[] = [];
    for (const piece of splitAtPauses(samples)) {
        const text = (await decode(engine.port, piece)).trim();
        if (text) parts.push(text);
    }
    touch(engine);
    return parts.join(" ").replace(/\s+/g, " ").trim();
}

export async function fixGrammar(_: IpcMainInvokeEvent, text: string) {
    if (typeof text !== "string" || !text.trim() || text.length > 20_000) return text;

    const engine = await startGrammar();
    const res = await fetch(`http://127.0.0.1:${engine.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
            temperature: 0,
            max_tokens: Math.ceil(text.length / 2) + 64,
            messages: [
                { role: "system", content: GRAMMAR_PROMPT },
                { role: "user", content: text },
            ],
        }),
    });
    touch(engine);
    if (!res.ok) throw new Error(`The grammar engine answered ${res.status}.`);

    const out = ((await res.json()) as { choices?: { message?: { content?: string; }; }[]; }).choices?.[0]?.message?.content ?? "";
    const cleaned = out.replace(/<think>[\s\S]*?<\/think>/g, "").trim().replace(/^"([\s\S]*)"$/, "$1").replace(/\s*[—–]\s*/g, ", ").trim();
    if (!cleaned || cleaned.length > text.length * 1.5 + 20 || cleaned.length < text.length * 0.6) return text;
    return cleaned;
}

export function unload() {
    stopEngine(speech);
    stopEngine(grammar);
}

app.on("before-quit", unload);
