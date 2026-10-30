/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import * as DataStore from "@api/DataStore";
import { HeaderBarButton } from "@api/HeaderBar";
import definePlugin from "@utils/types";
import { Alerts, SelectedChannelStore, SelectedGuildStore } from "@webpack/common";

import { resumeAftermath, stopAftermath } from "./aftermath";
import { onKey, ransomGold, scheduleNext, stopChallenges } from "./challenge";
import { startCreature, stopCreature } from "./creature";
import { loadDoors, unloadDoors } from "./doors";
import { onChannelSelect, refreshHunt, stopHunt } from "./hunt";
import { onImagesChange } from "./images";
import { dropGold, startLoot, stopLoot } from "./loot";
import { openPanel, StopIcon, TopGold, tryChallenge } from "./Panel";
import { bindSettings, settings } from "./settings";
import { closeAudio, openAudio } from "./sound";

let active = false;
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
let offImages: (() => void) | undefined;
const startTimers: ReturnType<typeof setTimeout>[] = [];

function loadCreature() {
    if (!active) return;
    stopCreature();
    if (settings.store.creature) startCreature({ mode: settings.store.mode, speed: settings.store.speed, size: settings.store.size });
}

function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(refreshHunt, 250);
}

function warnOnce() {
    if (settings.store.warned || !settings.store.jumpscare || !settings.store.challenges) return;
    Alerts.show({
        title: "Ransom has a jumpscare",
        body: `Now and then Ransom shows up with a stop sign. If you move your mouse or press a key while it's up, it screams at you and encrypts your Discord: you have 90 seconds to pay ${ransomGold()} gold by collecting gold hidden around Discord. If you can't pay, it jumpscares you with a loud scream (50% volume to start). Press Esc at any time to stop. You can turn the jumpscare off, lower its volume, or turn challenges off in the plugin's settings.`,
        confirmText: "Keep the jumpscare",
        cancelText: "Turn it off",
        onConfirm: () => void (settings.store.warned = true),
        onCancel: () => {
            settings.store.warned = true;
            settings.store.jumpscare = false;
        }
    });
}

export default definePlugin({
    name: "Ransom",
    description: "Ransom from DOORS in your Discord: it wanders around, shows its stop sign, encrypts your Discord if you move, and hides items in your DMs and servers.",
    authors: [{ name: "nolifepops", id: 221807880053981184n }],
    tags: ["Fun", "Appearance"],
    searchTerms: ["Halloween", "Oneko", "DOORS", "A-90", "Spooky", "Jumpscare"],
    settings,

    headerBarButton: {
        icon: StopIcon,
        render: () => (
            <>
                <TopGold />
                <HeaderBarButton icon={StopIcon} tooltip="Ransom" position="bottom" onClick={openPanel} />
            </>
        )
    },

    toolboxActions: {
        "Open Ransom": openPanel,
        "Try a challenge": tryChallenge,
        "Drop some gold": dropGold
    },

    flux: {
        CHANNEL_SELECT({ channelId, guildId }: { channelId?: string | null; guildId?: string | null; }) {
            void onChannelSelect(channelId, guildId);
        }
    },

    start() {
        active = true;
        openAudio();
        bindSettings(loadCreature, () => scheduleNext(true), () => settings.store.doorsAssets ? void loadDoors(true) : unloadDoors());
        offImages = onImagesChange(loadCreature);
        // Ransom used to take custom packs; drop one left saved from back then.
        void DataStore.del("Ransom_pack");
        if (settings.store.doorsAssets) void loadDoors();
        loadCreature();
        document.addEventListener("keydown", onKey, true);
        window.addEventListener("resize", onResize);
        scheduleNext(true);
        startLoot();
        void onChannelSelect(SelectedChannelStore.getChannelId(), SelectedGuildStore.getGuildId());
        startTimers.push(setTimeout(warnOnce, 3000), setTimeout(() => void resumeAftermath(), 2500));
    },

    stop() {
        active = false;
        startTimers.splice(0).forEach(clearTimeout);
        bindSettings(() => { }, () => { }, () => { });
        unloadDoors();
        offImages?.();
        offImages = undefined;
        clearTimeout(resizeTimer);
        document.removeEventListener("keydown", onKey, true);
        window.removeEventListener("resize", onResize);
        stopChallenges();
        stopAftermath();
        stopLoot();
        stopCreature();
        stopHunt();
        closeAudio();
    }
});
