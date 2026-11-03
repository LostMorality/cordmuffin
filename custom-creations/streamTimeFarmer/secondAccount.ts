/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import type { PluginNative } from "@utils/types";
import { useEffect, UserStore, useState } from "@webpack/common";

import { changeStreamProfile, pluginActive } from ".";
import { profile, type SecondAccountInfo, updateProfile } from "./profile";
import type { StreamStatus } from "./stream";

const logger = new Logger("StreamTimeFarmer");

// The second account runs inside this Discord instead of a second Discord: a hidden window with its own login
// (see native.ts). This side starts it, sets it up as the viewer and reads back who it is and how it's doing. The
// stream farm only ever calls the account logged in here, so it can't be pointed at someone else's account.
// The window only runs during a call (or while logging in); hanging up closes it but keeps its login.

const Native = IS_DISCORD_DESKTOP ? VencordNative.pluginHelpers.StreamTimeFarmer as PluginNative<typeof import("./native")> : null;

// off: no second account linked. idle: linked, window closed until the next call. same: logged into this account.
export type SecondPhase = "unavailable" | "off" | "idle" | "starting" | "login" | "same" | "ready";

export interface SecondStatus {
    phase: SecondPhase;
    account: SecondAccountInfo | null;
    viewer: StreamStatus | null;
}

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
let status: SecondStatus = { phase: "off", account: null, viewer: null };
const listeners = new Set<() => void>();

export const secondStatus = () => status;
export const canHostSecond = () => Native != null;

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
    if (!me) return { ready: !!V && /^\\/(login|register)/.test(location.pathname), loggedIn: false };
    const P = V.Plugins.plugins.StreamTimeFarmer;
    let avatar = "";
    try { avatar = me.getAvatarURL?.(undefined, 80, false) ?? ""; } catch { }
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
        viewer: P?.started ? P.streamFarmStatus?.() ?? null : null
    };
})()`;

const setUp = (streamerId: string, watch: boolean) => `(() => {
    const V = window.Vencord, s = V?.Settings?.plugins?.StreamTimeFarmer, P = V?.Plugins?.plugins?.StreamTimeFarmer;
    if (!s || !P?.configureStreamFarm) return false;
    if (!s.enabled) { s.enabled = true; V.Plugins.startPlugin(P); }
    P.configureStreamFarm(${JSON.stringify({ role: watch ? "viewer" : "off", partner: streamerId })});
    return true;
})()`;

const idle = (): SecondStatus => ({ phase: "idle", account: profile().account, viewer: null });

async function tick() {
    if (busy || !Native) return;
    const run = generation;
    const stale = () => run !== generation || !timer;
    busy = true;
    try {
        if (!await Native.openSecondAccount(false)) return setStatus({ phase: "unavailable", account: null, viewer: null });
        if (stale()) return;
        const r = await Native.secondAccountEval(READ) as { ready: boolean; loggedIn: boolean; account?: SecondAccountInfo; viewer?: StreamStatus | null; } | null;
        if (stale()) return;
        if (r == null) {
            if (++failedReads >= FAILED_READS_LIMIT) {
                failedReads = 0;
                await Native.closeSecondAccount();
            }
            return setStatus({ phase: "starting", account: status.account ?? profile().account, viewer: null });
        }
        failedReads = 0;
        if (!r.ready) return setStatus({ ...status, phase: status.phase === "ready" ? "ready" : "starting", account: status.account ?? profile().account });
        if (!r.loggedIn || !r.account) {
            if (++loggedOutReads < LOGGED_OUT_READS) return;
            // Logged out (or never logged in): show its window so the user can log in.
            if (!loggingIn) {
                loggingIn = true;
                void Native.openSecondAccount(true);
            }
            return setStatus({ phase: "login", account: null, viewer: null });
        }
        loggedOutReads = 0;

        const me = UserStore.getCurrentUser().id;
        if (r.account.id === me) return setStatus({ phase: "same", account: r.account, viewer: null });

        const { role, partner, account } = profile();
        // A different account logged in there: the call moves to it (changing the partner restarts the farm).
        if (partner !== r.account.id) changeStreamProfile({ partner: r.account.id, account: r.account });
        else if (JSON.stringify(account) !== JSON.stringify(r.account)) updateProfile({ account: r.account });
        if (loggingIn) {
            // Its window was only shown to log in; that's done, so it goes back to hiding, or closes if there's no call.
            loggingIn = false;
            void Native.hideSecondAccount();
            if (role !== "streamer") return startSecondAccount();
        }
        const configured = await Native.secondAccountEval(setUp(me, role === "streamer"));
        if (stale()) return;
        if (configured !== true) return setStatus({ phase: "starting", account: r.account, viewer: null });
        setStatus({ phase: "ready", account: r.account, viewer: r.viewer ?? null });
    } catch (e) {
        logger.warn("Second account check failed", e);
    } finally {
        if (run === generation) busy = false;
    }
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

// Closing the window takes the second account out of the call. Its login stays saved for next time.
export function stopSecondAccount(close = true) {
    generation++;
    busy = false;
    loggedOutReads = failedReads = 0;
    clearInterval(timer);
    timer = undefined;
    if (close) {
        loggingIn = false;
        void Native?.closeSecondAccount();
    }
    setStatus({ phase: Native ? "off" : "unavailable", account: null, viewer: null });
}

// Links a second account: opens its window to log in (or goes straight in, if it's still logged in from before).
export function linkSecondAccount() {
    if (!Native || !pluginActive()) return;
    loggingIn = true;
    if (!profile().hostSecond) changeStreamProfile({ hostSecond: true });
    else startSecondAccount();
    void Native.openSecondAccount(true);
}

// Stops logging in. During a call that also hangs up, since the call can't go on without the second account.
export function cancelLink() {
    loggingIn = false;
    const { account, role } = profile();
    if (!account) changeStreamProfile({ hostSecond: false, role: "off" });
    else if (role === "streamer") changeStreamProfile({ role: "off" });
    else startSecondAccount();
}

export const showSecondAccount = () => Native?.openSecondAccount(true);
export const hideSecondAccount = () => Native?.hideSecondAccount();

// Forgets the second account completely: ends any call, closes its window and clears its saved login.
export async function signOutSecondAccount() {
    stopSecondAccount();
    await Native?.signOutSecondAccount();
    changeStreamProfile({ hostSecond: false, account: null, partner: "", role: "off" });
}

export const hasWebBuild = async () => !!await Native?.hasWebBuild();
