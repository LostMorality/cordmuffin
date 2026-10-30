/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";

import { isRunning } from "./challenge";
import { notify } from "./notify";
import { settings } from "./settings";
import { play } from "./sound";

const FOUND_KEY = "Ransom_found";
const DAY_KEY = "Ransom_day";
const DAILY_CAP = 20;

export const ITEMS = [
    { id: "gold", emoji: "💰", name: "Gold", weight: 30 },
    { id: "key", emoji: "🗝️", name: "Room key", weight: 20 },
    { id: "candle", emoji: "🕯️", name: "Candle", weight: 18 },
    { id: "flashlight", emoji: "🔦", name: "Flashlight", weight: 15 },
    { id: "vitamins", emoji: "💊", name: "Vitamins", weight: 12 },
    { id: "lockpick", emoji: "🪛", name: "Lockpick", weight: 4 },
    { id: "golden", emoji: "🔑", name: "Golden key", weight: 1 }
] as const;

export type ItemId = typeof ITEMS[number]["id"];

export interface FoundItem {
    item: ItemId;
    channelId: string;
    guildId?: string;
    at: number;
}

interface Spot {
    item: ItemId;
    x: number;
    y: number;
}

interface Day {
    day: string;
    rolled: string[];
    pending: Record<string, Spot>;
    count: number;
}

let day: Day | undefined;
let current: { channelId: string; guildId?: string; } | undefined;
let shown: HTMLElement[] = [];
let showTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

export function onFoundChange(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}

const today = () => new Date().toLocaleDateString("en-CA");

async function loadDay() {
    if (day?.day === today()) return day;
    const saved = await DataStore.get<Day>(DAY_KEY);
    day = saved?.day === today() ? { day: saved.day, rolled: [...saved.rolled], pending: { ...saved.pending }, count: saved.count } : { day: today(), rolled: [], pending: {}, count: 0 };
    return day;
}

const saveDay = (d: Day) => DataStore.set(DAY_KEY, { day: d.day, rolled: [...d.rolled], pending: { ...d.pending }, count: d.count });

export async function getFound() {
    const saved = await DataStore.get<FoundItem[]>(FOUND_KEY);
    return Array.isArray(saved) ? saved.map(f => ({ ...f })) : [];
}

export async function clearFound() {
    await DataStore.del(FOUND_KEY);
    listeners.forEach(l => l());
}

export async function takeFound(count: number) {
    const found = await getFound();
    const taken: FoundItem[] = [];
    for (let i = 0; i < count && found.length; i++) taken.push(...found.splice(Math.floor(Math.random() * found.length), 1));
    if (taken.length) {
        await DataStore.set(FOUND_KEY, found);
        listeners.forEach(l => l());
    }
    return taken;
}

export const itemInfo = (id: ItemId) => ITEMS.find(i => i.id === id) ?? ITEMS[0];

function pick(): ItemId {
    const total = ITEMS.reduce((sum, i) => sum + i.weight, 0);
    let roll = Math.random() * total;
    for (const item of ITEMS) {
        roll -= item.weight;
        if (roll < 0) return item.id;
    }
    return "gold";
}

function clearShown() {
    clearTimeout(showTimer);
    showTimer = undefined;
    shown.forEach(el => el.remove());
    shown = [];
}

function chatArea() {
    return document.querySelector<HTMLElement>('[class*="messagesWrapper"]');
}

function show(channelId: string, guildId: string | undefined, spot: Spot, tries = 0) {
    clearShown();
    const area = chatArea();
    if (!area) {
        if (tries < 10) showTimer = setTimeout(() => show(channelId, guildId, spot, tries + 1), 300);
        return;
    }
    const rect = area.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 120) return;
    const info = itemInfo(spot.item);

    const el = document.createElement("button");
    el.className = `vc-ransom-item vc-ransom-item-${spot.item}`;
    el.textContent = info.emoji;
    el.title = "Something spooky";
    el.style.left = `${rect.left + 20 + spot.x * (rect.width - 80)}px`;
    el.style.top = `${rect.top + 40 + spot.y * (rect.height - 120)}px`;
    el.addEventListener("click", () => void collect(channelId, guildId, spot.item));
    document.body.appendChild(el);
    shown.push(el);

    if (settings.store.huntHint) {
        const hint = document.createElement("div");
        hint.className = "vc-ransom-hint";
        hint.textContent = "👀 Something is hiding in this chat...";
        hint.style.left = `${rect.left + rect.width / 2}px`;
        hint.style.top = `${rect.top + 8}px`;
        document.body.appendChild(hint);
        shown.push(hint);
    }
}

async function collect(channelId: string, guildId: string | undefined, item: ItemId) {
    clearShown();
    const d = await loadDay();
    delete d.pending[channelId];
    await saveDay(d);
    const found = await getFound();
    found.push({ item, channelId, ...(guildId ? { guildId } : {}), at: Date.now() });
    await DataStore.set(FOUND_KEY, found);
    play("coin", settings.store.soundVolume);
    const info = itemInfo(item);
    notify(`You found ${info.name === "Gold" ? "some" : "a"} ${info.name} ${info.emoji}! That's ${found.length} found so far.`, "success");
    listeners.forEach(l => l());
}

export async function onChannelSelect(channelId: string | null | undefined, guildId: string | null | undefined) {
    clearShown();
    current = undefined;
    if (!channelId || !settings.store.hunt) return;
    const inServer = !!guildId;
    if (inServer ? !settings.store.huntServers : !settings.store.huntDMs) return;
    current = { channelId, guildId: guildId ?? undefined };

    const d = await loadDay();
    if (current?.channelId !== channelId) return;
    let spot = d.pending[channelId];
    if (!spot && !d.rolled.includes(channelId) && d.count < DAILY_CAP) {
        d.rolled.push(channelId);
        if (Math.random() * 100 < settings.store.huntChance) {
            spot = { item: pick(), x: Math.random(), y: Math.random() };
            d.pending[channelId] = spot;
            d.count++;
        }
        await saveDay(d);
        if (current?.channelId !== channelId) return;
    }
    clearTimeout(showTimer);
    if (spot && !isRunning()) showTimer = setTimeout(() => show(channelId, current?.guildId, spot), 600);
}

export function refreshHunt() {
    if (current) void onChannelSelect(current.channelId, current.guildId);
    else clearShown();
}

export async function hideHere(channelId: string, guildId: string | undefined) {
    const d = await loadDay();
    d.pending[channelId] = { item: pick(), x: Math.random(), y: Math.random() };
    await saveDay(d);
    void onChannelSelect(channelId, guildId);
}

export function stopHunt() {
    clearShown();
    current = undefined;
    day = undefined;
}
