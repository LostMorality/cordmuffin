/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import { relaunch } from "@utils/native";
import { Alerts, createRoot, useEffect, useState } from "@webpack/common";
import type { Root } from "react-dom/client";

import { changeStreamProfile, pluginActive, settings } from ".";
import { enterAfk } from "./afk";
import { type SecondAccountInfo, useProfile } from "./profile";
import { BROKEN_TEXT, cancelLink, canHostSecond, linkSecondAccount, PRESENCE_LABELS, refetchWeb, RESTART_TEXT, showSecondAccount, signOutSecondAccount, turnOn, useSecondStatus, useSetupProblem, WEB_TEXT } from "./secondAccount";
import { hangingUp, onStreamStatus, streamFarmRunning, streamStatus } from "./stream";
import { ReportStatus, TrackingWarning, useTrackingLevel } from "./TrackingWarning";

const cl = classNameFactory("vc-stf-");

export function formatTime(ms: number) {
    ms = Math.max(0, ms);
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

// One line about where the call stands, shared by the settings card and the widget.
function useCallState(): { text: string; account: SecondAccountInfo | null; inCall: boolean; } {
    const second = useSecondStatus();
    const stream = useStreamStatus();
    const { role, account: saved } = useProfile();
    const inCall = role === "streamer" && !hangingUp();
    const account = second.account ?? saved;

    switch (second.phase) {
        case "unavailable":
            return { text: WEB_TEXT, account, inCall };
        case "restart":
            return { text: RESTART_TEXT, account, inCall };
        case "login":
            return { text: "Log in to your second account in the window that opened.", account: null, inCall };
        case "broken":
            return { text: BROKEN_TEXT, account, inCall };
        case "same":
            return { text: "That window is logged into this same account. Sign out there and log into your other account.", account, inCall };
        case "starting":
            return { text: "Starting your second account...", account, inCall };
        case "ready": {
            if (!inCall) return { text: "Not in a call.", account, inCall };
            return { text: stream.detail || "Starting the call...", account, inCall };
        }
        default:
            return { text: inCall ? "Starting the call..." : "Not in a call.", account, inCall };
    }
}

// The second account's online status while it runs; it's offline here while its window is closed.
function usePresence() {
    const second = useSecondStatus();
    return second.phase === "ready" ? second.presence || "unknown" : "offline";
}

// The dot on the picture is the account's online status, like everywhere else in Discord.
function Avatar({ account, size }: { account: SecondAccountInfo | null; size: number; }) {
    const presence = usePresence();
    return (
        <div className={cl("call-avatar")} style={{ width: size, height: size }} aria-hidden="true">
            {account?.avatar
                ? <img src={account.avatar} alt="" width={size} height={size} />
                : <div className={cl("call-avatar-blank")}>{(account?.globalName || account?.username || "?").slice(0, 1).toUpperCase()}</div>}
            <span className={cl("call-dot", `presence-${presence}`)} />
        </div>
    );
}

function Who({ account }: { account: SecondAccountInfo; }) {
    const presence = usePresence();
    return (
        <div className={cl("call-who")}>
            <div className={cl("call-name")}>{account.globalName || account.username}</div>
            <div className={cl("call-tag")}>{account.tag}</div>
            {PRESENCE_LABELS[presence] && <div className={cl("call-presence")}>Online status: {PRESENCE_LABELS[presence]}</div>}
        </div>
    );
}

// Logging in starts a lot at once, so it's spelled out before anything happens.
function confirmLogin() {
    Alerts.show({
        title: "Log in a second account?",
        body: (
            <div className={cl("login-warning")}>
                <Paragraph>This opens a second Discord, hidden inside this one, and you log your other account into it.</Paragraph>
                <Paragraph>
                    {!pluginActive() && "It turns StreamTimeFarmer on. "}
                    Whenever the farm calls, that hidden Discord joins the call, watches your stream and stays connected in the
                    background, so it uses some CPU, memory and internet while it runs.
                </Paragraph>
                <Paragraph>
                    The other account stays logged in on this PC until you press Sign out. Only log in an account you own.
                    Discord doesn't allow automating accounts, so both accounts are at risk. Don't use one you can't afford to lose.
                </Paragraph>
            </div>
        ),
        confirmText: "Log in",
        cancelText: "Cancel",
        onConfirm: () => void linkSecondAccount(),
    });
}

function confirmSignOut() {
    Alerts.show({
        title: "Sign out your second account?",
        body: "This ends the call and forgets its login on this PC.",
        confirmText: "Sign out",
        cancelText: "Cancel",
        onConfirm: () => void signOutSecondAccount()
    });
}

// Shown only when the second account's window has nothing to load. The plugin fetches Equicord's web build from
// Equicord by itself, so there is nothing to install; this is for when that download hasn't got through, and all it
// offers is another go. Once it works, onDone lets the card move on.
function WebSetup({ onDone }: { onDone(): void; }) {
    const [fetching, setFetching] = useState(false);
    const [failed, setFailed] = useState("");

    const retry = async () => {
        setFailed("");
        setFetching(true);
        const why = await refetchWeb();
        if (!why) return onDone();
        setFetching(false);
        setFailed(why);
    };

    return (
        <div className={cl("call-card")}>
            <div className={cl("call-text")}>{fetching ? "Downloading what your second account needs..." : failed || WEB_TEXT}</div>
            <Button size="small" disabled={fetching} onClick={retry}>{fetching ? "Downloading..." : "Try again"}</Button>
        </div>
    );
}

export function SecondAccountCard() {
    const second = useSecondStatus();
    const { text, account, inCall } = useCallState();
    const stream = useStreamStatus();
    const { hostSecond } = useProfile();
    const problem = useSetupProblem();
    const [webFetched, setWebFetched] = useState(false);
    // Whether the plugin runs isn't something React sees, so turning it on here redraws the card by hand.
    const [, redraw] = useState(0);

    if (!canHostSecond()) return <div className={cl("stream-status", "stream-setup")}>This needs the Discord desktop app.</div>;
    // Nothing to press until the check is done, so Log in or Turn on can't be clicked when they can't work. On a
    // first run that check downloads Equicord for the second account's window, which takes a moment.
    if (problem === null) return <div className={cl("call-card")}><div className={cl("call-text")}>Getting your second account ready...</div></div>;
    if (problem === "restart") {
        return (
            <div className={cl("call-card")}>
                <div className={cl("call-text")}>{RESTART_TEXT}</div>
                <Button size="small" onClick={relaunch}>Restart Discord</Button>
            </div>
        );
    }
    if (problem === "web" && !webFetched) return <WebSetup onDone={() => setWebFetched(true)} />;
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
                <Button size="small" onClick={confirmLogin}>Log in to second account</Button>
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
                <Avatar account={account} size={48} />
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
                <Button size="small" variant="dangerSecondary" onClick={confirmSignOut}>Sign out</Button>
            </div>
        </div>
    );
}

function Widget() {
    const { hostSecond } = useProfile();
    const { callWidget, widgetOpen: open } = settings.use(["callWidget", "widgetOpen"]);
    const setOpen = (value: boolean) => void (settings.store.widgetOpen = value);
    const second = useSecondStatus();
    const stream = useStreamStatus();
    const { text, account, inCall } = useCallState();
    const tracking = useTrackingLevel();

    if (!callWidget || !hostSecond || !canHostSecond() || second.phase === "off") return null;

    if (!open) {
        const hint = tracking === "blocked" ? `${text} Your Streaming badge won't count. Open this to fix it.` : tracking === "maybe" ? `${text} Your Streaming badge may not count. Open this to see why.` : text;
        return (
            <button className={cl("call-widget", "call-pill", tracking === "blocked" && "call-pill-warn", tracking === "maybe" && "call-pill-maybe")} onClick={() => setOpen(true)} title={hint} aria-label={`Open the call widget. ${hint}`}>
                <Avatar account={account} size={40} />
            </button>
        );
    }

    return (
        <div className={cl("call-widget")}>
            <div className={cl("stream-row")}>
                <Avatar account={account} size={40} />
                {account ? <Who account={account} /> : <div className={cl("call-who")}>Second account</div>}
                <button className={cl("call-icon")} onClick={() => setOpen(false)} title="Minimize" aria-label="Minimize">–</button>
            </div>
            <div className={cl("call-text")}>{text}</div>
            <TrackingWarning compact />
            {streamFarmRunning() && <div className={cl("stream-time")}>This call {formatTime(stream.sessionMs)} · Streamed {formatTime(stream.countedMs)}</div>}
            {streamFarmRunning() && <ReportStatus />}
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
