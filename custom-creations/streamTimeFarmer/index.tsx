/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings, SettingsStore } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher } from "@webpack/common";

import { enterAfk, exitAfk } from "./afk";
import { mountCallWidget, unmountCallWidget } from "./CallWidget";
import { startKeepAwake, stopKeepAwake, syncKeepAwake } from "./keepAwake";
import { currentUserId, migrateLegacy, migrateRandomSource, profile, type StreamProfile, updateProfile } from "./profile";
import { applySecondPresence, startSecondAccount, stopSecondAccount } from "./secondAccount";
import { startSoundMute, stopSoundMute } from "./sounds";
import { noteConnect, noteReports, refreshGoLive, startStreamFarm, stopStreamFarm, streamStatus, takePendingHangUp } from "./stream";
import { StreamFarm } from "./StreamFarm";
import { allowTracking, loadConsents, startReportWatch, stopReportWatch, trackingState } from "./tracking";

const logger = new Logger("StreamTimeFarmer");

export const settings = definePluginSettings({
    muteMic: {
        type: OptionType.BOOLEAN,
        description: "Mute your mic when the farm joins the call. It's unmuted again when the farm stops.",
        default: true
    },
    muteCallSounds: {
        type: OptionType.BOOLEAN,
        description: "Silence Discord's call sounds while the farm runs: calling and ringing (including real incoming calls, though their popup still shows), Go Live starting and ending, joins and leaves, mute and deafen. Message sounds stay on. This can't change what other people in the call hear on their own Discord.",
        default: true
    },
    keepComputerAwake: {
        type: OptionType.BOOLEAN,
        description: "Stop your computer going to sleep by itself while the farm is running or AFK mode is on, including moments when no call is live. During a call Discord already does this itself and keeps the screen on; otherwise the screen can still turn off. Your normal sleep settings come back when both stop. Choosing Sleep yourself or closing a laptop lid still puts it to sleep, and some laptops on battery can still sleep after a while.",
        default: false,
        onChange: () => syncKeepAwake()
    },
    deafenViewer: {
        type: OptionType.BOOLEAN,
        description: "The viewer also deafens itself, so the two accounts can't feed sound back into each other. It's undone when the farm stops.",
        default: true
    },
    callWidget: {
        type: OptionType.BOOLEAN,
        description: "Show a small call widget in the bottom-right corner while a second account is logged in, to call, hang up and open its window.",
        default: true
    },
    reportEvery: {
        type: OptionType.SELECT,
        description: "Discord only counts a stream's time toward the Streaming badge when the stream ends. The farm ends and restarts its stream this often (the second account stays in the call), so Discord gets the time so far, and a crash or shutdown only loses the time since the last restart. The badge doesn't update right after a report: it can take many hours, and Discord doesn't publish a schedule. Each restart plays Discord's stream sounds.",
        options: [
            { label: "Every 30 minutes", value: 30 },
            { label: "Every hour", value: 60, default: true },
            { label: "Every 2 hours", value: 120 },
            { label: "Every 4 hours", value: 240 },
            { label: "Never (only when you hang up)", value: 0 }
        ]
    },
    afkMode: {
        type: OptionType.BOOLEAN,
        description: "AFK mode is on (it comes back after Discord restarts).",
        default: false,
        hidden: true
    },
    streamFarm: {
        type: OptionType.COMPONENT,
        component: StreamFarm
    },
    profiles: {
        type: OptionType.CUSTOM,
        default: {} as Record<string, StreamProfile>,
        description: ""
    }
});

// The stream farm used to be part of GameTimeSpoof. Its settings move over once, before plugins start, and if it was
// in use there this plugin starts turned on, so the update doesn't switch it off.
const MOVED: Record<string, string> = { streamMute: "muteMic", streamDeafen: "deafenViewer", streamWidget: "callWidget", streamProfiles: "profiles" };

function moveFromGameTimeSpoof() {
    const { plugins } = SettingsStore.plain;
    const old = plugins.GameTimeSpoof;
    const keys = old ? Object.keys(old).filter(k => k.startsWith("stream")) : [];
    if (!keys.length) return;

    const mine = plugins.StreamTimeFarmer ??= { enabled: false };
    for (const key of keys) {
        // Keys from before the settings were per account keep their names; migrateLegacy sorts them out on start.
        const to = MOVED[key] ?? key;
        if (!Object.hasOwn(mine, to)) mine[to] = old[key];
        delete old[key];
    }

    const profiles = Object.values(mine.profiles ?? {}) as Partial<StreamProfile>[];
    const used = profiles.some(p => p.role && p.role !== "off" || p.hostSecond || p.account)
        || mine.streamRole && mine.streamRole !== "off" || !!mine.streamHostSecond;
    if (used && old.enabled) mine.enabled = true;
    SettingsStore.markAsChanged();
    logger.info("Moved the stream farm's settings over from GameTimeSpoof");
}

try {
    moveFromGameTimeSpoof();
} catch (e) {
    logger.error("Couldn't move the stream farm's settings over from GameTimeSpoof", e);
}

let active = false;
export const pluginActive = () => active;

// Switching accounts doesn't reload Discord, so the stream farm and second account restart for whoever is logged in
// now. Both run outside Discord's dispatch, since stopping leaves the call, which dispatches too.
let streamUser = "";
function followAccount() {
    setTimeout(() => {
        const id = currentUserId();
        if (!active || id === streamUser) return;
        streamUser = id;
        stopStreamFarm();
        stopSecondAccount();
        if (!id) return;
        migrateLegacy(id);
        startStreamFarm();
        startSecondAccount();
    });
}

// Stream farm settings belong to the account that's logged in. Changes that alter what the farm does restart it.
// Right after the user left the call in Discord, pressing Call starts a new one; any other change keeps it ended.
export function changeStreamProfile(patch: Partial<StreamProfile>) {
    const hungUp = takePendingHangUp();
    if (hungUp && patch.role !== "streamer") patch = { ...patch, role: "off" };
    const before = profile();
    updateProfile(patch);
    if (!active) return;
    const after = profile();
    if (hungUp || before.role !== after.role || before.where !== after.where || before.channel !== after.channel || before.partner !== after.partner) startStreamFarm();
    else if (before.source !== after.source || JSON.stringify(before.farmGame) !== JSON.stringify(after.farmGame)) refreshGoLive();
    if (hungUp || before.role !== after.role || before.hostSecond !== after.hostSecond) startSecondAccount();
    else if (before.secondPresence !== after.secondPresence) applySecondPresence();
}

// A failed look at the privacy settings must never stop the farm from starting.
const loadTracking = () => {
    try {
        void loadConsents();
    } catch (e) {
        logger.warn("Couldn't load the privacy settings", e);
    }
};
let stopNotingReports: (() => void) | undefined;

export default definePlugin({
    name: "StreamTimeFarmer",
    description: "Streams its own window (optionally shown as a game) to a second account of yours, logged in right inside Discord, so your Streaming badge time keeps counting.",
    tags: ["Voice", "Fun"],
    authors: [{ name: "nolifepops", id: 221807880053981184n }],
    settings,

    // Read by the streaming Discord when this one runs as its second account.
    streamFarmStatus: () => streamStatus(),
    configureStreamFarm: (patch: Partial<StreamProfile>) => changeStreamProfile(patch),
    trackingState,
    allowTracking,

    start() {
        active = true;
        streamUser = currentUserId();
        migrateLegacy(streamUser);
        try {
            migrateRandomSource();
        } catch (e) {
            logger.error("Couldn't move profiles off the random window source", e);
        }
        FluxDispatcher.subscribe("CONNECTION_OPEN", noteConnect);
        FluxDispatcher.subscribe("CONNECTION_OPEN", followAccount);
        FluxDispatcher.subscribe("LOGOUT", followAccount);
        FluxDispatcher.subscribe("CONNECTION_OPEN", loadTracking);
        startReportWatch();
        startSoundMute();
        stopNotingReports = noteReports();
        loadTracking();
        startStreamFarm();
        startSecondAccount();
        mountCallWidget();
        if (settings.store.afkMode) enterAfk();
        startKeepAwake();
    },

    stop() {
        active = false;
        stopKeepAwake();
        FluxDispatcher.unsubscribe("CONNECTION_OPEN", noteConnect);
        FluxDispatcher.unsubscribe("CONNECTION_OPEN", followAccount);
        FluxDispatcher.unsubscribe("LOGOUT", followAccount);
        FluxDispatcher.unsubscribe("CONNECTION_OPEN", loadTracking);
        stopReportWatch();
        stopNotingReports?.();
        stopStreamFarm();
        stopSecondAccount();
        stopSoundMute();
        unmountCallWidget();
        exitAfk(false);
    }
});
