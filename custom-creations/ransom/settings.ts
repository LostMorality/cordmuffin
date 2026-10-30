/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import { SettingsButtons } from "./Panel";

let onCreatureChange = () => { };
let onScheduleChange = () => { };
let onDoorsChange = () => { };

export function bindSettings(creature: () => void, schedule: () => void, doors: () => void) {
    onCreatureChange = creature;
    onScheduleChange = schedule;
    onDoorsChange = doors;
}

export const settings = definePluginSettings({
    buttons: {
        type: OptionType.COMPONENT,
        component: SettingsButtons
    },
    creature: {
        type: OptionType.BOOLEAN,
        description: "Show Ransom's face wandering around Discord, like Oneko.",
        default: true,
        onChange: () => onCreatureChange()
    },
    mode: {
        type: OptionType.SELECT,
        description: "How Ransom moves.",
        options: [
            { label: "Follows your cursor", value: "follow", default: true },
            { label: "Wanders around on its own", value: "wander" }
        ],
        onChange: () => onCreatureChange()
    },
    speed: {
        type: OptionType.SLIDER,
        description: "How fast Ransom moves.",
        markers: [4, 8, 12, 16, 20],
        default: 10,
        stickToMarkers: false,
        onChange: () => onCreatureChange()
    },
    size: {
        type: OptionType.SLIDER,
        description: "How big Ransom is.",
        markers: [1, 2, 3, 4],
        default: 2,
        stickToMarkers: true,
        onChange: () => onCreatureChange()
    },
    challenges: {
        type: OptionType.BOOLEAN,
        description: "Ransom encounters: now and then Ransom shows up with its stop sign. Move your mouse or press a key while it's up and it encrypts your Discord: pay the gold it asks for within 90 seconds by collecting gold hidden around Discord. Turn this off to only keep it wandering.",
        default: true,
        onChange: () => onScheduleChange()
    },
    frequency: {
        type: OptionType.SELECT,
        description: "How often a challenge can happen. The wait only counts down while you're actually using Discord, never while it's in the background, idle or you're in a call. Like in DOORS, grabbing loose gold brings Ransom sooner: each pile you take cuts the wait.",
        options: [
            { label: "Rarely (every 15 to 45 minutes)", value: "rare" },
            { label: "Sometimes (every 6 to 20 minutes)", value: "sometimes", default: true },
            { label: "Often (every 2 to 8 minutes)", value: "often" }
        ],
        onChange: () => onScheduleChange()
    },
    difficulty: {
        type: OptionType.SELECT,
        description: "How much gold Ransom asks for, how long each gold pile stays, and the fine for spam clicking (5 missed clicks in a second).",
        options: [
            { label: "Easy: 300 gold, piles stay until you take them, spam clicking costs 15", value: "easy" },
            { label: "Normal: 500 gold, piles slip away after 16 seconds, spam clicking costs 25", value: "normal", default: true },
            { label: "Hard: 750 gold, piles slip away after 9 seconds, spam clicking costs 40", value: "hard" }
        ]
    },
    seeThrough: {
        type: OptionType.BOOLEAN,
        description: "See-through: the stop sign, download and B▓GG▓R screens are tinted red instead of solid, so you can still see your chat behind them. The jumpscares stay solid.",
        default: true
    },
    breakUI: {
        type: OptionType.BOOLEAN,
        description: "Discord falls apart: as the ransom timer runs down, Discord glitches, tears and finally starts falling to pieces. Lose, and it stays broken: revive with all your gold (at least 1000) or Ransom kills you and you get the DOORS death screen. Only visual; turning this off puts Discord back.",
        default: true
    },
    encryptUI: {
        type: OptionType.BOOLEAN,
        description: "Encrypt Discord: while the ransom runs, names, channels and messages turn into scrambled text and the message box is locked. It's only visual, and everything comes back when it ends.",
        default: true
    },
    rareChance: {
        type: OptionType.SLIDER,
        description: "Chance (%) of the rare B▓GG▓R encounter: a red screen with a huge countdown, a gun and an open hand. It asks for twice the gold. It's fair at first, kicks up a gear when the beat drops and keeps getting harder.",
        markers: [0, 5, 10, 15, 25, 50, 100],
        default: 15,
        stickToMarkers: false
    },
    looseGold: {
        type: OptionType.SELECT,
        description: "Loose gold: like the gold in DOORS drawers, a small pile now and then turns up somewhere in Discord. Click it to pick it up. Nothing else is blocked. (Ransom still has to be paid with newly found gold, and paying him off always drops a Honey Pot.)",
        options: [
            { label: "Off", value: "off" },
            { label: "Now and then (every few minutes)", value: "sometimes", default: true },
            { label: "Often (about every minute)", value: "often" }
        ]
    },
    takeItems: {
        type: OptionType.BOOLEAN,
        description: "When you can't pay in time, it takes up to 3 of the hidden items you found.",
        default: true
    },
    jumpscare: {
        type: OptionType.BOOLEAN,
        description: "Show the jumpscare with a loud scream when you get caught and when time runs out. Off shows a plain \"TIME'S UP\" screen instead.",
        default: true
    },
    jumpscareVolume: {
        type: OptionType.SLIDER,
        description: "Jumpscare volume.",
        markers: [0, 20, 40, 60, 80, 100],
        default: 50,
        stickToMarkers: false
    },
    soundVolume: {
        type: OptionType.SLIDER,
        description: "Volume of everything else: the sign, pop-ups, gold and the music.",
        markers: [0, 20, 40, 60, 80, 100],
        default: 50,
        stickToMarkers: false
    },
    doorsAssets: {
        type: OptionType.BOOLEAN,
        description: "Download Ransom's sprites, pop-ups, sounds and music from the official DOORS wiki (doorsgame.wiki, files on static.wikitide.net) onto your PC. They aren't part of this plugin and belong to the DOORS developers. With this off, or if a download fails, plain stand-ins are used (a stop sign, beeps, text).",
        default: true,
        onChange: () => onDoorsChange()
    },
    calmEffects: {
        type: OptionType.BOOLEAN,
        description: "Calmer effects: no flashing, softer static and shaking.",
        default: false
    },
    allowWhileTyping: {
        type: OptionType.BOOLEAN,
        description: "Allow challenges while you're typing.",
        default: false
    },
    allowInCall: {
        type: OptionType.BOOLEAN,
        description: "Allow challenges while you're in a voice call or streaming.",
        default: false
    },
    hunt: {
        type: OptionType.BOOLEAN,
        description: "Hidden items: sometimes a small spooky item hides in a DM or server channel when you open it. Click it to collect it.",
        default: true
    },
    huntDMs: {
        type: OptionType.BOOLEAN,
        description: "Hide items in DMs.",
        default: true
    },
    huntServers: {
        type: OptionType.BOOLEAN,
        description: "Hide items in server channels.",
        default: true
    },
    huntChance: {
        type: OptionType.SLIDER,
        description: "Chance (%) that a channel you open has an item, up to 20 items a day.",
        markers: [5, 10, 15, 25, 50],
        default: 15,
        stickToMarkers: false
    },
    huntHint: {
        type: OptionType.BOOLEAN,
        description: "Show a small hint at the top of the chat when something is hiding there.",
        default: true
    },
    warned: {
        type: OptionType.BOOLEAN,
        description: "Saw the jumpscare warning.",
        default: false,
        hidden: true
    }
}, {
    mode: { disabled() { return !this.store.creature; } },
    speed: { disabled() { return !this.store.creature; } },
    size: { disabled() { return !this.store.creature; } },
    frequency: { disabled() { return !this.store.challenges; } },
    difficulty: { disabled() { return !this.store.challenges; } },
    jumpscare: { disabled() { return !this.store.challenges; } },
    takeItems: { disabled() { return !this.store.challenges; } },
    rareChance: { disabled() { return !this.store.challenges; } },
    seeThrough: { disabled() { return !this.store.challenges; } },
    encryptUI: { disabled() { return !this.store.challenges; } },
    breakUI: { disabled() { return !this.store.challenges; } },
    jumpscareVolume: { disabled() { return !this.store.challenges || !this.store.jumpscare; } },
    allowWhileTyping: { disabled() { return !this.store.challenges; } },
    allowInCall: { disabled() { return !this.store.challenges; } },
    huntDMs: { disabled() { return !this.store.hunt; } },
    huntServers: { disabled() { return !this.store.hunt; } },
    huntChance: { disabled() { return !this.store.hunt; } },
    huntHint: { disabled() { return !this.store.hunt; } }
});
