/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Switch } from "@components/Switch";
import { classNameFactory } from "@utils/css";
import { getGuildAcronym, hasGuildFeature } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { classes } from "@utils/misc";
import { saveFile } from "@utils/web";
import definePlugin, { OptionType } from "@utils/types";
import type { Guild, ModalAction, RenderModalProps, SoundboardSound } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { zipSync } from "fflate";
import { GuildStore, IconUtils, Menu, Modal, NavigationRouter, openModal, PermissionsBits, PermissionStore, React, RestAPI, SortedGuildStore, SoundboardStore, useEffect, useMemo, useReducer, useRef, useState, UserStore } from "@webpack/common";

const logger = new Logger("SoundboardCloner");

// Own lookup of Discord's toast, so a failed lookup throws here and the message falls back to a notification.
const discordToast: (options: { text: string; variant?: string; }) => void = findByCodeLazy(".currentToastMap.get(", "setState");
// Discord's toasts cut text off after about two lines.
const TOAST_FITS = 50;
const NOTIFY_COLORS = { default: undefined, success: "var(--status-positive)", critical: "var(--status-danger)" };

function notify(text: string, variant: keyof typeof NOTIFY_COLORS = "default") {
    if (text.length <= TOAST_FITS) {
        try {
            discordToast({ text, variant });
            return;
        } catch (e) {
            logger.warn("Toast failed", e);
        }
    }
    showNotification({ title: "SoundboardCloner", body: text, color: NOTIFY_COLORS[variant] });
}
const cl = classNameFactory("vc-sbc-");

const DEFAULTS_ID = "0";
const NEW_GUILD_SLOTS = 8;
const MAX_SOUND_BYTES = 512 * 1024;
const MAX_LOG_ENTRIES = 500;

const ErrorCodes = { MAX_GUILDS: 30001, MISSING_ACCESS: 50001, MISSING_PERMISSIONS: 50013 } as const;

const fetchAllSounds: (opts?: { disableAnalytics?: boolean; }) => Promise<unknown> = findByCodeLazy("OVERLAY_SOUNDBOARD_SOUNDS_FETCH_REQUEST");

interface SoundItem {
    id: string;
    name: string;
    volume: number;
    emojiId: string | null;
    emojiName: string | null;
    sourceId: string;
}

interface SourceGroup {
    id: string;
    name: string;
    guild: Guild | null;
    sounds: SoundItem[];
}

interface CloneOptions {
    skipDuplicates: boolean;
    keepEmojis: boolean;
    overflow: boolean;
    overflowBaseName: string;
    maxOverflowServers: number;
    delayMs: number;
}

type DestinationChoice = { mode: "existing"; guildId: string; } | { mode: "create"; name: string; };
type LogStatus = "success" | "skipped" | "failed" | "info";
type JobStatus = "running" | "done" | "cancelled" | "error";

interface LogEntry {
    id: number;
    status: LogStatus;
    message: string;
    item: SoundItem | null;
}

interface JobState {
    status: JobStatus;
    total: number;
    processed: number;
    succeeded: number;
    skipped: number;
    failed: number;
    current: SoundItem | null;
    waitingUntil: number | null;
    destinations: { id: string; name: string; created: boolean; }[];
    log: LogEntry[];
    startedAt: number;
    finishedAt: number | null;
    fatal: string | null;
}

const settings = definePluginSettings({
    openCloner: {
        type: OptionType.COMPONENT,
        component: () => (
            <Button size="small" onClick={() => openCloner()}>Open Sound Cloner</Button>
        )
    },
    previewVolume: {
        type: OptionType.SLIDER,
        description: "How loud sounds play when you press ▶ in the cloner. Some sounds are very loud, so this starts at half.",
        markers: [0, 25, 50, 75, 100],
        stickToMarkers: false,
        default: 50
    },
    uploadDelay: {
        type: OptionType.NUMBER,
        description: "Wait between uploads, in milliseconds. Rate limits are handled either way; a small wait just hits them less often.",
        default: 1500
    },
    skipDuplicates: {
        type: OptionType.BOOLEAN,
        description: "Skip sounds whose name already exists in the server they're going to",
        default: true
    },
    keepEmojis: {
        type: OptionType.BOOLEAN,
        description: "Copy each sound's emoji too. Custom emojis Discord won't accept are dropped and the sound is still copied.",
        default: true
    },
    overflowServers: {
        type: OptionType.BOOLEAN,
        description: "When the server runs out of sound slots, create new servers and keep going",
        default: false
    },
    maxOverflowServers: {
        type: OptionType.NUMBER,
        description: "Most extra servers one clone may create",
        default: 3
    },
    newServerName: {
        type: OptionType.STRING,
        description: "Name for servers the cloner creates",
        default: "Sound Vault"
    }
});

function getDefaultOptions(): CloneOptions {
    const s = settings.store;
    return {
        skipDuplicates: s.skipDuplicates,
        keepEmojis: s.keepEmojis,
        overflow: s.overflowServers,
        overflowBaseName: s.newServerName,
        maxOverflowServers: Math.max(0, Math.min(20, Math.floor(Number(s.maxOverflowServers) || 0))),
        delayMs: Math.max(0, Math.floor(Number(s.uploadDelay) || 0))
    };
}

function rememberOptions(o: CloneOptions) {
    const s = settings.store;
    s.skipDuplicates = o.skipDuplicates;
    s.keepEmojis = o.keepEmojis;
    s.overflowServers = o.overflow;
    s.newServerName = o.overflowBaseName;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function soundToItem(s: SoundboardSound, sourceId: string): SoundItem {
    return {
        id: s.soundId,
        name: s.name,
        volume: typeof s.volume === "number" ? s.volume : 1,
        emojiId: s.emojiId ?? null,
        emojiName: s.emojiName ?? null,
        sourceId
    };
}

function soundUrl(id: string) {
    return `https://${window.GLOBAL_ENV.CDN_HOST}/soundboard-sounds/${id}`;
}

function emojiUrl(id: string) {
    return `https://${window.GLOBAL_ENV.CDN_HOST}/emojis/${id}.webp?size=32`;
}

function sanitizeSoundName(raw: string) {
    const chars = Array.from(raw.trim().replace(/\s+/g, " ")).slice(0, 32);
    while (chars.length < 2) chars.push("_");
    return chars.join("");
}

function sanitizeServerName(raw: string) {
    return raw.trim().slice(0, 100);
}

function getMaxSoundSlots(guild: Guild) {
    const extra = (guild.premiumFeatures as { additionalSoundSlots?: number; } | undefined)?.additionalSoundSlots ?? 0;
    return Math.max(hasGuildFeature(guild, "MORE_SOUNDBOARD" as any) ? 200 : NEW_GUILD_SLOTS, NEW_GUILD_SLOTS + extra);
}

function getUsedSoundSlots(guildId: string) {
    return SoundboardStore.getSoundsForGuild(guildId)?.length ?? 0;
}

function getFreeSoundSlots(guild: Guild) {
    return Math.max(0, getMaxSoundSlots(guild) - getUsedSoundSlots(guild.id));
}

function getExistingSoundNames(guildId: string) {
    return new Set((SoundboardStore.getSoundsForGuild(guildId) ?? []).map(s => s.name.toLowerCase()));
}

function canCreateExpressions(guild: Guild) {
    if (guild.ownerId === UserStore.getCurrentUser()?.id) return true;
    const perms = PermissionStore.getGuildPermissions({ id: guild.id } as Guild);
    return (perms & PermissionsBits.CREATE_GUILD_EXPRESSIONS) === PermissionsBits.CREATE_GUILD_EXPRESSIONS;
}

function getOrderedGuilds(): Guild[] {
    const all = GuildStore.getGuilds();
    const seen = new Set<string>();
    const out: Guild[] = [];

    for (const id of SortedGuildStore.getFlattenedGuildIds?.() ?? []) {
        const guild = all[id];
        if (guild && !seen.has(id)) {
            seen.add(id);
            out.push(guild);
        }
    }

    for (const guild of Object.values(all))
        if (!seen.has(guild.id)) out.push(guild);

    return out;
}

function buildSourceGroups(): SourceGroup[] {
    const groups: SourceGroup[] = [];

    for (const guild of getOrderedGuilds()) {
        const sounds = SoundboardStore.getSoundsForGuild(guild.id) ?? [];
        if (sounds.length) groups.push({ id: guild.id, name: guild.name, guild, sounds: sounds.map(s => soundToItem(s, guild.id)) });
    }

    const defaults = SoundboardStore.getSoundsForGuild(DEFAULTS_ID) ?? [];
    if (defaults.length)
        groups.push({ id: DEFAULTS_ID, name: "Discord Defaults", guild: null, sounds: defaults.map(s => soundToItem(s, DEFAULTS_ID)) });

    return groups;
}

async function ensureSoundsLoaded() {
    if (SoundboardStore.hasFetchedAllSounds() && SoundboardStore.hasFetchedDefaultSounds()) return;
    try {
        await Promise.race([
            fetchAllSounds({ disableAnalytics: true }),
            new Promise(r => setTimeout(r, 15_000))
        ]);
    } catch (e) {
        logger.error("Couldn't load soundboard sounds", e);
    }
}

class AbortedError extends Error {
    constructor() {
        super("Aborted");
        this.name = "AbortError";
    }
}

const isAbortError = (e: unknown) => (e as any)?.name === "AbortError";

function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new AbortedError());

        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, Math.max(0, ms));

        function onAbort() {
            clearTimeout(timer);
            reject(new AbortedError());
        }

        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

interface HttpErrorInfo {
    status?: number;
    code?: number;
    message: string;
    retryAfter?: number;
    captcha: boolean;
    fields: string[];
}

function collectFieldErrors(errors: any, path: string[] = [], out: { path: string; message: string; }[] = []) {
    if (!errors || typeof errors !== "object") return out;

    const own = errors._errors?.[0]?.message;
    if (typeof own === "string") out.push({ path: path.join("."), message: own });

    for (const [key, value] of Object.entries(errors))
        if (key !== "_errors") collectFieldErrors(value, [...path, key], out);

    return out;
}

function parseHttpError(e: any): HttpErrorInfo {
    let body = e?.body;
    if (!body && typeof e?.text === "string") {
        try { body = JSON.parse(e.text); } catch { }
    }

    const captcha = body?.captcha_key != null || body?.captcha_sitekey != null;
    const fieldErrors = collectFieldErrors(body?.errors);
    const first = fieldErrors[0];
    const message = captcha
        ? "Discord asked for a captcha. Add one sound by hand in Server Settings, then try again"
        : (first ? (first.path ? `${first.path}: ${first.message}` : first.message) : undefined)
        ?? body?.message ?? (e instanceof Error ? e.message : undefined) ?? "Unknown error";

    return {
        status: typeof e?.status === "number" ? e.status : undefined,
        code: typeof body?.code === "number" ? body.code : undefined,
        retryAfter: typeof body?.retry_after === "number" ? body.retry_after : undefined,
        message,
        captcha,
        fields: fieldErrors.map(f => f.path)
    };
}

const isLimitError = (info: HttpErrorInfo) =>
    info.code != null && info.code > 30001 && info.code < 30100;

const isEmojiError = (info: HttpErrorInfo) =>
    info.fields.some(f => f.startsWith("emoji")) || (info.status === 400 && /emoji/i.test(info.message));

async function withRateLimit<T>(fn: () => Promise<T>, signal: AbortSignal, onWait: (until: number | null) => void, maxRetries = 20): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        if (signal.aborted) throw new AbortedError();

        try {
            return await fn();
        } catch (e) {
            if (isAbortError(e)) throw e;

            const info = parseHttpError(e);
            if (info.status !== 429 || attempt >= maxRetries) throw e;

            const until = Date.now() + Math.ceil((info.retryAfter ?? 5) * 1000) + 250;
            onWait(until);
            try {
                await sleep(until - Date.now(), signal);
            } finally {
                onWait(null);
            }
        }
    }
}

function sniffAudioType(bytes: Uint8Array) {
    if (bytes[0] === 0x4F && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return "audio/ogg";
    return "audio/mpeg";
}

async function fetchSoundFile(id: string, signal?: AbortSignal) {
    const res = await fetch(soundUrl(id), { signal });
    if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.byteLength) throw new Error("Downloaded file is empty");

    const headerType = res.headers.get("content-type")?.split(";")[0].trim();
    const type = headerType === "audio/ogg" || headerType === "audio/mpeg" ? headerType : sniffAudioType(bytes);
    return { bytes, type };
}

async function downloadSound(id: string, signal: AbortSignal) {
    const { bytes, type } = await fetchSoundFile(id, signal);
    if (bytes.byteLength > MAX_SOUND_BYTES) throw new Error(`File is ${Math.ceil(bytes.byteLength / 1024)} KB, Discord allows 512 KB`);

    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the sound file"));
        reader.readAsDataURL(new Blob([bytes], { type }));
    });
}

const extFor = (type: string) => type === "audio/ogg" ? "ogg" : "mp3";

function safeFileName(raw: string, fallback = "sound") {
    const name = raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().replace(/[. ]+$/, "").slice(0, 80);
    return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name) ? `${name}_` : name || fallback;
}

function sourceName(sourceId: string) {
    if (sourceId === DEFAULTS_ID) return "Discord Defaults";
    return GuildStore.getGuild(sourceId)?.name ?? sourceId;
}

function nativeFileName(filename: string, fallback: string) {
    const dot = filename.lastIndexOf(".");
    const ext = dot > 0 ? filename.slice(dot).replace(/[^\w.]/g, "") : "";
    const stem = (dot > 0 ? filename.slice(0, dot) : filename)
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\w-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80);
    return `${/[A-Za-z0-9]/.test(stem) ? stem : fallback}${ext}`;
}

const isSaveCancel = (e: any) => /cancel/i.test(String(e?.message ?? e));

async function saveBytes(data: Uint8Array, filename: string, fallback: string) {
    const name = nativeFileName(filename, fallback);

    if (IS_DISCORD_DESKTOP) await DiscordNative.fileManager.saveWithDialog(data, name);
    else saveFile(new File([data as Uint8Array<ArrayBuffer>], name));

    toast(`Saved ${name}`);
}

let saveBusy = false;
const saveListeners = new Set<() => void>();

function setSaveBusy(v: boolean) {
    saveBusy = v;
    for (const l of saveListeners) l();
}

function useSaveBusy() {
    const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
    useEffect(() => {
        saveListeners.add(forceUpdate);
        return () => void saveListeners.delete(forceUpdate);
    }, []);
    return saveBusy;
}

async function saveSounds(items: SoundItem[], zipName: string) {
    if (saveBusy || !items.length) return;
    setSaveBusy(true);

    try {
        if (items.length === 1) {
            const [item] = items;
            const { bytes, type } = await fetchSoundFile(item.id);
            await saveBytes(bytes, `${item.name}.${extFor(type)}`, `sound_${item.id}`);
            return;
        }

        toast(`Downloading ${plural(items.length, "sound")}…`);

        const files: Record<string, Uint8Array> = {};
        const used = new Set<string>();
        const queue = [...items];
        let failed = 0;

        const worker = async () => {
            for (let item = queue.shift(); item; item = queue.shift()) {
                try {
                    const { bytes, type } = await fetchSoundFile(item.id);
                    const folder = safeFileName(sourceName(item.sourceId), "Server");
                    const base = `${folder}/${safeFileName(item.name)}`;
                    let path = `${base}.${extFor(type)}`;
                    for (let n = 2; used.has(path.toLowerCase()); n++) path = `${base} (${n}).${extFor(type)}`;
                    used.add(path.toLowerCase());
                    files[path] = bytes;
                } catch (e) {
                    failed++;
                    logger.warn("Couldn't download sound", item, e);
                }
            }
        };

        await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));

        const saved = Object.keys(files).length;
        if (!saved) throw new Error("None of the sounds could be downloaded");

        await saveBytes(zipSync(files, { level: 0 }), `${zipName}.zip`, "Soundboard_Sounds");
        if (failed) toast(`Zipped ${saved} of ${items.length} sounds. ${failed} couldn't be downloaded.`, true);
    } catch (e: any) {
        if (isSaveCancel(e)) return;
        logger.error("Saving sounds failed", e);
        toast(`Couldn't save: ${e?.message ?? "unknown error"}`, true);
    } finally {
        setSaveBusy(false);
    }
}

async function postSound(guildId: string, body: { name: string; sound: string; volume: number; emoji_id: string | null; emoji_name: string | null; }) {
    const res = await RestAPI.post({ url: `/guilds/${guildId}/soundboard-sounds`, body });
    return res.body;
}

async function createGuild(name: string): Promise<{ id: string; name: string; }> {
    const { body } = await RestAPI.post({
        url: "/guilds",
        body: { name, icon: null, channels: [], system_channel_id: null }
    });

    if (!body?.id) throw new Error("Discord didn't return the new server");
    return { id: body.id, name: body.name ?? name };
}

interface Destination {
    guildId: string;
    name: string;
    created: boolean;
    free: number;
    names: Set<string>;
}

class CloneJob {
    state: JobState;

    private readonly listeners = new Set<() => void>();
    private readonly controller = new AbortController();
    private readonly destinations: Destination[] = [];
    private logSeq = 0;
    private overflowCreated = 0;
    private sent = false;
    private overflowBlocked = false;

    constructor(private readonly items: SoundItem[], private readonly target: DestinationChoice, private readonly options: CloneOptions) {
        this.state = {
            status: "running",
            total: items.length,
            processed: 0,
            succeeded: 0,
            skipped: 0,
            failed: 0,
            current: null,
            waitingUntil: null,
            destinations: [],
            log: [],
            startedAt: Date.now(),
            finishedAt: null,
            fatal: null
        };
    }

    get isRunning() {
        return this.state.status === "running";
    }

    subscribe(listener: () => void) {
        this.listeners.add(listener);
        return () => void this.listeners.delete(listener);
    }

    cancel() {
        this.controller.abort();
    }

    private update(patch: Partial<JobState>) {
        this.state = { ...this.state, ...patch };
        for (const l of this.listeners) {
            try { l(); } catch (e) { logger.error("Listener failed", e); }
        }
    }

    private log(status: LogStatus, message: string, item: SoundItem | null = null) {
        const entry = { id: this.logSeq++, status, message, item };
        const log = this.state.log.length >= MAX_LOG_ENTRIES
            ? [...this.state.log.slice(-(MAX_LOG_ENTRIES - 1)), entry]
            : [...this.state.log, entry];

        const counters: Partial<JobState> = {};
        if (status === "success") counters.succeeded = this.state.succeeded + 1;
        else if (status === "skipped") counters.skipped = this.state.skipped + 1;
        else if (status === "failed") counters.failed = this.state.failed + 1;

        this.update({ log, ...counters });
    }

    private setWaiting = (until: number | null) => this.update({ waitingUntil: until });

    private addDestination(dest: Destination) {
        this.destinations.push(dest);
        this.update({ destinations: [...this.state.destinations, { id: dest.guildId, name: dest.name, created: dest.created }] });
    }

    private async createDestination(name: string) {
        const clean = sanitizeServerName(name) || "Sound Vault";
        this.log("info", `Creating server "${clean}"…`);
        this.sent = true;
        const guild = await withRateLimit(() => createGuild(clean), this.controller.signal, this.setWaiting);

        const dest: Destination = { guildId: guild.id, name: guild.name, created: true, free: NEW_GUILD_SLOTS, names: new Set() };
        this.addDestination(dest);
        this.log("info", `Created server "${guild.name}"`);
        return dest;
    }

    private overflowName(index: number) {
        const clean = sanitizeServerName(this.options.overflowBaseName).slice(0, 95);
        const base = clean.length >= 2 ? clean : "Sound Vault";
        return index <= 1 ? base : `${base} ${index}`;
    }

    private async destinationFor() {
        const existing = this.destinations.find(d => d.free > 0);
        if (existing) return existing;

        if (!this.canMakeOverflow()) return null;

        const index = this.overflowCreated + 1 + (this.target.mode === "create" ? 1 : 0);
        try {
            const dest = await this.createDestination(this.overflowName(index));
            this.overflowCreated++;
            return dest;
        } catch (e) {
            const info = parseHttpError(e);
            if (isAbortError(e) || info.captcha || info.code === ErrorCodes.MAX_GUILDS) throw e;

            this.overflowBlocked = true;
            logger.error("Couldn't create an extra server", e);
            this.log("info", `Couldn't create an extra server: ${info.message}`);
            return null;
        }
    }

    private canMakeOverflow() {
        return this.options.overflow && !this.overflowBlocked && this.overflowCreated < this.options.maxOverflowServers;
    }

    private hasRoom() {
        return this.destinations.some(d => d.free > 0) || this.canMakeOverflow();
    }

    private async cloneOne(item: SoundItem) {
        const { signal } = this.controller;
        const name = sanitizeSoundName(item.name);
        const lower = name.toLowerCase();

        if (this.options.skipDuplicates) {
            const dup = this.destinations.find(d => d.names.has(lower));
            if (dup) return this.log("skipped", `"${name}" is already in ${dup.name}`, item);
        }

        if (!this.hasRoom()) return this.log("skipped", "No free sound slots left", item);

        const sound = await downloadSound(item.id, signal);
        let emojiId = this.options.keepEmojis ? item.emojiId : null;
        let emojiName = this.options.keepEmojis && !item.emojiId ? item.emojiName : null;

        for (; ;) {
            const dest = await this.destinationFor();
            if (!dest) return this.log("skipped", "No free sound slots left", item);

            try {
                this.sent = true;
                await withRateLimit(
                    () => postSound(dest.guildId, { name, sound, volume: Math.min(1, Math.max(0, item.volume)), emoji_id: emojiId, emoji_name: emojiName }),
                    signal,
                    this.setWaiting
                );

                dest.free--;
                dest.names.add(lower);
                return this.log("success", `Copied to ${dest.name}`, item);
            } catch (e) {
                if (isAbortError(e)) throw e;

                const info = parseHttpError(e);
                if (info.captcha || info.code === ErrorCodes.MAX_GUILDS) throw e;

                if (isLimitError(info)) {
                    dest.free = 0;
                    this.log("info", `${dest.name} is out of sound slots`);
                    continue;
                }

                if (info.code === ErrorCodes.MISSING_ACCESS || info.code === ErrorCodes.MISSING_PERMISSIONS) {
                    dest.free = 0;
                    this.log("info", `No permission to add sounds in ${dest.name}`);
                    continue;
                }

                if ((emojiId || emojiName) && isEmojiError(info)) {
                    emojiId = emojiName = null;
                    this.log("info", `Discord didn't accept the emoji for "${name}", copying it without one`, item);
                    continue;
                }

                logger.error("Upload failed", item, e);
                return this.log("failed", info.message, item);
            }
        }
    }

    async run() {
        const { signal } = this.controller;

        try {
            if (this.target.mode === "existing") {
                const guild = GuildStore.getGuild(this.target.guildId);
                if (!guild) throw new Error("That server isn't available anymore");

                this.addDestination({
                    guildId: guild.id,
                    name: guild.name,
                    created: false,
                    free: getFreeSoundSlots(guild),
                    names: getExistingSoundNames(guild.id)
                });
            } else {
                await this.createDestination(this.target.name);
            }

            for (let i = 0; i < this.items.length; i++) {
                if (signal.aborted) break;

                const item = this.items[i];
                this.update({ current: item });
                this.sent = false;

                try {
                    await this.cloneOne(item);
                } catch (e) {
                    if (isAbortError(e)) throw e;

                    const info = parseHttpError(e);
                    if (info.code === ErrorCodes.MAX_GUILDS || info.captcha) throw e;

                    logger.error("Clone failed", item, e);
                    this.log("failed", info.message, item);
                }

                this.update({ processed: this.state.processed + 1 });

                if (this.sent && this.options.delayMs > 0 && i < this.items.length - 1)
                    await sleep(this.options.delayMs, signal);
            }

            this.update({ status: signal.aborted ? "cancelled" : "done" });
        } catch (e) {
            if (isAbortError(e) || signal.aborted) {
                this.update({ status: "cancelled" });
            } else {
                const info = parseHttpError(e);
                logger.error("Clone job failed", e);
                this.log("info", `Stopped: ${info.message}`, this.state.current);
                this.update({ status: "error", fatal: info.message });
            }
        } finally {
            this.update({ current: null, waitingUntil: null, finishedAt: Date.now() });
            this.toastResult();
        }
    }

    private toastResult() {
        const { status, succeeded, total, failed, skipped, fatal } = this.state;
        const tail = [failed && `${failed} failed`, skipped && `${skipped} skipped`].filter(Boolean).join(", ");
        const summary = `${succeeded}/${total} copied${tail ? ` (${tail})` : ""}`;

        if (status === "error") notify(`Sound clone stopped: ${fatal}`, "critical");
        else if (status === "cancelled") notify(`Sound clone cancelled: ${summary}`);
        else notify(`Sound clone finished: ${summary}`, failed ? "critical" : "success");
    }
}

let activeJob: CloneJob | null = null;

const getRunningJob = () => activeJob?.isRunning ? activeJob : null;

function startJob(items: SoundItem[], target: DestinationChoice, options: CloneOptions) {
    if (getRunningJob()) throw new Error("A sound clone is already running");
    const job = new CloneJob(items, target, options);
    activeJob = job;
    void job.run();
    return job;
}

function useJobState(job: CloneJob | null) {
    const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
    useEffect(() => job?.subscribe(forceUpdate), [job]);
    return job?.state ?? null;
}

function toast(text: string, critical = false) {
    notify(text, critical ? "critical" : "default");
}

let previewAudio: HTMLAudioElement | null = null;
let previewId: string | null = null;
let previewItemVolume = 1;

function previewGain() {
    const v = Number(settings.store.previewVolume);
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v / 100)) : 0.5;
}

function setPreviewVolume(percent: number) {
    settings.store.previewVolume = Math.round(Math.min(100, Math.max(0, percent)));
    if (previewAudio) previewAudio.volume = previewItemVolume * previewGain();
}

function VolumeControl() {
    const { previewVolume } = settings.use(["previewVolume"]);
    const value = Math.round(Math.min(100, Math.max(0, Number(previewVolume) || 0)));
    return (
        <label className={cl("volume")} title="How loud sounds play when you press ▶">
            <span className={cl("volume-icon")}>{value === 0 ? "🔇" : value < 50 ? "🔉" : "🔊"}</span>
            <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={value}
                aria-label="Preview volume"
                className={cl("volume-range")}
                onChange={e => setPreviewVolume(Number(e.currentTarget.value))}
            />
            <span className={cl("volume-value")}>{value}%</span>
        </label>
    );
}
const previewListeners = new Set<() => void>();

function notifyPreview() {
    for (const l of previewListeners) l();
}

function stopPreview() {
    if (previewAudio) {
        previewAudio.pause();
        previewAudio.src = "";
    }
    previewAudio = null;
    previewId = null;
    notifyPreview();
}

function togglePreview(item: SoundItem) {
    if (previewId === item.id) return stopPreview();
    stopPreview();

    const audio = new Audio(soundUrl(item.id));
    previewItemVolume = Math.min(1, Math.max(0, item.volume));
    audio.volume = previewItemVolume * previewGain();
    audio.onended = audio.onerror = () => {
        if (previewAudio === audio) stopPreview();
    };
    previewAudio = audio;
    previewId = item.id;
    notifyPreview();
    audio.play().catch(e => {
        logger.warn("Preview failed", e);
        if (previewAudio === audio) stopPreview();
    });
}

function usePreviewId() {
    const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
    useEffect(() => {
        previewListeners.add(forceUpdate);
        return () => void previewListeners.delete(forceUpdate);
    }, []);
    return previewId;
}

function formatDuration(ms: number) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h) return `${h}h ${m}m ${s}s`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
}

function GuildIcon({ guild, size }: { guild: Guild | null; size: number; }) {
    const style = { width: size, height: size, fontSize: Math.max(8, Math.round(size / 3)) };
    if (!guild) return <div className={classes(cl("guild-icon"), cl("guild-icon-text"))} style={style}>🔊</div>;

    const url = guild.icon ? IconUtils.getGuildIconURL({ id: guild.id, icon: guild.icon, canAnimate: false, size: size <= 32 ? 64 : 128 }) : null;
    if (url) return <img className={cl("guild-icon")} style={style} src={url} alt="" draggable={false} />;
    return <div className={classes(cl("guild-icon"), cl("guild-icon-text"))} style={style}>{getGuildAcronym(guild)}</div>;
}

function SoundEmoji({ item }: { item: SoundItem; }) {
    if (item.emojiId) return <img className={cl("emoji")} src={emojiUrl(item.emojiId)} alt="" loading="lazy" draggable={false} />;
    if (item.emojiName) return <span className={cl("emoji")}>{item.emojiName}</span>;
    return <span className={classes(cl("emoji"), cl("emoji-none"))}>🔊</span>;
}

function SoundTile({ item, selected, playing, saving, sourceName, onToggle }: { item: SoundItem; selected: boolean; playing: boolean; saving: boolean; sourceName?: string; onToggle(): void; }) {
    return (
        <div
            role="checkbox"
            tabIndex={0}
            aria-checked={selected}
            className={classes(cl("tile"), selected && cl("tile-selected"))}
            onClick={onToggle}
            onKeyDown={e => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onToggle();
                }
            }}
            title={item.name}
        >
            <SoundEmoji item={item} />
            <div className={cl("tile-text")}>
                <div className={cl("tile-name")}>{item.name}</div>
                {sourceName && <div className={cl("tile-sub")}>{sourceName}</div>}
            </div>
            <button
                className={classes(cl("play"), playing && cl("play-on"))}
                aria-label={playing ? "Stop" : "Play"}
                title={playing ? "Stop" : "Play"}
                onClick={e => {
                    e.stopPropagation();
                    togglePreview(item);
                }}
            >
                {playing ? "■" : "▶"}
            </button>
            <button
                className={cl("play")}
                aria-label="Save to your PC"
                title="Save to your PC"
                disabled={saving}
                onClick={e => {
                    e.stopPropagation();
                    void saveSounds([item], item.name);
                }}
            >
                ⭳
            </button>
            <span className={cl("check")}>{selected ? "✓" : ""}</span>
        </div>
    );
}

type Selection = Map<string, SoundItem>;

function PickerStep({ groups, selection, setSelection, focusId }: {
    groups: SourceGroup[];
    selection: Selection;
    setSelection: React.Dispatch<React.SetStateAction<Selection>>;
    focusId: string | null;
}) {
    const [focused, setFocused] = useState<string | null>(() => groups.find(g => g.id === focusId)?.id ?? groups[0]?.id ?? null);
    const [query, setQuery] = useState("");
    const playingId = usePreviewId();
    const saving = useSaveBusy();

    const group = groups.find(g => g.id === focused) ?? null;
    const q = query.trim().toLowerCase();

    const shown = useMemo(() => {
        if (!q) return (group?.sounds ?? []).map(item => ({ item, source: undefined as string | undefined }));
        return groups.flatMap(g => g.sounds.filter(s => s.name.toLowerCase().includes(q)).map(item => ({ item, source: g.name })));
    }, [groups, group, q]);

    const selectedPer = useMemo(() => {
        const counts = new Map<string, number>();
        for (const item of selection.values()) counts.set(item.sourceId, (counts.get(item.sourceId) ?? 0) + 1);
        return counts;
    }, [selection]);

    function toggle(item: SoundItem) {
        setSelection(prev => {
            const next = new Map(prev);
            if (next.has(item.id)) next.delete(item.id);
            else next.set(item.id, item);
            return next;
        });
    }

    function setMany(items: SoundItem[], on: boolean) {
        setSelection(prev => {
            const next = new Map(prev);
            for (const item of items) {
                if (on) next.set(item.id, item);
                else next.delete(item.id);
            }
            return next;
        });
    }

    const shownItems = shown.map(s => s.item);
    const allShownSelected = shownItems.length > 0 && shownItems.every(i => selection.has(i.id));

    if (!groups.length)
        return <div className={cl("empty")}>None of your servers have soundboard sounds yet, and Discord's default sounds didn't load.</div>;

    return (
        <div className={cl("picker")}>
            <div className={cl("rail")}>
                {groups.map(g => {
                    const count = selectedPer.get(g.id) ?? 0;
                    return (
                        <button
                            key={g.id}
                            className={classes(cl("rail-row"), g.id === focused && !q && cl("rail-row-active"))}
                            onClick={() => {
                                setFocused(g.id);
                                setQuery("");
                            }}
                            title={g.name}
                        >
                            <GuildIcon guild={g.guild} size={32} />
                            <div className={cl("rail-text")}>
                                <div className={cl("rail-name")}>{g.name}</div>
                                <div className={cl("rail-sub")}>{plural(g.sounds.length, "sound")}</div>
                            </div>
                            {count > 0 && <span className={cl("badge")}>{count}</span>}
                        </button>
                    );
                })}
            </div>

            <div className={cl("main")}>
                <div className={cl("toolbar")}>
                    <input
                        className={cl("input")}
                        placeholder="Search sounds in every server"
                        value={query}
                        onChange={e => setQuery(e.currentTarget.value)}
                        autoFocus
                    />
                    <button className={cl("tool-btn")} disabled={!shownItems.length} onClick={() => setMany(shownItems, !allShownSelected)}>
                        {allShownSelected ? "Clear These" : "Select These"}
                    </button>
                    <button className={cl("tool-btn")} disabled={!selection.size} onClick={() => setSelection(new Map())}>
                        Clear All
                    </button>
                    <button
                        className={cl("tool-btn")}
                        disabled={!selection.size || saving}
                        title="Save the picked sounds to your PC (several sounds come as one .zip)"
                        onClick={() => void saveSounds([...selection.values()], "Soundboard Sounds")}
                    >
                        {saving ? "Saving…" : `Save Selected (${selection.size})`}
                    </button>
                </div>
                <div className={cl("heading-row")}>
                    <div className={cl("heading")}>
                        {q ? `${plural(shown.length, "match")} for "${query.trim()}"` : group ? `${group.name}: ${plural(group.sounds.length, "sound")}` : ""}
                    </div>
                    <VolumeControl />
                </div>
                <div className={cl("grid")}>
                    {shown.map(({ item, source }) => (
                        <SoundTile
                            key={`${item.sourceId}:${item.id}`}
                            item={item}
                            sourceName={source}
                            selected={selection.has(item.id)}
                            playing={playingId === item.id}
                            saving={saving}
                            onToggle={() => toggle(item)}
                        />
                    ))}
                    {!shown.length && <div className={cl("empty")}>No sounds match that search.</div>}
                </div>
            </div>
        </div>
    );
}

function OptionRow({ title, note, checked, onChange }: { title: string; note: string; checked: boolean; onChange(v: boolean): void; }) {
    return (
        <div className={cl("option")}>
            <div className={cl("option-text")}>
                <div className={cl("option-title")}>{title}</div>
                <div className={cl("option-note")}>{note}</div>
            </div>
            <Switch checked={checked} onChange={onChange} />
        </div>
    );
}

function DestinationStep({ needed, destination, setDestination, options, setOptions, busy }: {
    needed: number;
    destination: DestinationChoice | null;
    setDestination(d: DestinationChoice): void;
    options: CloneOptions;
    setOptions: React.Dispatch<React.SetStateAction<CloneOptions>>;
    busy: boolean;
}) {
    const [filter, setFilter] = useState("");

    const candidates = useMemo(
        () => getOrderedGuilds().filter(canCreateExpressions).map(guild => ({ guild, used: getUsedSoundSlots(guild.id), max: getMaxSoundSlots(guild) })),
        []
    );

    const shown = useMemo(() => {
        const q = filter.trim().toLowerCase();
        return q ? candidates.filter(c => c.guild.name.toLowerCase().includes(q)) : candidates;
    }, [candidates, filter]);

    const picked = destination?.mode === "existing" ? candidates.find(c => c.guild.id === destination.guildId) ?? null : null;
    const free = destination?.mode === "create" ? NEW_GUILD_SLOTS : picked ? Math.max(0, picked.max - picked.used) : null;

    const short = free == null ? 0 : Math.max(0, needed - free);
    const extraUncapped = Math.ceil(short / NEW_GUILD_SLOTS);
    const extra = options.overflow ? Math.min(extraUncapped, options.maxOverflowServers) : 0;
    const unplaceable = Math.max(0, short - extra * NEW_GUILD_SLOTS);

    function pickCreate() {
        if (destination?.mode !== "create") setDestination({ mode: "create", name: options.overflowBaseName });
    }

    return (
        <div className={cl("dest")}>
            <div className={cl("dest-list-wrap")}>
                <input className={cl("input")} placeholder="Search your servers" value={filter} onChange={e => setFilter(e.currentTarget.value)} />
                <div className={cl("dest-list")} role="radiogroup" aria-label="Destination">
                    <div
                        role="radio"
                        tabIndex={0}
                        aria-checked={destination?.mode === "create"}
                        className={classes(cl("dest-row"), destination?.mode === "create" && cl("dest-row-active"))}
                        onClick={pickCreate}
                        onKeyDown={e => {
                            if (e.key !== "Enter" && e.key !== " ") return;
                            e.preventDefault();
                            pickCreate();
                        }}
                    >
                        <div className={classes(cl("guild-icon"), cl("guild-icon-text"))} style={{ width: 40, height: 40, fontSize: 22 }}>+</div>
                        <div className={cl("dest-row-text")}>
                            <div className={cl("dest-row-name")}>Create a new server</div>
                            <div className={cl("dest-row-sub")}>A fresh server has {NEW_GUILD_SLOTS} sound slots</div>
                        </div>
                    </div>

                    {destination?.mode === "create" && (
                        <div className={cl("dest-create")}>
                            <input
                                className={cl("input")}
                                value={destination.name}
                                maxLength={100}
                                placeholder="Server name"
                                autoFocus
                                onChange={e => setDestination({ mode: "create", name: e.currentTarget.value })}
                            />
                        </div>
                    )}

                    {shown.map(({ guild, used, max }) => {
                        const active = destination?.mode === "existing" && destination.guildId === guild.id;
                        const room = Math.max(0, max - used);
                        return (
                            <div
                                key={guild.id}
                                role="radio"
                                tabIndex={0}
                                aria-checked={active}
                                className={classes(cl("dest-row"), active && cl("dest-row-active"))}
                                onClick={() => setDestination({ mode: "existing", guildId: guild.id })}
                                onKeyDown={e => {
                                    if (e.key !== "Enter" && e.key !== " ") return;
                                    e.preventDefault();
                                    setDestination({ mode: "existing", guildId: guild.id });
                                }}
                            >
                                <GuildIcon guild={guild} size={40} />
                                <div className={cl("dest-row-text")}>
                                    <div className={cl("dest-row-name")}>{guild.name}</div>
                                    <span className={classes(cl("pill"), room >= needed ? cl("pill-ok") : cl("pill-warn"))}>
                                        Sounds {used}/{max}
                                    </span>
                                </div>
                            </div>
                        );
                    })}

                    {!shown.length && (
                        <div className={cl("empty")}>
                            {filter ? "No matching servers you can add sounds to" : "You can't add sounds to any of your servers. Create a new one instead"}
                        </div>
                    )}
                </div>
            </div>

            <div className={cl("dest-side")}>
                <div className={cl("card")}>
                    <div className={cl("card-title")}>Selected</div>
                    <div className={cl("card-body")}>{plural(needed, "sound")}</div>
                </div>

                <div className={cl("card")}>
                    <OptionRow
                        title="Skip duplicates"
                        note="Don't copy a sound whose name is already in the server."
                        checked={options.skipDuplicates}
                        onChange={v => setOptions(o => ({ ...o, skipDuplicates: v }))}
                    />
                    <OptionRow
                        title="Keep emojis"
                        note="Copy each sound's emoji too, when Discord accepts it."
                        checked={options.keepEmojis}
                        onChange={v => setOptions(o => ({ ...o, keepEmojis: v }))}
                    />
                    <OptionRow
                        title="New servers when full"
                        note={`Make up to ${options.maxOverflowServers} extra servers once this one runs out of slots.`}
                        checked={options.overflow}
                        onChange={v => setOptions(o => ({ ...o, overflow: v }))}
                    />
                    {options.overflow && (
                        <div className={cl("option-field")}>
                            <div className={cl("option-note")}>Name for extra servers</div>
                            <input
                                className={cl("input")}
                                value={options.overflowBaseName}
                                maxLength={95}
                                onChange={e => setOptions(o => ({ ...o, overflowBaseName: e.currentTarget.value }))}
                            />
                            {sanitizeServerName(options.overflowBaseName).length < 2 && (
                                <div className={cl("note-warn")}>Server names need at least 2 characters.</div>
                            )}
                        </div>
                    )}
                </div>

                <div className={cl("card")}>
                    <div className={cl("card-title")}>Plan</div>
                    <div className={cl("card-body")}>
                        {free == null ? "Pick where the sounds go." : (
                            <>
                                <div>{destination?.mode === "create" ? "The new server" : picked?.guild.name} has room for {plural(free, "sound")}.</div>
                                {extra > 0 && <div className={cl("note-info")}>Will create {plural(extra, "extra server")} for the rest.</div>}
                                {unplaceable > 0 && (
                                    <div className={cl("note-warn")}>
                                        {plural(unplaceable, "sound")} won't fit and will be skipped
                                        {options.overflow
                                            ? extraUncapped > options.maxOverflowServers ? ` (it would need ${extraUncapped} extra servers, the limit is ${options.maxOverflowServers})` : ""
                                            : ". Turn on \"New servers when full\" to fit everything"}.
                                    </div>
                                )}
                                {options.skipDuplicates && <div className={cl("note-muted")}>Duplicates are skipped, so fewer may get copied.</div>}
                            </>
                        )}
                    </div>
                </div>

                <div className={cl("note-muted")}>Discord rate-limits sound uploads, so big clones can take a while. Cloning keeps going if you close this window.</div>
                {busy && <div className={cl("note-warn")}>Another sound clone is still running. Wait for it or cancel it first.</div>}
            </div>
        </div>
    );
}

const STATUS_LABEL: Record<LogStatus, string> = { success: "Copied", skipped: "Skipped", failed: "Failed", info: "Info" };

function headline(state: JobState) {
    switch (state.status) {
        case "running":
            return state.waitingUntil
                ? `Rate limited by Discord. Going again in ${formatDuration(state.waitingUntil - Date.now())}`
                : `Copying… ${state.processed} / ${state.total}`;
        case "done":
            return `Finished in ${formatDuration((state.finishedAt ?? Date.now()) - state.startedAt)}`;
        case "cancelled":
            return "Cancelled";
        case "error":
            return `Stopped: ${state.fatal}`;
    }
}

function ProgressStep({ job, onNavigate }: { job: CloneJob; onNavigate(): void; }) {
    const state = useJobState(job)!;
    const [, tick] = useReducer((x: number) => x + 1, 0);

    useEffect(() => {
        if (!state.waitingUntil) return;
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [state.waitingUntil]);

    const pct = state.total ? Math.round((state.processed / state.total) * 100) : 100;
    const log = state.log.slice(-300).reverse();

    return (
        <div className={cl("progress")}>
            <div className={classes(cl("progress-title"), state.status === "error" && cl("note-warn"))}>{headline(state)}</div>
            <div className={cl("bar")} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                <div className={classes(cl("bar-fill"), state.waitingUntil != null && cl("bar-fill-wait"))} style={{ width: `${pct}%` }} />
            </div>
            <div className={cl("stats")}>
                <span className={cl("stat-ok")}>{state.succeeded} copied</span>
                <span className={cl("stat-skip")}>{state.skipped} skipped</span>
                <span className={cl("stat-fail")}>{state.failed} failed</span>
                <span>{state.total - state.processed} left</span>
            </div>

            {state.destinations.length > 0 && (
                <div className={cl("chips")}>
                    {state.destinations.map(d => (
                        <button
                            key={d.id}
                            className={cl("chip")}
                            title={`Go to ${d.name}`}
                            onClick={() => {
                                NavigationRouter.transitionToGuild(d.id);
                                onNavigate();
                            }}
                        >
                            <GuildIcon guild={GuildStore.getGuild(d.id) ?? null} size={20} />
                            <span>{d.name}</span>
                            {d.created && <span className={cl("chip-tag")}>NEW</span>}
                        </button>
                    ))}
                </div>
            )}

            <div className={cl("log")}>
                {log.map(entry => (
                    <div key={entry.id} className={classes(cl("log-row"), cl(`log-${entry.status}`))}>
                        <span className={cl("log-status")}>{STATUS_LABEL[entry.status]}</span>
                        <span className={cl("log-name")}>{entry.item?.name ?? ""}</span>
                        <span className={cl("log-message")}>{entry.message}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

type Step = "pick" | "destination" | "progress";

interface ClonerInit {
    focusId?: string | null;
    selectAllFrom?: string | null;
    step?: Step;
}

function ClonerModal({ modalProps, init }: { modalProps: RenderModalProps; init: ClonerInit; }) {
    const [groups, setGroups] = useState(buildSourceGroups);

    const [selection, setSelection] = useState<Selection>(() => {
        const from = init.selectAllFrom ? groups.find(g => g.id === init.selectAllFrom) : null;
        return new Map((from?.sounds ?? []).map(s => [s.id, s] as const));
    });

    const [job, setJob] = useState<CloneJob | null>(() => getRunningJob() ?? (init.step === "progress" ? activeJob : null));
    const [deferredInit, setDeferredInit] = useState(() => !!job && init.step !== "progress");
    const jobState = useJobState(job);
    const [step, setStep] = useState<Step>(() => job ? "progress" : init.step === "destination" && selection.size ? "destination" : "pick");
    const [destination, setDestination] = useState<DestinationChoice | null>(null);
    const [options, setOptions] = useState<CloneOptions>(getDefaultOptions);

    const stepChangedAt = useRef(0);
    useEffect(() => stopPreview, []);
    useEffect(() => {
        if (step !== "pick") stopPreview();
    }, [step]);

    const guarded = (fn: () => void) => () => {
        if (Date.now() - stepChangedAt.current >= 400) fn();
    };

    const running = jobState?.status === "running";
    useEffect(() => {
        stepChangedAt.current = Date.now();
    }, [step, running]);

    const otherJobRunning = !!getRunningJob() && getRunningJob() !== job;

    const destinationValid = !!destination && (destination.mode === "existing"
        ? !!GuildStore.getGuild(destination.guildId)
        : sanitizeServerName(destination.name).length >= 2)
        && (!options.overflow || sanitizeServerName(options.overflowBaseName).length >= 2);

    function start() {
        if (!destination || !destinationValid || !selection.size) return;
        try {
            rememberOptions(options);
            const target: DestinationChoice = destination.mode === "create"
                ? { mode: "create", name: sanitizeServerName(destination.name) }
                : destination;
            setJob(startJob([...selection.values()], target, options));
            setStep("progress");
        } catch (e: any) {
            toast(e?.message ?? "Couldn't start the clone", true);
        }
    }

    function restart() {
        const fresh = buildSourceGroups();
        setGroups(fresh);
        const from = deferredInit && init.selectAllFrom ? fresh.find(g => g.id === init.selectAllFrom) : null;
        const next = new Map((from?.sounds ?? []).map(s => [s.id, s] as const));
        setDeferredInit(false);
        setSelection(next);
        setDestination(null);
        setJob(null);
        setStep(from && next.size && init.step === "destination" ? "destination" : "pick");
    }

    let subtitle: string;
    let actions: ModalAction[];

    switch (step) {
        case "pick":
            subtitle = "Pick the sounds you want to copy. Press ▶ to hear one, ⭳ to save one to your PC.";
            actions = [
                { text: "Cancel", variant: "secondary", onClick: guarded(modalProps.onClose) },
                { text: `Next (${selection.size})`, variant: "primary", disabled: !selection.size, onClick: guarded(() => setStep("destination")) }
            ];
            break;
        case "destination":
            subtitle = "Choose where they go.";
            actions = [
                { text: "Back", variant: "secondary", onClick: guarded(() => setStep("pick")) },
                { text: "Start Cloning", variant: "primary", disabled: !destinationValid || !selection.size || otherJobRunning, onClick: guarded(start) }
            ];
            break;
        case "progress":
            subtitle = running ? "You can close this window. Copying keeps going in the background." : jobState?.status === "cancelled" ? "Cancelled." : jobState?.status === "error" ? "Stopped early." : "Done.";
            actions = running
                ? [
                    { text: "Hide", variant: "secondary", onClick: guarded(modalProps.onClose) },
                    { text: "Cancel Clone", variant: "critical-primary", onClick: guarded(() => job?.cancel()) }
                ]
                : [
                    { text: "Clone More", variant: "secondary", onClick: guarded(restart) },
                    { text: "Close", variant: "primary", onClick: guarded(modalProps.onClose) }
                ];
            break;
    }

    return (
        <Modal {...modalProps} size="xl" title="Clone Sounds" subtitle={subtitle} actions={actions}>
            <style>{CSS}</style>
            <div className={cl("root")}>
                <ErrorBoundary>
                    {step === "pick" && <PickerStep groups={groups} selection={selection} setSelection={setSelection} focusId={init.focusId ?? init.selectAllFrom ?? null} />}
                    {step === "destination" && (
                        <DestinationStep
                            needed={selection.size}
                            destination={destination}
                            setDestination={setDestination}
                            options={options}
                            setOptions={setOptions}
                            busy={otherJobRunning}
                        />
                    )}
                    {step === "progress" && job && <ProgressStep job={job} onNavigate={modalProps.onClose} />}
                </ErrorBoundary>
            </div>
        </Modal>
    );
}

let opening = false;

async function saveGuildSounds(guild: Guild) {
    await ensureSoundsLoaded();
    const sounds = SoundboardStore.getSoundsForGuild(guild.id) ?? [];
    if (!sounds.length) return toast(`${guild.name} has no soundboard sounds`);
    await saveSounds(sounds.map(s => soundToItem(s, guild.id)), guild.name);
}

async function openCloner(init: ClonerInit = {}) {
    if (opening) return;
    opening = true;
    try {
        if (init.step !== "progress") await ensureSoundsLoaded();
        openModal(modalProps => <ClonerModal modalProps={modalProps} init={init} />);
    } catch (e) {
        logger.error("Couldn't open the sound cloner", e);
        toast("Couldn't open the sound cloner", true);
    } finally {
        opening = false;
    }
}

const guildContextPatch: NavContextMenuPatchCallback = (children, { guild }: { guild?: Guild; }) => {
    if (!guild) return;

    const running = getRunningJob();
    const count = SoundboardStore.hasFetchedAllSounds() ? SoundboardStore.getSoundsForGuild(guild.id)?.length ?? 0 : -1;

    const item = (
        <Menu.MenuItem id="vc-sbc-guild" key="vc-sbc-guild" label="Clone Sounds">
            <Menu.MenuItem id="vc-sbc-guild-pick" label="Pick Sounds…" action={() => openCloner({ focusId: guild.id })} />
            {count !== 0 && (
                <Menu.MenuItem id="vc-sbc-guild-all" label="Clone All Sounds…" action={() => openCloner({ selectAllFrom: guild.id, step: "destination" })} />
            )}
            {count !== 0 && (
                <Menu.MenuItem
                    id="vc-sbc-guild-save"
                    label="Save All Sounds…"
                    disabled={saveBusy}
                    action={() => void saveGuildSounds(guild)}
                />
            )}
            {activeJob && (
                <Menu.MenuItem id="vc-sbc-guild-progress" label={running ? "View Clone Progress" : "View Last Clone"} action={() => openCloner({ step: "progress" })} />
            )}
            {running && <Menu.MenuItem id="vc-sbc-guild-cancel" label="Cancel Running Clone" color="danger" action={() => running.cancel()} />}
        </Menu.MenuItem>
    );

    const group = findGroupChildrenByChildId("privacy", children);
    if (group) group.push(item);
    else children.push(item);
};

const CSS = `
.vc-sbc-root {
    --sbc-bg: var(--background-base-low, var(--background-secondary, #2b2d31));
    --sbc-rail: var(--background-base-lower, var(--background-tertiary, #1e1f22));
    --sbc-input: var(--background-base-lowest, var(--input-background, #1e1f22));
    --sbc-hover: var(--background-modifier-hover, rgb(78 80 88 / 30%));
    --sbc-active: var(--background-modifier-selected, rgb(78 80 88 / 60%));
    --sbc-border: var(--border-subtle, var(--background-modifier-accent, rgb(78 80 88 / 48%)));
    --sbc-brand: var(--brand-500, #5865f2);
    --sbc-text: var(--text-default, var(--text-normal, #dbdee1));
    --sbc-muted: var(--text-muted, #949ba4);
    --sbc-green: var(--status-positive, #23a55a);
    --sbc-yellow: var(--status-warning, #f0b232);
    --sbc-red: var(--status-danger, #f23f43);
    color: var(--sbc-text);
    font-size: 14px;
}
.vc-sbc-root button { font: inherit; }
.vc-sbc-picker {
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr);
    height: min(64vh, 620px);
    min-height: 360px;
    border: 1px solid var(--sbc-border);
    border-radius: 8px;
    overflow: hidden;
    background: var(--sbc-bg);
}
.vc-sbc-rail {
    overflow-y: auto;
    background: var(--sbc-rail);
    border-right: 1px solid var(--sbc-border);
    padding: 6px;
}
.vc-sbc-rail-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--sbc-text);
    text-align: left;
    cursor: pointer;
}
.vc-sbc-rail-row:hover { background: var(--sbc-hover); }
.vc-sbc-rail-row-active, .vc-sbc-rail-row-active:hover { background: var(--sbc-active); }
.vc-sbc-rail-text { flex: 1; min-width: 0; }
.vc-sbc-rail-name, .vc-sbc-tile-name, .vc-sbc-dest-row-name {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-weight: 500;
}
.vc-sbc-rail-sub, .vc-sbc-tile-sub, .vc-sbc-dest-row-sub {
    color: var(--sbc-muted);
    font-size: 12px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
}
.vc-sbc-badge {
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    box-sizing: border-box;
    border-radius: 9px;
    background: var(--sbc-brand);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    line-height: 18px;
    text-align: center;
}
.vc-sbc-main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
}
.vc-sbc-toolbar {
    display: flex;
    gap: 8px;
    padding: 10px 12px 6px;
}
.vc-sbc-input {
    flex: 1;
    min-width: 0;
    box-sizing: border-box;
    width: 100%;
    padding: 7px 10px;
    border: 1px solid var(--sbc-border);
    border-radius: 6px;
    background: var(--sbc-input);
    color: var(--sbc-text);
    font-size: 14px;
    outline: none;
}
.vc-sbc-input:focus { border-color: var(--sbc-brand); }
.vc-sbc-dest-list-wrap > .vc-sbc-input { flex: none; }
.vc-sbc-tool-btn {
    flex: none;
    padding: 0 12px;
    border: 1px solid var(--sbc-border);
    border-radius: 6px;
    background: var(--sbc-hover);
    color: var(--sbc-text);
    cursor: pointer;
    white-space: nowrap;
}
.vc-sbc-tool-btn:hover:not(:disabled) { background: var(--sbc-active); }
.vc-sbc-tool-btn:disabled { opacity: 0.5; cursor: default; }
.vc-sbc-heading-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 2px 12px 6px;
}
.vc-sbc-volume {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--sbc-muted);
    font-size: 12px;
    cursor: pointer;
}
.vc-sbc-volume-icon { width: 18px; text-align: center; font-size: 14px; }
.vc-sbc-volume-range { width: 120px; accent-color: var(--sbc-brand); cursor: pointer; }
.vc-sbc-volume-value { width: 34px; text-align: right; font-variant-numeric: tabular-nums; }
.vc-sbc-heading {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--sbc-muted);
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
}
.vc-sbc-grid {
    flex: 1;
    overflow-y: auto;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    align-content: start;
    gap: 8px;
    padding: 0 12px 12px;
}
.vc-sbc-tile {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px;
    border: 2px solid transparent;
    border-radius: 8px;
    background: var(--sbc-hover);
    cursor: pointer;
    user-select: none;
    outline: none;
}
.vc-sbc-tile:hover { background: var(--sbc-active); }
.vc-sbc-tile:focus-visible { border-color: var(--sbc-muted); }
.vc-sbc-tile-selected, .vc-sbc-tile-selected:focus-visible { border-color: var(--sbc-brand); }
.vc-sbc-tile-text { flex: 1; min-width: 0; }
.vc-sbc-emoji {
    flex: none;
    width: 24px;
    height: 24px;
    font-size: 20px;
    line-height: 24px;
    text-align: center;
    object-fit: contain;
}
.vc-sbc-emoji-none { opacity: 0.5; }
.vc-sbc-play {
    flex: none;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 50%;
    background: var(--sbc-rail);
    color: var(--sbc-text);
    font-size: 11px;
    cursor: pointer;
}
.vc-sbc-play:hover:not(:disabled), .vc-sbc-play-on { background: var(--sbc-brand); color: #fff; }
.vc-sbc-play:disabled { opacity: 0.5; cursor: default; }
.vc-sbc-check {
    position: absolute;
    top: -6px;
    right: -6px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--sbc-brand);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    line-height: 18px;
    text-align: center;
    display: none;
}
.vc-sbc-tile-selected .vc-sbc-check { display: block; }
.vc-sbc-empty {
    grid-column: 1 / -1;
    padding: 24px;
    color: var(--sbc-muted);
    text-align: center;
}
.vc-sbc-guild-icon {
    flex: none;
    border-radius: 30%;
    object-fit: cover;
}
.vc-sbc-guild-icon-text {
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--sbc-active);
    color: var(--sbc-text);
    font-weight: 600;
    overflow: hidden;
}
.vc-sbc-dest {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 320px;
    gap: 12px;
    height: min(64vh, 620px);
    min-height: 360px;
}
.vc-sbc-dest-list-wrap {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
}
.vc-sbc-dest-list {
    flex: 1;
    overflow-y: auto;
    border: 1px solid var(--sbc-border);
    border-radius: 8px;
    background: var(--sbc-bg);
    padding: 6px;
}
.vc-sbc-dest-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px;
    border-radius: 6px;
    cursor: pointer;
    outline: none;
}
.vc-sbc-dest-row:hover, .vc-sbc-dest-row:focus-visible { background: var(--sbc-hover); }
.vc-sbc-dest-row-active, .vc-sbc-dest-row-active:hover { background: var(--sbc-active); }
.vc-sbc-dest-row-text { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 3px; }
.vc-sbc-dest-create { padding: 4px 8px 10px 58px; }
.vc-sbc-pill {
    padding: 1px 8px;
    border-radius: 10px;
    background: var(--sbc-rail);
    font-size: 12px;
}
.vc-sbc-pill-ok { color: var(--sbc-green); }
.vc-sbc-pill-warn { color: var(--sbc-yellow); }
.vc-sbc-dest-side {
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow-y: auto;
}
.vc-sbc-card {
    border: 1px solid var(--sbc-border);
    border-radius: 8px;
    background: var(--sbc-bg);
    padding: 10px 12px;
}
.vc-sbc-card-title {
    color: var(--sbc-muted);
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    margin-bottom: 4px;
}
.vc-sbc-card-body { display: flex; flex-direction: column; gap: 6px; }
.vc-sbc-option {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 0;
}
.vc-sbc-option-text { flex: 1; min-width: 0; }
.vc-sbc-option-title { font-weight: 500; }
.vc-sbc-option-note, .vc-sbc-note-muted { color: var(--sbc-muted); font-size: 12px; }
.vc-sbc-option-field { display: flex; flex-direction: column; gap: 4px; padding-top: 4px; }
.vc-sbc-note-info { color: var(--sbc-text); }
.vc-sbc-note-warn { color: var(--sbc-yellow); }
.vc-sbc-progress { display: flex; flex-direction: column; gap: 10px; min-height: 360px; }
.vc-sbc-progress-title { font-size: 16px; font-weight: 600; }
.vc-sbc-bar {
    height: 8px;
    border-radius: 4px;
    background: var(--sbc-rail);
    overflow: hidden;
}
.vc-sbc-bar-fill {
    height: 100%;
    background: var(--sbc-brand);
    transition: width 0.3s ease;
}
.vc-sbc-bar-fill-wait { background: var(--sbc-yellow); }
.vc-sbc-stats { display: flex; flex-wrap: wrap; gap: 14px; color: var(--sbc-muted); font-size: 13px; }
.vc-sbc-stat-ok { color: var(--sbc-green); }
.vc-sbc-stat-skip { color: var(--sbc-yellow); }
.vc-sbc-stat-fail { color: var(--sbc-red); }
.vc-sbc-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.vc-sbc-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px 3px 4px;
    border: 1px solid var(--sbc-border);
    border-radius: 14px;
    background: var(--sbc-bg);
    color: var(--sbc-text);
    cursor: pointer;
}
.vc-sbc-chip:hover { background: var(--sbc-hover); }
.vc-sbc-chip-tag {
    padding: 0 5px;
    border-radius: 4px;
    background: var(--sbc-brand);
    color: #fff;
    font-size: 10px;
    font-weight: 700;
}
.vc-sbc-log {
    flex: 1;
    max-height: 46vh;
    overflow-y: auto;
    border: 1px solid var(--sbc-border);
    border-radius: 8px;
    background: var(--sbc-bg);
    padding: 4px 0;
}
.vc-sbc-log-row {
    display: grid;
    grid-template-columns: 64px minmax(0, 200px) minmax(0, 1fr);
    gap: 10px;
    padding: 3px 12px;
    font-size: 13px;
}
.vc-sbc-log-name, .vc-sbc-log-message { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.vc-sbc-log-message { color: var(--sbc-muted); }
.vc-sbc-log-status { font-weight: 600; }
.vc-sbc-log-success .vc-sbc-log-status { color: var(--sbc-green); }
.vc-sbc-log-skipped .vc-sbc-log-status { color: var(--sbc-yellow); }
.vc-sbc-log-failed .vc-sbc-log-status { color: var(--sbc-red); }
.vc-sbc-log-info .vc-sbc-log-status { color: var(--sbc-muted); }
`;

export default definePlugin({
    name: "SoundboardCloner",
    description: "Copy soundboard sounds from any server you're in (or Discord's defaults) into servers you manage, in bulk, or save them to your PC. Right-click a server and pick Clone Sounds.",
    tags: ["Servers", "Voice"],
    searchTerms: ["SoundCloner", "SoundboardCopy", "Sounds", "Soundboard"],
    authors: [{ name: "nolifepops", id: 221807880053981184n }],
    settings,

    contextMenus: {
        "guild-context": guildContextPatch,
        "guild-header-popout": guildContextPatch
    },

    openCloner,

    stop() {
        activeJob?.cancel();
        stopPreview();
    }
});
