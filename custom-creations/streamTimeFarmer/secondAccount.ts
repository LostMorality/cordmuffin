/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { plugins, startPlugin } from "@api/PluginManager";
import { Settings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import type { PluginNative } from "@utils/types";
import { showToast, useEffect, UserStore, useState } from "@webpack/common";

import { changeStreamProfile, pluginActive } from ".";
import { currentUserId, profile, type SecondAccountInfo, type SecondPresence, updateProfile } from "./profile";
import type { StreamStatus } from "./stream";

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
// Checks in a row where the page answered but Equicord never got going there. After a minute the window is rebuilt
// once (which reads the web build again); if that doesn't help either, the user is told.
let stuckReads = 0;
const STUCK_READS_LIMIT = 12;
// The online status already put on the second account since its window opened. It's set once per start (or when the
// setting changes), so changing it somewhere else during a call isn't undone every few seconds.
let appliedPresence: SecondPresence | null = null;
let status: SecondStatus = { phase: "off", account: null, viewer: null };
const listeners = new Set<() => void>();

export const secondStatus = () => status;
export const canHostSecond = () => IS_DISCORD_DESKTOP;

// Why the second account can't run in this Discord, or "" when it can. "restart": the plugin's desktop half isn't
// loaded, which happens when it was added or updated while Discord kept running (closing to the tray or reloading
// doesn't load it). "web": the installer couldn't build the web version the second account's window runs.
export type SetupProblem = "" | "restart" | "web";

async function setupProblem(): Promise<SetupProblem> {
    if (!Native) return "restart";
    try {
        return await Native.hasWebBuild() ? "" : "web";
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
    const P = V.Plugins.plugins.StreamTimeFarmer;
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
        presence
    };
})()`;

// The online status is the second account's own Discord setting, so it changes wherever that account is logged in.
// It answers with the status the account has afterwards, so what's shown is always what it really has.
const setUp = (streamerId: string, watch: boolean, presence: SecondPresence) => `(() => {
    const V = window.Vencord, s = V?.Settings?.plugins?.StreamTimeFarmer, P = V?.Plugins?.plugins?.StreamTimeFarmer;
    if (!s || !P?.configureStreamFarm) return false;
    if (!s.enabled) { s.enabled = true; V.Plugins.startPlugin(P); }
    P.configureStreamFarm(${JSON.stringify({ role: watch ? "viewer" : "off", partner: streamerId })});
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

async function tick() {
    if (busy || !Native) return;
    const run = generation;
    const stale = () => run !== generation || !timer;
    busy = true;
    try {
        const opened = await Native.openSecondAccount(false, loginKey());
        if (stale()) return;
        if (!opened) return setStatus({ phase: "unavailable", account: null, viewer: null });
        // Rebuilt while the user was logging in: its window has to be shown again.
        if (opened === "created" && loggingIn) void Native.openSecondAccount(true, loginKey());
        const r = await Native.secondAccountEval(READ) as { ready: boolean; loggedIn: boolean; noVencord?: boolean; account?: SecondAccountInfo; viewer?: StreamStatus | null; presence?: string; } | null;
        if (stale()) return;
        if (r == null) {
            if (++failedReads >= FAILED_READS_LIMIT) {
                failedReads = 0;
                await Native.closeSecondAccount();
                if (stale()) return;
            }
            return setStatus({ phase: "starting", account: status.account ?? profile().account, viewer: null });
        }
        failedReads = 0;
        if (!r.ready) {
            if (r.noVencord) return void await stuck();
            return setStatus({ ...status, phase: status.phase === "ready" ? "ready" : "starting", account: status.account ?? profile().account });
        }
        if (!r.loggedIn || !r.account) {
            if (++loggedOutReads < LOGGED_OUT_READS) return;
            // Logged out (or never logged in): show its window so the user can log in.
            if (!loggingIn) {
                loggingIn = true;
                void Native.openSecondAccount(true, loginKey());
            }
            return setStatus({ phase: "login", account: null, viewer: null });
        }
        loggedOutReads = 0;

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
        setStatus({ phase: "ready", account: r.account, viewer: r.viewer ?? null, presence: configured.presence || r.presence || "" });
    } catch (e) {
        logger.warn("Second account check failed", e);
    } finally {
        if (run === generation) busy = false;
    }
}

async function stuck(account: SecondAccountInfo | null = null) {
    const run = generation;
    stuckReads++;
    if (stuckReads === STUCK_READS_LIMIT) await Native?.closeSecondAccount();
    if (run !== generation) return;
    const phase = stuckReads >= 2 * STUCK_READS_LIMIT ? "broken" : "starting";
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
    loggedOutReads = failedReads = stuckReads = 0;
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
        showToast({ text: "StreamTimeFarmer couldn't start. Turn it on in the plugin list instead.", variant: "critical" });
        return false;
    }
    Settings.plugins.StreamTimeFarmer.enabled = true;
    return true;
}

// Works with the plugin off too: logging in turns it on, since the second account only runs while it's on.
export async function linkSecondAccount() {
    const problem = await setupProblem();
    if (problem) {
        showToast({ text: problem === "restart" ? RESTART_TEXT : WEB_TEXT, variant: "critical" });
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
export const WEB_TEXT = "The part of Equicord that runs the second account didn't install. Run the Cordmuffin installer again to add it.";

// Stops logging in. During a call that also hangs up, since the call can't go on without the second account.
export function cancelLink() {
    loggingIn = false;
    const { account, role } = profile();
    if (!account) changeStreamProfile({ hostSecond: false, role: "off" });
    else if (role === "streamer") changeStreamProfile({ role: "off" });
    else startSecondAccount();
}

export const showSecondAccount = () => Native?.openSecondAccount(true, loginKey());
export const hideSecondAccount = () => Native?.hideSecondAccount();

// Forgets the second account completely: ends any call, closes its window and clears its saved login.
export async function signOutSecondAccount() {
    const login = loginKey();
    stopSecondAccount();
    await Native?.signOutSecondAccount(login);
    changeStreamProfile({ hostSecond: false, account: null, partner: "", role: "off" });
}
