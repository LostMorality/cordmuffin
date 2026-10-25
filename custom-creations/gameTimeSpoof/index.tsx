/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
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

import { openGameBrowser } from "./GameBrowser";
import { ReportedGame,reportPlaytime } from "./science";

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

export const settings = definePluginSettings({
    games: {
        type: OptionType.STRING,
        description: "Games to fake as running. Use application IDs or exact game names from Discord's detectable list, separated by commas.",
        default: "Minecraft",
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
    }
});

let rotationTimer: ReturnType<typeof setInterval> | undefined;

async function rotate() {
    const { favorites, games, rotation } = settings.store;
    if (rotation === "random") {
        const apps = (await loadDetectable()).filter(a => a.cover_image_hash && a.id !== games.trim());
        settings.store.games = apps[Math.floor(Math.random() * apps.length)].id;
    } else if (favorites.length) {
        settings.store.games = favorites[(favorites.indexOf(games.trim()) + 1) % favorites.length];
    }
}

function updateRotation(switchNow: boolean) {
    clearInterval(rotationTimer);
    rotationTimer = undefined;
    const { rotation, favorites, games, rotateMinutes } = settings.store;
    if (rotation === "off") return;
    if (switchNow || rotation === "favorites" && !favorites.includes(games.trim())) rotate();
    rotationTimer = setInterval(rotate, rotateMinutes * 60_000);
}

let detectable: DetectableApp[] | null = null;
let fakeGames: FakeGame[] = [];
const realGames = new Map<number, TrackedGame>();
let original: Pick<typeof RunningGameStore, "getRunningGames" | "getGameForPID" | "getGameOrTransformedSubgameForPID" | "getVisibleGame" | "getVisibleRunningGames"> | null = null;

export async function loadDetectable() {
    if (detectable) return detectable;
    const res = await RestAPI.get({ url: "/applications/detectable" });
    detectable = res.body as DetectableApp[];
    return detectable;
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
    const pid = 90000 + index;
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
    return [...games.filter(g => !g.id || !fakeIds.has(g.id)), ...fakeGames];
}

interface GamesAction {
    type: string;
    games?: RunningGame[];
    removed?: RunningGame[];
    __gameTimeSpoof?: boolean;
}

function trackRealGames(games: RunningGame[]) {
    if (Settings.plugins.NoTrack?.disableAnalytics === false) return;
    const fakePids = new Set(fakeGames.map(g => g.pid));
    const livePids = new Set<number>();

    for (const game of games) {
        if (!game.id || game.pid == null || fakePids.has(game.pid) || game.hidden || game.isLauncher) continue;
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
    if (Array.isArray(action.removed)) {
        const fakePids = new Set(fakeGames.map(g => g.pid));
        action.removed = action.removed.filter(g => !fakePids.has(g.pid));
    }
    return false;
}

function dispatchChange(added: RunningGame[], removed: RunningGame[]) {
    FluxDispatcher.dispatch({
        type: "RUNNING_GAMES_CHANGE",
        added,
        removed,
        games: RunningGameStore.getRunningGames(),
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
    const entries = settings.store.games.split(",").map(s => s.trim()).filter(Boolean);
    if (!entries.length) return;

    let apps: DetectableApp[];
    try {
        apps = await loadDetectable();
    } catch (e) {
        logger.error("Failed to fetch detectable games", e);
        showToast({ text: "GameTimeSpoof: couldn't load Discord's game list", variant: "critical" });
        return;
    }

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

let reportTimer: ReturnType<typeof setInterval> | undefined;

function reportElapsed(games: TrackedGame[]) {
    const now = Date.now();
    for (const game of games) {
        const elapsed = now - game.reportedAt;
        if (elapsed < 60_000) continue;
        game.reportedAt = now;
        reportPlaytime(game, elapsed).catch(e => logger.error(`Failed to report play time for ${game.name}`, e));
    }
}

function clear() {
    const removed = fakeGames;
    reportElapsed(removed);
    fakeGames = [];
    unpatchStore();
    if (removed.length) dispatchChange([], removed);
}

function restart() {
    clear();
    apply();
}

export default definePlugin({
    name: "GameTimeSpoof",
    description: "Makes Discord think detectable PC games are running so your Game Time badge hours keep counting.",
    tags: ["Activity", "Fun"],
    authors: [{ name: "Unknown", id: 0n }],
    enabledByDefault: true,
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
        FluxDispatcher.addInterceptor(interceptor);
        trackRealGames(RunningGameStore.getRunningGames());
        apply();
        updateRotation(false);
        reportTimer = setInterval(() => reportElapsed([...fakeGames, ...realGames.values()]), REPORT_INTERVAL);
    },

    stop() {
        clearInterval(rotationTimer);
        clearInterval(reportTimer);
        const index = FluxDispatcher._interceptors.indexOf(interceptor);
        if (index !== -1) FluxDispatcher._interceptors.splice(index, 1);
        reportElapsed([...realGames.values()]);
        realGames.clear();
        clear();
    }
});
