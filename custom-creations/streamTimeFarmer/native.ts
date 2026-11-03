/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, BrowserWindow, ipcMain, IpcMainInvokeEvent, screen, session } from "electron";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// The stream farm's second account runs here: Discord's web app in a hidden window with its own separate login, with
// Equicord's web build loaded into it so the same StreamTimeFarmer runs there as the viewer.

// Each main account keeps its own second-account login. Logins made before that (when the stream farm was part of
// GameTimeSpoof) live in the old shared storage, and the accounts that made them keep using it.
const LEGACY_PARTITION = "persist:gametimespoof-second-account";
const partitionFor = (login: string) => /^\d{17,20}$/.test(login) ? `persist:streamtimefarmer-second-${login}` : LEGACY_PARTITION;
const CODE_CHANNEL = "StreamTimeFarmer_secondAccountCode";
const PRELOAD = `"use strict";
const { ipcRenderer, webFrame } = require("electron");
const code = ipcRenderer.sendSync(${JSON.stringify(CODE_CHANNEL)});
if (code) webFrame.executeJavaScript(code);
`;

// The web build is a userscript; these are the two userscript-manager features it uses. All of its own fetches go
// through GM_xmlhttpRequest, which has to answer with a Blob and the response headers like a userscript manager does.
// Without a userscript manager's rights it's limited to what the page itself may fetch.
// The login page also asks Windows for a passkey on its own, which pops up a system window even while this one is
// hidden; that silent ask is turned off (logging in by QR code or password still works).
const USERSCRIPT_SHIM = `(() => {
    const creds = navigator.credentials;
    if (!creds?.get) return;
    const get = creds.get.bind(creds);
    creds.get = options => options?.mediation === "conditional" ? new Promise(() => { }) : get(options);
})();
var unsafeWindow = window;
function GM_xmlhttpRequest(o) {
    const pageFetch = window.fetch.bind(window);
    pageFetch(o.url, { method: o.method || "GET", headers: o.headers, body: o.data })
        .then(async r => {
            const blob = await r.blob();
            const text = o.responseType === "blob" ? undefined : await blob.text();
            const responseHeaders = [...r.headers].map(([k, v]) => k + ": " + v).join("\\n");
            o.onload && o.onload({ status: r.status, statusText: r.statusText, response: o.responseType === "blob" ? blob : text, responseText: text, responseHeaders, finalUrl: r.url });
        })
        .catch(e => o.onerror && o.onerror(e));
}
`;
// How long a check in the second account's page may take before it counts as failed (a hung page never answers).
const EVAL_TIMEOUT_MS = 10_000;
const MIN_WIDTH = 360;
const MIN_HEIGHT = 480;

let win: BrowserWindow | null = null;
let winPartition = "";
let quitting = false;
let placed = false;

// Next to the desktop build when the cordmuffin installer built it, one folder up in a plain Equicord build.
const webBuild = () => [join(__dirname, "Equicord.user.js"), join(__dirname, "..", "Equicord.user.js"), join(__dirname, "..", "Vencord.user.js")].find(existsSync);

app.on("before-quit", () => quitting = true);

// Only the second account's own window gets the code.
ipcMain.on(CODE_CHANNEL, e => {
    const path = webBuild();
    // Wrapped in a function like a userscript manager does; the build's last line relies on that to set window.Vencord.
    e.returnValue = win && !win.isDestroyed() && e.sender === win.webContents && path ? `(function () {\n${USERSCRIPT_SHIM}\n${readFileSync(path, "utf8")}\n})();` : "";
});

function create(partition: string) {
    const ses = session.fromPartition(partition);
    // The web app needs the microphone to join a call (it stays muted); nothing else is granted.
    ses.setPermissionRequestHandler((_, permission, callback) => callback(permission === "media"));
    ses.setPermissionCheckHandler((_, permission) => permission === "media");

    const preload = join(app.getPath("userData"), "streamtimefarmer-second-account-preload.js");
    writeFileSync(preload, PRELOAD);

    win = new BrowserWindow({
        show: false,
        width: 480,
        height: 720,
        title: "Second account (StreamTimeFarmer)",
        minWidth: MIN_WIDTH,
        minHeight: MIN_HEIGHT,
        autoHideMenuBar: true,
        webPreferences: {
            partition,
            preload,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            backgroundThrottling: false
        }
    });
    // Look like a normal browser, not the desktop app, so Discord serves its regular web app.
    win.webContents.setUserAgent(win.webContents.getUserAgent().replace(/\s(discord|Electron)\/\S+/gi, ""));
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // It only ever shows Discord, so the second account's login and the injected code never reach another site.
    win.webContents.on("will-navigate", (e, url) => {
        if (!/^https:\/\/([a-z0-9-]+\.)?discord\.com(\/|$)/i.test(url)) e.preventDefault();
    });
    // Discord's page title would make it look like a second Discord in the taskbar.
    win.on("page-title-updated", e => e.preventDefault());
    win.webContents.setAudioMuted(true);
    // Closing it only hides it; it keeps watching in the background until the farm stops.
    win.on("close", e => {
        if (quitting) return;
        e.preventDefault();
        win?.hide();
    });
    // A crashed page never comes back by itself; the next check builds a new window from the saved login.
    win.webContents.on("render-process-gone", () => {
        if (win && !win.isDestroyed()) win.destroy();
    });
    win.on("closed", () => {
        win = null;
        placed = false;
    });
    winPartition = partition;
    win.loadURL("https://discord.com/app");
}

export function hasWebBuild(_: IpcMainInvokeEvent) {
    return webBuild() != null;
}

// "created" when a new window was built (its page starts from scratch), true when it was already there.
export function openSecondAccount(_: IpcMainInvokeEvent, show: boolean, login = ""): boolean | "created" {
    if (!webBuild()) return false;
    const partition = partitionFor(login);
    if (win && !win.isDestroyed() && (win.webContents.isCrashed() || winPartition !== partition)) win.destroy();
    let created = false;
    if (!win || win.isDestroyed()) {
        create(partition);
        created = true;
    }
    if (show) {
        // A small panel in the bottom-right corner, next to the call widget, the first time it's shown. It's made
        // smaller if the screen is too short for it.
        if (!win!.isVisible() && !placed) {
            placed = true;
            const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
            const [w, h] = win!.getSize();
            // On a screen smaller than the usual minimum size, the minimum shrinks too, so the window still fits.
            const minWidth = Math.min(MIN_WIDTH, area.width), minHeight = Math.min(MIN_HEIGHT, area.height);
            win!.setMinimumSize(minWidth, minHeight);
            const width = Math.max(minWidth, Math.min(w, area.width - 48)), height = Math.max(minHeight, Math.min(h, area.height - 48));
            if (width !== w || height !== h) win!.setSize(width, height);
            win!.setPosition(Math.max(area.x, area.x + area.width - width - 24), Math.max(area.y, area.y + area.height - height - 24));
        }
        win!.show();
        win!.focus();
    }
    return created ? "created" : true;
}

export function hideSecondAccount(_: IpcMainInvokeEvent) {
    win?.hide();
}

export function closeSecondAccount(_: IpcMainInvokeEvent) {
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
}

export async function signOutSecondAccount(_: IpcMainInvokeEvent, login = "") {
    closeSecondAccount(_);
    try {
        await session.fromPartition(partitionFor(login)).clearStorageData();
    } catch (e) {
        console.warn("[StreamTimeFarmer] Couldn't clear the second account's login:", e);
    }
}

// Runs a snippet in the second account's page (only ever code from this plugin) and returns the result. The snippets
// check for Equicord themselves, so a page that's still loading just answers "not ready".
export async function secondAccountEval(_: IpcMainInvokeEvent, code: string): Promise<unknown> {
    if (!win || win.isDestroyed()) return null;
    const contents = win.webContents;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onGone = () => { };
    // A crashed, closed or frozen page never answers, so the check gives up instead of waiting forever.
    const gaveUp = new Promise<null>(resolve => {
        onGone = () => resolve(null);
        timeout = setTimeout(onGone, EVAL_TIMEOUT_MS);
        contents.once("destroyed", onGone);
        contents.once("render-process-gone", onGone);
    });
    try {
        return await Promise.race([contents.executeJavaScript(code, true), gaveUp]);
    } catch (e) {
        console.warn("[StreamTimeFarmer] Second account check failed:", e);
        return null;
    } finally {
        clearTimeout(timeout);
        if (!contents.isDestroyed()) {
            contents.removeListener("destroyed", onGone);
            contents.removeListener("render-process-gone", onGone);
        }
    }
}
