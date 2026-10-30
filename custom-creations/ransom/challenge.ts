/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { SelectedChannelStore } from "@webpack/common";

import { afterLoss, isWrecked } from "./aftermath";
import { breakUI, repairUI } from "./breakdown";
import { hideCreature } from "./creature";
import { decryptUI, encryptUI } from "./encrypt";
import { takeFound } from "./hunt";
import { image, popupImages } from "./images";
import { dropHoneyPot } from "./loot";
import { settings } from "./settings";
import { type Music, play, startMusic, stopAll } from "./sound";

const STATS_KEY = "Ransom_stats";

export interface Stats {
    signs: number;
    stayedStill: number;
    hunts: number;
    won: number;
    lost: number;
    goldPaid: number;
    goldFound: number;
    honeyPots: number;
    bestSeconds: number;
    deaths: number;
    revives: number;
}

const EMPTY_STATS: Stats = { signs: 0, stayedStill: 0, hunts: 0, won: 0, lost: 0, goldPaid: 0, goldFound: 0, honeyPots: 0, bestSeconds: 0, deaths: 0, revives: 0 };

export async function getStats(): Promise<Stats> {
    const saved = await DataStore.get<Partial<Stats>>(STATS_KEY);
    return { ...EMPTY_STATS, ...saved };
}

const statsListeners = new Set<(stats: Stats) => void>();

export function onStatsChange(listener: (stats: Stats) => void) {
    statsListeners.add(listener);
    return () => void statsListeners.delete(listener);
}

// Changes run one after another, so two at once (a death taking the gold while it's counted) can't undo each other.
let statsQueue: Promise<unknown> = Promise.resolve();

function bumpStats(change: (stats: Stats) => void) {
    const run = statsQueue.then(async () => {
        const stats = await getStats();
        change(stats);
        await DataStore.set(STATS_KEY, { ...stats });
        for (const listener of statsListeners) listener({ ...stats });
    });
    statsQueue = run.catch(() => { });
    return run;
}

export function resetStats() {
    return bumpStats(s => void Object.assign(s, EMPTY_STATS));
}
export const addGoldFound = (amount: number) => bumpStats(s => void (s.goldFound += amount));
export const addHoneyPot = () => bumpStats(s => void s.honeyPots++);
export const addRevive = () => bumpStats(s => void s.revives++);

/** Empties your gold (a revive or a death) and says how much there was. */
export async function takeAllGold() {
    let taken = 0;
    await bumpStats(s => {
        taken = s.goldFound;
        s.goldFound = 0;
    });
    return taken;
}

/** Counts a death to Ransom and returns how many there have been. */
export async function addDeath() {
    let deaths = 0;
    await bumpStats(s => void (deaths = ++s.deaths));
    return deaths;
}

const FREQUENCY: Record<string, [number, number]> = {
    rare: [15, 45],
    sometimes: [6, 20],
    often: [2, 8]
};

// gold: what Ransom wants. piles: how many gold piles are hidden around Discord at once. life: how long a pile
// stays before it slips away (0 = until found). fine: gold added for clicking around wildly.
// Gold trickles in: a new pile every `every` ms while fewer than `piles` are out, each worth 5 to 25. Even grabbing
// each one the moment it shows up (around the pop-ups) takes about 45 s on easy, 55 s on normal and 65 s on hard, so
// a slow hand or a pile left to slip away makes it a close call.
const DIFFICULTY = {
    easy: { gold: 300, piles: 4, every: 2300, life: 0, fine: 15 },
    normal: { gold: 500, piles: 4, every: 1600, life: 16_000, fine: 25 },
    hard: { gold: 750, piles: 4, every: 1200, life: 9000, fine: 40 }
} as const;

/** The gold Ransom wants at the current difficulty. */
export const ransomGold = () => level().gold;

const level = () => DIFFICULTY[settings.store.difficulty as keyof typeof DIFFICULTY] ?? DIFFICULTY.normal;

const SECONDS = 90;
// The face flashes in for SPAWN_MS, then the sign is up for SIGN_MS: a split-second freeze, like the game.
const SPAWN_MS = 450;
const SIGN_MS = 750;
const GRACE_MS = 120;

const minutes = (n: number) => n * 60_000;
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const pick = <T,>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)];

let lastKey = 0;
let cleanup: (() => void) | undefined;
let running = false;
// What Esc does on the current screen; with nothing set it ends the challenge and waits for the next one.
let onEscape: (() => void) | undefined;
// Set while the plugin is off, so a challenge queued just before can't start after.
let stopped = false;

export const isRunning = () => running;

// The wait for the next Ransom only runs while you're actually using Discord: the window is focused and visible,
// you've moved, clicked, scrolled or typed in the last 45 seconds, nothing is fullscreen, and you're not in a call
// (unless calls are allowed). A long video in another window or a call in the background never sets him off.
const IDLE_MS = 45_000;
let ticker: ReturnType<typeof setInterval> | undefined;
let remaining = 0;
let lastTick = 0;
let lastActive = 0;

const markActive = () => void (lastActive = Date.now());
const ACTIVITY = ["mousemove", "mousedown", "keydown", "wheel"] as const;

function counting() {
    return !running && !document.hidden && document.hasFocus() && !document.fullscreenElement
        && Date.now() - lastActive < IDLE_MS
        && (settings.store.allowInCall || !SelectedChannelStore.getVoiceChannelId());
}

function tick() {
    const now = Date.now();
    const step = Math.min(now - lastTick, 2000);
    lastTick = now;
    if (!settings.store.challenges) return stopTicker();
    if (!counting()) return;
    remaining -= step;
    if (remaining > 0) return;
    stopTicker();
    tryStart();
}

function stopTicker() {
    clearInterval(ticker);
    ticker = undefined;
    for (const type of ACTIVITY) document.removeEventListener(type, markActive, true);
}

function setNext(wait: number) {
    remaining = wait;
    lastTick = Date.now();
    if (ticker) return;
    for (const type of ACTIVITY) document.addEventListener(type, markActive, { capture: true, passive: true });
    ticker = setInterval(tick, 1000);
}

export function scheduleNext(first = false) {
    if (first) stopped = false;
    else if (stopped) return;
    stopTicker();
    if (!settings.store.challenges) return;
    const [min, max] = FREQUENCY[settings.store.frequency] ?? FREQUENCY.sometimes;
    setNext(first ? minutes(Math.max(10, min)) + rand(0, minutes(10)) : rand(minutes(min), minutes(max)));
}

function retryLater() {
    setNext(rand(60_000, 120_000));
}

/** Greed draws Ransom in, like in DOORS: each pile of gold you grab cuts a quarter off the wait for the next one. */
export function onGoldGrabbed() {
    markActive();
    if (!settings.store.challenges || running || !ticker) return;
    remaining = Math.min(remaining, Math.max(45_000, remaining * 0.75));
}

function isTyping() {
    const el = document.activeElement;
    const editable = el instanceof HTMLElement && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA");
    return editable || Date.now() - lastKey < 8000;
}

export function blockedReason(): string | undefined {
    if (stopped) return "Ransom is turned off.";
    if (running) return "Ransom is already here.";
    if (isWrecked()) return "Discord is still broken from the last one. Revive it first.";
    if (document.hidden || !document.hasFocus()) return "Discord isn't the focused window.";
    if (document.fullscreenElement) return "Something is fullscreen.";
    if (!settings.store.allowWhileTyping && isTyping()) return "You're typing.";
    if (!settings.store.allowInCall && SelectedChannelStore.getVoiceChannelId()) return "You're in a voice call.";
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) return "A window is open.";
}

function tryStart() {
    if (!settings.store.challenges) return;
    if (blockedReason()) return retryLater();
    showSign();
}

export function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && running) {
        e.preventDefault();
        e.stopPropagation();
        if (onEscape) onEscape();
        else finish();
        return;
    }
    lastKey = Date.now();
}

export function endAll() {
    onEscape = undefined;
    cleanup?.();
    cleanup = undefined;
    // A Discord left broken by a lost ransom stays broken until it's revived.
    if (!isWrecked()) {
        decryptUI();
        repairUI();
    }
    stopAll();
    running = false;
    hideCreature(false);
}

function finish(next = true) {
    endAll();
    if (next) scheduleNext();
}

function layer(className: string) {
    const el = document.createElement("div");
    el.className = `vc-ransom-layer ${className}`;
    if (settings.store.calmEffects) el.classList.add("vc-ransom-calm");
    document.body.appendChild(el);
    return el;
}

function picture(src: string, className: string) {
    const el = document.createElement("img");
    el.className = className;
    el.src = src;
    el.alt = "";
    el.draggable = false;
    return el;
}

function div(className: string, text?: string) {
    const el = document.createElement("div");
    el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

/**
 * Animated TV static on a small canvas that CSS stretches over the screen. "speckle" is the fine red grain Ransom
 * spreads over the edges of the screen: mostly see-through, with red and the odd coloured dot.
 */
function noise(className: string, tint: "red" | "grey" | "speckle", fps: number, scale = 10) {
    const canvas = document.createElement("canvas");
    canvas.className = className;
    canvas.width = Math.max(64, Math.round(window.innerWidth / scale));
    canvas.height = Math.max(36, Math.round(window.innerHeight / scale));
    const ctx = canvas.getContext("2d");
    let frame = 0;
    if (ctx) {
        const data = ctx.createImageData(canvas.width, canvas.height);
        const pixels = new Uint32Array(data.data.buffer);
        const every = 1000 / fps;
        let last = 0;
        const draw = (now: number) => {
            frame = requestAnimationFrame(draw);
            if (now - last < every) return;
            last = now;
            for (let i = 0; i < pixels.length; i++) {
                const v = (Math.random() * 255) | 0;
                if (tint === "speckle") {
                    pixels[i] = v < 110 ? 0 : v > 252
                        ? 0xff000000 | ((Math.random() * 0xffffff) | 0)
                        : 0xff000000 | ((v >> 4) << 16) | ((v >> 4) << 8) | (120 + (v >> 1));
                    continue;
                }
                pixels[i] = tint === "red"
                    ? 0xff000000 | ((v >> 3) << 16) | ((v >> 3) << 8) | v
                    : 0xff000000 | (v << 16) | (v << 8) | v;
            }
            ctx.putImageData(data, 0, 0);
        };
        frame = requestAnimationFrame(draw);
    }
    return { el: canvas, stop: () => cancelAnimationFrame(frame) };
}

const clock = (ms: number) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

// 1. Ransom's face flickers in somewhere on screen. 2. Its stop sign flashes in the middle with red static:
// any input while it's up gets you caught.
export function showSign() {
    endAll();
    running = true;
    hideCreature(true);
    void bumpStats(s => void s.signs++);

    const vol = settings.store.soundVolume;
    const root = layer("vc-ransom-encounter");
    const timers: ReturnType<typeof setTimeout>[] = [];
    const stops: (() => void)[] = [];
    let watching = false;
    let moved = 0;
    let lastX: number | undefined;
    let lastY: number | undefined;

    // The screen cuts to black with Ransom's face in the middle, then its sign shows on dark red.
    const face = image("creature");
    if (face) {
        root.classList.add("vc-ransom-blackout");
        root.appendChild(picture(face, "vc-ransom-spawn"));
    }
    play("spawn", vol);

    const caught = () => {
        watching = false;
        cleanup?.();
        cleanup = undefined;
        stopAll();
        caughtScare();
    };
    const onMove = (e: MouseEvent) => {
        if (!watching) return;
        if (lastX !== undefined && lastY !== undefined) moved += Math.hypot(e.clientX - lastX, e.clientY - lastY);
        lastX = e.clientX;
        lastY = e.clientY;
        if (moved > 10) caught();
    };
    const onInput = (e: Event) => {
        if (!watching) return;
        if (e instanceof KeyboardEvent && e.key === "Escape") return;
        caught();
    };
    const onBlur = () => {
        if (running && !watching) finish();
    };
    document.addEventListener("mousemove", onMove, { passive: true });
    document.addEventListener("keydown", onInput);
    document.addEventListener("mousedown", onInput);
    document.addEventListener("wheel", onInput, { passive: true });
    window.addEventListener("blur", onBlur);

    timers.push(setTimeout(() => {
        root.querySelector(".vc-ransom-spawn")?.remove();
        root.classList.remove("vc-ransom-blackout");
        root.classList.add("vc-ransom-dim");
        if (settings.store.seeThrough) root.classList.add("vc-ransom-see");
        const fuzz = noise("vc-ransom-fuzz", "red", settings.store.calmEffects ? 8 : 20, 6);
        stops.push(fuzz.stop);
        root.appendChild(fuzz.el);
        root.appendChild(picture(image("sign"), "vc-ransom-stopsign"));
        play("sign", vol);
        timers.push(setTimeout(() => watching = true, GRACE_MS));
        timers.push(setTimeout(() => {
            if (!watching) return;
            watching = false;
            void bumpStats(s => void s.stayedStill++);
            root.classList.add("vc-ransom-leave");
            timers.push(setTimeout(() => finish(), 250));
        }, SIGN_MS));
    }, face ? SPAWN_MS : 200));

    cleanup = () => {
        timers.forEach(clearTimeout);
        stops.forEach(s => s());
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("keydown", onInput);
        document.removeEventListener("mousedown", onInput);
        document.removeEventListener("wheel", onInput);
        window.removeEventListener("blur", onBlur);
        root.remove();
    };
}

// Caught: the jumpscare on red static, a white, red and black flash, then the ransom starts.
function caughtScare() {
    running = true;
    const rare = Math.random() * 100 < settings.store.rareChance;
    const root = layer("vc-ransom-scare");
    const timers: ReturnType<typeof setTimeout>[] = [];
    const fuzz = noise("vc-ransom-fuzz", "red", 30, 6);
    root.appendChild(fuzz.el);
    // As in the game: its face hangs small on red for a moment, then lunges at you full screen.
    const face = image("creature");
    const small = face ? picture(face, "vc-ransom-caught-face") : undefined;
    if (small) root.appendChild(small);
    const scary = settings.store.jumpscare ? image("jumpscare") : "";
    const lunge = small ? 520 : 0;
    timers.push(setTimeout(() => {
        small?.remove();
        if (scary) root.appendChild(picture(scary, "vc-ransom-scare-face"));
        if (scary || !small) play("jumpscare", settings.store.jumpscareVolume);
    }, lunge));
    timers.push(setTimeout(() => {
        cleanup?.();
        cleanup = undefined;
        downloading(rare ? startEasterEgg : startRansom);
    }, lunge + (scary ? 950 : 300)));
    cleanup = () => {
        timers.forEach(clearTimeout);
        fuzz.stop();
        root.remove();
    };
}

// The red "DOWNLOADING.." screen the game shows while the ransom installs itself. The EasterEgg gets it too.
function downloading(next: () => void) {
    running = true;
    const root = layer("vc-ransom-download");
    if (settings.store.seeThrough) root.classList.add("vc-ransom-see");
    const fuzz = noise("vc-ransom-fuzz", "red", settings.store.calmEffects ? 8 : 14, 8);
    const text = div("vc-ransom-download-text", "DOWNLOADING.");
    const bar = div("vc-ransom-download-bar");
    const segments = Array.from({ length: 10 }, () => bar.appendChild(div("vc-ransom-download-seg")));
    root.append(fuzz.el, text, bar);
    const timers: ReturnType<typeof setTimeout>[] = [];
    let filled = 0;
    const step = () => {
        segments[filled++]?.classList.add("vc-ransom-download-on");
        text.textContent = "DOWNLOADING" + ".".repeat(filled % 3 + 1);
        if (filled < segments.length) timers.push(setTimeout(step, rand(90, 260)));
        else timers.push(setTimeout(() => {
            cleanup?.();
            cleanup = undefined;
            next();
        }, 350));
    };
    timers.push(setTimeout(step, 250));
    cleanup = () => {
        timers.forEach(clearTimeout);
        fuzz.stop();
        root.remove();
    };
}

const POPUP_TITLES = ["R4NSOM", "RANSOM", "Untitled", "IDIOT", "MOSNAR", "AJWBXV", "R4NS0M"];
const GLITCH_COLOURS = ["#ff1010", "#ffe600", "#3dff3d", "#ff2bd6", "#000000", "#ffffff", "#20e0ff", "#b00000"];

/** Fills a pop-up's canvas like the game's broken windows: torn rows of loud colour, or white static. */
function drawPopup(ctx: CanvasRenderingContext2D, kind: "glitch" | "white", w: number, h: number) {
    if (kind === "white") {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
        for (let i = 0; i < w * h * 0.25; i++) {
            const x = Math.random() * w;
            if (Math.random() < x / w) continue;
            ctx.fillStyle = Math.random() < 0.7 ? `rgb(255 ${130 + Math.random() * 110} ${130 + Math.random() * 110})` : "#e01010";
            ctx.fillRect(x | 0, (Math.random() * h) | 0, 1, 1);
        }
        return;
    }
    let y = 0;
    while (y < h) {
        const rows = 1 + ((Math.random() * 4) | 0);
        let x = 0;
        while (x < w) {
            const len = 2 + ((Math.random() * w * 0.4) | 0);
            ctx.fillStyle = pick(GLITCH_COLOURS);
            ctx.fillRect(x, y, len, rows);
            x += len;
        }
        y += rows;
    }
}

/** One of the windows that pop up during the ransom. They open blank and white, then fill in. */
function popupWindow(pictures: string[], width: number) {
    const el = div("vc-ransom-pop");
    el.style.width = `${width}px`;
    el.appendChild(div("vc-ransom-pop-bar", pick(POPUP_TITLES)));
    const body = div("vc-ransom-pop-body");
    el.appendChild(body);
    const kind = pictures.length && Math.random() < 0.35 ? "art" : Math.random() < 0.55 ? "glitch" : "white";
    if (kind === "art") {
        body.classList.add("vc-ransom-pop-red");
        body.appendChild(picture(pick(pictures), "vc-ransom-pop-art"));
        return el;
    }
    const canvas = document.createElement("canvas");
    canvas.className = "vc-ransom-pop-canvas";
    canvas.width = 96;
    canvas.height = 44;
    body.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) return el;
    let last = 0;
    const draw = (now: number) => {
        if (last && !el.isConnected) return;
        requestAnimationFrame(draw);
        if (now - last < (kind === "glitch" ? 140 : 220)) return;
        last = now;
        drawPopup(ctx, kind, canvas.width, canvas.height);
    };
    requestAnimationFrame(draw);
    return el;
}

interface Round {
    gold: number;
    owed: number;
    started: number;
    deadline: number;
    over: boolean;
}

/** `scale` multiplies what's owed: the rare EasterEgg asks for twice the normal ransom. */
function newRound(scale = 1): Round {
    void bumpStats(s => void s.hunts++);
    const gold = level().gold * scale;
    const started = Date.now();
    return { gold, owed: gold, started, deadline: started + SECONDS * 1000, over: false };
}

/** Spam clicking costs gold: five missed clicks inside a second adds the difficulty's fine to what's owed. */
function spamGuard(root: HTMLElement, charge: (amount: number) => boolean) {
    const misses: number[] = [];
    let lastFine = 0;
    return (e: MouseEvent) => {
        const now = performance.now();
        misses.push(now);
        while (misses.length && now - misses[0] > 1000) misses.shift();
        if (misses.length < 5 || now - lastFine < 1500) return;
        const { fine } = level();
        if (!charge(fine)) return;
        lastFine = now;
        misses.length = 0;
        play("error", settings.store.soundVolume);
        const tag = div("vc-ransom-fine", `+${fine}`);
        tag.style.left = `${e.clientX}px`;
        tag.style.top = `${e.clientY}px`;
        root.appendChild(tag);
        setTimeout(() => tag.remove(), 900);
    };
}

/**
 * Covers Discord while the ransom runs so a miss can't click a message, button or link by accident. The mouse wheel
 * still scrolls whatever is underneath, so new gold can be found further up the chat.
 */
function clickShield() {
    const shield = div("vc-ransom-shield");
    shield.addEventListener("wheel", e => {
        shield.style.pointerEvents = "none";
        let el = document.elementFromPoint(e.clientX, e.clientY);
        shield.style.pointerEvents = "";
        while (el && !(el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
        el?.scrollBy({ top: e.deltaY, left: e.deltaX });
    }, { passive: true });
    shield.addEventListener("contextmenu", e => e.preventDefault());
    return shield;
}

function pileValue() {
    return 5 * Math.round(rand(1, 5));
}

/** Coin flies from a pile to where the gold is counted. */
function flyCoin(from: DOMRect, to: DOMRect, parent: HTMLElement, done: () => void) {
    const coin = picture(image("coin"), "vc-ransom-flycoin");
    const size = 28;
    coin.style.left = `${from.left + from.width / 2 - size / 2}px`;
    coin.style.top = `${from.top + from.height / 2 - size / 2}px`;
    parent.appendChild(coin);
    requestAnimationFrame(() => requestAnimationFrame(() => {
        coin.style.transform = `translate(${to.left + to.width / 2 - from.left - from.width / 2}px, ${to.top + to.height / 2 - from.top - from.height / 2}px) scale(0.6)`;
        coin.style.opacity = "0.4";
    }));
    setTimeout(() => {
        coin.remove();
        done();
    }, 460);
}

/**
 * The "virus" pop-ups both ransoms throw at you: a burst at the start, then more and bigger ones as time runs out.
 * Early ones hug the edges of the screen, later ones land anywhere.
 */
function startPopups(pops: HTMLElement, timers: ReturnType<typeof setTimeout>[], vol: number, level: () => number, over: () => boolean) {
    const popup = () => {
        if (over()) return;
        const intensity = level();
        const max = 4 + intensity * 2;
        if (pops.querySelectorAll(".vc-ransom-pop").length < max) {
            const w = rand(220, 340) * (1 + intensity * 0.12);
            const h = w * 0.5;
            const el = popupWindow(popupImages(), w);
            const edgeOnly = intensity === 0 || Math.random() < 0.5;
            const x = edgeOnly && Math.random() < 0.5
                ? (Math.random() < 0.5 ? rand(-w * 0.2, 40) : rand(window.innerWidth - w - 40, window.innerWidth - w * 0.8))
                : rand(0, window.innerWidth - w);
            const y = rand(30, window.innerHeight - h);
            el.style.left = `${x}px`;
            el.style.top = `${y}px`;
            pops.appendChild(el);
            play("popupIn", vol * 0.6);
            timers.push(setTimeout(() => {
                if (!el.isConnected) return;
                el.classList.add("vc-ransom-pop-out");
                play("popupOut", vol * 0.5);
                timers.push(setTimeout(() => el.remove(), 180));
            }, rand(5000, 10_000)));
        }
        timers.push(setTimeout(popup, intensity >= 2 ? rand(1200, 2600) : intensity >= 1 ? rand(2200, 4200) : rand(3500, 6000)));
    };
    for (let i = 0; i < 5; i++) timers.push(setTimeout(popup, 150 + i * rand(180, 320)));
}

/** The game's "YOUR ITEMS HAVE BEEN ENCRYPTED" window, made about your Discord, with the gold owed and the time left. */
function ransomWindow(owed: number) {
    const win = div("vc-ransom-window");
    const bar = div("vc-ransom-pop-bar", "RANSOM");
    const inner = div("vc-ransom-window-inner");
    const head = div("vc-ransom-window-head");
    const face = image("creature");
    if (face) head.appendChild(picture(face, "vc-ransom-window-face"));
    const title = div("vc-ransom-window-title");
    title.append("YOUR DISCORD", document.createElement("br"), "HAS BEEN", document.createElement("br"), "ENCRYPTED");
    head.appendChild(title);
    const note = div("vc-ransom-window-note", "IF YOU DO NOT PAY THIS RANSOM BEFORE THE TIMER ENDS, YOUR ACCOUNT WILL BE ");
    note.appendChild(div("vc-ransom-window-warn", "LOST FOREVER."));
    const row = div("vc-ransom-window-row");
    const goldBox = div("vc-ransom-window-gold");
    const num = div("vc-ransom-window-num", String(owed));
    goldBox.append(num, picture(image("coin"), "vc-ransom-window-coin"));
    const timeBox = div("vc-ransom-window-time");
    const time = div("vc-ransom-window-clock", clock(SECONDS * 1000));
    timeBox.append(div("vc-ransom-window-label", "TIME:"), time);
    row.append(goldBox, timeBox);
    inner.append(head, note, row);
    win.append(bar, inner);
    return { win, num, time, goldBox };
}

const countSteps = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>[]>();

/** Counts a number shown on screen down to `to`, a few steps at a time. */
function countTo(el: HTMLElement, to: number) {
    // A newer value always wins over the steps of an older count still running.
    for (const t of countSteps.get(el) ?? []) clearTimeout(t);
    countSteps.delete(el);
    const from = Number(el.textContent) || 0;
    if (from <= to) return void (el.textContent = String(to));
    const steps = 6;
    const pending: ReturnType<typeof setTimeout>[] = [];
    for (let i = 1; i <= steps; i++) pending.push(setTimeout(() => el.textContent = String(Math.round(from - (from - to) * i / steps)), i * 40));
    countSteps.set(el, pending);
}

const ANCHORS = '[class*="messageListItem"], [data-list-item-id]';

// The ransom, the way it plays in the game: you keep using Discord while pop-ups cloud your view and a red static
// creeps in from the edges. Gold is hidden in messages, channels, servers and DMs; collect what Ransom wants before
// the timer ends.
function startRansom() {
    running = true;
    const { piles: pileCount, every, life } = level();
    const round = newRound();
    const vol = settings.store.soundVolume;
    const calm = settings.store.calmEffects;

    const root = layer("vc-ransom-attack");
    encryptUI();
    const edge = noise("vc-ransom-edge", "speckle", calm ? 8 : 18, 3);
    const pops = div("vc-ransom-pops");
    const field = div("vc-ransom-golds");
    const { win, num, time, goldBox } = ransomWindow(round.owed);
    const fade = div("vc-ransom-fadein");
    root.append(edge.el, clickShield(), field, pops, win, fade);
    play("popupMain", vol);

    const timers: ReturnType<typeof setTimeout>[] = [];
    const music: Music = startMusic(vol);
    let intensity = 0;
    let rose = false;
    let raf = 0;

    interface Pile { el: HTMLButtonElement; anchor: HTMLElement; ox: number; oy: number; born: number; value: number; }
    const piles = new Set<Pile>();

    const blocked = () => win.getBoundingClientRect();
    const spawnPile = () => {
        if (round.over || piles.size >= pileCount) return;
        const avoid = blocked();
        const used = new Set([...piles].map(p => p.anchor));
        const options = [...document.querySelectorAll<HTMLElement>(ANCHORS)].filter(el => {
            if (used.has(el) || el.closest(".vc-ransom-layer")) return false;
            const r = el.getBoundingClientRect();
            if (r.width < 32 || r.height < 24 || r.top < 40 || r.bottom > window.innerHeight - 8 || r.left < 0 || r.right > window.innerWidth) return false;
            return r.bottom < avoid.top - 4 || r.top > avoid.bottom + 4 || r.right < avoid.left - 4 || r.left > avoid.right + 4;
        });
        if (!options.length) return;
        const anchor = pick(options);
        const wide = anchor.getBoundingClientRect().width > 120;
        const el = document.createElement("button");
        el.className = "vc-ransom-gold";
        el.style.setProperty("--tilt", `${rand(-25, 25)}deg`);
        el.appendChild(picture(image("coin"), ""));
        const pile: Pile = { el, anchor, ox: wide ? rand(0.25, 0.92) : rand(0.55, 0.8), oy: rand(0.3, 0.7), born: Date.now(), value: pileValue() };
        const take = (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            if (round.over || !piles.has(pile)) return;
            piles.delete(pile);
            const from = el.getBoundingClientRect();
            el.remove();
            round.owed = Math.max(0, round.owed - pile.value);
            play("coin", vol);
            flyCoin(from, goldBox.getBoundingClientRect(), root, () => {
                play("goldUp", vol * 0.8);
                countTo(num, round.owed);
                goldBox.classList.remove("vc-ransom-bump");
                void goldBox.offsetWidth;
                goldBox.classList.add("vc-ransom-bump");
            });
            if (round.owed <= 0) {
                round.over = true;
                timers.push(setTimeout(() => paid(round), 700));
            }
        };
        el.addEventListener("mousedown", take);
        el.addEventListener("click", e => {
            e.preventDefault();
            e.stopPropagation();
        });
        piles.add(pile);
        field.appendChild(el);
    };

    // Like in the game, the ransom window doesn't stay put: every few seconds it jumps somewhere else.
    const moveWindow = () => {
        if (round.over) return;
        const r = win.getBoundingClientRect();
        win.style.left = `${rand(r.width / 2 + 12, window.innerWidth - r.width / 2 - 12)}px`;
        win.style.top = `${rand(12, Math.max(12, window.innerHeight - r.height - 12))}px`;
        timers.push(setTimeout(moveWindow, rand(6000, 11_000) / (1 + intensity * 0.4)));
    };

    const peek = () => {
        if (round.over) return;
        const face = image(intensity >= 2 ? "jumpscare" : "creature");
        const near = pick([...piles]);
        if (face && near) {
            const r = near.el.getBoundingClientRect();
            const el = picture(face, "vc-ransom-peek");
            el.style.left = `${r.left + rand(-60, 30)}px`;
            el.style.top = `${r.top + rand(-60, 20)}px`;
            pops.appendChild(el);
            timers.push(setTimeout(() => el.remove(), calm ? 700 : 260));
        }
        timers.push(setTimeout(peek, rand(5000, 9000) / (1 + intensity * 0.5)));
    };

    const tick = () => {
        raf = requestAnimationFrame(tick);
        const now = Date.now();
        const left = round.deadline - now;
        const shown = clock(left);
        if (time.textContent !== shown) time.textContent = shown;
        const n = left <= 30_000 ? 2 : left <= 60_000 ? 1 : 0;
        if (n > intensity) {
            intensity = n;
            breakUI(n);
            root.classList.add(`vc-ransom-i${n}`);
            music.intensity(n);
        }
        if (!rose && left <= 15_000) {
            rose = true;
            breakUI(3);
            win.classList.add("vc-ransom-window-urgent");
            music.riser();
        }
        for (const pile of piles) {
            const r = pile.anchor.getBoundingClientRect();
            const gone = !pile.anchor.isConnected || r.bottom < 40 || r.top > window.innerHeight || r.width === 0;
            const expired = life && now - pile.born > life;
            if (gone || expired) {
                piles.delete(pile);
                if (expired && !gone) {
                    // Gone for good: the next one only comes with the steady trickle.
                    pile.el.classList.add("vc-ransom-gold-lost");
                    play("popupOut", vol * 0.6);
                    setTimeout(() => pile.el.remove(), 300);
                } else {
                    // Scrolled out of view isn't your fault: it turns up somewhere else.
                    pile.el.remove();
                    timers.push(setTimeout(spawnPile, rand(300, 1200)));
                }
                continue;
            }
            pile.el.style.transform = `translate(${Math.round(r.left + r.width * pile.ox - 14)}px, ${Math.round(r.top + r.height * pile.oy - 14)}px) rotate(var(--tilt))`;
        }
        if (left <= 0 && !round.over) {
            round.over = true;
            failed(round);
        }
    };

    root.addEventListener("mousedown", spamGuard(root, fine => {
        if (round.over) return false;
        round.owed += fine;
        countTo(num, round.owed);
        goldBox.classList.remove("vc-ransom-fined");
        void goldBox.offsetWidth;
        goldBox.classList.add("vc-ransom-fined");
        return true;
    }));

    for (let i = 0; i < pileCount; i++) timers.push(setTimeout(spawnPile, 300 + i * 250));
    // New piles trickle in, like fresh drawers in the next room.
    const refill = setInterval(spawnPile, every);
    // The ransom opens with a burst of windows, then they keep coming.
    startPopups(pops, timers, vol, () => intensity, () => round.over);
    timers.push(setTimeout(moveWindow, rand(5000, 8000)));
    timers.push(setTimeout(peek, 4000));
    raf = requestAnimationFrame(tick);

    cleanup = () => {
        round.over = true;
        cancelAnimationFrame(raf);
        clearInterval(refill);
        timers.forEach(clearTimeout);
        edge.stop();
        music.stop();
        root.remove();
    };
}

// The rare EasterEgg, after Lobi's R4NS0M fan song: a red screen, the seconds left in huge numbers either side of
// Ransom's face, a gun pointed at you and an open hand asking for twice the usual gold. It starts out fair and gets
// harder the longer it goes; when the beat drops it kicks into a higher gear, and from then on every kick of the bass
// hits.
function startEasterEgg() {
    running = true;
    const round = newRound(2);
    const vol = settings.store.soundVolume;
    const calm = settings.store.calmEffects;

    const root = layer("vc-ransom-easterEgg");
    if (settings.store.seeThrough) root.classList.add("vc-ransom-see");
    encryptUI("BEGGAR");
    const grain = noise("vc-ransom-grain", "grey", calm ? 8 : 15, 4);
    const stage = div("vc-ransom-stage");
    const left = div("vc-ransom-digit vc-ransom-digit-left", "9");
    const right = div("vc-ransom-digit vc-ransom-digit-right", "0");
    const faceSrc = image("creature");
    const face = faceSrc ? picture(faceSrc, "vc-ransom-easterEgg-face") : undefined;
    const gun = picture(image("gun"), "vc-ransom-easterEgg-gun");
    const hand = picture(image("hand"), "vc-ransom-easterEgg-hand");
    const owedLabel = div("vc-ransom-owed", `PAY ${round.owed}`);
    // The fist goes behind Ransom's face, like in the video, where his static covers the knuckles.
    stage.append(left, right, gun, ...(face ? [face] : []), hand, owedLabel);
    const field = div("vc-ransom-golds");
    const pops = div("vc-ransom-pops");
    const fade = div("vc-ransom-fadein vc-ransom-fadein-slow");
    root.append(grain.el, stage, field, pops, fade);

    const timers: ReturnType<typeof setTimeout>[] = [];
    const music = startMusic(vol, "easterEggMusic");
    let raf = 0;
    let intensity = 0;
    let angry = false;
    let rose = false;
    // When the beat dropped (0 = not yet), and the bass level for the kicks after it.
    let droppedAt = 0;
    let bassAvg = 0;
    let lastKick = 0;
    let kicks = 0;
    // The song's drop is found in the file itself; the DOORS layers get one a third of the way in.
    const dropAt = round.started + (music.dropTime ? music.dropTime * 1000 : SECONDS * 1000 * 0.33);

    /** 0 to 1: how hard the EasterEgg is right now. Creeps up before the drop, jumps at it, then climbs to the end. */
    const heat = () => {
        const now = Date.now();
        if (!droppedAt) return Math.min(0.3, (now - round.started) / (SECONDS * 1000) * 0.7);
        return 0.45 + 0.55 * Math.min(1, (now - droppedAt) / Math.max(1, round.deadline - droppedAt));
    };

    const restart = (el: HTMLElement, className: string) => {
        el.classList.remove(className);
        void el.offsetWidth;
        el.classList.add(className);
    };

    const target = () => hand.getBoundingClientRect();
    const spawnPile = (chain = true) => {
        if (round.over) return;
        const h = heat();
        // Piles flicker in anywhere, drift, and vanish faster the hotter it gets.
        const life = Math.max(1400, 4200 - h * 2800);
        const reach = 80 + h * 120;
        const el = document.createElement("button");
        el.className = "vc-ransom-gold vc-ransom-gold-drift";
        el.style.setProperty("--tilt", `${rand(-25, 25)}deg`);
        el.style.setProperty("--dx", `${rand(-reach, reach)}px`);
        el.style.setProperty("--dy", `${rand(-reach * 0.6, reach * 0.6)}px`);
        el.style.setProperty("--life", `${life}ms`);
        el.style.left = `${rand(4, 92)}vw`;
        el.style.top = `${rand(10, 82)}vh`;
        el.appendChild(picture(image("coin"), ""));
        let taken = false;
        el.addEventListener("mousedown", e => {
            e.preventDefault();
            e.stopPropagation();
            if (round.over || taken) return;
            taken = true;
            const from = el.getBoundingClientRect();
            el.remove();
            // A bit more than a normal pile, since these drift and don't stay long, and more on harder settings since
            // there's more to pay: about 55 catches clears it either way.
            const value = 5 * Math.max(1, Math.round(pileValue() * 1.25 * level().gold / 500 / 5));
            round.owed = Math.max(0, round.owed - value);
            play("coin", vol);
            flyCoin(from, target(), root, () => {
                play("goldUp", vol * 0.8);
                owedLabel.textContent = `PAY ${round.owed}`;
                restart(hand, "vc-ransom-bump");
            });
            if (round.owed <= 0) {
                round.over = true;
                timers.push(setTimeout(() => paid(round), 700));
            }
        });
        field.appendChild(el);
        timers.push(setTimeout(() => {
            if (!taken) el.remove();
        }, life));
        if (chain) timers.push(setTimeout(spawnPile, rand(500, 1100) * (1 - h * 0.5)));
    };

    const drop = () => {
        droppedAt = Date.now();
        root.classList.add("vc-ransom-dropped");
        breakUI(2);
        if (!calm) {
            const flash = div("vc-ransom-drop-flash");
            root.appendChild(flash);
            timers.push(setTimeout(() => flash.remove(), 700));
        }
        for (let i = 0; i < 3; i++) timers.push(setTimeout(() => spawnPile(false), i * 120));
    };

    // After the drop, each kick of the bass jolts the gun and the numbers, and every other one throws in more gold
    // that won't stay long. With a song they land on its beat, counted from the drop; the DOORS layers are listened to.
    let nextBeat = 0;
    const kick = (now: number) => {
        lastKick = now;
        kicks++;
        if (!calm) {
            restart(gun, "vc-ransom-recoil");
            restart(stage, "vc-ransom-kick");
        }
        if (kicks % 2 === 0 && field.childElementCount < 5 + heat() * 5) spawnPile(false);
    };

    const tick = () => {
        raf = requestAnimationFrame(tick);
        const now = Date.now();
        const ms = round.deadline - now;
        const secs = Math.max(0, Math.ceil(ms / 1000));
        const text = String(secs).padStart(2, "0");
        if (left.textContent !== text[0]) left.textContent = text[0];
        if (right.textContent !== text[1]) right.textContent = text[1];

        const bass = music.bass();
        stage.style.setProperty("--beat", String(1 + (calm ? 0 : bass * (droppedAt ? 0.12 : 0.05))));
        if (!droppedAt) {
            if (now >= dropAt) drop();
        } else if (music.beat) {
            if (!nextBeat) nextBeat = dropAt;
            if (now >= nextBeat) {
                kick(now);
                while (nextBeat <= now) nextBeat += music.beat * 1000;
            }
        } else {
            bassAvg += (bass - bassAvg) * 0.08;
            if (bass > bassAvg + 0.07 && now - lastKick > 260) kick(now);
        }

        const n = Math.max(secs <= 30 ? 2 : secs <= 60 ? 1 : 0, droppedAt ? 1 : 0, heat() > 0.75 ? 2 : 0);
        if (n > intensity) {
            intensity = n;
            breakUI(n);
            root.classList.add(`vc-ransom-i${n}`);
            music.intensity(n);
        }
        if (!angry && secs <= 30) {
            angry = true;
            root.classList.add("vc-ransom-angry");
            play("error", vol);
        }
        if (!rose && secs <= 15) {
            rose = true;
            breakUI(3);
            music.riser();
        }
        if (ms <= 0 && !round.over) {
            round.over = true;
            failed(round, true);
        }
    };

    root.addEventListener("mousedown", spamGuard(root, fine => {
        if (round.over) return false;
        round.owed += fine;
        owedLabel.textContent = `PAY ${round.owed}`;
        restart(owedLabel, "vc-ransom-fined");
        return true;
    }));

    timers.push(setTimeout(spawnPile, 1600));
    timers.push(setTimeout(() => startPopups(pops, timers, vol, () => intensity, () => round.over), 1200));
    raf = requestAnimationFrame(tick);

    cleanup = () => {
        round.over = true;
        cancelAnimationFrame(raf);
        timers.forEach(clearTimeout);
        grain.stop();
        music.stop();
        root.remove();
    };
}

// Paid: the green "THANK YOU" screen.
function paid(round: Round) {
    const seconds = Math.round((Date.now() - round.started) / 1000);
    void bumpStats(s => {
        s.won++;
        s.goldPaid += round.gold;
        if (!s.bestSeconds || seconds < s.bestSeconds) s.bestSeconds = seconds;
    });
    cleanup?.();
    cleanup = undefined;
    stopAll();
    decryptUI();
    repairUI();
    running = true;
    const root = layer("vc-ransom-thanks");
    const text = div("vc-ransom-thanks-text", "THANK YOU");
    text.dataset.text = "THANK YOU";
    const sign = image("thanks");
    root.append(text, sign ? picture(sign, "vc-ransom-thanks-sign") : div("vc-ransom-thanks-sign vc-ransom-thanks-fallback", "👍"));
    play("paid", settings.store.soundVolume);
    play("success", settings.store.soundVolume);
    // Like the game, paying Ransom off leaves a Honey Pot behind to break open.
    let done = false;
    const close = () => {
        if (done) return;
        done = true;
        finish();
        dropHoneyPot();
    };
    const timers = [
        setTimeout(() => root.classList.add("vc-ransom-leave"), 3600),
        setTimeout(close, 4000)
    ];
    root.addEventListener("click", close);
    onEscape = close;
    cleanup = () => {
        timers.forEach(clearTimeout);
        root.remove();
    };
}

function failed(round: Round, easterEgg = false) {
    void bumpStats(s => void s.lost++);
    cleanup?.();
    cleanup = undefined;
    stopAll();
    const deleted = settings.store.takeItems ? takeFound(3).then(t => t.length) : Promise.resolve(0);
    jumpscare(false, deleted, true, easterEgg);
}

// Time's up: the jumpscare, then black with what was lost.
export function jumpscare(test = false, deleted: Promise<number> = Promise.resolve(0), lost = false, easterEgg = false) {
    cleanup?.();
    cleanup = undefined;
    stopAll();
    running = true;
    hideCreature(true);
    const root = layer("vc-ransom-scare vc-ransom-fail");
    const timers: ReturnType<typeof setTimeout>[] = [];
    const fuzz = noise("vc-ransom-fuzz", "red", 30, 6);
    root.appendChild(fuzz.el);
    const scary = settings.store.jumpscare ? image("jumpscare") : "";
    if (scary) {
        root.appendChild(picture(scary, "vc-ransom-scare-face vc-ransom-scare-lunge"));
        play("fail", settings.store.jumpscareVolume);
    } else root.appendChild(div("vc-ransom-scare-text", "TIME'S UP"));
    const note = div("vc-ransom-lost");
    root.appendChild(note);
    void deleted.then(n => {
        if (n) note.textContent = `${n} ENCRYPTED ${n === 1 ? "ITEM" : "ITEMS"} DELETED`;
    });
    // Then a flash of bright red that fades back to Discord, the way the game hands you back control.
    const flash = scary ? 1300 : 1100;
    if (!settings.store.calmEffects) timers.push(setTimeout(() => root.classList.add("vc-ransom-flash-red"), flash));
    timers.push(setTimeout(() => {
        fuzz.stop();
        root.classList.remove("vc-ransom-flash-red");
        root.classList.add("vc-ransom-after");
    }, flash + 220));
    // A real loss leaves Discord broken (see aftermath.ts) instead of handing it straight back.
    let over = false;
    const close = () => {
        if (over) return;
        over = true;
        if (!lost || !settings.store.breakUI) return finish(!test);
        cleanup?.();
        cleanup = undefined;
        stopAll();
        running = false;
        hideCreature(false);
        void afterLoss(easterEgg);
    };
    timers.push(setTimeout(close, flash + 2600));
    root.addEventListener("click", close);
    onEscape = close;
    cleanup = () => {
        timers.forEach(clearTimeout);
        fuzz.stop();
        root.remove();
    };
}

export function stopChallenges() {
    stopped = true;
    stopTicker();
    endAll();
}
