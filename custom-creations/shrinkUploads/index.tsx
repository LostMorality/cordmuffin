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
import { findByCodeLazy, findCssClassesLazy } from "@webpack";
import { Alerts, ChannelStore, createRoot, Modal, openModal, SelectedGuildStore, TextInput, UploadAttachmentStore, UploadHandler, UploadManager, useEffect, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { type ImageFormat, isAnimatedStill, shrinkImage } from "./image";
import { describeLimit, getUploadLimit } from "./limits";
import { formatBytes } from "./plan";

const Native = VencordNative.pluginHelpers.ShrinkUploads as PluginNative<typeof import("./native")> | undefined;
const ActionBarIcon = findByCodeLazy("Children.map", "isValidElement", "dangerous:");
const sumTooBig = findByCodeLazy('"uploadSumTooLarge"') as (files: { size: number; }[]) => boolean;
const TileClasses = findCssClassesLazy("action", "actionBarIcon", "attachmentItemSmall");
const cl = classNameFactory("vc-shrink-");
const logger = new Logger("ShrinkUploads");
const MB = 1024 * 1024;
const CHUNK = 8 * MB;
const MAX_FILES = 10;
const SMALL_TILE = 0;
const MIN_TARGET = 64 * 1024;

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
        description: "How fast videos shrink. Slower looks better.",
        options: [
            { label: "Fast", value: "fast" },
            { label: "Balanced", value: "balanced", default: true },
            { label: "Best quality (slow)", value: "best" },
        ],
    },
    maxFps: {
        type: OptionType.SELECT,
        displayName: "Video frame rate",
        description: "30 fps keeps shrunk videos sharper.",
        options: [
            { label: "60 fps (smoother)", value: 60, default: true },
            { label: "30 fps (sharper)", value: 30 },
        ],
    },
    imageFormat: {
        type: OptionType.SELECT,
        displayName: "Picture format",
        description: "Automatic keeps JPEGs as JPEG. See-through pictures always become WebP.",
        options: [
            { label: "Automatic", value: "auto", default: true },
            { label: "WebP (smallest)", value: "webp" },
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
        description: "Keep hidden info like location in videos and audio. Pictures always lose it.",
        default: false,
    },
    autoDownload: {
        type: OptionType.BOOLEAN,
        displayName: "Get the video tool automatically",
        description: "Download the free video tool (ffmpeg) the first time it's needed.",
        default: true,
    },
    ffmpegPath: {
        type: OptionType.STRING,
        description: "",
        default: "",
        hidden: true,
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

function messageCap() {
    try {
        return sumTooBig([{ size: 600 * MB }]) ? 500 * MB : 1024 * MB;
    } catch {
        return 500 * MB;
    }
}

const draftBytes = (channelId: string, draftType: number, skipId?: string) =>
    UploadAttachmentStore.getUploads(channelId, draftType).reduce((n, u) => u.id === skipId ? n : n + (u.item?.file?.size ?? u.currentSize ?? 0), 0);

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
const shared = new WeakMap<File, { target: number; result: Promise<File>; }[]>();
let imageQueue = Promise.resolve();
let toolQueue = Promise.resolve();
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

function close(job: Job) {
    jobs = jobs.filter(j => j !== job);
    emit();
}

function dismiss(job: Job, delay: number) {
    setTimeout(() => close(job), delay);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function ensureTools(job: Job) {
    if (!Native) throw new Error("Videos, GIFs and audio need the Discord desktop app.");
    let tools = await Native.getTools();
    if (tools.ready) return;
    if (!tools.supported) throw new Error("Your system needs ffmpeg installed to shrink videos. Install it, then restart Discord.");
    if (!settings.store.autoDownload && !tools.installing) throw new Error("The video tool isn't installed. Get it in the ShrinkUploads settings.");

    const install = Native.installTools();
    let done = false;
    install.then(() => { done = true; }, () => { done = true; });
    while (!done) {
        tools = await Native.getTools();
        const d = tools.download;
        update(job, { phase: "Getting the video tool (only the first time)", percent: d?.total ? Math.min(99, d.received / d.total * 100) : 0 });
        if (job.controller.signal.aborted) throw new Error("Cancelled");
        await sleep(400);
    }
    await install;
}

async function shrinkWithTools(file: File, kind: Exclude<Kind, "image">, target: number, job: Job) {
    if (!Native) throw new Error("Videos, GIFs and audio need the Discord desktop app.");
    await ensureTools(job);
    const { signal } = job.controller;
    const id = await Native.startJob(file.name, file.size, target);
    const onAbort = () => void Native.cancelJob(id);
    signal.addEventListener("abort", onAbort);
    try {
        for (let at = 0; at < file.size; at += CHUNK) {
            signal.throwIfAborted();
            update(job, { phase: "Getting the file ready", percent: at / file.size * 3 });
            await Native.writeChunk(id, new Uint8Array(await file.slice(at, at + CHUNK).arrayBuffer()));
        }
        update(job, { phase: "Checking the file", percent: 3 });

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
            if (p && !finished) update(job, { phase: p.phase === "Reading file" ? "Checking the file" : p.phase, percent: Math.max(3, p.percent) });
            await sleep(400);
        }
        const result = await work;
        signal.throwIfAborted();

        const parts: Blob[] = [];
        for (let at = 0; at < result.size; at += CHUNK) {
            signal.throwIfAborted();
            update(job, { phase: "Almost done", percent: 99 });
            parts.push(new Blob([await Native.readChunk(id, at, Math.min(CHUNK, result.size - at)) as BlobPart]));
        }
        return { blob: new Blob(parts, { type: result.mime }), ext: result.ext, mime: result.mime, note: result.note };
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
        if (await isAnimatedStill(file)) throw new Error("Moving pictures (animated WebP, PNG or AVIF) can't be shrunk yet.");
        out = await shrinkImage(file, target, settings.store.imageFormat as ImageFormat, job.controller.signal, text => update(job, { phase: text }));
    } else {
        out = await shrinkWithTools(file, kind, target, job);
    }
    job.controller.signal.throwIfAborted();
    if (out.blob.size > target) throw new Error("It couldn't be made small enough.");
    const base = file.name.replace(/\.[^.]+$/, "") || "file";
    update(job, { phase: `Done! ${formatBytes(file.size)} → ${formatBytes(out.blob.size)}${out.note ? ` (${out.note})` : ""}` });
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

function enqueue(file: File, target: number, onDone: (out: File) => void, onFail?: () => void, restoresOriginal = onFail != null, label = file.name) {
    mountPanel();
    const job: Job = { id: nextId++, name: label, phase: "Waiting in line", percent: 0, state: "queued", controller: new AbortController(), onFail };
    jobs.push(job);
    emit();
    const step = async () => {
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
            update(job, { state: "failed", phase: cancelled ? "Cancelled" : `${restoresOriginal ? "" : "Not added. "}${errorText(e)}` });
            onFail?.();
            if (cancelled) dismiss(job, 1500);
        }
    };
    if (kindOf(file) === "image") imageQueue = imageQueue.then(step);
    else toolQueue = toolQueue.then(step);
}

function shrinkOnce(file: File, target: number) {
    const list = shared.get(file) ?? [];
    const hit = list.find(e => e.target <= target);
    if (hit) return hit.result;
    const entry = { target, result: new Promise<File>((resolve, reject) => enqueue(file, target, resolve, () => reject(new Error("failed")), false)) };
    list.push(entry);
    shared.set(file, list);
    entry.result.catch(() => {
        const i = list.indexOf(entry);
        if (i >= 0) list.splice(i, 1);
    });
    return entry.result;
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
        if (UploadAttachmentStore.getUploadCount(channel.id, draftType) + files.length > MAX_FILES) {
            Alerts.show({ title: "Too many files", body: `You can add up to ${MAX_FILES} files to one message.` });
            return true;
        }

        const small = files.filter(f => !big.includes(f));
        const room = messageCap() - draftBytes(channel.id, draftType) - small.reduce((n, f) => n + f.size, 0);
        const target = Math.min(targetFor(limit), targetFor(Math.floor(room / big.length)));
        if (target < 256 * 1024) return false;

        const metadata = options?.filesMetadata && new Map(files.map((f, i) => [f, options.filesMetadata?.[i]]));
        const run = () => {
            addFiles(small, channel, draftType, metadata, options);
            for (const file of big)
                shrinkOnce(file, target).then(out => {
                    metadata?.set(out, metadata.get(file));
                    addFiles([out], channel, draftType, metadata, options);
                }, () => { });
        };

        if (settings.store.whenTooBig === "ask") {
            let settled = false;
            const keepSmall = () => {
                if (settled) return;
                settled = true;
                addFiles(small, channel, draftType, metadata, options);
            };
            const one = big.length === 1;
            Alerts.show({
                title: one ? "File too big" : "Files too big",
                body: `${one ? `${big[0].name} is` : `${big.length} files are`} over your ${formatBytes(limit)} upload limit here. Shrink ${one ? "it" : "them"} on this computer so ${one ? "it fits" : "they fit"}?`,
                confirmText: "Shrink",
                cancelText: one ? "Leave it out" : "Leave them out",
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
                <div key={job.id} className={cl("job")} data-state={job.state} data-busy={job.state === "working" && job.percent <= 3}>
                    <div className={cl("row")}>
                        <span className={cl("name")} title={job.name}>{job.name}</span>
                        {(job.state === "queued" || job.state === "working") && (
                            <Button size="min" variant="secondary" onClick={() => cancel(job)}>Cancel</Button>
                        )}
                        {job.state === "failed" && job.phase !== "Cancelled" && (
                            <Button size="min" variant="secondary" onClick={() => close(job)}>Close</Button>
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

async function setOwnTool(file: string) {
    if (!Native) return;
    try {
        settings.store.ffmpegPath = await Native.useTool(file);
    } catch (e) {
        Alerts.show({ title: "Couldn't use that ffmpeg", body: errorText(e) });
    }
}

async function pickOwnTool() {
    if (!Native) return;
    const file = await Native.pickTool().catch(() => "");
    if (file) await setOwnTool(file);
}

function StatusCard() {
    const guildId = SelectedGuildStore.getGuildId();
    const here = describeLimit(guildId);
    const dms = describeLimit(null);
    const { ffmpegPath } = settings.use(["ffmpegPath"]);
    const [tools, setTools] = useState<Awaited<ReturnType<NonNullable<typeof Native>["getTools"]>> | null>(null);

    useEffect(() => {
        if (!Native) return;
        let alive = true;
        const tick = () => Native.getTools().then(t => alive && setTools(t));
        tick();
        const timer = setInterval(tick, 700);
        return () => { alive = false; clearInterval(timer); };
    }, []);

    let toolLine: ReactNode = "Pictures work here. Videos, GIFs and audio need the Discord desktop app.";
    if (Native && !tools) {
        toolLine = "Checking for the video tool...";
    } else if (Native && tools) {
        if (tools.installing) {
            const d = tools.download;
            toolLine = `Downloading the video tool${d?.total ? ` (${Math.round(d.received / d.total * 100)}%)` : ""}...`;
        } else if (tools.ready) {
            toolLine = tools.source === "custom" ? "Video tool: using the ffmpeg you picked."
                : tools.source === "system" ? "Video tool: using the ffmpeg already on this computer."
                    : "Video tool: ready.";
        } else if (!tools.supported) {
            toolLine = "Video tool: none available for this system. Install ffmpeg to shrink videos.";
        } else {
            toolLine = `Video tool: not installed yet (${tools.sizeMb} MB, free).${settings.store.autoDownload ? " It downloads by itself the first time you need it." : ""}${tools.error ? ` Last try failed: ${tools.error}` : ""}`;
        }
    }

    return (
        <div className={cl("status")}>
            <div>Just send a file. If it's too big, it gets shrunk first.</div>
            <div className={cl("limit")}>
                Your upload limit: <b>{formatBytes(dms.limit)}</b> ({dms.plan})
                {guildId && here.limit !== dms.limit && <> · this server: <b>{formatBytes(here.limit)}</b>{here.boosted ? " (boosted)" : ""}</>}
            </div>
            <div className={cl("tools")}>{toolLine}</div>
            {tools?.ready && tools.source !== "downloaded" && tools.path && <div className={cl("path")}>{tools.path}</div>}
            {tools?.customError && <div className={cl("warn")}>{tools.customError}</div>}
            {Native && tools && (
                <div className={cl("buttons")}>
                    {!tools.ready && tools.supported && !tools.installing && (
                        <Button size="small" onClick={() => Native.installTools().catch(() => { })}>Download video tool</Button>
                    )}
                    {tools.source === "system" && tools.supported && !tools.installing && (
                        <Button size="small" variant="secondary" onClick={() => Native.installTools().catch(e => Alerts.show({ title: "Couldn't download it", body: errorText(e) }))}>Use the plugin's own copy</Button>
                    )}
                    {tools.source === "downloaded" && (
                        <Button size="small" variant="secondary" onClick={() => Native.removeTools().catch(e => Alerts.show({ title: "Couldn't remove it", body: errorText(e) }))}>Remove video tool</Button>
                    )}
                    {!tools.installing && <Button size="small" variant="secondary" onClick={pickOwnTool}>Use my own ffmpeg</Button>}
                    {(tools.source === "custom" || tools.customError || ffmpegPath) && <Button size="small" variant="secondary" onClick={() => setOwnTool("")}>Back to automatic</Button>}
                </div>
            )}
            <div className={cl("note")}>Everything is shrunk on this computer. Files are never uploaded anywhere except to Discord.</div>
        </div>
    );
}

function TargetModal({ upload, limit, onShrink, ...props }: RenderModalProps & { upload: CloudUpload; limit: number; onShrink(target: number): void; }) {
    const { size } = upload.item.file;
    const suggested = size > limit ? targetFor(limit) : Math.floor(size / 2);
    const [value, setValue] = useState(String(Math.floor(suggested / MB * 100) / 100));
    const text = value.trim();
    const mb = /^\d+(?:[.,]\d+)?$/.test(text) ? Number(text.replace(",", ".")) : NaN;
    const bytes = Math.floor(mb * MB);
    const valid = Number.isFinite(mb) && bytes >= MIN_TARGET && bytes < size && bytes <= limit;
    const highest = Math.floor((Math.min(size - 1, limit) / MB) * 100) / 100;
    const hint = valid ? "Smaller sizes mean lower quality." : `Pick a size between ${Math.ceil(MIN_TARGET / MB * 100) / 100} and ${highest} MB.`;

    return (
        <Modal
            {...props}
            size="sm"
            title="Shrink file"
            subtitle={`${upload.filename} is ${formatBytes(size)}. Your limit here is ${formatBytes(limit)}.`}
            actions={[{ text: "Shrink", variant: "primary", disabled: !valid, onClick: () => valid && onShrink(bytes) }]}
        >
            <div className={cl("label")}>New size (MB)</div>
            <TextInput value={value} onChange={setValue} placeholder="Size in MB" autoFocus />
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
    size?: number;
}

function ShrinkButton({ upload, channelId, draftType, size }: ActionBarProps) {
    const { shrinkButton } = settings.use(["shrinkButton"]);
    const file = upload.item.platform === 1 ? upload.item.file : null;
    if (!shrinkButton || !file || !kindOf(file)) return null;
    const small = size === SMALL_TILE;

    const open = () => {
        const channel = ChannelStore.getChannel(channelId);
        if (!channel) return;
        const limit = Math.min(getUploadLimit(channel.guild_id), messageCap() - draftBytes(channelId, draftType, upload.id));
        if (limit < MIN_TARGET) return;
        const details = { spoiler: upload.spoiler, description: upload.description, filename: upload.filename, clip: upload.clip };
        const readd = (next: File) => {
            const metadata = details.clip ? new Map<File, unknown>([[next, { clip: details.clip }]]) : undefined;
            addFiles([next], channel, draftType, metadata, metadata && {}).then(() => restoreDetails(channelId, draftType, next, details));
        };
        openModal(props => (
            <TargetModal {...props} upload={upload} limit={limit} onShrink={target => {
                props.onClose();
                UploadManager.remove(channelId, upload.id, draftType);
                enqueue(file, target, readd, () => readd(file), true, details.filename || file.name);
            }} />
        ));
    };

    return (
        <ActionBarIcon tooltip="Shrink" onClick={open} className={small ? TileClasses.action : undefined}>
            <svg className={small ? TileClasses.actionBarIcon : undefined} viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
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
        if (props.canEdit === false) return null;
        return <ErrorBoundary noop><ShrinkButton {...props} /></ErrorBoundary>;
    },

    start() {
        if (Native && settings.store.ffmpegPath) Native.useTool(settings.store.ffmpegPath, true).catch(() => { });
    },

    stop() {
        jobs.forEach(j => j.controller.abort());
        jobs = [];
        unmountPanel();
    },
});
