/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { HeaderBarButton } from "@api/HeaderBar";
import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { Alerts } from "@webpack/common";
import type { ReactNode } from "react";

import type { Status } from "./native";
import { notify } from "./notify";
import { actions, getStatus, Native, setStatus, settings } from "./settings";

const logger = new Logger("DiscrubLoader");

const FIRST_CHECK = 20_000;
const CHECK_EVERY = 6 * 60 * 60_000;
const START_GRACE = 30_000;
const DISCRUB_BUTTON = "discrub-floating-button";

let firstTimer: ReturnType<typeof setTimeout> | undefined;
let repeatTimer: ReturnType<typeof setInterval> | undefined;
let startPoll: ReturnType<typeof setInterval> | undefined;
let running = false;
let checking = false;

function BroomIcon({ width = 24, height = 24, className }: { width?: number; height?: number; className?: string; }) {
    return (
        <svg className={className} width={width} height={height} viewBox="0 0 24 24" role="img">
            <path fill="currentColor" d="M19.7 2.3a1 1 0 0 1 0 1.4l-5.6 5.6 1.4 1.4a1 1 0 0 1 0 1.4l-.7.7-5.6-5.6.7-.7a1 1 0 0 1 1.4 0l1.4 1.4 5.6-5.6a1 1 0 0 1 1.4 0Z" />
            <path fill="currentColor" d="M8.2 8.6 14 14.4c-.7 2.6-2.2 5-4.3 6.9-.4.4-1 .4-1.4.1l-1.2-1 1.6-2.4-2.6 1.6-1.5-1.3 1.9-2.8-3 1.8-.7-.6a1 1 0 0 1 0-1.5c1.8-2 4.6-4.1 5.4-6.6Z" />
        </svg>
    );
}

function compareVersions(a: string, b: string) {
    const x = a.split(".").map(Number), y = b.split(".").map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] ?? 0) - (y[i] ?? 0);
        if (d) return Math.sign(d);
    }
    return 0;
}

function ask(title: string, body: ReactNode, confirmText: string, cancelText = "Not now") {
    return new Promise<boolean>(resolve => Alerts.show({
        title, body, confirmText, cancelText,
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false),
        onCloseCallback: () => resolve(false),
    }));
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

async function reloadDiscord(reason: string) {
    const yes = await ask(
        "Reload Discord?",
        <Paragraph>{reason} Discord needs to reload for Discrub to start. If you're in a call you'll drop out for a few seconds.</Paragraph>,
        "Reload now",
        "Later",
    );
    if (!yes) return;
    try {
        setStatus(await Native.applyStaged());
    } catch (e) {
        Native.getStatus().then(setStatus).catch(() => { });
        return void notify(errorText(e), "critical");
    }
    location.reload();
}

async function install(version: string) {
    notify(`Downloading Discrub v${version} and checking it...`);
    try {
        const before = getStatus()?.installed;
        const status = setStatus(await Native.install(version));
        if (!before) return void reloadDiscord(`Discrub v${status.installed} is installed and checked.`);
        notify(`Discrub v${version} is downloaded and checked. Click here to use it now, or it starts with Discord next time.`, "success",
            () => void reloadDiscord(`Discrub v${version} is ready.`));
    } catch (e) {
        setStatus(await Native.getStatus());
        notify(errorText(e), "critical");
    }
}

async function offerUpdate(from: string, to: string) {
    const yes = await ask(
        "Discrub update",
        <>
            <Paragraph>Discrub v{to} is out (you have v{from}).</Paragraph>
            <Paragraph>It comes from the Chrome Web Store and is only used if it's signed by Discrub's developer and every file matches the list Discrub publishes on GitHub.</Paragraph>
        </>,
        `Update to v${to}`,
    );
    if (yes) await install(to);
}

async function check(manual: boolean) {
    if (checking) return;
    checking = true;
    try {
        const status = setStatus(await Native.checkLatest());
        if (status.lastError || !status.latest) {
            if (manual) notify(status.lastError ?? "Couldn't reach the Chrome Web Store.", "critical");
            return;
        }
        const { latest } = status;
        if (!status.installed) {
            if (manual) await offerInstall(latest);
            return;
        }
        const newest = status.staged ?? status.installed;
        if (compareVersions(latest, newest) <= 0) {
            if (manual) notify(status.staged ? `v${status.staged} is waiting for a reload.` : `Discrub v${newest} is the newest.`, "success");
            return;
        }
        if (!manual && status.bad.includes(latest)) return;

        const mode = settings.store.updateMode;
        if (mode === "pinned" && !manual) return;
        if (mode === "auto" && !manual) await install(latest);
        else await offerUpdate(newest, latest);
    } catch (e) {
        logger.error("Update check failed", e);
        if (manual) notify(errorText(e), "critical");
    } finally {
        checking = false;
    }
}

async function offerInstall(latest?: string) {
    if (!latest) {
        const status = setStatus(await Native.checkLatest());
        if (!status.latest) return void notify(status.lastError ?? "Couldn't reach the Chrome Web Store.", "critical");
        latest = status.latest;
    }
    const yes = await ask(
        "Get Discrub",
        <>
            <Paragraph>Discrub is a separate tool by Prather Bytecraft for exporting and cleaning up your own messages. This plugin only loads it; it isn't made or supported by them.</Paragraph>
            <Paragraph>v{latest} comes from the Chrome Web Store, unchanged. It's only used if it's signed by Discrub's developer and every file matches the list Discrub publishes on GitHub.</Paragraph>
            <Paragraph>Bulk deleting or exporting with your own account is automation Discord's rules don't allow, the same as with the browser extension. Keep Discrub's delays on.</Paragraph>
        </>,
        `Download v${latest}`,
    );
    if (yes) await install(latest);
}

async function openDiscrub() {
    const status = setStatus(await Native.getStatus());
    if (!status.installed) return offerInstall(status.latest ?? undefined);
    const button = document.getElementById(DISCRUB_BUTTON);
    if (!status.loaded || !button) return reloadDiscord(status.staged ? `Discrub v${status.staged} is ready.` : "Discrub is installed but not running in this window yet.");

    button.click();
    const view = settings.store.startWith;
    if (view === "web" || view === "classic") {
        Native.chooseView(view).catch(e => logger.warn("Couldn't pick the version on Discrub's start screen", e));
    }
}

// After an update, Discrub's content script adds its button within a few seconds. No button means the new version is broken.
function watchStart(status: Status) {
    if (!status.justUpdated || !status.loaded) return;
    const started = Date.now();
    clearInterval(startPoll);
    startPoll = setInterval(async () => {
        if (!running) return void clearInterval(startPoll);
        if (document.getElementById(DISCRUB_BUTTON)) {
            clearInterval(startPoll);
            setStatus(await Native.confirmStarted());
        } else if (Date.now() - started > START_GRACE) {
            clearInterval(startPoll);
            try {
                const back = setStatus(await Native.rollback("its button never showed up"));
                if (running) void reloadDiscord(back.lastError ?? `Went back to Discrub v${back.installed}.`);
            } catch (e) {
                notify(`Discrub v${status.justUpdated} didn't start, and there's no older copy to go back to. ${errorText(e)}`, "critical");
            }
        }
    }, 1000);
}

actions.checkNow = () => check(true);
actions.applyUpdate = () => reloadDiscord(`Discrub v${getStatus()?.staged} is ready.`);

export default definePlugin({
    name: "DiscrubLoader",
    description: "Opens Discrub (message export and cleanup by Prather Bytecraft) inside Discord, loaded straight from its official build and checked against GitHub. Unofficial.",
    authors: [{ name: "nolifepops", id: 221807880053981184n }],
    settings,

    settingsAboutComponent: () => (
        <>
            <Button onClick={() => void openDiscrub()}>Open Discrub</Button>
            <Paragraph>
                Discrub also opens from the broom at the top of Discord. Discrub itself is made by Prather Bytecraft (github.com/pratherbytecraft/discrub); this plugin only downloads their official build and runs it unchanged.
            </Paragraph>
        </>
    ),

    headerBarButton: {
        icon: BroomIcon,
        render: () => <HeaderBarButton icon={BroomIcon} tooltip="Discrub" position="bottom" onClick={() => void openDiscrub()} />
    },

    async start() {
        running = true;
        try {
            const status = setStatus(await Native.start());
            if (status.lastError?.includes("Went back")) notify(status.lastError, "critical");
            watchStart(status);
        } catch (e) {
            logger.error("Couldn't start", e);
        }
        firstTimer = setTimeout(() => void check(false), FIRST_CHECK);
        repeatTimer = setInterval(() => void check(false), CHECK_EVERY);
    },

    stop() {
        running = false;
        clearInterval(startPoll);
        clearTimeout(firstTimer);
        clearInterval(repeatTimer);
        Native.stop().then(setStatus).catch(() => { });
    },
});
