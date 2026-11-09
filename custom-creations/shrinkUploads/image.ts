/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { searchImage } from "./plan";

export type ImageFormat = "auto" | "webp" | "jpeg";

const MAX_SIDE = 16383;
const MAX_AREA = 16383 * 16383 / 2;
const ALPHA_PROBE = 1024;

async function head(file: Blob, bytes: number) {
    return new Uint8Array(await file.slice(0, bytes).arrayBuffer());
}

const ascii = (b: Uint8Array, at: number, text: string) => [...text].every((c, i) => b[at + i] === c.charCodeAt(0));

async function isAnimatedPng(file: File) {
    let at = 8;
    while (at + 8 <= file.size) {
        const b = await head(file.slice(at), 8);
        const length = new DataView(b.buffer).getUint32(0);
        if (ascii(b, 4, "acTL")) return true;
        if (ascii(b, 4, "IDAT") || ascii(b, 4, "IEND")) return false;
        at += 12 + length;
    }
    return false;
}

export async function isAnimatedStill(file: File) {
    const b = await head(file, 64);
    if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return ascii(b, 12, "VP8X") && (b[20] & 0x02) !== 0;
    if (b[0] === 0x89 && ascii(b, 1, "PNG")) return isAnimatedPng(file);
    if (ascii(b, 4, "ftyp")) {
        const size = new DataView(b.buffer).getUint32(0);
        const end = Math.min(size >= 16 ? size : b.length, b.length);
        const brands = [8];
        for (let at = 16; at + 4 <= end; at += 4) brands.push(at);
        return brands.some(at => ascii(b, at, "avis") || ascii(b, at, "msf1"));
    }
    return false;
}

function hasAlpha(bitmap: ImageBitmap) {
    const scale = Math.min(1, ALPHA_PROBE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
    if (!ctx) return true;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
    return false;
}

const TILE = 512;

async function losslessEstimate(bitmap: ImageBitmap, w: number, h: number) {
    const tw = Math.min(TILE, w);
    const th = Math.min(TILE, h);
    const canvas = new OffscreenCanvas(tw, th);
    const ctx = canvas.getContext("2d");
    if (!ctx) return Infinity;
    const sx = bitmap.width / w;
    const sy = bitmap.height / h;
    let bytes = 0;
    for (const f of [0.25, 0.5, 0.75]) {
        ctx.clearRect(0, 0, tw, th);
        ctx.drawImage(bitmap, Math.round((w - tw) * f * sx), Math.round((h - th) * f * sy), tw * sx, th * sy, 0, 0, tw, th);
        bytes += (await canvas.convertToBlob({ type: "image/webp", quality: 1 })).size;
    }
    return bytes / 3 * (w * h) / (tw * th);
}

export async function shrinkImage(file: File, target: number, format: ImageFormat, signal: AbortSignal, onStep: (text: string) => void) {
    const bitmap = await createImageBitmap(file).catch(() => {
        throw new Error("This picture couldn't be opened. Try saving it as PNG or JPG first.");
    });
    try {
        const fit = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height), Math.sqrt(MAX_AREA / (bitmap.width * bitmap.height)));
        const transparent = file.type !== "image/jpeg" && hasAlpha(bitmap);

        const type = format === "jpeg" && !transparent ? "image/jpeg"
            : format === "auto" && !transparent && file.type === "image/jpeg" ? "image/jpeg"
                : "image/webp";

        const canvas = new OffscreenCanvas(1, 1);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("This picture couldn't be drawn.");
        let drawnScale = -1;
        let tries = 0;
        const encode = async (scale: number, quality: number) => {
            signal.throwIfAborted();
            onStep(`Shrinking picture (try ${++tries})`);
            const w = Math.max(1, Math.round(bitmap.width * fit * scale));
            const h = Math.max(1, Math.round(bitmap.height * fit * scale));
            if (drawnScale !== scale) {
                canvas.width = w;
                canvas.height = h;
                if (type === "image/jpeg") {
                    ctx.fillStyle = "#fff";
                    ctx.fillRect(0, 0, w, h);
                }
                ctx.imageSmoothingQuality = "high";
                ctx.drawImage(bitmap, 0, 0, w, h);
                drawnScale = scale;
            }
            const blob = await canvas.convertToBlob({ type, quality });
            if (blob.type !== type) throw new Error("This picture is too large to convert.");
            return { size: blob.size, blob, w, h, quality };
        };

        try {
            let result: Awaited<ReturnType<typeof encode>> | null = null;
            if (type === "image/webp") {
                const w = Math.max(1, Math.round(bitmap.width * fit));
                const h = Math.max(1, Math.round(bitmap.height * fit));
                if (await losslessEstimate(bitmap, w, h) <= target * 1.1) {
                    const exact = await encode(1, 1);
                    if (exact.size <= target) result = exact;
                }
            }
            result ??= await searchImage(encode, target, false, signal);
            if (!result) throw new Error("It couldn't be made small enough.");
            const ext = type === "image/jpeg" ? "jpg" : "webp";
            const resized = result.w !== bitmap.width || result.h !== bitmap.height;
            return { blob: result.blob, ext, mime: type, note: resized ? `resized to ${result.w}x${result.h}` : "" };
        } finally {
            canvas.width = 0;
            canvas.height = 0;
        }
    } finally {
        bitmap.close();
    }
}
