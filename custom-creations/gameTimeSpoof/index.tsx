/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { HeaderBarButton } from "@api/HeaderBar";
import { definePluginSettings, Settings } from "@api/Settings";
import { Button } from "@components/Button";
import { GameControllerIcon } from "@components/Icons";
import { Link } from "@components/Link";
import { Paragraph } from "@components/Paragraph";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { RunningGame } from "@vencord/discord-types";
import { FluxDispatcher, RestAPI, RunningGameStore, showToast } from "@webpack/common";

import type { PendingCredit } from "./badges";
import { openGameBrowser } from "./GameBrowser";
import { ReportedGame, reportPlaytime } from "./science";

const logger = new Logger("GameTimeSpoof");

export interface DetectableApp {
    id: string;
    name: string;
    aliases: string[];
    themes: string[];
    icon_hash: string | null;
    cover_image_hash: string | null;
    executables?: { os: string; name: string; }[];
}

type FakeGame = RunningGame & { id: string; pidPath: number[]; processName: string; start: number; reportedAt: number; };
type TrackedGame = ReportedGame & { reportedAt: number; };

const REPORT_INTERVAL = 10 * 60_000;
const MAX_REPORT = REPORT_INTERVAL + 2 * 60_000;
const FAKE_PID_BASE = 0x7f000001;
const LOAD_RETRY_MS = 60_000;

export const settings = definePluginSettings({
    games: {
        type: OptionType.STRING,
        description: "Games to fake as running. Use application IDs or exact game names from Discord's detectable list, separated by commas. Rotation replaces this with one game at a time.",
        default: "",
        onChange: () => restart()
    },
    rotation: {
        type: OptionType.SELECT,
        description: "Switch games automatically, so each one counts toward the Game Variety badge.",
        options: [
            { label: "Off", value: "off", default: true },
            { label: "Cycle through my favorites", value: "favorites" },
            { label: "Pick a random game each time", value: "random" }
        ],
        onChange: () => updateRotation(true)
    },
    rotateMinutes: {
        type: OptionType.SLIDER,
        description: "Minutes to play each game before switching to the next one.",
        markers: [5, 10, 15, 30, 60],
        default: 15,
        onChange: () => updateRotation(false)
    },
    favorites: {
        type: OptionType.CUSTOM,
        default: [] as string[],
        description: ""
    },
    pending: {
        type: OptionType.CUSTOM,
        default: [] as PendingCredit[],
        description: ""
    }
});

let active = false;
let generation = 0;
let trackRealPlay = false;
let rotationTimer: ReturnType<typeof setInterval> | undefined;
let reportTimer: ReturnType<typeof setInterval> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let lastTick = 0;
let appliedKey = "";

let detectable: Promise<DetectableApp[]> | null = null;
let fakeGames: FakeGame[] = [];
const realGames = new Map<number, TrackedGame>();
let original: Pick<typeof RunningGameStore, "getRunningGames" | "getGameForPID" | "getGameOrTransformedSubgameForPID" | "getVisibleGame" | "getVisibleRunningGames"> | null = null;

export function loadDetectable() {
    detectable ??= RestAPI.get({ url: "/applications/detectable" }).then(res => res.body as DetectableApp[]);
    detectable.catch(() => detectable = null);
    return detectable;
}

const parseGames = (value: string) => value.split(",").map(s => s.trim()).filter(Boolean);
const isFakePid = (pid: number | undefined) => pid != null && pid >= FAKE_PID_BASE && pid % 2 === 1;

async function rotate() {
    if (!active) return;
    try {
        const { favorites, games, rotation } = settings.store;
        if (rotation === "random") {
            const apps = (await loadDetectable()).filter(a => a.cover_image_hash && a.id !== games.trim());
            if (active && apps.length) settings.store.games = apps[Math.floor(Math.random() * apps.length)].id;
        } else if (favorites.length) {
            const ids = new Set((await loadDetectable()).map(a => a.id));
            const valid = favorites.filter(id => ids.has(id));
            if (active && valid.length) settings.store.games = valid[(valid.indexOf(games.trim()) + 1) % valid.length];
        }
    } catch (e) {
        logger.error("Couldn't switch games", e);
    }
}

function updateRotation(switchNow: boolean) {
    clearInterval(rotationTimer);
    rotationTimer = undefined;
    if (!active) return;
    const { rotation, favorites, games, rotateMinutes } = settings.store;
    if (rotation === "off") return;
    if (switchNow || rotation === "favorites" && !favorites.includes(games.trim())) rotate();
    rotationTimer = setInterval(rotate, rotateMinutes * 60_000);
}

function resolveApp(apps: DetectableApp[], entry: string) {
    if (/^\d{17,20}$/.test(entry)) return apps.find(a => a.id === entry);
    const lower = entry.toLowerCase();
    return apps.find(a => a.name.toLowerCase() === lower);
}

export function isSpoofing(app: DetectableApp, games: string) {
    const name = app.name.toLowerCase();
    return games.split(",").some(e => {
        const entry = e.trim();
        return entry === app.id || entry.toLowerCase() === name;
    });
}

export function exeName(app: DetectableApp) {
    return app.executables?.find(e => e.os === "win32")?.name.replace(/^>/, "")
        ?? `${app.name.replace(/[^\w]/g, "")}.exe`;
}

function makeFakeGame(app: DetectableApp, index: number): FakeGame {
    const exe = exeName(app);
    const exePath = `c:/program files/${exe}`;
    const pid = FAKE_PID_BASE + index * 2;
    const now = Date.now();

    return {
        id: app.id,
        name: app.name,
        exePath,
        cmdLine: `"${exePath}"`,
        processName: exe,
        distributor: "",
        pid,
        pidPath: [pid],
        start: now,
        reportedAt: now,
        lastFocused: Math.floor(now / 1000),
        lastLaunched: now,
        nativeProcessObserverId: pid,
        hidden: false,
        isLauncher: false
    };
}

function withFakes(games: RunningGame[] = []) {
    const fakeIds = new Set(fakeGames.map(g => g.id));
    return [...games.filter(g => !isFakePid(g.pid) && (!g.id || !fakeIds.has(g.id))), ...fakeGames];
}

interface GamesAction {
    type: string;
    games?: RunningGame[];
    removed?: RunningGame[];
    __gameTimeSpoof?: boolean;
}

function trackRealGames(games: RunningGame[]) {
    if (!trackRealPlay) return;
    const fakeIds = new Set(fakeGames.map(g => g.id));
    const livePids = new Set<number>();

    for (const game of games) {
        if (!game.id || game.pid == null || isFakePid(game.pid) || fakeIds.has(game.id) || game.hidden || game.isLauncher) continue;
        livePids.add(game.pid);
        if (realGames.has(game.pid)) continue;
        realGames.set(game.pid, {
            id: game.id,
            name: game.name,
            processName: game.exePath.split(/[\\/]/).pop() ?? game.name,
            fingerprint: (game as RunningGame & { executableFingerprint?: string; }).executableFingerprint,
            reportedAt: Date.now()
        });
    }

    for (const [pid, game] of realGames) {
        if (livePids.has(pid)) continue;
        reportElapsed([game]);
        realGames.delete(pid);
    }
}

function interceptor(action: GamesAction) {
    if (action.type !== "RUNNING_GAMES_CHANGE" || action.__gameTimeSpoof) return false;
    trackRealGames(action.games ?? []);
    if (!fakeGames.length) return false;
    action.games = withFakes(action.games);
    if (Array.isArray(action.removed)) action.removed = action.removed.filter(g => !isFakePid(g.pid));
    return false;
}

function dispatchChange(added: RunningGame[], removed: RunningGame[]) {
    FluxDispatcher.dispatch({
        type: "RUNNING_GAMES_CHANGE",
        added,
        removed,
        games: original ? RunningGameStore.getRunningGames() : RunningGameStore.getRunningGames().filter(g => !isFakePid(g.pid)),
        __gameTimeSpoof: true
    });
}

function patchStore() {
    if (original) return;
    original = {
        getRunningGames: RunningGameStore.getRunningGames,
        getGameForPID: RunningGameStore.getGameForPID,
        getGameOrTransformedSubgameForPID: RunningGameStore.getGameOrTransformedSubgameForPID,
        getVisibleGame: RunningGameStore.getVisibleGame,
        getVisibleRunningGames: RunningGameStore.getVisibleRunningGames
    };
    const o = original;

    RunningGameStore.getRunningGames = function () {
        return withFakes(o.getRunningGames.call(this));
    };
    RunningGameStore.getVisibleRunningGames = function () {
        return withFakes(o.getVisibleRunningGames.call(this));
    };
    RunningGameStore.getVisibleGame = function () {
        return o.getVisibleGame.call(this) ?? fakeGames[0] ?? null;
    };
    RunningGameStore.getGameForPID = function (pid) {
        return fakeGames.find(g => g.pid === pid) ?? o.getGameForPID.call(this, pid);
    };
    RunningGameStore.getGameOrTransformedSubgameForPID = function (pid) {
        return fakeGames.find(g => g.pid === pid) ?? o.getGameOrTransformedSubgameForPID.call(this, pid);
    };
}

function unpatchStore() {
    if (!original) return;
    Object.assign(RunningGameStore, original);
    original = null;
}

async function apply() {
    const entries = parseGames(settings.store.games);
    if (!active || !entries.length) return;
    const run = generation;

    let apps: DetectableApp[];
    try {
        apps = await loadDetectable();
    } catch (e) {
        if (run !== generation || !active) return;
        logger.error("Failed to fetch detectable games", e);
        showToast({ text: "GameTimeSpoof couldn't load Discord's game list. It'll try again in a minute.", variant: "critical" });
        retryTimer = setTimeout(() => run === generation && apply(), LOAD_RETRY_MS);
        return;
    }
    if (run !== generation || !active) return;

    const resolved: DetectableApp[] = [];
    for (const entry of entries) {
        const app = resolveApp(apps, entry);
        if (app) resolved.push(app);
        else showToast({ text: `GameTimeSpoof: "${entry}" isn't a detectable game`, variant: "critical" });
    }
    if (!resolved.length) return;

    fakeGames = resolved.map(makeFakeGame);
    patchStore();
    dispatchChange(fakeGames, []);
    logger.info("Faking", fakeGames.map(g => g.name).join(", "));
}

function reportElapsed(games: TrackedGame[]) {
    const now = Date.now();
    for (const game of games) {
        const elapsed = now - game.reportedAt;
        if (elapsed < 0) {
            game.reportedAt = now;
            continue;
        }
        if (elapsed < 60_000) continue;
        const from = game.reportedAt;
        game.reportedAt = now;
        reportPlaytime(game, Math.min(elapsed, MAX_REPORT)).catch(e => {
            logger.error(`Failed to report play time for ${game.name}`, e);
            if (game.reportedAt === now) game.reportedAt = Math.max(from, now - MAX_REPORT);
        });
    }
}

function tick() {
    const now = Date.now();
    const games = [...fakeGames, ...realGames.values()];
    if (now - lastTick > 2 * REPORT_INTERVAL || now < lastTick) {
        for (const game of games) game.reportedAt = now;
    } else {
        reportElapsed(games);
    }
    lastTick = now;
}

function clear() {
    generation++;
    clearTimeout(retryTimer);
    const removed = fakeGames;
    reportElapsed(removed);
    fakeGames = [];
    unpatchStore();
    if (removed.length) dispatchChange([], removed);
}

function restart() {
    if (!active) return;
    const key = parseGames(settings.store.games).join(",").toLowerCase();
    if (key === appliedKey) return;
    appliedKey = key;
    clear();
    apply();
}

export default definePlugin({
    name: "GameTimeSpoof",
    description: "Makes Discord think detectable PC games are running so your Game Time badge hours keep counting.",
    tags: ["Activity", "Fun"],
    authors: [{ name: "nolifepops", id: 221807880053981184n }],
    settings,

    settingsAboutComponent: () => (
        <>
            <Button onClick={openGameBrowser}>Open Game Browser</Button>
            <Paragraph>
                Game names must match an entry in <Link href="https://discord.com/api/v9/applications/detectable">Discord's detectable games list</Link>. Press Ctrl+F on that page to search it.
            </Paragraph>
        </>
    ),

    headerBarButton: {
        icon: GameControllerIcon,
        render: () => <HeaderBarButton icon={GameControllerIcon} tooltip="Game Browser" position="bottom" onClick={openGameBrowser} />
    },

    start() {
        active = true;
        trackRealPlay = Settings.plugins.NoTrack?.disableAnalytics !== false;
        lastTick = Date.now();
        appliedKey = parseGames(settings.store.games).join(",").toLowerCase();
        FluxDispatcher.addInterceptor(interceptor);
        trackRealGames(RunningGameStore.getRunningGames());
        apply();
        updateRotation(false);
        reportTimer = setInterval(tick, REPORT_INTERVAL);
    },

    stop() {
        active = false;
        clearInterval(rotationTimer);
        clearInterval(reportTimer);
        rotationTimer = reportTimer = undefined;
        const index = FluxDispatcher._interceptors.indexOf(interceptor);
        if (index !== -1) FluxDispatcher._interceptors.splice(index, 1);
        reportElapsed([...realGames.values()]);
        realGames.clear();
        clear();
        appliedKey = "";
    }
});
