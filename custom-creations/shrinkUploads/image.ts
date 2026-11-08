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
    if (ascii(b, 4, "ftyp")) return ascii(b, 8, "avis");
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

export async function shrinkImage(file: File, target: number, format: ImageFormat, signal: AbortSignal, onStep: (text: string) => void) {
    const bitmap = await createImageBitmap(file).catch(() => {
        throw new Error("This picture format can't be opened here.");
    });
    try {
        const fit = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height), Math.sqrt(MAX_AREA / (bitmap.width * bitmap.height)));
        const transparent = file.type !== "image/jpeg" && hasAlpha(bitmap);

        const type = format === "jpeg" && !transparent ? "image/jpeg"
            : format === "auto" && !transparent && file.type === "image/jpeg" ? "image/jpeg"
                : "image/webp";

        let tries = 0;
        const result = await searchImage(async (scale, quality) => {
            signal.throwIfAborted();
            onStep(`Trying ${Math.round(scale * fit * 100)}% size, quality ${Math.round(quality * 100)} (${++tries})`);
            const w = Math.max(1, Math.round(bitmap.width * fit * scale));
            const h = Math.max(1, Math.round(bitmap.height * fit * scale));
            const canvas = new OffscreenCanvas(w, h);
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("Could not draw this image.");
            if (type === "image/jpeg") {
                ctx.fillStyle = "#fff";
                ctx.fillRect(0, 0, w, h);
            }
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(bitmap, 0, 0, w, h);
            const blob = await canvas.convertToBlob({ type, quality });
            if (blob.type !== type) throw new Error("This picture is too large to convert.");
            return { size: blob.size, blob, w, h, quality };
        }, target, false, signal);

        if (!result) throw new Error("Could not get this image under the limit.");
        const ext = type === "image/jpeg" ? "jpg" : "webp";
        return { blob: result.blob, ext, mime: type, note: `${result.w}x${result.h}, quality ${Math.round(result.quality * 100)}` };
    } finally {
        bitmap.close();
    }
}
