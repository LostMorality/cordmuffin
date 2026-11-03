/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { relaunch } from "@utils/native";
import { createRoot, useEffect, useState } from "@webpack/common";
import type { Root } from "react-dom/client";

import { changeStreamProfile, pluginActive, settings } from ".";
import { enterAfk } from "./afk";
import { type SecondAccountInfo, useProfile } from "./profile";
import { cancelLink, canHostSecond, linkSecondAccount, RESTART_TEXT, showSecondAccount, signOutSecondAccount, turnOn, useSecondStatus, useSetupProblem, WEB_TEXT } from "./secondAccount";
import { hangingUp, onStreamStatus, streamFarmRunning, streamStatus } from "./stream";

const cl = classNameFactory("vc-stf-");

export function formatTime(ms: number) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor(ms % 3_600_000 / 60_000);
    return h ? `${h}h ${m}m` : `${m}m`;
}

export function useStreamStatus() {
    const [status, setStatus] = useState(streamStatus);
    useEffect(() => {
        const unsubscribe = onStreamStatus(() => setStatus(streamStatus()));
        setStatus(streamStatus());
        return unsubscribe;
    }, []);
    return status;
}

// Call and Hang up swap places, so a double click would undo the first click straight away.
let lastPress = 0;
const once = (action: () => void) => () => {
    const now = Date.now();
    if (now - lastPress < 1_000) return;
    lastPress = now;
    action();
};

export const callSecond = once(() => changeStreamProfile({ role: "streamer" }));
export const hangUp = once(() => changeStreamProfile({ role: "off" }));
const hangUpLogin = once(cancelLink);

type Tone = "idle" | "busy" | "live" | "bad";

// One line about where the call stands, shared by the settings card and the widget.
function useCallState(): { tone: Tone; text: string; account: SecondAccountInfo | null; inCall: boolean; } {
    const second = useSecondStatus();
    const stream = useStreamStatus();
    const { role, account: saved } = useProfile();
    const inCall = role === "streamer" && !hangingUp();
    const account = second.account ?? saved;

    switch (second.phase) {
        case "unavailable":
            return { tone: "bad", text: WEB_TEXT, account, inCall };
        case "restart":
            return { tone: "bad", text: RESTART_TEXT, account, inCall };
        case "login":
            return { tone: "busy", text: "Log in to your second account in the window that opened.", account: null, inCall };
        case "broken":
            return { tone: "bad", text: "Equicord didn't load in your second account's window. Run the Cordmuffin installer again to rebuild it.", account, inCall };
        case "same":
            return { tone: "bad", text: "That window is logged into this same account. Sign out there and log into your other account.", account, inCall };
        case "starting":
            return { tone: "busy", text: "Starting your second account...", account, inCall };
        case "ready": {
            if (!inCall) return { tone: "idle", text: "Not in a call.", account, inCall };
            const tone = stream.phase === "counting" ? "live" : stream.phase === "setup" ? "bad" : "busy";
            return { tone, text: stream.detail || "Starting the call...", account, inCall };
        }
        default:
            return { tone: "idle", text: inCall ? "Starting the call..." : "Not in a call.", account, inCall };
    }
}

function Avatar({ account, tone, size }: { account: SecondAccountInfo | null; tone: Tone; size: number; }) {
    return (
        <div className={cl("call-avatar")} style={{ width: size, height: size }} aria-hidden="true">
            {account?.avatar
                ? <img src={account.avatar} alt="" width={size} height={size} />
                : <div className={cl("call-avatar-blank")}>{(account?.globalName || account?.username || "?").slice(0, 1).toUpperCase()}</div>}
            <span className={cl("call-dot", `call-${tone}`)} />
        </div>
    );
}

function Who({ account }: { account: SecondAccountInfo; }) {
    return (
        <div className={cl("call-who")}>
            <div className={cl("call-name")}>{account.globalName || account.username}</div>
            <div className={cl("call-tag")}>{account.tag}</div>
        </div>
    );
}

// The second account in the plugin's settings: log it in, see who it is, call it, hang up, sign it out.
export function SecondAccountCard() {
    const second = useSecondStatus();
    const { tone, text, account, inCall } = useCallState();
    const stream = useStreamStatus();
    const { hostSecond } = useProfile();
    const problem = useSetupProblem();
    // Whether the plugin runs isn't something React sees, so turning it on here redraws the card by hand.
    const [, redraw] = useState(0);

    if (!canHostSecond()) return <div className={cl("stream-status", "stream-setup")}>The second account runs in the Discord desktop app.</div>;
    // Nothing to press until the check is done, so Log in or Turn on can't be clicked when they can't work.
    if (problem === null) return null;
    if (problem === "restart") {
        return (
            <div className={cl("call-card")}>
                <div className={cl("call-text")}>{RESTART_TEXT}</div>
                <Button size="small" onClick={relaunch}>Restart Discord</Button>
            </div>
        );
    }
    if (problem === "web") return <div className={cl("stream-status", "stream-setup")}>{WEB_TEXT}</div>;
    if (hostSecond && !pluginActive()) {
        return (
            <div className={cl("call-card")}>
                <div className={cl("call-text")}>StreamTimeFarmer is off, so your second account isn't running.</div>
                <Button size="small" onClick={() => turnOn() && redraw(n => n + 1)}>Turn on</Button>
            </div>
        );
    }

    if (!hostSecond) {
        return (
            <div className={cl("call-card")}>
                <div className={cl("call-text")}>
                    Log in to your other account here. It runs in a hidden window inside this Discord, so you don't need a
                    second Discord, and calls only ever go to the account logged in here.
                    {!pluginActive() && " Logging in turns StreamTimeFarmer on."}
                </div>
                <Button size="small" onClick={linkSecondAccount}>Log in to second account</Button>
            </div>
        );
    }

    if (second.phase === "login") {
        return (
            <div className={cl("call-card")}>
                <div className={cl("call-text")}>{text}</div>
                <div className={cl("stream-row")}>
                    <Button size="small" onClick={() => showSecondAccount()}>Show login window</Button>
                    <Button size="small" variant="secondary" onClick={cancelLink}>Cancel</Button>
                </div>
            </div>
        );
    }

    return (
        <div className={cl("call-card")}>
            <div className={cl("stream-row")}>
                <Avatar account={account} tone={tone} size={48} />
                {account ? <Who account={account} /> : <div className={cl("call-who")}>Second account</div>}
            </div>
            {account && <div className={cl("call-id")}>ID {account.id}</div>}
            <div className={cl("call-text")}>{text}</div>
            {streamFarmRunning() && <div className={cl("stream-time")}>This call: {formatTime(stream.sessionMs)}</div>}
            <div className={cl("stream-row")}>
                {inCall
                    ? <Button size="small" variant="dangerPrimary" onClick={hangUp}>Hang up</Button>
                    : <Button size="small" variant="positive" onClick={callSecond} disabled={second.phase === "same" || second.phase === "unavailable" || second.phase === "restart"}>Call</Button>}
                {inCall && <Button size="small" variant="secondary" onClick={() => showSecondAccount()}>Open its window</Button>}
                {inCall && <Button size="small" variant="secondary" onClick={enterAfk}>AFK mode</Button>}
                <Button size="small" variant="dangerSecondary" onClick={() => signOutSecondAccount()}>Sign out</Button>
            </div>
        </div>
    );
}

function Widget() {
    const [open, setOpen] = useState(true);
    const { hostSecond } = useProfile();
    const { callWidget } = settings.use(["callWidget"]);
    const second = useSecondStatus();
    const stream = useStreamStatus();
    const { tone, text, account, inCall } = useCallState();

    if (!callWidget || !hostSecond || !canHostSecond() || second.phase === "off") return null;

    if (!open) {
        return (
            <button className={cl("call-widget", "call-pill")} onClick={() => setOpen(true)} title={text} aria-label={`Open the call widget. ${text}`}>
                <Avatar account={account} tone={tone} size={40} />
            </button>
        );
    }

    return (
        <div className={cl("call-widget")}>
            <div className={cl("stream-row")}>
                <Avatar account={account} tone={tone} size={40} />
                {account ? <Who account={account} /> : <div className={cl("call-who")}>Second account</div>}
                <button className={cl("call-icon")} onClick={() => setOpen(false)} title="Minimize" aria-label="Minimize">–</button>
            </div>
            <div className={cl("call-text")}>{text}</div>
            {streamFarmRunning() && <div className={cl("stream-time")}>This call {formatTime(stream.sessionMs)} · Total {formatTime(stream.countedMs)}</div>}
            <div className={cl("call-buttons")}>
                {second.phase === "login"
                    ? <Button size="small" onClick={() => showSecondAccount()}>Log in</Button>
                    : inCall
                        ? <Button size="small" variant="dangerPrimary" onClick={hangUp}>Hang up</Button>
                        : <Button size="small" variant="positive" onClick={callSecond} disabled={second.phase === "same" || second.phase === "unavailable" || second.phase === "restart"}>Call</Button>}
                {inCall && second.phase === "login" && <Button size="small" variant="dangerPrimary" onClick={hangUpLogin}>Hang up</Button>}
                {inCall && second.phase !== "login" && <Button size="small" variant="secondary" onClick={() => showSecondAccount()}>Open</Button>}
                {inCall && second.phase !== "login" && <Button size="small" variant="secondary" onClick={enterAfk} title="Hide Discord behind a black screen so it uses almost nothing. Esc twice brings it back.">AFK</Button>}
            </div>
        </div>
    );
}

const SafeWidget = ErrorBoundary.wrap(Widget, { noop: true });

let host: HTMLDivElement | undefined;
let root: Root | undefined;

export function mountCallWidget() {
    if (host) return;
    host = document.createElement("div");
    host.className = cl("call-host");
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(<SafeWidget />);
}

export function unmountCallWidget() {
    root?.unmount();
    host?.remove();
    root = host = undefined;
}
