/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";

import { starlightSvg } from "./art";
import { repairUI, wreckUI } from "./breakdown";
import { addDeath, addRevive, getStats, onStatsChange, scheduleNext, takeAllGold } from "./challenge";
import { hideCreature } from "./creature";
import { decryptUI, encryptUI } from "./encrypt";
import { image } from "./images";
import { settings } from "./settings";
import { play, playSong, stopAll } from "./sound";

// What happens after a lost ransom. Discord stays broken and encrypted. With at least 1000 gold you can revive:
// it takes all your gold, and the Starlight's light puts Discord back together, like walking out through the light at
// the end of The Archives. Giving up, or not having enough gold, lets Ransom finish you off, and the Starlight talks to
// you in the dark water the way it does on the DOORS death screen, then shows the run overview and hands Discord back.

const WRECK_KEY = "Ransom_wrecked";
const REVIVE_MIN = 1000;

/** Reviving always takes everything you have, and never less than 1000. */
export const reviveCost = (gold: number) => Math.max(REVIVE_MIN, gold);

let wrecked = false;
// Lost to the rare EasterEgg: its death screen gets its own song.
let easterEggLoss = false;
let card: HTMLElement | undefined;
let offStats: (() => void) | undefined;
let watch: ReturnType<typeof setInterval> | undefined;
let scene: (() => void) | undefined;
// False once the plugin stops, so scenes cut short don't mend Discord or book the next Ransom on the way out.
let active = true;
// Bumped when the plugin stops, so a loss still being saved knows it was cut off.
let generation = 0;

/** True while Discord is broken or a revive or death is playing out. */
export const isWrecked = () => wrecked;

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const pick = <T,>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function img(src: string, className: string) {
    const node = el("img", className);
    node.src = src;
    node.alt = "";
    node.draggable = false;
    return node;
}

function layer(className: string) {
    const node = el("div", `vc-ransom-layer ${className}`);
    if (settings.store.calmEffects) node.classList.add("vc-ransom-calm");
    document.body.appendChild(node);
    return node;
}

function removeCard() {
    offStats?.();
    offStats = undefined;
    card?.remove();
    card = undefined;
}

/** Puts Discord back and forgets the broken state. */
async function mend() {
    clearInterval(watch);
    watch = undefined;
    removeCard();
    repairUI();
    decryptUI();
    wrecked = false;
    easterEggLoss = false;
    await DataStore.del(WRECK_KEY);
}

/** Called once the lost ransom's jumpscare is over, with Discord still broken and encrypted. */
export async function afterLoss(easterEgg = false) {
    const mine = ++generation;
    active = true;
    wrecked = true;
    easterEggLoss = easterEgg;
    await DataStore.set(WRECK_KEY, easterEgg ? "easterEgg" : true);
    if (mine !== generation) return;
    // Turning "Discord falls apart" or challenges off is always a way out.
    clearInterval(watch);
    watch = setInterval(() => {
        if (!scene && (!settings.store.breakUI || !settings.store.challenges)) void mend().then(() => { if (active) scheduleNext(); });
    }, 1000);
    const { goldFound } = await getStats();
    if (mine !== generation) return;
    if (goldFound >= REVIVE_MIN) {
        wreckUI();
        encryptUI(easterEgg ? "BEGGAR" : "RANSOM");
        showRevive();
    } else kill();
}

/** Brings the broken state back after Discord restarts, so a lost ransom can't be undone with a reload. */
export async function resumeAftermath() {
    const mine = generation;
    const kind = await DataStore.get(WRECK_KEY);
    if (mine !== generation) return;
    if (kind !== true && kind !== "easterEgg") return;
    if (!settings.store.breakUI || !settings.store.challenges) return void DataStore.del(WRECK_KEY);
    void afterLoss(kind === "easterEgg");
}

function showRevive() {
    removeCard();
    card = el("div", "vc-ransom-revive");
    const heart = img(image("revive"), "vc-ransom-revive-heart");
    const title = el("div", "vc-ransom-revive-title", "REVIVE");
    const note = el("div", "vc-ransom-revive-note", `${easterEggLoss ? "Beggar" : "Ransom"} broke Discord. Revive to put it back together.`);
    const cost = el("div", "vc-ransom-revive-cost");
    const coin = img(image("coin"), "vc-ransom-revive-coin");
    const amount = el("span", "vc-ransom-revive-amount");
    const fine = el("span", "vc-ransom-revive-fine", "costs all of your gold");
    cost.append(coin, amount, fine);
    const buttons = el("div", "vc-ransom-revive-buttons");
    const yes = el("button", "vc-ransom-revive-yes", "Revive");
    const no = el("button", "vc-ransom-revive-no", "Give up");
    buttons.append(yes, no);
    card.append(heart, title, note, cost, buttons);
    document.body.appendChild(card);

    const show = (gold: number) => {
        amount.textContent = reviveCost(gold).toLocaleString();
        yes.disabled = gold < REVIVE_MIN;
    };
    void getStats().then(s => show(s.goldFound));
    offStats = onStatsChange(s => show(s.goldFound));

    yes.addEventListener("click", () => void revive());
    // Like skipping the revive in DOORS: Ransom finishes you off.
    no.addEventListener("click", () => {
        if (!scene && !reviving) kill();
    });
    play("popupIn", settings.store.soundVolume);
}

/** Opens the revive card again, if Discord is broken. */
export function openRevive() {
    if (!wrecked || scene) return false;
    showRevive();
    return true;
}

let reviving = false;

async function revive() {
    if (scene || reviving) return;
    // Held across the awaits so a double click can't take the gold twice or open two doorways.
    reviving = true;
    try {
        const { goldFound } = await getStats();
        if (goldFound < REVIVE_MIN) return kill();
        removeCard();
        await takeAllGold();
        // Paid for: a restart during the light shouldn't bring the broken Discord (and a death) back.
        void DataStore.del(WRECK_KEY);
        void addRevive();
        if (active) lightEnding();
    } finally {
        reviving = false;
    }
}

/** The Starlight's doorway: a frame of light opens, floods the screen while Discord mends behind it, then fades. */
function lightEnding() {
    const root = layer("vc-ransom-light");
    const veil = el("div", "vc-ransom-light-veil");
    const door = el("div", "vc-ransom-light-door");
    door.appendChild(el("div", "vc-ransom-light-glow"));
    const sparks = el("div", "vc-ransom-light-sparks");
    for (let i = 0; i < 26; i++) {
        const spark = el("i", "");
        spark.style.left = `${rand(38, 62)}%`;
        spark.style.top = `${rand(30, 80)}%`;
        spark.style.setProperty("--rise", `${rand(80, 260) | 0}px`);
        spark.style.setProperty("--drift", `${rand(-60, 60) | 0}px`);
        spark.style.animationDelay = `${rand(0, 2.2).toFixed(2)}s`;
        sparks.appendChild(spark);
    }
    const flood = el("div", "vc-ransom-light-flood");
    root.append(veil, door, sparks, flood);
    play("success", settings.store.soundVolume);

    const timers = [
        setTimeout(() => root.classList.add("vc-ransom-light-open"), 80),
        setTimeout(() => root.classList.add("vc-ransom-light-flooding"), 1500),
        setTimeout(() => void mend(), 3100),
        setTimeout(() => root.classList.add("vc-ransom-light-out"), 3300),
        setTimeout(() => end(), 5200)
    ];
    const end = () => {
        timers.forEach(clearTimeout);
        root.remove();
        scene = undefined;
        if (!active) return;
        if (wrecked) void mend();
        scheduleNext();
    };
    scene = end;
}

/** Ransom finishes the job: one last lunge, then the dark water. */
function kill() {
    removeCard();
    stopAll();
    hideCreature(true);
    const root = layer("vc-ransom-kill");
    const face = settings.store.jumpscare ? image("jumpscare") || image("creature") : "";
    if (face) {
        root.appendChild(img(face, "vc-ransom-kill-face"));
        play("jumpscare", settings.store.jumpscareVolume);
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    const end = () => {
        timers.forEach(clearTimeout);
        root.remove();
    };
    scene = end;
    // Dying settles it: a restart from here on shouldn't bring the broken Discord (or another death) back.
    void DataStore.del(WRECK_KEY);
    // If saving fails the death screen still plays, so the screen never sticks on black.
    void Promise.all([takeAllGold(), addDeath()]).catch(() => [0, 1]).then(([lost, deaths]) => {
        if (!active) return end();
        timers.push(setTimeout(() => root.classList.add("vc-ransom-kill-black"), face ? 900 : 200));
        timers.push(setTimeout(() => {
            end();
            deathScreen(deaths, lost);
        }, face ? 1700 : 900));
    });
}

// The Starlight's death messages for Ransom in The Archives, by how many times it has killed you.
const SAID: string[][] = [
    [
        "Oh... Hello.",
        "I'm surprised you found this place... It's pretty tedious just to get here, last time I checked.",
        "You were hacked by Ransom.",
        "Ransom is always hungry for gold.",
        "You should probably just give it what it wants.",
        "Alright, hurry back. We're not done yet."
    ],
    [
        "Welcome back.",
        "The Archives are very long, and the entities here are quite dangerous.",
        "Which one got you this time?",
        "You were encrypted by Ransom.",
        "Have you tried collecting gold faster, and not being super slow?",
        "There's plenty of it around.",
        "See you next time."
    ],
    [
        "Hmm. What was it this time?",
        "You were hacked by Ransom, and died.",
        "Have you tried collecting gold faster, and not being super slow?",
        "There's plenty of it around.",
        "See you next time. Now, hold your breath...",
        "I understand getting water up your nasal cavity doesn't feel great."
    ],
    [
        "You can do this. I believe in you.",
        "I'll see you next time, right?"
    ]
];

// Other things the Starlight says in The Archives, one of which sometimes slips in.
const ASIDES = [
    "Ransom is always hungry for gold.",
    "There's plenty of it around.",
    "The Archives are very long, and the entities here are quite dangerous.",
    "You can do this. I believe in you.",
    "Alright, hurry back. We're not done yet.",
    "Now, hold your breath..."
];

// The EasterEgg's Ransom goes by Beggar: he holds you at gunpoint and does the talking himself, one of these at random.
const ROBBED: string[][] = [
    [
        "Hey.",
        "Remember me?",
        "You had 90 seconds.",
        "Ninety. Seconds.",
        "And you spent them doing... whatever that was.",
        "No gold? Skill issue.",
        "Same time next week."
    ],
    [
        "Sir, this is a robbery.",
        "I don't take cards. I don't take checks.",
        "I take gold, gold, or gold.",
        "Your Discord has been encrypted, and your gold has been yoinked.",
        "Have a nice day."
    ],
    [
        "Bro really thought he could skip the payment.",
        "Insufficient funds. Insufficient skill.",
        "It's free real estate. Your gold, I mean.",
        "This could've been a payment.",
        "Should've paid. Just saying."
    ],
    [
        "Gold. Now. Please. Thank you.",
        "Oh wait, you don't have any.",
        "Okay so here's the thing.",
        "I'm not saying I'm the problem.",
        "I'm saying you're broke.",
        "Run it back. Bring gold this time."
    ]
];

function lines(deaths: number) {
    const said = [...SAID[Math.min(deaths, SAID.length) - 1]];
    if (Math.random() < 0.35) {
        const aside = pick(ASIDES.filter(a => !said.includes(a)));
        if (aside) said.splice(said.length - 1, 0, aside);
    }
    return said;
}

function deathScreen(deaths: number, goldLost: number) {
    const robbed = easterEggLoss;
    const root = layer(robbed ? "vc-ransom-death vc-ransom-robbed" : "vc-ransom-death");
    const text = el("div", "vc-ransom-starlight-text");
    const hint = el("div", "vc-ransom-death-hint", "Click to continue");
    const name = el("div", "vc-ransom-robbed-name", "BEGGAR");
    if (robbed) {
        // Ransom himself, gun and all, the way he looked during the EasterEgg.
        const stage = el("div", "vc-ransom-stage vc-ransom-robbed-stage");
        const face = image("creature");
        stage.append(img(image("gun"), "vc-ransom-easterEgg-gun"), ...(face ? [img(face, "vc-ransom-easterEgg-face")] : []), img(image("hand"), "vc-ransom-easterEgg-hand"));
        root.append(stage, name, text, hint);
    } else {
        const water = el("div", "vc-ransom-water");
        water.append(el("div", "vc-ransom-wave"), el("div", "vc-ransom-wave vc-ransom-wave-back"));
        root.append(water, img(starlightSvg(), "vc-ransom-starlight"), text, hint);
    }
    hideCreature(true);
    // Guiding Light, the DOORS death screen theme, under the Starlight's words. The EasterEgg uses your own song for it
    // when there is one (see native.ts).
    const music = easterEggLoss
        ? playSong("easterEggDeath", settings.store.soundVolume, "deathMusic")
        : playSong("deathMusic", settings.store.soundVolume);

    const said = robbed ? pick(ROBBED) : lines(deaths);
    let at = -1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;

    const next = () => {
        clearTimeout(timer);
        if (done) return;
        at++;
        if (at >= said.length) return overview();
        text.classList.remove("vc-ransom-said");
        void text.offsetWidth;
        text.textContent = said[at];
        text.classList.add("vc-ransom-said");
        timer = setTimeout(next, Math.max(2600, said[at].length * 60));
    };

    const overview = async () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        text.remove();
        hint.remove();
        name.remove();
        const stats = await getStats();
        if (ended) return;
        const panel = el("div", "vc-ransom-overview");
        const head = el("div", "vc-ransom-overview-head", "OVERVIEW");
        const died = el("div", "vc-ransom-overview-died");
        const skull = image("skull");
        if (skull) died.appendChild(img(skull, ""));
        died.append(robbed ? "Robbed by Beggar" : "Died to Ransom");
        const rows = el("div", "vc-ransom-overview-rows");
        const row = (label: string, value: string, tone: string) => {
            const r = el("div", `vc-ransom-overview-row vc-ransom-overview-${tone}`);
            r.append(el("span", "", label), el("b", "", value));
            rows.appendChild(r);
        };
        row(`Ransoms Paid Off (${stats.won})`, "", "paid");
        row(`Gold Lost (${goldLost.toLocaleString()})`, goldLost ? `- ${goldLost.toLocaleString()}` : "", "gold");
        row(`Honey Pots Broken (${stats.honeyPots})`, "", "pots");
        row(`${robbed ? "Deaths" : "Deaths to Ransom"} (${deaths})`, "", "deaths");
        const back = el("button", "vc-ransom-overview-back", "Return to Discord");
        back.addEventListener("click", e => {
            e.stopPropagation();
            leave();
        });
        panel.append(head, died, rows, back);
        root.appendChild(panel);
        timer = setTimeout(leave, 25_000);
    };

    let left = false;
    const leave = () => {
        if (left) return;
        left = true;
        clearTimeout(timer);
        root.classList.add("vc-ransom-death-out");
        music.fade(1.3);
        if (active) void mend();
        timer = setTimeout(end, 1400);
    };

    const onKey = (e: KeyboardEvent) => {
        if (e.key !== "Escape" && e.key !== " " && e.key !== "Enter") return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") return done ? leave() : void overview();
        if (!done) next();
    };
    document.addEventListener("keydown", onKey, true);
    root.addEventListener("click", () => void (done ? undefined : next()));

    let ended = false;
    const end = () => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        document.removeEventListener("keydown", onKey, true);
        music.stop();
        root.remove();
        scene = undefined;
        hideCreature(false);
        if (!active) return;
        if (wrecked) void mend();
        scheduleNext();
    };
    scene = end;
    timer = setTimeout(next, 1400);
}

/** Plugin stopping: clear everything off the screen but remember a broken Discord for next time. */
export function stopAftermath() {
    active = false;
    generation++;
    clearInterval(watch);
    watch = undefined;
    const running = scene;
    scene = undefined;
    running?.();
    removeCard();
    repairUI();
    decryptUI();
    wrecked = false;
    easterEggLoss = false;
}
