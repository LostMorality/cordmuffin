/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, type PluginNative } from "@utils/types";
import type { Channel, CloudUpload, RenderModalProps } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { Alerts, ChannelStore, createRoot, Modal, openModal, SelectedGuildStore, TextInput, UploadAttachmentStore, UploadHandler, UploadManager, useEffect, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { type ImageFormat, isAnimatedStill, shrinkImage } from "./image";
import { describeLimit, getUploadLimit } from "./limits";
import { formatBytes } from "./plan";

const Native = VencordNative.pluginHelpers.ShrinkUploads as PluginNative<typeof import("./native")> | undefined;
const ActionBarIcon = findByCodeLazy("Children.map", "isValidElement", "dangerous:");
const cl = classNameFactory("vc-shrink-");
const logger = new Logger("ShrinkUploads");
const MB = 1024 * 1024;
const CHUNK = 8 * MB;

const settings = definePluginSettings({
    status: {
        type: OptionType.COMPONENT,
        component: () => <StatusCard />,
    },
    whenTooBig: {
        type: OptionType.SELECT,
        displayName: "When a file is too big",
        description: "What to do when a file is over your upload limit.",
        options: [
            { label: "Shrink it automatically", value: "auto", default: true },
            { label: "Ask me first", value: "ask" },
            { label: "Do nothing", value: "off" },
        ],
    },
    shrinkButton: {
        type: OptionType.BOOLEAN,
        displayName: "Shrink button",
        description: "Show a Shrink button on files waiting to be sent.",
        default: true,
    },
    speed: {
        type: OptionType.SELECT,
        displayName: "Video speed",
        description: "Video encoding speed. Slower looks better.",
        options: [
            { label: "Fast", value: "fast" },
            { label: "Balanced", value: "balanced", default: true },
            { label: "Best quality (slow)", value: "best" },
        ],
    },
    maxFps: {
        type: OptionType.SELECT,
        displayName: "Video frame rate",
        description: "Highest frame rate for shrunk videos.",
        options: [
            { label: "60 fps", value: 60, default: true },
            { label: "30 fps", value: 30 },
        ],
    },
    imageFormat: {
        type: OptionType.SELECT,
        displayName: "Picture format",
        description: "Format for shrunk pictures.",
        options: [
            { label: "Automatic", value: "auto", default: true },
            { label: "WebP", value: "webp" },
            { label: "JPEG", value: "jpeg" },
        ],
    },
    gifToVideo: {
        type: OptionType.BOOLEAN,
        displayName: "GIFs as video",
        description: "Turn big GIFs into small videos instead of smaller GIFs.",
        default: false,
    },
    keepMetadata: {
        type: OptionType.BOOLEAN,
        displayName: "Keep file info",
        description: "Keep hidden file info like location and camera details.",
        default: false,
    },
    autoDownload: {
        type: OptionType.BOOLEAN,
        displayName: "Get the video tool automatically",
        description: "Download the free video tool (ffmpeg) the first time it is needed.",
        default: true,
    },
});

type Kind = "image" | "gif" | "video" | "audio";

const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|wmv|flv|3gp|ts|mts|m2ts|mpe?g|ogv)$/i;
const AUDIO_EXT = /\.(mp3|wav|flac|m4a|aac|ogg|oga|opus|wma|aiff?|alac|amr)$/i;
const IMAGE_EXT = /\.(jpe?g|jfif|png|webp|bmp|avif)$/i;

function kindOf(file: File): Kind | null {
    const { type, name } = file;
    if (type === "image/gif" || /\.gif$/i.test(name)) return Native ? "gif" : null;
    if (/^image\/(jpeg|png|webp|bmp|avif)$/.test(type) || IMAGE_EXT.test(name)) return "image";
    if (type.startsWith("video/") || VIDEO_EXT.test(name)) return Native ? "video" : null;
    if (type.startsWith("audio/") || AUDIO_EXT.test(name)) return Native ? "audio" : null;
    return null;
}

const targetFor = (limit: number) => Math.floor(limit * 0.985) - 4096;
const errorText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");

interface Job {
    id: number;
    name: string;
    phase: string;
    percent: number;
    state: "queued" | "working" | "done" | "failed";
    controller: AbortController;
    onFail?: () => void;
}

let jobs: Job[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const passThrough = new WeakSet<File>();
let queue = Promise.resolve();
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;

function emit() {
    jobs = [...jobs];
    listeners.forEach(l => l());
}

function update(job: Job, patch: Partial<Job>) {
    Object.assign(job, patch);
    emit();
}

function dismiss(job: Job, delay: number) {
    setTimeout(() => {
        jobs = jobs.filter(j => j !== job);
        emit();
    }, delay);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function ensureTools(job: Job) {
    if (!Native) throw new Error("Video and audio shrinking needs the desktop app.");
    let tools = await Native.getTools();
    if (tools.ready) return;
    if (!tools.supported) throw new Error("There is no ready made video tool for this system. Install ffmpeg and restart Discord.");
    if (!settings.store.autoDownload && !tools.installing) throw new Error("The video tool is not installed. Get it in the ShrinkUploads settings.");

    const install = Native.installTools();
    let done = false;
    install.then(() => { done = true; }, () => { done = true; });
    while (!done) {
        tools = await Native.getTools();
        const d = tools.download;
        update(job, { phase: "Getting the video tool (one time only)", percent: d?.total ? Math.min(99, d.received / d.total * 100) : 0 });
        if (job.controller.signal.aborted) throw new Error("Cancelled");
        await sleep(400);
    }
    await install;
}

async function shrinkWithTools(file: File, kind: Exclude<Kind, "image">, target: number, job: Job) {
    if (!Native) throw new Error("Video and audio shrinking needs the desktop app.");
    await ensureTools(job);
    const { signal } = job.controller;
    const id = await Native.startJob(file.name);
    const onAbort = () => void Native.cancelJob(id);
    signal.addEventListener("abort", onAbort);
    try {
        for (let at = 0; at < file.size; at += CHUNK) {
            signal.throwIfAborted();
            update(job, { phase: "Reading file", percent: at / file.size * 100 });
            await Native.writeChunk(id, new Uint8Array(await file.slice(at, at + CHUNK).arrayBuffer()));
        }
        update(job, { phase: "Starting", percent: 0 });

        let finished = false;
        const work = Native.runJob(id, kind, target, {
            speed: settings.store.speed as "fast" | "balanced" | "best",
            maxFps: settings.store.maxFps,
            gifToVideo: settings.store.gifToVideo,
            keepMetadata: settings.store.keepMetadata,
        }).finally(() => { finished = true; });
        work.catch(() => { });
        while (!finished) {
            const p = await Native.getProgress(id);
            if (p && !finished) update(job, { phase: p.phase, percent: p.percent });
            await sleep(400);
        }
        const result = await work;
        signal.throwIfAborted();

        const parts: Uint8Array[] = [];
        for (let at = 0; at < result.size; at += CHUNK) {
            signal.throwIfAborted();
            update(job, { phase: "Finishing", percent: 99 });
            parts.push(await Native.readChunk(id, at, Math.min(CHUNK, result.size - at)));
        }
        return { blob: new Blob(parts as BlobPart[], { type: result.mime }), ext: result.ext, mime: result.mime, note: result.note };
    } finally {
        signal.removeEventListener("abort", onAbort);
        void Native.finishJob(id);
    }
}

async function shrink(file: File, target: number, job: Job): Promise<File> {
    const kind = kindOf(file);
    if (!kind) throw new Error("This kind of file can't be shrunk.");
    let out: { blob: Blob; ext: string; mime: string; note: string; };
    if (kind === "image") {
        if (await isAnimatedStill(file)) throw new Error("Animated WebP, PNG and AVIF pictures can't be shrunk yet.");
        out = await shrinkImage(file, target, settings.store.imageFormat as ImageFormat, job.controller.signal, text => update(job, { phase: text }));
    } else {
        out = await shrinkWithTools(file, kind, target, job);
    }
    job.controller.signal.throwIfAborted();
    if (out.blob.size > target) throw new Error("The result was still too big.");
    const base = file.name.replace(/\.[^.]+$/, "") || "file";
    update(job, { phase: `${formatBytes(file.size)} to ${formatBytes(out.blob.size)}${out.note ? ` (${out.note})` : ""}` });
    return new File([out.blob], `${base}.${out.ext}`, { type: out.mime, lastModified: Date.now() });
}

function mountPanel() {
    if (root) return;
    host = document.createElement("div");
    host.className = cl("host");
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(<Panel />);
}

function unmountPanel() {
    root?.unmount();
    host?.remove();
    root = null;
    host = null;
}

function enqueue(file: File, target: number, onDone: (out: File) => void, onFail?: () => void) {
    mountPanel();
    const job: Job = { id: nextId++, name: file.name, phase: "Waiting", percent: 0, state: "queued", controller: new AbortController(), onFail };
    jobs.push(job);
    emit();
    queue = queue.then(async () => {
        if (job.controller.signal.aborted) return;
        update(job, { state: "working", phase: "Starting" });
        try {
            const out = await shrink(file, target, job);
            update(job, { state: "done", percent: 100 });
            onDone(out);
            dismiss(job, 6000);
        } catch (e) {
            const cancelled = job.controller.signal.aborted;
            if (!cancelled) logger.error(`Could not shrink ${file.name}`, e);
            update(job, { state: "failed", phase: cancelled ? "Cancelled" : errorText(e) });
            onFail?.();
            dismiss(job, cancelled ? 1500 : 12000);
        }
    });
}

function cancel(job: Job) {
    const queued = job.state === "queued";
    job.controller.abort();
    if (!queued) return;
    update(job, { state: "failed", phase: "Cancelled" });
    job.onFail?.();
    dismiss(job, 1500);
}

function addFiles(files: File[], channel: Channel, draftType: number, metadata?: Map<File, unknown>, options?: PromptOptions) {
    if (!files.length) return Promise.resolve();
    files.forEach(f => passThrough.add(f));
    const filesMetadata = metadata && files.map(f => metadata.get(f));
    const prompt = UploadHandler.promptToUpload as (files: File[], channel: Channel, draftType: number, options?: PromptOptions) => Promise<void>;
    return prompt(files, channel, draftType, options && { ...options, filesMetadata }).catch(e => logger.error("Upload failed", e));
}

interface PromptOptions {
    filesMetadata?: unknown[];
    [key: string]: unknown;
}

function intercept(fileList: ArrayLike<File>, channel: Channel, draftType: number, options?: PromptOptions) {
    try {
        const files = Array.from(fileList);
        if (settings.store.whenTooBig === "off" || !files.length || files.every(f => passThrough.has(f))) return false;

        const limit = getUploadLimit(channel.guild_id);
        if (!limit) return false;
        const big = files.filter(f => !passThrough.has(f) && f.size > limit && kindOf(f));
        if (!big.length) return false;

        const metadata = options?.filesMetadata && new Map(files.map((f, i) => [f, options.filesMetadata?.[i]]));
        const small = files.filter(f => !big.includes(f));
        const run = () => {
            addFiles(small, channel, draftType, metadata, options);
            for (const file of big)
                enqueue(file, targetFor(limit), out => {
                    metadata?.set(out, metadata.get(file));
                    addFiles([out], channel, draftType, metadata, options);
                });
        };

        if (settings.store.whenTooBig === "ask") {
            let settled = false;
            const keepSmall = () => {
                if (settled) return;
                settled = true;
                addFiles(small, channel, draftType, metadata, options);
            };
            Alerts.show({
                title: big.length === 1 ? "File too big" : "Files too big",
                body: `${big.length === 1 ? `${big[0].name} is` : `${big.length} files are`} over your ${formatBytes(limit)} upload limit here. Shrink ${big.length === 1 ? "it" : "them"} on this computer so ${big.length === 1 ? "it fits" : "they fit"}?`,
                confirmText: "Shrink",
                cancelText: "Cancel",
                onConfirm: () => {
                    settled = true;
                    run();
                },
                onCancel: keepSmall,
                onCloseCallback: keepSmall,
            });
        } else run();
        return true;
    } catch (e) {
        logger.error("Could not check upload size", e);
        return false;
    }
}

function Panel() {
    const [list, setList] = useState(jobs);
    useEffect(() => {
        const l = () => setList(jobs);
        listeners.add(l);
        return () => void listeners.delete(l);
    }, []);
    if (!list.length) return null;

    return (
        <div className={cl("panel")}>
            {list.map(job => (
                <div key={job.id} className={cl("job")} data-state={job.state}>
                    <div className={cl("row")}>
                        <span className={cl("name")} title={job.name}>{job.name}</span>
                        {(job.state === "queued" || job.state === "working") && (
                            <Button size="min" variant="secondary" onClick={() => cancel(job)}>Cancel</Button>
                        )}
                    </div>
                    <div className={cl("phase")}>{job.phase}</div>
                    <div className={cl("track")}>
                        <div className={cl("fill")} style={{ width: `${Math.round(job.percent)}%` }} />
                    </div>
                </div>
            ))}
        </div>
    );
}

function StatusCard() {
    const guildId = SelectedGuildStore.getGuildId();
    const here = describeLimit(guildId);
    const dms = describeLimit(null);
    const [tools, setTools] = useState<Awaited<ReturnType<NonNullable<typeof Native>["getTools"]>> | null>(null);

    useEffect(() => {
        if (!Native) return;
        let alive = true;
        const tick = () => Native.getTools().then(t => alive && setTools(t));
        tick();
        const timer = setInterval(tick, 700);
        return () => { alive = false; clearInterval(timer); };
    }, []);

    let toolLine: ReactNode = "Pictures shrink right away. Videos, GIFs and audio need the desktop app.";
    if (Native && tools) {
        if (tools.installing) {
            const d = tools.download;
            toolLine = `Downloading the video tool${d?.total ? ` (${Math.round(d.received / d.total * 100)}%)` : ""}...`;
        } else if (tools.ready) {
            toolLine = tools.source === "system" ? "Video tool: using the ffmpeg already on this computer." : "Video tool: ready.";
        } else if (!tools.supported) {
            toolLine = "Video tool: none available for this system. Install ffmpeg to shrink videos.";
        } else {
            toolLine = `Video tool: not installed yet (${tools.sizeMb} MB, free).${tools.error ? ` Last try failed: ${tools.error}` : ""}`;
        }
    }

    return (
        <div className={cl("status")}>
            <div className={cl("limit")}>
                Your upload limit: <b>{formatBytes(dms.limit)}</b> ({dms.plan})
                {guildId && here.limit !== dms.limit && <> · this server: <b>{formatBytes(here.limit)}</b>{here.boosted ? " (boosted)" : ""}</>}
            </div>
            <div className={cl("tools")}>{toolLine}</div>
            {Native && tools && !tools.ready && tools.supported && !tools.installing && (
                <Button size="small" onClick={() => Native.installTools().catch(() => { })}>Download video tool</Button>
            )}
            {Native && tools?.source === "downloaded" && (
                <Button size="small" variant="secondary" onClick={() => Native.removeTools()}>Remove video tool</Button>
            )}
            <div className={cl("note")}>Everything is shrunk on this computer. Files are never uploaded anywhere except to Discord.</div>
        </div>
    );
}

function TargetModal({ upload, limit, onShrink, ...props }: RenderModalProps & { upload: CloudUpload; limit: number; onShrink(target: number): void; }) {
    const { size } = upload.item.file;
    const suggested = size > limit ? targetFor(limit) : Math.floor(size / 2);
    const [value, setValue] = useState(String(Math.floor(suggested / MB * 100) / 100));
    const mb = Number(value.trim().replace(",", "."));
    const bytes = Math.floor(mb * MB);
    const valid = Number.isFinite(mb) && bytes >= 64 * 1024 && bytes < size && bytes <= limit;
    const hint = valid ? "Smaller sizes mean lower quality." : `Enter a size in MB below ${formatBytes(Math.min(size, limit))}.`;

    return (
        <Modal
            {...props}
            size="sm"
            title="Shrink file"
            subtitle={`${upload.filename} is ${formatBytes(size)}. Your limit here is ${formatBytes(limit)}.`}
            actions={[{ text: "Shrink", variant: "primary", disabled: !valid, onClick: () => valid && onShrink(bytes) }]}
        >
            <TextInput value={value} onChange={setValue} placeholder="Target size in MB" />
            <div className={cl("hint")} data-invalid={!valid}>{hint}</div>
        </Modal>
    );
}

function restoreDetails(channelId: string, draftType: number, file: File, details: { spoiler: boolean; description: string | null; filename: string; }) {
    const added = UploadAttachmentStore.getUploads(channelId, draftType).find(u => u.item.file === file);
    if (!added) return;
    const ext = /\.[^.]+$/.exec(file.name)?.[0] ?? "";
    const filename = (details.filename.replace(/\.[^.]+$/, "") || "file") + ext;
    if (details.spoiler || details.description || filename !== added.filename)
        UploadManager.update(channelId, added.id, draftType, { spoiler: details.spoiler, description: details.description, filename });
}

interface ActionBarProps {
    upload: CloudUpload;
    channelId: string;
    draftType: number;
    canEdit?: boolean;
}

function ShrinkButton({ upload, channelId, draftType }: ActionBarProps) {
    const file = upload.item.platform === 1 ? upload.item.file : null;
    if (!file || !kindOf(file)) return null;

    const open = () => {
        const channel = ChannelStore.getChannel(channelId);
        const limit = getUploadLimit(channel?.guild_id);
        if (!channel || !limit) return;
        const details = { spoiler: upload.spoiler, description: upload.description, filename: upload.filename, clip: upload.clip };
        const readd = (next: File) => {
            const metadata = details.clip ? new Map<File, unknown>([[next, { clip: details.clip }]]) : undefined;
            addFiles([next], channel, draftType, metadata, metadata && {}).then(() => restoreDetails(channelId, draftType, next, details));
        };
        openModal(props => (
            <TargetModal {...props} upload={upload} limit={limit} onShrink={target => {
                props.onClose();
                UploadManager.remove(channelId, upload.id, draftType);
                enqueue(file, target, readd, () => readd(file));
            }} />
        ));
    };

    return (
        <ActionBarIcon tooltip="Shrink" onClick={open}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path fill="currentColor" d="M5 16h3v3h2v-5H5v2Zm3-8H5v2h5V5H8v3Zm6 11h2v-3h3v-2h-5v5Zm2-11V5h-2v5h5V8h-3Z" />
            </svg>
        </ActionBarIcon>
    );
}

export default definePlugin({
    name: "ShrinkUploads",
    description: "Shrinks pictures, GIFs, videos and audio on your own computer so they fit your Discord upload limit.",
    authors: [{ name: "nolifepops", id: 221807880053981184n }],
    settings,

    patches: [
        {
            find: "Unexpected mismatch between files and file metadata",
            replacement: {
                match: /(async function\((\i),(\i),(\i)\){)(let{filesMetadata:)/,
                replace: "$1if($self.intercept($2,$3,$4,arguments[3]))return;$5"
            }
        },
        {
            find: "#{intl::ATTACHMENT_UTILITIES_SPOILER}",
            replacement: {
                match: /(?=\]}\),draftType:\i,id:\i\.id,channelId:)/,
                replace: ",$self.renderShrinkButton(arguments[0])"
            }
        },
    ],

    intercept,

    renderShrinkButton(props: ActionBarProps) {
        if (!settings.store.shrinkButton || props.canEdit === false) return null;
        return <ErrorBoundary noop><ShrinkButton {...props} /></ErrorBoundary>;
    },

    stop() {
        jobs.forEach(j => j.controller.abort());
        jobs = [];
        unmountPanel();
    },
});
