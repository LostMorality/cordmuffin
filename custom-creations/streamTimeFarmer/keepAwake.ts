/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import type { PluginNative } from "@utils/types";

import { settings } from ".";
import { afkActive } from "./afk";
import { streamFarmRunning } from "./stream";

const logger = new Logger("StreamTimeFarmer");
const Native = IS_DISCORD_DESKTOP ? VencordNative.pluginHelpers.StreamTimeFarmer as PluginNative<typeof import("./native")> : null;
const CHECK_MS = 5000;

let timer: ReturnType<typeof setInterval> | undefined;
// Unknown after a reload, when Discord's main process may still be holding the computer awake.
let applied: boolean | undefined;
let warned = false;

function apply(on: boolean) {
    if (on === applied) return;
    // The helper isn't there until Discord has fully restarted after an update.
    if (!Native?.setKeepAwake) return;
    applied = on;
    Native.setKeepAwake(on).catch(e => {
        applied = undefined;
        if (warned) return;
        warned = true;
        logger.error("Couldn't change whether the computer stays awake", e);
    });
}

export const syncKeepAwake = () => {
    if (timer) apply(settings.store.keepComputerAwake && (streamFarmRunning() || afkActive()));
};

export function startKeepAwake() {
    if (timer) return;
    timer = setInterval(syncKeepAwake, CHECK_MS);
    syncKeepAwake();
}

export function stopKeepAwake() {
    clearInterval(timer);
    timer = undefined;
    apply(false);
}
