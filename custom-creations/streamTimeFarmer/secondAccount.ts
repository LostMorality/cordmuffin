/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { plugins, startPlugin } from "@api/PluginManager";
import { Settings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import type { PluginNative } from "@utils/types";
import { useEffect, UserStore, useState } from "@webpack/common";

import { changeStreamProfile, pluginActive } from ".";
import { currentUserId, profile, type SecondAccountInfo, type SecondPresence, updateProfile } from "./profile";
import type { StreamStatus } from "./stream";
import { toast } from "./toast";
import type { TrackingState } from "./tracking";

const logger = new Logger("StreamTimeFarmer");

// The second account runs inside this Discord instead of a second Discord: a hidden window with its own login
// (see native.ts). This side starts it, sets it up as the viewer and reads back who it is and how it's doing. The
// stream farm only ever calls the account logged in here, so it can't be pointed at someone else's account.
// The window only runs during a call (or while logging in); hanging up closes it but keeps its login.

const Native = IS_DISCORD_DESKTOP ? VencordNative.pluginHelpers.StreamTimeFarmer as PluginNative<typeof import("./native")> : null;

// Which saved login the window uses: this account's own, or the old shared one.
const loginKey = () => profile().ownLogin ? currentUserId() : "";

// off: no second account linked. idle: linked, window closed until the next call. same: logged into this account.
// broken: its page keeps loading without Equicord (or with an Equicord too old to run the farm).
export type SecondPhase = "unavailable" | "restart" | "off" | "idle" | "starting" | "login" | "same" | "broken" | "ready";

export interface SecondStatus {
    phase: SecondPhase;
    account: SecondAccountInfo | null;
    viewer: StreamStatus | null;
    // Its online status as its own Discord has it, while it's running ("" when not known).
    presence?: string;
    // Whether its Discord reports streams (see tracking.ts), while it's running; null when its Equicord can't say.
    tracking?: TrackingState | null;
}

// Discord's names for its online statuses.
export const PRESENCE_LABELS: Record<string, string> = { online: "Online", idle: "Idle", dnd: "Do Not Disturb", invisible: "Invisible", offline: "Offline" };

const TICK_MS = 5_000;
// The login page can flash past while Discord is still deciding, so it has to be seen twice before the window opens.
const LOGGED_OUT_READS = 2;

let timer: ReturnType<typeof setInterval> | undefined;
// Bumped on every stop, so a check still waiting on the page from before can't change anything afterwards.
let generation = 0;
let busy = false;
let loggingIn = false;
let loggedOutReads = 0;
// Checks in a row that got no answer at all: its page crashed or froze, so the window is rebuilt.
let failedReads = 0;
const FAILED_READS_LIMIT = 3;
// Checks in a row where Equicord is there but Discord itself never finished loading. After two minutes the window is
// rebuilt, and again every two minutes for as long as it stays that way.
let notReadyReads = 0;
const NOT_READY_READS_LIMIT = 24;
// Windows in a row lost to a crash or a freeze without the account ever showing up. After a few, the window stays
// closed for BROKEN_RETRY_MS instead of being rebuilt over and over.
let deadRebuilds = 0;
const DEAD_REBUILDS_LIMIT = 3;
let deadSince = 0;
// Whether the next new window is one this side asked for (first start, or after closing it on purpose). A new window
// nobody asked for means the last one's page crashed.
let expectNew = true;
// Checks in a row where the page answered but Equicord never got going there. After a minute the window is rebuilt
// once (which reads the web build again); if that doesn't help either, the user is told.
let stuckReads = 0;
const STUCK_READS_LIMIT = 12;
// While it's broken it tries again by itself now and then: a fresh download of the web build and a new window.
const BROKEN_RETRY_MS = 12 * 60_000;
let brokenSince = 0;
let lastBrokenRetry = 0;
// The online status already put on the second account since its window opened. It's set once per start (or when the
// setting changes), so changing it somewhere else during a call isn't undone every few seconds.
let appliedPresence: SecondPresence | null = null;
let status: SecondStatus = { phase: "off", account: null, viewer: null };
const listeners = new Set<() => void>();

export const secondStatus = () => status;
export const canHostSecond = () => IS_DISCORD_DESKTOP;

// Why the second account can't run in this Discord, or "" when it can. "restart": the plugin's desktop half isn't
// loaded, which happens when it was added or updated while Discord kept running (closing to the tray or reloading
// doesn't load it). "web": the Equicord build that window runs couldn't be downloaded.
export type SetupProblem = "" | "restart" | "web";

async function setupProblem(): Promise<SetupProblem> {
    if (!Native) return "restart";
    try {
        // This downloads the build when it's missing, so a first run isn't turned away for not having it yet.
        return await Native.webBuildProblem() ? "web" : "";
    } catch {
        // The desktop half is from an older start of Discord and doesn't have this plugin's handlers.
        return "restart";
    }
}

export function useSetupProblem() {
    const [problem, setProblem] = useState<SetupProblem | null>(null);
    useEffect(() => {
        let live = true;
        void setupProblem().then(p => live && setProblem(p));
        return () => void (live = false);
    }, []);
    return problem;
}

export function onSecondStatus(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}

export function useSecondStatus() {
    const [current, setCurrent] = useState(secondStatus);
    useEffect(() => {
        const unsubscribe = onSecondStatus(() => setCurrent(secondStatus()));
        setCurrent(secondStatus());
        return unsubscribe;
    }, []);
    return current;
}

function setStatus(next: SecondStatus) {
    if (JSON.stringify(next) === JSON.stringify(status)) return;
    status = next;
    for (const listener of listeners) listener();
}

// Everything below runs inside the second account's page, where its own Equicord and StreamTimeFarmer are loaded.
// "Logged out" only counts once the login page is really showing; before that Discord is just still starting.
const READ = `(() => {
    const V = window.Vencord;
    const me = V?.Webpack?.Common?.UserStore?.getCurrentUser?.();
    if (!me) return { ready: !!V && /^\\/(login|register)/.test(location.pathname), loggedIn: false, noVencord: !V?.Plugins?.plugins };
    // Either the plugin itself, in a build that has it, or the agent injected into a released Equicord.
    const P = V.Plugins?.plugins?.StreamTimeFarmer || window.__streamTimeFarmerAgent;
    let avatar = "", presence = "";
    try { avatar = me.getAvatarURL?.(undefined, 80, false) ?? ""; } catch { }
    try { presence = V.Api?.UserSettings?.getUserSettingLazy?.("status", "status")?.getSetting?.() || V.Webpack.findStore?.("PresenceStore")?.getStatus?.(me.id) || ""; } catch { }
    return {
        ready: true,
        loggedIn: true,
        account: {
            id: me.id,
            username: me.username,
            globalName: me.globalName ?? "",
            tag: me.discriminator && me.discriminator !== "0" ? me.username + "#" + me.discriminator : "@" + me.username,
            avatar
        },
        viewer: P?.started ? P.streamFarmStatus?.() ?? null : null,
        presence,
        tracking: P?.trackingState?.() ?? null
    };
})()`;

// The online status is the second account's own Discord setting, so it changes wherever that account is logged in.
// It answers with the status the account has afterwards, so what's shown is always what it really has.
const setUp = (streamerId: string, watch: boolean, presence: SecondPresence) => `(() => {
    const V = window.Vencord, P = V?.Plugins?.plugins?.StreamTimeFarmer || window.__streamTimeFarmerAgent;
    if (!P?.configureStreamFarm) return false;
    // The agent is already running; only a real plugin has to be switched on first.
    const s = V?.Settings?.plugins?.StreamTimeFarmer;
    if (!P.isAgent && s && !s.enabled) { s.enabled = true; V.Plugins.startPlugin(P); }
    P.configureStreamFarm(${JSON.stringify({
        role: watch ? "viewer" : "off",
        partner: streamerId,
        muteMic: Settings.plugins.StreamTimeFarmer.muteMic !== false,
        deafenBoth: Settings.plugins.StreamTimeFarmer.deafenBoth !== false
    })});
    const want = ${JSON.stringify(presence)};
    let now = "", applied = false;
    try {
        const setting = V.Api.UserSettings.getUserSettingLazy("status", "status");
        if (want && setting.getSetting() !== want) setting.updateSetting(want);
        now = setting.getSetting() ?? "";
        applied = !want || now === want;
    } catch { }
    return { ok: true, presence: now, applied };
})()`;

const idle = (): SecondStatus => ({ phase: "idle", account: profile().account, viewer: null });

// Notes a window lost to a crash or freeze. True once that has happened too often in a row: it's closed and left
// closed for a while.
async function died(run: number) {
    if (++deadRebuilds < DEAD_REBUILDS_LIMIT) return false;
    deadSince = Date.now();
    expectNew = true;
    await Native?.closeSecondAccount();
    if (run === generation) setStatus({ phase: "broken", account: status.account ?? profile().account, viewer: null });
    return true;
}

async function tick() {
    if (busy || !Native) return;
    const run = generation;
    const stale = () => run !== generation || !timer;
    busy = true;
    try {
        if (deadRebuilds >= DEAD_REBUILDS_LIMIT) {
            if (Date.now() - deadSince < BROKEN_RETRY_MS) return;
            deadRebuilds = 0;
            const why = await refetchWeb();
            if (why) logger.warn("Couldn't download Equicord again for the second account:", why);
            if (stale()) return;
            setStatus({ phase: "starting", account: status.account ?? profile().account, viewer: null });
        }
        const opened = await Native.openSecondAccount(false, loginKey());
        if (stale()) return;
        if (!opened) return setStatus({ phase: "unavailable", account: null, viewer: null });
        if (opened === "created") {
            if (!expectNew && await died(run)) return;
            if (stale()) return;
            expectNew = false;
            // Rebuilt while the user was logging in: its window has to be shown again, without jumping in front.
            if (loggingIn) void Native.openSecondAccount(true, loginKey(), false);
        }
        const r = await Native.secondAccountEval(READ) as { ready: boolean; loggedIn: boolean; noVencord?: boolean; account?: SecondAccountInfo; viewer?: StreamStatus | null; presence?: string; tracking?: TrackingState | null; } | null;
        if (stale()) return;
        if (r == null) {
            if (++failedReads >= FAILED_READS_LIMIT) {
                failedReads = 0;
                expectNew = true;
                if (await died(run)) return;
                await Native.closeSecondAccount();
                if (stale()) return;
            }
            return setStatus({ phase: "starting", account: status.account ?? profile().account, viewer: null });
        }
        failedReads = 0;
        if (!r.ready) {
            if (r.noVencord) return void await stuck();
            if (++notReadyReads >= NOT_READY_READS_LIMIT) {
                notReadyReads = 0;
                expectNew = true;
                await Native.closeSecondAccount();
                if (stale()) return;
            }
            // One slow answer keeps what was last known; after that it counts as loading again.
            if (status.phase === "ready" && notReadyReads === 1) return;
            return setStatus({ phase: "starting", account: status.account ?? profile().account, viewer: null });
        }
        notReadyReads = 0;
        if (!r.loggedIn || !r.account) {
            if (++loggedOutReads < LOGGED_OUT_READS) return;
            // Logged out (or never logged in): show its window so the user can log in.
            if (!loggingIn) {
                loggingIn = true;
                // It opened by itself, so it's shown without taking the keyboard from whatever the user is doing.
                void Native.openSecondAccount(true, loginKey(), false);
            }
            return setStatus({ phase: "login", account: null, viewer: null });
        }
        loggedOutReads = 0;
        deadRebuilds = 0;

        const me = UserStore.getCurrentUser().id;
        if (r.account.id === me) return setStatus({ phase: "same", account: r.account, viewer: null });

        const { role, partner, account, secondPresence } = profile();
        // A different account logged in there: the call moves to it (changing the partner restarts the farm).
        if (partner !== r.account.id) changeStreamProfile({ partner: r.account.id, account: r.account });
        else if (JSON.stringify(account) !== JSON.stringify(r.account)) updateProfile({ account: r.account });
        if (loggingIn) {
            // Its window was only shown to log in; that's done, so it goes back to hiding, or closes if there's no call.
            loggingIn = false;
            void Native.hideSecondAccount();
            if (role !== "streamer") return startSecondAccount();
        }
        const configured = await Native.secondAccountEval(setUp(me, role === "streamer", appliedPresence === secondPresence ? "" : secondPresence)) as { ok: boolean; presence: string; applied: boolean; } | false | null;
        if (stale()) return;
        if (!configured || !configured.ok) return void await stuck(r.account);
        if (configured.applied) appliedPresence = secondPresence;
        stuckReads = 0;
        brokenSince = 0;
        setStatus({ phase: "ready", account: r.account, viewer: r.viewer ?? null, presence: configured.presence || r.presence || "", tracking: r.tracking ?? null });
    } catch (e) {
        logger.warn("Second account check failed", e);
    } finally {
        if (run === generation) busy = false;
    }
}

async function stuck(account: SecondAccountInfo | null = null) {
    const run = generation;
    stuckReads++;
    if (stuckReads === STUCK_READS_LIMIT) {
        // The copy it loaded may be the problem, so the rebuilt window gets a fresh download.
        const why = await refetchWeb();
        if (why) logger.warn("Couldn't download Equicord again for the second account:", why);
        if (run !== generation) return;
        expectNew = true;
        await Native?.closeSecondAccount();
    }
    if (run !== generation) return;
    const phase = stuckReads >= 2 * STUCK_READS_LIMIT ? "broken" : "starting";
    const now = Date.now();
    if (phase === "broken") {
        brokenSince ||= now;
        // Timed from the last retry too, so the minute or two it takes to fail again doesn't shorten the wait.
        if (now - brokenSince >= BROKEN_RETRY_MS && now - lastBrokenRetry >= BROKEN_RETRY_MS) {
            lastBrokenRetry = now;
            const why = await refetchWeb();
            if (why) logger.warn("Couldn't download Equicord again for the second account:", why);
            if (run !== generation) return;
            expectNew = true;
            await Native?.closeSecondAccount();
            if (run !== generation) return;
            stuckReads = 0;
            brokenSince = 0;
            return setStatus({ phase: "starting", account: account ?? status.account ?? profile().account, viewer: null });
        }
    }
    setStatus({ phase, account: account ?? status.account ?? profile().account, viewer: null });
}

// The window runs during a call and while logging in; otherwise it stays closed and the saved account is shown.
export function startSecondAccount() {
    const { hostSecond, role } = profile();
    const wanted = Native != null && pluginActive() && hostSecond && (role === "streamer" || loggingIn);
    if (wanted && timer) return void tick();
    stopSecondAccount(!wanted);
    if (!Native || !hostSecond) return;
    if (!wanted) return setStatus(idle());
    setStatus({ phase: "starting", account: profile().account, viewer: null });
    timer = setInterval(tick, TICK_MS);
    void tick();
}

// A new choice of online status goes on at the next check, if the second account is running.
export function applySecondPresence() {
    appliedPresence = null;
    if (timer) void tick();
}

// Closing the window takes the second account out of the call. Its login stays saved for next time.
export function stopSecondAccount(close = true) {
    generation++;
    busy = false;
    loggedOutReads = failedReads = stuckReads = brokenSince = notReadyReads = deadRebuilds = deadSince = 0;
    expectNew = true;
    appliedPresence = null;
    clearInterval(timer);
    timer = undefined;
    if (close) {
        loggingIn = false;
        void Native?.closeSecondAccount();
    }
    setStatus({ phase: Native ? "off" : "restart", account: null, viewer: null });
}

// Links a second account: opens its window to log in (or goes straight in, if it's still logged in from before).
// Turns the plugin on from its own settings, like its switch in the plugin list. It has no patches, so it starts
// right away without a restart.
export function turnOn() {
    if (pluginActive()) return true;
    const plugin = plugins.StreamTimeFarmer;
    if (!plugin || !startPlugin(plugin)) {
        toast({ text: "StreamTimeFarmer couldn't start. Turn it on in the plugin list instead.", variant: "critical" });
        return false;
    }
    Settings.plugins.StreamTimeFarmer.enabled = true;
    return true;
}

// Works with the plugin off too: logging in turns it on, since the second account only runs while it's on.
export async function linkSecondAccount() {
    const problem = await setupProblem();
    if (problem) {
        toast({ text: problem === "restart" ? RESTART_TEXT : WEB_TEXT, variant: "critical" });
        return;
    }
    if (!turnOn()) return;
    loggingIn = true;
    // A new link gets this account's own login, separate from any other account's.
    if (!profile().account && !profile().ownLogin) updateProfile({ ownLogin: true });
    if (!profile().hostSecond) changeStreamProfile({ hostSecond: true });
    else startSecondAccount();
    void Native!.openSecondAccount(true, loginKey()).catch(e => logger.error("Couldn't open the second account's window", e));
}

export const RESTART_TEXT = "StreamTimeFarmer was added or updated while Discord was running. Quit Discord fully (right-click its tray icon, then Quit Discord) and open it again to finish setting it up.";
// About 2 minutes of failed checks, then BROKEN_RETRY_MS, between tries.
export const BROKEN_TEXT = "Your second account's window keeps failing to load. The farm tries again by itself about every 15 minutes.";
export const WEB_TEXT = "Couldn't download what your second account needs. Check your internet and try again.";

// Whether the window has what it needs, and fetching it again. Both answer with "" when all is well, or a short reason.
export const webProblem = async () => {
    try {
        return Native ? await Native.webBuildProblem() : "";
    } catch (e) {
        logger.warn("Couldn't check for Equicord's web build", e);
        return RESTART_TEXT;
    }
};

export const refetchWeb = async () => {
    try {
        return await Native!.refetchWeb();
    } catch (e) {
        logger.warn("The download of Equicord's web build couldn't run", e);
        return RESTART_TEXT;
    }
};

// Keeps the second account's notifications and taskbar badge quiet. Called when the setting changes and when the
// plugin starts, so the native side matches the setting even after Discord restarts.
export const syncQuietSecondAccount = (on = Settings.plugins.StreamTimeFarmer.quietSecondAccount !== false) => {
    void Native?.setSecondAccountQuiet(on).catch(e => logger.error("Couldn't change the second account's notifications", e));
};

// Stops logging in. During a call that also hangs up, since the call can't go on without the second account.
export function cancelLink() {
    loggingIn = false;
    const { account, role } = profile();
    if (!account) changeStreamProfile({ hostSecond: false, role: "off" });
    else if (role === "streamer") changeStreamProfile({ role: "off" });
    else startSecondAccount();
}

// Opening it by hand also ends the wait after too many lost windows, so the new window is set up at once.
export function showSecondAccount() {
    const parked = timer != null && deadRebuilds >= DEAD_REBUILDS_LIMIT;
    const run = generation;
    if (parked) {
        deadRebuilds = deadSince = failedReads = 0;
        setStatus({ phase: "starting", account: status.account ?? profile().account, viewer: null });
    }
    const opened = Native?.openSecondAccount(true, loginKey());
    if (parked) void opened?.then(result => {
        if (run !== generation) return;
        // This window was asked for, so the next check must not take it for a crashed one's replacement.
        if (result === "created") expectNew = false;
        void tick();
    }, () => { });
    return opened;
}
export const hideSecondAccount = () => Native?.hideSecondAccount();

// Forgets the second account completely: ends any call, closes its window and clears its saved login.
export async function signOutSecondAccount() {
    const login = loginKey();
    stopSecondAccount();
    try {
        await Native?.signOutSecondAccount(login);
    } catch (e) {
        logger.error("Couldn't clear the second account's login", e);
        toast({ text: "Your second account was removed, but its saved login couldn't be cleared. Quit Discord fully and open it again.", variant: "critical" });
    } finally {
        // Unlinked either way, so the saved profile never lists an account the status shows as off.
        changeStreamProfile({ hostSecond: false, account: null, partner: "", role: "off" });
    }
}

// Turns stream reporting on inside the second account's Discord. Its page reloads afterwards when NoTrack was
// blocking there, which ends its NoTrack block, and it rejoins the call by itself. False when it isn't running.
export async function allowSecondTracking(): Promise<boolean> {
    if (status.phase !== "ready" || !Native) return false;
    const done = await Native.secondAccountEval(`(async () => {
        const P = window.Vencord?.Plugins?.plugins?.StreamTimeFarmer;
        if (!P?.allowTracking) return false;
        const { restart } = await P.allowTracking();
        if (restart) setTimeout(() => location.reload(), 500);
        return true;
    })()`);
    return done === true;
}
