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

// The stream farm started out inside GameTimeSpoof; its login storage keeps that name so a logged-in second account
// stays logged in.
const PARTITION = "persist:gametimespoof-second-account";
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

let win: BrowserWindow | null = null;
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

function create() {
    const ses = session.fromPartition(PARTITION);
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
        minWidth: 360,
        minHeight: 480,
        autoHideMenuBar: true,
        webPreferences: {
            partition: PARTITION,
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
    win.loadURL("https://discord.com/app");
}

export function hasWebBuild(_: IpcMainInvokeEvent) {
    return webBuild() != null;
}

export function openSecondAccount(_: IpcMainInvokeEvent, show: boolean) {
    if (!webBuild()) return false;
    if (win && !win.isDestroyed() && win.webContents.isCrashed()) win.destroy();
    if (!win || win.isDestroyed()) create();
    if (show) {
        // A small panel in the bottom-right corner, next to the call widget, the first time it's shown.
        if (!win!.isVisible() && !placed) {
            placed = true;
            const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
            const [w, h] = win!.getSize();
            win!.setPosition(area.x + area.width - w - 24, area.y + area.height - h - 24);
        }
        win!.show();
        win!.focus();
    }
    return true;
}

export function hideSecondAccount(_: IpcMainInvokeEvent) {
    win?.hide();
}

export function closeSecondAccount(_: IpcMainInvokeEvent) {
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
}

export async function signOutSecondAccount(_: IpcMainInvokeEvent) {
    closeSecondAccount(_);
    await session.fromPartition(PARTITION).clearStorageData();
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
