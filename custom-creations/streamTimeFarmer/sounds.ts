/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { findByPropsLazy } from "@webpack";

import { settings } from ".";
import { farmJustRan } from "./stream";

const logger = new Logger("StreamTimeFarmer");

const SoundModule: { WebAudioSound: { prototype: Record<string, (...args: any[]) => any>; }; } = findByPropsLazy("WebAudioSound");

// Calls, Go Live, joins and leaves, mute and deafen, in every seasonal sound pack. Message and mention sounds stay.
const CALL_SOUND = /(^|_)(call_(calling|ringing)|(un)?(deafen|defean|mute)|disconnect|reconnect|user_(join|leave|moved)|stream_(started|ended|user_joined|user_left)|ptt_(start|stop))/;

type Fn = (...args: any[]) => any;

// Each method's original and this plugin's wrapper around it, while the mute is set up.
const wrapped = new Map<string, { original: Fn; mine: Fn; }>();
const silenced = (name: unknown) => typeof name === "string" && CALL_SOUND.test(name);
// Bumped on every start, so a wrapper left inside another plugin's chain after a stop stays a pass-through for good.
let muteRun = 0;

// All of Discord's sounds go through this one class, so checking there covers them without changing what Discord does.
export function startSoundMute() {
    if (wrapped.size) return;
    const run = ++muteRun;
    try {
        const { prototype } = SoundModule.WebAudioSound;
        for (const method of ["play", "loop", "playWithListener"]) {
            const original = prototype[method];
            if (typeof original !== "function") continue;
            const mine = function (this: { name?: string; audio?: unknown; }, ...args: any[]) {
                // Equicord's audio API keeps the sound's name in "audio" instead.
                if (run === muteRun && settings.store.muteCallSounds && farmJustRan() && (silenced(this.name) || silenced(this.audio))) return method === "playWithListener" ? Promise.resolve(true) : undefined;
                return original.apply(this, args);
            };
            wrapped.set(method, { original, mine });
            prototype[method] = mine;
        }
    } catch (e) {
        logger.error("Couldn't set up muting of call sounds", e);
    }
}

// Only a method still holding this plugin's own wrapper is put back; one another plugin has wrapped over since keeps
// that plugin's wrapper, and the bumped run makes this one a pass-through inside it.
export function stopSoundMute() {
    muteRun++;
    try {
        const { prototype } = SoundModule.WebAudioSound;
        for (const [method, { original, mine }] of wrapped) if (prototype[method] === mine) prototype[method] = original;
    } catch (e) {
        logger.error("Couldn't undo muting of call sounds", e);
    }
    wrapped.clear();
}
