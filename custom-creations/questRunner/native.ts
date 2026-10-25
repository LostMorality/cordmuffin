/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { type ChildProcess, spawn } from "child_process";
import { randomBytes, randomInt } from "crypto";
import { app, type IpcMainInvokeEvent } from "electron";
import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from "fs";
import { dirname, join, normalize, relative, sep } from "path";

import { STUB_EXE_BASE64 } from "./stubBinary";

const gamesRoot = join(app.getPath("appData"), "QuestRunner", "games");
const running = new Map<string, ChildProcess>();
const stub = Buffer.from(STUB_EXE_BASE64, "base64");
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

function cleanSegment(name: string): string {
    const clean = name.replace(/[<>:"/\\|?*\x00-\x1f™®©]/g, "").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 64).trim() || "Game";
    const stem = clean.replace(/\.[^.]*$/, "");
    return RESERVED.test(stem) ? `_${clean}` : clean;
}

// Discord's executable names can carry a parent folder ("once human/once_human.exe") and a leading ">" marker.
function resolveExePath(gameName: string, executable: string): string {
    const parts = executable.replace(/^>/, "").split(/[\\/]/).filter(Boolean).slice(-4).map(cleanSegment);
    const exePath = normalize(join(gamesRoot, cleanSegment(gameName), ...parts));

    if (relative(gamesRoot, exePath).startsWith("..") || !exePath.toLowerCase().endsWith(".exe")) {
        throw new Error(`Refusing executable path outside the games folder: ${executable}`);
    }

    return exePath;
}

function isCurrentStub(exePath: string) {
    try {
        const fd = openSync(exePath, "r");
        try {
            const head = Buffer.alloc(stub.length);
            return readSync(fd, head, 0, stub.length, 0) === stub.length && head.equals(stub);
        } finally {
            closeSync(fd);
        }
    } catch {
        return false;
    }
}

// Each game gets its own copy with random trailing bytes, so no two stand-ins share a file hash.
function ensureExe(exePath: string): void {
    if (existsSync(exePath) && isCurrentStub(exePath)) return;
    mkdirSync(dirname(exePath), { recursive: true });
    writeFileSync(exePath, Buffer.concat([stub, randomBytes(randomInt(4096, 262144))]));
}

const shortPath = (exePath: string) => exePath.split(sep).slice(-2).join("/");

export async function launchGame(_: IpcMainInvokeEvent, appId: string, gameName: string, executable: string, args: string[] = []): Promise<{ pid: number | null; path: string; error: string | null; }> {
    if (process.platform !== "win32") {
        return { pid: null, path: "", error: "Stand-in games only work on Windows." };
    }

    const existing = running.get(appId);
    if (existing && existing.exitCode === null && existing.pid) {
        return { pid: existing.pid, path: shortPath(existing.spawnfile), error: null };
    }

    let exePath: string;
    try {
        exePath = resolveExePath(gameName, executable);
        ensureExe(exePath);
    } catch (e) {
        return { pid: null, path: "", error: String(e) };
    }

    const safeArgs = args.filter(a => /^-[\w.=-]+$/.test(a));
    const child = spawn(exePath, safeArgs, {
        cwd: dirname(exePath),
        detached: true,
        stdio: "ignore",
        windowsHide: false,
        env: { ...process.env, QR_TITLE: gameName.slice(0, 200), QR_PARENT: String(process.pid) },
    });

    // A spawn error (antivirus blocking the file, for example) arrives as an event; without a listener it would crash Discord.
    const error = await new Promise<string | null>(resolve => {
        child.once("spawn", () => resolve(null));
        child.once("error", e => resolve(e.message.includes("EPERM") || e.message.includes("EACCES")
            ? "Windows or your antivirus blocked the stand-in game. Allow it in your antivirus to use play quests."
            : String(e)));
    });
    if (error || !child.pid) return { pid: null, path: "", error: error ?? "The stand-in game didn't start." };

    child.unref();
    child.once("exit", () => {
        if (running.get(appId) === child) running.delete(appId);
    });
    running.set(appId, child);
    return { pid: child.pid, path: shortPath(exePath), error: null };
}

export function isGameRunning(_: IpcMainInvokeEvent, appId: string): boolean {
    const child = running.get(appId);
    return !!child && child.exitCode === null;
}

export function stopGame(_: IpcMainInvokeEvent, appId: string): boolean {
    const child = running.get(appId);
    running.delete(appId);

    if (!child || child.exitCode !== null) return false;
    return child.kill();
}

export function stopAllGames(): number {
    let stopped = 0;

    for (const [appId, child] of running) {
        running.delete(appId);
        if (child.exitCode === null && child.kill()) stopped++;
    }

    return stopped;
}

export function runningGames(): string[] {
    return [...running].filter(([, child]) => child.exitCode === null).map(([appId]) => appId);
}

export function deleteStandIns(): { ok: boolean; error: string | null; } {
    if (runningGames().length) return { ok: false, error: "Wait until no play quest is running." };
    try {
        rmSync(gamesRoot, { recursive: true, force: true });
        return { ok: true, error: null };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}

function activityHeaders(questId: string, authToken: string, referrer?: string): Record<string, string> {
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Auth-Token": authToken,
        "X-Discord-Quest-ID": questId,
    };

    if (referrer) headers.Referer = referrer;
    return headers;
}

// Achievement-in-activity quests: trade an OAuth code for the activity's token, then post the progress the activity would.
// Runs here because discordsays.com rejects the renderer's origin.
export async function completeActivityAchievement(_: IpcMainInvokeEvent, appId: string, authCode: string, target: number, questId: string, referrer?: string): Promise<{ ok: boolean; error: string | null; }> {
    if (!/^\d{17,20}$/.test(appId) || !/^\d{17,20}$/.test(questId)) {
        return { ok: false, error: "Bad application or quest id." };
    }

    const base = `https://${appId}.discordsays.com/.proxy/acf`;

    try {
        const authRes = await fetch(`${base}/authorize`, {
            method: "POST",
            headers: activityHeaders(questId, "", referrer),
            body: JSON.stringify({ code: authCode }),
            signal: AbortSignal.timeout(15_000),
        });
        const auth = await authRes.json().catch(() => null) as { token?: unknown; } | null;

        if (!authRes.ok || typeof auth?.token !== "string") {
            return { ok: false, error: `authorize ${authRes.status}: ${JSON.stringify(auth)}` };
        }

        const progressRes = await fetch(`${base}/quest/progress`, {
            method: "POST",
            headers: activityHeaders(questId, auth.token, referrer),
            body: JSON.stringify({ progress: target }),
            signal: AbortSignal.timeout(15_000),
        });

        return progressRes.ok ? { ok: true, error: null } : { ok: false, error: `progress ${progressRes.status}` };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}
