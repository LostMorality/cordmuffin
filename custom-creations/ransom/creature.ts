/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { image } from "./images";

const FPS = 12;
const BASE = 40;

export interface CreatureOptions {
    mode: string;
    speed: number;
    size: number;
}

let el: HTMLDivElement | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let hidden = false;
let x = 64;
let y = 64;
let mouseX = 0;
let mouseY = 0;
let tick = 0;
let target: { x: number; y: number; } | undefined;
let facing = 1;
let moveListener: ((e: MouseEvent) => void) | undefined;

function step(opts: CreatureOptions) {
    if (!el || hidden || document.hidden) return;
    tick++;
    const side = BASE * opts.size;
    const maxX = window.innerWidth - side - 4;
    const maxY = window.innerHeight - side - 4;

    let goal: { x: number; y: number; } | undefined;
    if (opts.mode === "wander") {
        if (!target || (Math.abs(target.x - x) < opts.speed && Math.abs(target.y - y) < opts.speed)) {
            target = undefined;
            if (Math.random() < 0.02) target = { x: Math.random() * maxX, y: Math.random() * maxY };
        }
        goal = target;
    } else if (Math.hypot(mouseX - (x + side / 2), mouseY - (y + side / 2)) > 64) {
        goal = { x: mouseX - side / 2, y: mouseY - side / 2 };
    }

    if (goal) {
        const dx = goal.x - x;
        const dy = goal.y - y;
        const dist = Math.hypot(dx, dy) || 1;
        const move = Math.min(dist, opts.speed);
        x = Math.min(Math.max(4, x + (dx / dist) * move), maxX);
        y = Math.min(Math.max(4, y + (dy / dist) * move), maxY);
        if (Math.abs(dx) > 2) facing = dx < 0 ? -1 : 1;
    }
    const jitter = tick % 23 === 0 ? `translate(${Math.random() * 6 - 3}px, ${Math.random() * 6 - 3}px)` : "";
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) ${jitter} scaleX(${facing})`;
    el.classList.toggle("vc-ransom-glitch", tick % 23 === 0);
}

export function startCreature(opts: CreatureOptions) {
    stopCreature();
    const face = image("creature");
    if (!face) return;
    el = document.createElement("div");
    el.className = "vc-ransom-creature";
    el.classList.toggle("vc-ransom-gone", hidden);
    el.style.width = el.style.height = `${BASE * opts.size}px`;
    el.style.backgroundImage = `url("${face}")`;
    document.body.appendChild(el);
    moveListener = e => {
        mouseX = e.clientX;
        mouseY = e.clientY;
    };
    document.addEventListener("mousemove", moveListener, { passive: true });
    timer = setInterval(() => step(opts), 1000 / FPS);
}

export function stopCreature() {
    clearInterval(timer);
    timer = undefined;
    if (moveListener) document.removeEventListener("mousemove", moveListener);
    moveListener = undefined;
    el?.remove();
    el = undefined;
}

export function hideCreature(hide: boolean) {
    hidden = hide;
    el?.classList.toggle("vc-ransom-gone", hide);
}
