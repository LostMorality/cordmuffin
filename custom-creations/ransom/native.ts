/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, type IpcMainInvokeEvent } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

// The DOORS files are never part of the plugin. When "Use DOORS sounds and art" is on, they're downloaded from the
// official DOORS wiki's public file links (doorsgame.wiki, files on static.wikitide.net) onto this PC and cached
// here. Only these fixed links can be fetched.
const BASE = "https://static.wikitide.net/doorswiki/";
const FILES = {
    face: { path: "8/80/Ransom_sprite.png", kind: "image" },
    jumpscare: { path: "f/fd/Ransom_jumpscare_sprite.png", kind: "image" },
    sign: { path: "7/77/Ransom_block_sprite.png", kind: "image" },
    thanks: { path: "9/93/Ransom_thumbs_up_sprite.png", kind: "image" },
    gold: { path: "2/2b/Gold_icon.png", kind: "image" },
    honeypot: { path: "b/b4/Honey_Pot_icon.png", kind: "image" },
    revive: { path: "0/02/Revive_icon.png", kind: "image" },
    skull: { path: "f/f6/Skull_icon.png", kind: "image" },
    popup1: { path: "3/36/RansomPopup1.png", kind: "image" },
    popup2: { path: "b/b2/RansomPopup2.png", kind: "image" },
    popup3: { path: "a/a6/RansomPopup3.png", kind: "image" },
    popup4: { path: "9/97/RansomPopup4.png", kind: "image" },
    popup5: { path: "d/df/RansomPopup5.png", kind: "image" },
    popup6: { path: "1/14/RansomPopup6.png", kind: "image" },
    spawn: { path: "c/cd/Glitchybefore.ogg", kind: "audio" },
    glitch: { path: "a/a6/GEN_GLITCH_LOOP_%28135402425939071%29.ogg", kind: "audio" },
    popupMain: { path: "0/06/RansomPopupFaceAppear.wav", kind: "audio" },
    popupIn: { path: "d/de/RansomPopupAppear.wav", kind: "audio" },
    popupOut: { path: "4/44/RansomPopupDisappear.wav", kind: "audio" },
    scream: { path: "a/a3/Ransom_jumpscare1.ogg", kind: "audio" },
    fail: { path: "0/09/Ransom_Jumpscare_2.mp3", kind: "audio" },
    layer1: { path: "3/38/Ransomtimer_layer1InGame.ogg", kind: "audio" },
    layer2: { path: "3/3b/Ransomtimer_layer2InGame.ogg", kind: "audio" },
    layer3: { path: "0/04/Ransomtimer_layer3InGame.ogg", kind: "audio" },
    riser: { path: "5/58/Ransom_encounter.wav", kind: "audio" },
    coin: { path: "2/2b/Ransomgold.mp3", kind: "audio" },
    goldUp: { path: "6/6a/Ransomgold_increase_%2897004792231127%29.ogg", kind: "audio" },
    paid: { path: "7/78/Ransom_paid_in-game.mp3", kind: "audio" },
    success: { path: "8/83/Ransomsuccess_74683588362771.ogg", kind: "audio" },
    error: { path: "b/bc/Ransom_UI_-_Error_%2880099403859001%29.ogg", kind: "audio" },
    deathMusic: { path: "c/ce/Guiding_Light.ogg", kind: "audio" },
    easterEggMusic: { path: "2/25/LSPLASH_-_R4NS0M.mp3", kind: "audio" }
} as const;

export type DoorsFile = keyof typeof FILES;

const MAX_BYTES = 4 * 1024 * 1024;
const root = join(app.getPath("userData"), "RansomPlugin");
const cacheDir = join(root, "doors-wiki");

const MAGIC: Record<"image" | "audio", number[][]> = {
    image: [[0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff], [0x47, 0x49, 0x46, 0x38], [0x52, 0x49, 0x46, 0x46]],
    audio: [[0x4f, 0x67, 0x67, 0x53], [0x49, 0x44, 0x33], [0xff, 0xfb], [0xff, 0xf3], [0xff, 0xf2], [0x52, 0x49, 0x46, 0x46]]
};

function looksRight(bytes: Uint8Array, kind: "image" | "audio") {
    return bytes.length > 16 && bytes.length <= MAX_BYTES && MAGIC[kind].some(sig => sig.every((b, i) => bytes[i] === b));
}

// Stops reading as soon as the body passes MAX_BYTES, whatever content-length said.
async function readCapped(res: Response) {
    if (!res.body) throw new Error("Empty body");
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (; ;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_BYTES) {
            void reader.cancel();
            throw new Error("Too big");
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
    }
    return bytes;
}

async function download(name: DoorsFile) {
    const { path, kind } = FILES[name];
    // No redirects: the request never leaves the wiki's file host.
    const res = await fetch(BASE + path, { redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    const typeOk = kind === "image" ? type.startsWith("image/") : type.startsWith("audio/") || type === "application/ogg";
    if (!typeOk) throw new Error(`Unexpected type ${type}`);
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > MAX_BYTES) throw new Error("Too big");
    const bytes = await readCapped(res);
    if (!looksRight(bytes, kind)) throw new Error("Not a valid file");
    return bytes;
}

let oldCacheGone = false;

// Your own EasterEgg files, if you put them in RansomPlugin/EasterEgg next to the cache: the gun and hand pictures,
// the song, and the song for its death screen (looped from its first second). They stay on this PC and are only read,
// never downloaded or shared.
const EASTER_EGG = {
    gun: { file: "gun.png", kind: "image" },
    hand: { file: "hand.png", kind: "image" },
    music: { file: "music.mp3", kind: "audio" },
    death: { file: "death.mp3", kind: "audio" }
} as const;
const EASTER_EGG_MAX = 16 * 1024 * 1024;

export type EasterEggFile = keyof typeof EASTER_EGG;

export function getEasterEggFile(_: IpcMainInvokeEvent, name: EasterEggFile): Uint8Array | null {
    if (!Object.hasOwn(EASTER_EGG, name)) return null;
    try {
        const bytes = new Uint8Array(readFileSync(join(root, "EasterEgg", EASTER_EGG[name].file)));
        const ok = bytes.length > 16 && bytes.length <= EASTER_EGG_MAX && MAGIC[EASTER_EGG[name].kind].some(sig => sig.every((b, i) => bytes[i] === b));
        return ok ? bytes : null;
    } catch {
        return null;
    }
}

export async function getDoorsFile(_: IpcMainInvokeEvent, name: DoorsFile): Promise<Uint8Array | null> {
    if (!Object.hasOwn(FILES, name)) return null;
    if (!oldCacheGone) {
        oldCacheGone = true;
        try { rmSync(join(root, "doors-cache"), { recursive: true, force: true }); } catch { }
    }
    const file = join(cacheDir, name);
    try {
        if (existsSync(file)) {
            const cached = new Uint8Array(readFileSync(file));
            if (looksRight(cached, FILES[name].kind)) return cached;
        }
        const bytes = await download(name);
        mkdirSync(cacheDir, { recursive: true });
        // Written to a side file first, so a cut-off write never leaves a broken file in the cache.
        writeFileSync(`${file}.part`, bytes);
        renameSync(`${file}.part`, file);
        return bytes;
    } catch {
        return null;
    }
}
