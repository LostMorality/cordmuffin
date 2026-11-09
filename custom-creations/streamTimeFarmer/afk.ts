/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";

import { settings } from ".";
import { formatTime } from "./CallWidget";
import { secondStatus } from "./secondAccount";
import { onStreamStatus, streamFarmRunning, streamStatus } from "./stream";
import { trackingProblem } from "./tracking";

// AFK mode, for leaving the farm running for hours or days: all of Discord is hidden behind a black screen with one
// status line, so it has nothing to draw. The call and the stream don't need the screen and keep going. Esc twice
// brings everything back, and so does the Leave AFK button. While it's on, keys never reach Discord, so nothing gets
// typed into a hidden chat box.

const cl = classNameFactory("vc-stf-");
const DOUBLE_PRESS_MS = 800;
const KEY_EVENTS = ["keydown", "keyup", "keypress", "beforeinput", "input", "paste", "contextmenu"];
// The settings check changes without a status update, so it's looked at this often too.
const REFRESH_MS = 30_000;

let screen: HTMLDivElement | undefined;
let totalLine: HTMLDivElement | undefined;
let callLine: HTMLDivElement | undefined;
let dot: HTMLSpanElement | undefined;
let statusLine: HTMLDivElement | undefined;
let warnLine: HTMLDivElement | undefined;
let hintLine: HTMLDivElement | undefined;
let unsubscribe: (() => void) | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let lastEscape = 0;
let hintTimer: ReturnType<typeof setTimeout> | undefined;

const HINT = "Press Esc twice to come back.";
const WARNING = "Your badge may not count. Press Esc twice and check settings.";

// Only text that changed is touched, and the times change once a minute, so the screen is redrawn about that often.
// An empty line is hidden.
function setText(el: HTMLElement | undefined, text: string) {
    if (!el) return;
    if (el.textContent !== text) el.textContent = text;
    if (el.hidden !== !text) el.hidden = !text;
}

function warningText() {
    try {
        const second = secondStatus();
        return trackingProblem(second.phase === "ready" ? second.tracking : null) ? WARNING : "";
    } catch {
        return "";
    }
}

function render() {
    if (!screen) return;
    const s = streamStatus();
    const running = streamFarmRunning();
    setText(totalLine, formatTime(s.countedMs));
    setText(callLine, running ? `This call ${formatTime(s.sessionMs)}` : "Not in a call");
    setText(statusLine, running ? s.detail || "Starting the call..." : "The stream farm isn't calling right now.");
    setText(warnLine, warningText());
    const tone = s.phase === "counting" ? "live" : running ? "busy" : "bad";
    const className = cl("call-dot", `call-${tone}`, "afk-dot");
    if (dot && dot.className !== className) dot.className = className;
}

function line(className: string, text = "") {
    const el = document.createElement("div");
    el.className = cl(className);
    el.textContent = text;
    return el;
}

function onKey(e: Event) {
    e.stopImmediatePropagation();
    e.preventDefault();
    if (e.type !== "keydown") return;
    const key = e as KeyboardEvent;
    if (key.key !== "Escape" || key.repeat) return;
    const now = performance.now();
    if (now - lastEscape < DOUBLE_PRESS_MS) return void exitAfk();
    lastEscape = now;
    if (!hintLine) return;
    hintLine.textContent = "Press Esc once more.";
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hintLine && (hintLine.textContent = HINT), DOUBLE_PRESS_MS);
}

export const afkActive = () => screen != null;

export function enterAfk() {
    if (screen) return;
    settings.store.afkMode = true;
    (document.activeElement as HTMLElement | null)?.blur?.();

    screen = document.createElement("div");
    screen.className = cl("afk");
    screen.tabIndex = -1;
    totalLine = line("afk-total");
    callLine = line("afk-call");
    dot = document.createElement("span");
    const callRow = line("afk-row");
    callRow.append(dot, callLine);
    statusLine = line("afk-status");
    warnLine = line("afk-warn");
    hintLine = line("afk-hint", HINT);
    const leave = document.createElement("button");
    leave.type = "button";
    leave.className = cl("afk-leave");
    leave.textContent = "Leave AFK";
    leave.addEventListener("click", () => exitAfk());
    screen.append(line("afk-title", "AFK mode"), line("afk-label", "Time streamed while watched"), totalLine, callRow, statusLine, warnLine, hintLine, leave);
    document.body.appendChild(screen);
    document.body.classList.add(cl("afk-on"));
    screen.focus();

    for (const type of KEY_EVENTS) window.addEventListener(type, onKey, true);
    unsubscribe = onStreamStatus(render);
    refreshTimer = setInterval(render, REFRESH_MS);
    render();
}

// save is false when the plugin stops, so AFK mode comes back after a restart.
export function exitAfk(save = true) {
    if (!screen) return;
    if (save) settings.store.afkMode = false;
    for (const type of KEY_EVENTS) window.removeEventListener(type, onKey, true);
    unsubscribe?.();
    clearTimeout(hintTimer);
    clearInterval(refreshTimer);
    document.body.classList.remove(cl("afk-on"));
    screen.remove();
    screen = totalLine = callLine = dot = statusLine = warnLine = hintLine = unsubscribe = hintTimer = refreshTimer = undefined;
    lastEscape = 0;
}
