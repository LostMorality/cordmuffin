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

const originals = new Map<string, (...args: any[]) => any>();
const silenced = (name: unknown) => typeof name === "string" && CALL_SOUND.test(name);

// All of Discord's sounds go through this one class, so checking there covers them without changing what Discord does.
export function startSoundMute() {
    if (originals.size) return;
    try {
        const { prototype } = SoundModule.WebAudioSound;
        for (const method of ["play", "loop", "playWithListener"]) {
            const original = prototype[method];
            originals.set(method, original);
            prototype[method] = function (this: { name?: string; audio?: unknown; }, ...args: any[]) {
                // Equicord's audio API keeps the sound's name in "audio" instead.
                if (settings.store.muteCallSounds && farmJustRan() && (silenced(this.name) || silenced(this.audio))) return method === "playWithListener" ? Promise.resolve(true) : undefined;
                return original.apply(this, args);
            };
        }
    } catch (e) {
        logger.error("Couldn't set up muting of call sounds", e);
    }
}

export function stopSoundMute() {
    try {
        const { prototype } = SoundModule.WebAudioSound;
        for (const [method, original] of originals) prototype[method] = original;
    } catch (e) {
        logger.error("Couldn't undo muting of call sounds", e);
    }
    originals.clear();
}
