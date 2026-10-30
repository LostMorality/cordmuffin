/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginNative } from "@utils/types";

import { type ImageName, setDoorsImages } from "./images";
import type { DoorsFile, EasterEggFile } from "./native";
import { notify } from "./notify";
import { decode, setDoorsSounds, type SoundName } from "./sound";

const Native = VencordNative.pluginHelpers.Ransom as PluginNative<typeof import("./native")>;

const IMAGES: [DoorsFile, ImageName][] = [
    ["face", "creature"],
    ["jumpscare", "jumpscare"],
    ["sign", "sign"],
    ["thanks", "thanks"],
    ["gold", "coin"],
    ["honeypot", "honeypot"],
    ["revive", "revive"],
    ["skull", "skull"]
];

const POPUPS: DoorsFile[] = ["popup1", "popup2", "popup3", "popup4", "popup5", "popup6"];

const SOUNDS: [DoorsFile, SoundName][] = [
    ["spawn", "spawn"],
    ["glitch", "sign"],
    ["popupMain", "popupMain"],
    ["popupIn", "popupIn"],
    ["popupOut", "popupOut"],
    ["scream", "jumpscare"],
    ["fail", "fail"],
    ["layer1", "layer1"],
    ["layer2", "layer2"],
    ["layer3", "layer3"],
    ["riser", "riser"],
    ["coin", "coin"],
    ["goldUp", "goldUp"],
    ["paid", "paid"],
    ["success", "success"],
    ["error", "error"],
    ["deathMusic", "deathMusic"],
    ["easterEggMusic", "easterEggMusic"]
];

let generation = 0;

export async function loadDoors(announce = false) {
    const mine = ++generation;
    const images: Partial<Record<ImageName, Blob>> = {};
    const popups: Blob[] = [];
    const sounds: Partial<Record<SoundName, AudioBuffer>> = {};
    const songs: Partial<Record<SoundName, ArrayBuffer>> = {};
    let missing = 0;

    await Promise.all([
        ...IMAGES.map(async ([file, slot]) => {
            const bytes = await Native.getDoorsFile(file);
            if (bytes) images[slot] = new Blob([bytes.slice()]);
            else missing++;
        }),
        ...POPUPS.map(async file => {
            const bytes = await Native.getDoorsFile(file);
            if (bytes) popups.push(new Blob([bytes.slice()]));
            else missing++;
        }),
        ...SOUNDS.map(async ([file, slot]) => {
            const bytes = await Native.getDoorsFile(file);
            if (!bytes) return void missing++;
            // Stopped meanwhile: decoding now would open a fresh AudioContext that nothing closes.
            if (mine !== generation) return;
            if (slot === "deathMusic") return void (songs[slot] = bytes.slice().buffer);
            try {
                sounds[slot] = await decode(bytes.slice().buffer);
            } catch {
                missing++;
            }
        })
    ]);
    // Your own EasterEgg files (see native.ts) win over the stand-ins and the official track. They're optional, so they
    // never count as missing.
    await Promise.all((["gun", "hand", "music", "death"] as EasterEggFile[]).map(async name => {
        const bytes = await Native.getEasterEggFile(name);
        if (!bytes || mine !== generation) return;
        if (name === "gun" || name === "hand") return void (images[name] = new Blob([bytes.slice()]));
        if (name === "death") return void (songs.easterEggDeath = bytes.slice().buffer);
        try {
            sounds[name === "music" ? "easterEggMusic" : "easterEggDeath"] = await decode(bytes.slice().buffer);
        } catch { }
    }));

    if (mine !== generation) return;
    setDoorsImages(images, popups);
    setDoorsSounds(sounds, songs);
    if (!announce) return;
    const total = IMAGES.length + POPUPS.length + SOUNDS.length;
    if (missing === total) notify("Couldn't download the DOORS files, so Ransom uses plain stand-ins.", "critical");
    else if (missing) notify(`${missing} DOORS files couldn't be downloaded. Ransom uses stand-ins for those.`);
    else notify("DOORS sounds and art are ready.", "success");
}

export function unloadDoors() {
    generation++;
    setDoorsImages({}, []);
    setDoorsSounds({});
}
