/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface MediaInfo {
    duration: number;
    width: number;
    height: number;
    fps: number;
    hasVideo: boolean;
    hasAudio: boolean;
    audioChannels: number;
    audioKbps: number;
    totalKbps: number;
}

export interface VideoPlan {
    ok: boolean;
    reason?: string;
    videoKbps: number;
    audioKbps: number;
    audioChannels: number;
    shortSide: number;
    fps: number;
}

export interface AudioPlan {
    ok: boolean;
    reason?: string;
    kbps: number;
    channels: number;
}

const CONTAINER_SHARE = 0.96;
const MIN_VIDEO_KBPS = 80;
const MIN_BPP = 0.075;
const LADDER = [2160, 1440, 1080, 900, 720, 540, 480, 360, 288, 240, 180, 144];

export const budgetKbps = (targetBytes: number, seconds: number, share = CONTAINER_SHARE) =>
    targetBytes * 8 / 1000 / seconds * share;

function pickAudio(totalKbps: number, info: MediaInfo) {
    if (!info.hasAudio) return { kbps: 0, channels: 0 };
    const kbps = totalKbps >= 3000 ? 160 : totalKbps >= 1500 ? 128 : totalKbps >= 700 ? 96 : totalKbps >= 350 ? 64 : 48;
    const capped = info.audioKbps > 0 ? Math.min(kbps, Math.max(32, info.audioKbps)) : kbps;
    return { kbps: capped, channels: capped <= 64 || info.audioChannels === 1 ? 1 : 2 };
}

export function planVideo(info: MediaInfo, targetBytes: number, maxFps = 60, share = CONTAINER_SHARE): VideoPlan {
    const total = budgetKbps(targetBytes, info.duration, share);
    let { kbps: audioKbps, channels: audioChannels } = pickAudio(total, info);
    let videoKbps = total - audioKbps;

    if (videoKbps < MIN_VIDEO_KBPS && audioKbps > 32) {
        audioKbps = 32;
        audioChannels = 1;
        videoKbps = total - audioKbps;
    }

    const srcFps = info.fps > 0 ? info.fps : 30;
    let fps = Math.min(srcFps, maxFps);
    if (videoKbps < 1500) fps = Math.min(fps, 30);
    if (videoKbps < 300) fps = Math.min(fps, 24);

    const srcShort = Math.max(2, Math.min(info.width, info.height));
    const aspect = Math.max(info.width, info.height) / srcShort;
    const sides = [srcShort, ...LADDER.filter(s => s < srcShort)];
    const sideAt = (rate: number) => sides.find(s => videoKbps * 1000 / (s * s * aspect * rate) >= MIN_BPP) ?? sides[sides.length - 1];
    let shortSide = sideAt(fps);
    if (fps > 30 && shortSide < Math.min(srcShort, 720) && sideAt(30) > shortSide) {
        fps = 30;
        shortSide = sideAt(30);
    }

    if (videoKbps < MIN_VIDEO_KBPS)
        return { ok: false, reason: "It is too long to fit at a watchable quality. Trim it first.", videoKbps, audioKbps, audioChannels, shortSide, fps };

    return { ok: true, videoKbps: Math.floor(videoKbps), audioKbps, audioChannels, shortSide, fps };
}

export function planAudio(info: MediaInfo, targetBytes: number): AudioPlan {
    const raw = budgetKbps(targetBytes, info.duration, 0.97);
    const ceiling = info.audioKbps > 0 ? Math.min(256, Math.max(48, info.audioKbps)) : 256;
    const kbps = Math.floor(Math.min(raw, ceiling));
    const channels = kbps < 40 || info.audioChannels === 1 ? 1 : 2;
    if (kbps < 8) return { ok: false, reason: "It is too long to fit even at the lowest audio quality. Trim it first.", kbps, channels };
    return { ok: true, kbps, channels };
}

export const correctKbps = (kbps: number, targetBytes: number, actualBytes: number) =>
    Math.floor(kbps * targetBytes * 0.98 / actualBytes);

export interface GifStep {
    scale: number;
    fps: number;
    colors: number;
}

export function firstGifStep(size: number, targetBytes: number, srcFps: number): GifStep {
    return { scale: Math.min(1, Math.sqrt(targetBytes / size) * 0.92), fps: Math.min(srcFps > 0 ? srcFps : 15, 30), colors: 256 };
}

export function nextGifStep(step: GifStep, targetBytes: number, actualBytes: number): GifStep | null {
    const ratio = targetBytes / actualBytes;
    if (step.colors > 128 && ratio > 0.85) return { ...step, colors: 128 };
    const next = { ...step, scale: step.scale * Math.sqrt(ratio) * 0.95 };
    if (next.scale < 0.5 && step.fps > 12) {
        next.scale = step.scale;
        next.fps = Math.max(10, Math.round(step.fps * 0.7));
    }
    return next.scale < 0.08 ? null : next;
}

export interface ImageAttempt {
    size: number;
    blob: unknown;
}

export async function searchImage<T extends ImageAttempt>(
    encode: (scale: number, quality: number) => Promise<T>,
    targetBytes: number,
    lossless: boolean,
    signal?: AbortSignal
): Promise<T | null> {
    let scale = 1;
    let fallback: T | null = null;
    for (let round = 0; round < 6 && scale >= 0.05; round++) {
        signal?.throwIfAborted();
        const top = await encode(scale, lossless ? 1 : 0.92);
        if (top.size <= targetBytes) return top;
        if (lossless) {
            scale *= Math.sqrt(targetBytes / top.size) * 0.95;
            continue;
        }

        const floor = await encode(scale, 0.5);
        if (floor.size > targetBytes) {
            scale *= Math.sqrt(targetBytes / floor.size) * 0.95;
            continue;
        }

        let lo = 0.5, hi = 0.92, best = floor;
        for (let i = 0; i < 5 && hi - lo > 0.03 && best.size < targetBytes * 0.97; i++) {
            signal?.throwIfAborted();
            const mid = (lo + hi) / 2;
            const out = await encode(scale, mid);
            if (out.size <= targetBytes) { best = out; lo = mid; } else hi = mid;
        }
        if (lo >= 0.75 || fallback) return best;
        fallback = best;
        scale *= Math.sqrt(targetBytes / top.size) * 0.97;
    }
    return fallback;
}

export const seconds = (h: string, m: string, s: string) => Number(h) * 3600 + Number(m) * 60 + Number(s);

export function parseProbe(text: string): MediaInfo {
    const info: MediaInfo = { duration: 0, width: 0, height: 0, fps: 0, hasVideo: false, hasAudio: false, audioChannels: 2, audioKbps: 0, totalKbps: 0 };
    const dur = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
    if (dur) info.duration = seconds(dur[1], dur[2], dur[3]);
    const total = /Duration:.*?bitrate: (\d+) kb\/s/.exec(text);
    if (total) info.totalKbps = Number(total[1]);

    for (const line of text.split(/\r?\n/)) {
        if (!/^\s*Stream #/.test(line)) continue;
        if (!info.hasVideo && /: Video: /.test(line) && !/\(attached pic\)/.test(line)) {
            const size = /, (\d{2,5})x(\d{2,5})/.exec(line);
            if (!size) continue;
            info.hasVideo = true;
            info.width = Number(size[1]);
            info.height = Number(size[2]);
            const fps = /([\d.]+) fps/.exec(line) ?? /([\d.]+) tbr/.exec(line);
            if (fps) info.fps = Number(fps[1]);
        } else if (!info.hasAudio && /: Audio: /.test(line)) {
            info.hasAudio = true;
            if (/\bmono\b/.test(line)) info.audioChannels = 1;
            const kbps = /(\d+) kb\/s/.exec(line);
            if (kbps) info.audioKbps = Number(kbps[1]);
        }
    }
    return info;
}

export const formatBytes = (bytes: number) => {
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
    return `${bytes.toFixed(bytes >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
};
