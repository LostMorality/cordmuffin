/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { coinSvg, gunSvg, handSvg, honeyPotSvg, reviveSvg, skullSvg, stopSignSvg } from "./art";

// Ransom's pictures come from the downloaded DOORS files. Until those arrive, or if they can't be downloaded, the
// stop sign, gold, Honey Pot, revive heart, skull and the EasterEgg's gun and hand get drawn stand-ins.

export type ImageName = "creature" | "sign" | "jumpscare" | "coin" | "thanks" | "honeypot" | "gun" | "hand" | "revive" | "skull";

const urls = new Map<ImageName, string>();
let popups: string[] = [];
const listeners = new Set<() => void>();

export function onImagesChange(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}

export function setDoorsImages(images: Partial<Record<ImageName, Blob>>, popupBlobs: Blob[]) {
    for (const url of [...urls.values(), ...popups]) URL.revokeObjectURL(url);
    urls.clear();
    for (const [name, blob] of Object.entries(images) as [ImageName, Blob][]) urls.set(name, URL.createObjectURL(blob));
    popups = popupBlobs.map(blob => URL.createObjectURL(blob));
    listeners.forEach(l => l());
}

/** The DOORS pop-up pictures to pick from. */
export const popupImages = () => popups;

export function image(name: ImageName): string {
    const url = urls.get(name);
    if (url) return url;
    if (name === "sign") return stopSignSvg();
    if (name === "coin") return coinSvg();
    if (name === "honeypot") return honeyPotSvg();
    if (name === "revive") return reviveSvg();
    if (name === "skull") return skullSvg();
    if (name === "gun") return gunSvg();
    if (name === "hand") return handSvg();
    return "";
}
