/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChildProcess, spawn } from "child_process";
import { app, BrowserWindow, ipcMain, IpcMainInvokeEvent, powerSaveBlocker, screen, session } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { join } from "path";

import { VIEWER_AGENT } from "./viewerAgent";

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
// Discord's web app raises desktop notifications and sets the app badge. The second account's window belongs to the
// same Electron app as the user's own Discord, so its unread count lands on that same taskbar badge and its toasts
// look like the user's own. This keeps both quiet inside that window: the account still receives everything, it just
// doesn't announce it here. Injected ahead of the web build so it covers the login page too.
const SILENCE = `(() => {
    const quiet = () => Promise.resolve();
    try {
        navigator.setAppBadge = quiet;
        navigator.clearAppBadge = quiet;
    } catch (e) { }
    try {
        const Quiet = function () {
            return { close() { }, addEventListener() { }, removeEventListener() { }, onclick: null, onclose: null };
        };
        Quiet.permission = "denied";
        Quiet.requestPermission = () => Promise.resolve("denied");
        Object.defineProperty(window, "Notification", { configurable: true, writable: true, value: Quiet });
    } catch (e) { }
})();
`;

// Whether that silencing is on. Defaults to on, so a freshly linked account is quiet from its first call.
let quiet = true;

export function setSecondAccountQuiet(_: IpcMainInvokeEvent, on: boolean) {
    quiet = on;
    if (!on) return; // Turning it back on takes effect the next time that window loads; nothing here undoes it.
    clearBadge();
    // Apply it to the window already open, so the setting works without interrupting a call in progress.
    if (win && !win.isDestroyed()) void win.webContents.executeJavaScript(SILENCE).catch(() => { });
}

// A badge the second account already set stays until something clears it, so silencing clears it once.
function clearBadge() {
    try {
        if (app.badgeCount) app.setBadgeCount(0);
        win?.flashFrame(false);
    } catch (e) { }
}

// How long a check in the second account's page may take before it counts as failed (a hung page never answers).
const EVAL_TIMEOUT_MS = 10_000;
const MIN_WIDTH = 360;
const MIN_HEIGHT = 480;

let win: BrowserWindow | null = null;
let winPartition = "";
let quitting = false;
let placed = false;

// The second account's window runs Equicord's own released web build, fetched straight from Equicord and kept in this
// plugin's own folder. Nobody has to build or install anything, and the window always has the current Equicord. A
// released build knows nothing about this plugin, so the viewer's half comes from viewerAgent.ts instead.
const WEB_URL = "https://github.com/Equicord/Equicord/releases/download/latest/Equicord.user.js";
const WEB_MAX_AGE_MS = 6 * 60 * 60_000;
const WEB_MIN_BYTES = 500_000;
const DOWNLOAD_TIMEOUT_MS = 2 * 60_000;

const webDir = () => join(app.getPath("userData"), "streamtimefarmer");
const webCache = () => join(webDir(), "Equicord.user.js");

// The downloaded build comes first, so the second account is on the current Equicord whatever this Discord was built
// from, and everyone runs the same path. A build left next to the desktop build by the cordmuffin installer or a
// source checkout is only the fallback, for when the download has never succeeded (no internet on first run).
const localBuild = () => [join(__dirname, "Equicord.user.js"), join(__dirname, "..", "Equicord.user.js"), join(__dirname, "..", "Vencord.user.js")].find(existsSync);
const webBuild = () => existsSync(webCache()) ? webCache() : localBuild();

const fresh = (path: string) => {
    try {
        return Date.now() - statSync(path).mtimeMs < WEB_MAX_AGE_MS;
    } catch {
        return false;
    }
};

let downloading: Promise<string> | null = null;

// Downloads the released build to the cache. Resolves with "" when the window has something to load afterwards, or a
// short reason when it doesn't. Only one download runs at a time, and a failure leaves any older copy in place.
function downloadWeb(): Promise<string> {
    if (downloading) return downloading;
    downloading = (async () => {
        const target = webCache();
        try {
            const res = await fetch(WEB_URL, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: "follow" });
            if (!res.ok) throw new Error(`Equicord's download answered ${res.status}`);
            const text = await res.text();
            // Guard against a proxy or error page being saved as if it were the build.
            if (text.length < WEB_MIN_BYTES || !text.includes("==UserScript==")) throw new Error("what came back isn't Equicord's web build");
            mkdirSync(webDir(), { recursive: true });
            const tmp = `${target}.part`;
            writeFileSync(tmp, text);
            renameSync(tmp, target);
            return "";
        } catch (e: any) {
            // An older copy still works, so a failed refresh isn't a failure.
            if (existsSync(target)) return "";
            return `Couldn't download Equicord for the second account's window (${e?.message ?? e}). Check your internet connection and try again.`;
        }
    })();
    void downloading.finally(() => downloading = null);
    return downloading;
}

// What the window needs before it loads. A cached copy is used straight away and refreshed in the background, so a
// slow download never holds up a call.
async function ensureWeb(): Promise<string> {
    const cached = webCache();
    if (existsSync(cached)) {
        if (!fresh(cached)) void downloadWeb();
        return "";
    }
    // Nothing cached yet: a local build lets the window open now while the download runs for next time.
    if (localBuild()) {
        void downloadWeb();
        return "";
    }
    return await downloadWeb();
}

// Why the second account's window can't open, or "" when it can. The UI shows this instead of a bare failure.
export async function webBuildProblem(_: IpcMainInvokeEvent): Promise<string> {
    return await ensureWeb();
}

// Fetches the build again even when the cached one is still young, for the "Try again" button after a failure.
export function refetchWeb(_: IpcMainInvokeEvent): Promise<string> {
    return downloadWeb();
}

app.on("before-quit", () => quitting = true);

// Only the second account's own window gets the code.
ipcMain.on(CODE_CHANNEL, e => {
    if (!win || win.isDestroyed() || e.sender !== win.webContents) {
        e.returnValue = "";
        return;
    }
    let build = "";
    try {
        const path = webBuild();
        // Wrapped in a function like a userscript manager does; the build's last line relies on that to set window.Vencord.
        if (path) build = `(function () {\n${USERSCRIPT_SHIM}\n${readFileSync(path, "utf8")}\n})();`;
    } catch (e) {
        // This answer has to arrive whatever happens: the page waits for it before it does anything.
        console.warn("[StreamTimeFarmer] Couldn't read Equicord for the second account's window:", e);
    }
    // Silencing goes first, so it still applies while the window is only showing the login page. The agent goes last
    // and waits for Equicord to boot; it bows out by itself if this build already contains the plugin.
    e.returnValue = (quiet ? SILENCE : "") + build + (build ? `\n${VIEWER_AGENT}` : "");
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

// Stops the computer sleeping by itself, while still letting the screen turn off. Windows drops it if Discord closes.
let awakeBlocker: number | undefined;
export function setKeepAwake(_: IpcMainInvokeEvent, on: boolean) {
    if (on && (awakeBlocker === undefined || !powerSaveBlocker.isStarted(awakeBlocker))) awakeBlocker = powerSaveBlocker.start("prevent-app-suspension");
    else if (!on && awakeBlocker !== undefined) {
        powerSaveBlocker.stop(awakeBlocker);
        awakeBlocker = undefined;
    }
    return awakeBlocker !== undefined && powerSaveBlocker.isStarted(awakeBlocker);
}

// "created" when a new window was built (its page starts from scratch), true when it was already there.
export async function openSecondAccount(_: IpcMainInvokeEvent, show: boolean, login = ""): Promise<boolean | "created"> {
    await ensureWeb();
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

// The farm's own window to stream: a small borderless window in a corner of the main screen, behind every other window,
// almost fully see-through (1/255) and letting clicks pass through, with no taskbar button and kept out of Alt+Tab, so
// it can't be seen or bumped into. Windows only redraws the parts of a window that are on a screen, so parking it
// off-screen froze the stream on its first picture; see-through, it's on screen and Go Live still captures it at full
// brightness. Go Live can't capture minimized windows either, so it puts itself back when minimized. Its clock and a
// sweeping bar keep changing, which keeps frames reaching the viewer, and nothing private is ever in it. It closes by
// itself when Discord goes away.
const FARM_WINDOW_SCRIPT = String.raw`
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace StfFarm {
    [ComImport, Guid("56FDF342-FD6D-11d0-958A-006097C9A090"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ITaskbarList { void HrInit(); void AddTab(IntPtr hwnd); void DeleteTab(IntPtr hwnd); void ActivateTab(IntPtr hwnd); void SetActiveAlt(IntPtr hwnd); }
    [ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090")] class TaskbarList { }
    public static class Win {
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int index);
        [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr hWnd, int index, int value);
        [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr hWnd, uint key, byte alpha, uint flags);
        // Layered (see-through), clicks pass through, and never activated (which also keeps it out of Alt+Tab).
        const int GHOST = 0x80000 | 0x20 | 0x08000000;
        public static void Ghost(IntPtr hwnd) {
            int style = GetWindowLong(hwnd, -20);
            if ((style & GHOST) != GHOST) SetWindowLong(hwnd, -20, style | GHOST);
            SetLayeredWindowAttributes(hwnd, 0, 1, 2);
        }
        static ITaskbarList list;
        public static void HideButton(IntPtr hwnd) {
            try {
                if (list == null) { list = (ITaskbarList)new TaskbarList(); list.HrInit(); }
                list.DeleteTab(hwnd);
            } catch { list = null; }
        }
    }
}
"@
# Real pixels, so the window fits its corner exactly at any display scaling.
[StfFarm.Win]::SetProcessDPIAware() | Out-Null
$parent = [int]$env:STF_PARENT
# Compared on every check too, so a new program that gets Discord's old process id doesn't keep the window open.
$parentStart = [Diagnostics.Process]::GetProcessById($parent).StartTime
$started = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$env:STF_STARTED).LocalDateTime
$form = New-Object Windows.Forms.Form
$form.Text = $env:STF_TITLE
$form.BackColor = [Drawing.Color]::Black
$form.ClientSize = New-Object Drawing.Size 640, 360
$form.FormBorderStyle = "None"
$form.ShowInTaskbar = $true
$form.StartPosition = "Manual"
# The bottom-right corner of the main screen's free area, worked out again on every check since screens and the
# taskbar can move. Kept fully on screen, or Windows stops redrawing it.
function Get-Park { $area = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea; New-Object Drawing.Point ($area.Right - $form.Width), ($area.Bottom - $form.Height) }
# Behind every other window, without taking focus or changing size.
function Set-Park { $park = Get-Park; [StfFarm.Win]::SetWindowPos($form.Handle, [IntPtr]1, $park.X, $park.Y, 0, 0, 0x0011) | Out-Null }
$form.Location = Get-Park
# A bar sweeping across, a "keeping it going" line, and the clock with a blinking live dot.
$track = New-Object Windows.Forms.Panel
$track.Dock = "Bottom"
$track.Height = 6
$track.BackColor = [Drawing.Color]::FromArgb(32, 34, 37)
$bar = New-Object Windows.Forms.Panel
$bar.Width = 120
$bar.Height = 6
$bar.BackColor = [Drawing.Color]::FromArgb(88, 101, 242)
$track.Controls.Add($bar)
$note = New-Object Windows.Forms.Label
$note.Dock = "Bottom"
$note.Height = 26
$note.TextAlign = "MiddleCenter"
$note.ForeColor = [Drawing.Color]::FromArgb(148, 155, 164)
$note.Font = New-Object Drawing.Font "Segoe UI", 10
$note.Text = "StreamTimeFarmer is keeping your stream going"
$clock = New-Object Windows.Forms.Label
$clock.Dock = "Bottom"
$clock.Height = 64
$clock.TextAlign = "MiddleCenter"
$clock.ForeColor = [Drawing.Color]::White
$clock.Font = New-Object Drawing.Font "Segoe UI", 20
$name = New-Object Windows.Forms.Label
$name.Dock = "Fill"
$name.TextAlign = "MiddleCenter"
$name.ForeColor = [Drawing.Color]::White
$name.Font = New-Object Drawing.Font "Segoe UI", 24
$name.Text = $env:STF_TITLE
# Docked controls stack outward from the last one added: the bar sits at the very bottom, the line above it, then
# the clock, and the name (or cover) fills the rest.
$form.Controls.Add($clock)
$form.Controls.Add($note)
$form.Controls.Add($track)
$form.Controls.Add($name)
$name.BringToFront()
$ticks = 0
# The cover is fetched after the window is up, with a short time limit, so a slow download never holds up Go Live.
function Add-Cover {
    if (-not $env:STF_IMAGE) { return }
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $request = [Net.WebRequest]::Create($env:STF_IMAGE)
        $request.Timeout = 5000
        $response = $request.GetResponse()
        $data = New-Object IO.MemoryStream
        $response.GetResponseStream().CopyTo($data)
        $response.Close()
        $data.Position = 0
        $image = [Drawing.Image]::FromStream($data)
        $cover = New-Object Windows.Forms.PictureBox
        $cover.Dock = "Fill"
        $cover.SizeMode = "Zoom"
        $cover.Image = $image
        $form.Controls.Remove($name)
        $form.Controls.Add($cover)
        $cover.BringToFront()
        $form.Icon = [Drawing.Icon]::FromHandle((New-Object Drawing.Bitmap $image, 64, 64).GetHicon())
    } catch { }
}
# Runs 4 times a second so the picture always moves; the slower checks run once a second.
$tick = {
    $script:ticks++
    $left = (Get-Date) - $started
    $bar.Left = [int](($left.TotalMilliseconds % 4000) / 4000 * ($track.Width + $bar.Width)) - $bar.Width
    $dot = if ($left.Milliseconds -lt 500) { [char]0x25CF } else { [char]0x25CB }
    $clock.Text = "{0} LIVE   Streaming for {1}:{2:mm}:{2:ss}" -f $dot, [int][Math]::Floor($left.TotalHours), $left
    if ($script:ticks % 4 -ne 1) { return }
    $gone = $true
    try { $gone = [Diagnostics.Process]::GetProcessById($parent).StartTime -ne $parentStart } catch { }
    if ($gone) { [Windows.Forms.Application]::Exit(); return }
    # Go Live only lists ordinary app windows, so the window stays one and just its taskbar button is taken off.
    # Explorer puts buttons back when it restarts, so this runs every check, and so does making it see-through.
    [StfFarm.Win]::HideButton($form.Handle)
    [StfFarm.Win]::Ghost($form.Handle)
    if ($form.WindowState -eq "Minimized") { [StfFarm.Win]::ShowWindow($form.Handle, 4) | Out-Null }
    Set-Park
}
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 250
$timer.add_Tick($tick)
# Started hidden, Windows swallows the first show, so it's shown again once the window exists, without taking focus.
$form.add_Shown({ [StfFarm.Win]::Ghost($form.Handle); [StfFarm.Win]::ShowWindow($form.Handle, 4) | Out-Null; Set-Park; & $tick; $timer.Start(); Add-Cover })
$form.add_FormClosing({ param($s, $e) if ($e.CloseReason -eq "UserClosing") { $e.Cancel = $true } })
[Windows.Forms.Application]::Run($form)
`;

let farmProcess: ChildProcess | null = null;

function stopFarmProcess() {
    farmProcess?.kill();
    farmProcess = null;
}

process.once("exit", stopFarmProcess);

// Resolves with the window's process id once it's running. A new window replaces the old one.
export function startFarmWindow(_: IpcMainInvokeEvent, title: string, imageUrl = "", startedAt = Date.now()): Promise<number> {
    stopFarmProcess();
    if (process.platform !== "win32") return Promise.reject(new Error("The farm window only works on Windows."));
    // The full path, so a powershell.exe in Discord's working folder can never be picked up instead.
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const child = spawn(
        powershell,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(FARM_WINDOW_SCRIPT, "utf16le").toString("base64")],
        {
            windowsHide: true,
            stdio: "ignore",
            env: {
                ...process.env,
                STF_TITLE: String(title).slice(0, 120) || "StreamTimeFarmer",
                STF_IMAGE: /^https:\/\/cdn\.discordapp\.com\//.test(imageUrl) ? imageUrl : "",
                STF_STARTED: String(Number.isFinite(startedAt) ? Math.floor(startedAt) : Date.now()),
                STF_PARENT: String(process.pid)
            }
        }
    );
    farmProcess = child;
    return new Promise((resolve, reject) => {
        child.once("spawn", () => {
            if (farmProcess !== child || child.pid == null) {
                child.kill();
                return reject(new Error("The farm window was replaced before it started."));
            }
            resolve(child.pid);
        });
        child.once("error", e => {
            if (farmProcess === child) farmProcess = null;
            reject(e);
        });
        child.once("exit", () => {
            if (farmProcess === child) farmProcess = null;
            reject(new Error("The farm window closed before it started."));
        });
    });
}

// With a process id, only that window is closed, so a late stop can't close a newer window.
export function stopFarmWindow(_: IpcMainInvokeEvent, pid = 0) {
    if (!pid || farmProcess?.pid === pid) stopFarmProcess();
}

// The running window's process id, or 0 when it's gone (closed from Task Manager, or it crashed).
export function farmWindowPid(_: IpcMainInvokeEvent) {
    return farmProcess && farmProcess.exitCode == null && farmProcess.signalCode == null ? farmProcess.pid ?? 0 : 0;
}
