/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { currentNotice, noticesQueue, popNotice, showNotice } from "@api/Notices";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Card } from "@components/Card";
import { Divider } from "@components/Divider";
import { FormSwitch } from "@components/FormSwitch";
import { Heading, HeadingTertiary } from "@components/Heading";
import { UpdaterIcon } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import { SettingsTab, wrapTab } from "@components/settings/tabs/BaseTab";
import SettingsPlugin from "@plugins/_core/settings";
import { Logger } from "@utils/Logger";
import { Margins } from "@utils/margins";
import { removeFromArray } from "@utils/misc";
import { relaunch } from "@utils/native";
import definePlugin, { OptionType, type PluginNative } from "@utils/types";
import { React, Select, SettingsRouter } from "@webpack/common";

import type { CheckResult, Info, UpdateResult } from "./native";

const Native = VencordNative.pluginHelpers.CordmuffinUpdater as PluginNative<typeof import("./native")>;
const logger = new Logger("CordmuffinUpdater");

const PAGE_KEY = "cordmuffin_updater";
const FIRST_CHECK_MS = 20_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;

type Phase = "idle" | "checking" | "upToDate" | "available" | "updating" | "updated" | "error" | "unsupported";

interface Status {
    phase: Phase;
    what: string[];
    message: string;
    checkedAt: number;
    info: Info | null;
}

let status: Status = { phase: "idle", what: [], message: "", checkedAt: 0, info: null };
const listeners = new Set<() => void>();
let firstTimer: ReturnType<typeof setTimeout> | undefined;
let interval: ReturnType<typeof setInterval> | undefined;
let notice: string | undefined;
let failureShown = false;
let started = false;
// A finished update waits for a restart; later checks keep saying so.
let restartPending = false;

function setStatus(next: Partial<Status>) {
    status = { ...status, ...next };
    listeners.forEach(l => l());
}

function joinNames(names: string[]) {
    if (names.length < 2) return names.join("");
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const pluginNames: Record<string, string> = {
    gametimespoof: "Game Browser",
    muffinshelf: "Muffinshelf",
    questrunner: "QuestRunner",
    dictation: "Dictation",
    cordmuffinupdater: "CordmuffinUpdater",
};
const prettyName = (name: string) => pluginNames[name.toLowerCase()] ?? name;

const EQUICORD_EVERY: Record<string, number> = { daily: 24 * 60 * 60_000, weekly: 7 * 24 * 60 * 60_000 };

// When Equicord's own changes may go in by themselves. Equicord changes several times a day, so by default they
// wait until the last build is a day old; plugin and installer fixes always go out right away and take the
// newest Equicord along. A check started with "Check now" offers everything.
function equicordDueAt(r: CheckResult) {
    const mode = settings.store.equicordUpdates;
    if (mode === "always") return 0;
    if (mode === "withPlugins") return Infinity;
    const built = Date.parse(r.builtAt ?? "");
    return Number.isNaN(built) ? 0 : built + (EQUICORD_EVERY[mode] ?? EQUICORD_EVERY.daily);
}

function describe(r: CheckResult, auto: boolean) {
    const fixes = [
        ...(r.changedPlugins ?? []).map(prettyName),
        ...(r.changedMuffinshelf ?? []),
        ...(r.installer ? [`the installer (v${r.installer})`] : []),
    ];
    const dueAt = equicordDueAt(r);
    const equicordNow = !!r.equicordOutdated && (!auto || fixes.length > 0 || Date.now() >= dueAt);
    return {
        what: equicordNow ? ["Equicord", ...fixes] : fixes,
        heldBack: r.equicordOutdated && !equicordNow ? dueAt : 0,
    };
}

function heldBackLine(dueAt: number) {
    if (dueAt === Infinity) return "Equicord has newer changes; they're added together with the next plugin update.";
    return `Equicord has newer changes; they're added after ${new Date(dueAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}.`;
}

const equicordOptions = [
    { label: "Once a day", value: "daily", default: true },
    { label: "Once a week", value: "weekly" },
    { label: "Whenever Equicord changes (can mean a restart several times a day)", value: "always" },
    { label: "Only together with a plugin update", value: "withPlugins" },
];

// Shown on the Cordmuffin Updater page in Equicord's settings, not in the plugin list.
const settings = definePluginSettings({
    checkForUpdates: {
        type: OptionType.BOOLEAN,
        description: "Look for updates when Discord starts and every 6 hours.",
        default: true,
        hidden: true,
        onChange: (v: boolean) => v ? schedule() : unschedule(),
    },
    autoUpdate: {
        type: OptionType.BOOLEAN,
        description: "Install updates by themselves in the background.",
        default: true,
        hidden: true,
    },
    equicordUpdates: {
        type: OptionType.SELECT,
        description: "How often Equicord's own changes are installed.",
        options: equicordOptions,
        hidden: true,
    },
    muffinshelfUpdates: {
        type: OptionType.BOOLEAN,
        description: "Also update plugins installed with Muffinshelf.",
        default: true,
        hidden: true,
    },
});

async function checkNow(auto: boolean) {
    if (status.phase === "checking" || status.phase === "updating") return;
    setStatus({ phase: "checking", message: "" });
    let r: CheckResult;
    try {
        r = await Native.check(settings.store.muffinshelfUpdates);
    } catch (e) {
        r = { supported: true, error: String(e) };
    }
    if (!r.supported) {
        setStatus({ phase: "unsupported", message: r.reason ?? "", info: r });
        return;
    }
    setStatus({ info: r, checkedAt: Date.now() });
    if (r.error) {
        logger.warn("Update check failed:", r.error);
        setStatus({ phase: "error", message: r.error });
        return;
    }

    const { what, heldBack } = describe(r, auto);
    if (!what.length) {
        if (restartPending) setStatus({ phase: "updated" });
        else setStatus({ phase: "upToDate", what: [], message: heldBack ? heldBackLine(heldBack) : "" });
        return;
    }
    setStatus({ phase: "available", what });
    if (settings.store.autoUpdate) {
        await updateNow(auto);
    } else if (auto && notice === undefined) {
        notice = `A Cordmuffin update is ready: ${joinNames(what)}.`;
        showNotice(notice, "Update now", () => updateNow(false));
    }
}

// Discord's notice bar doesn't close by itself when its button is clicked.
function closeNotice() {
    if (notice === undefined) return;
    if (currentNotice?.[1] === notice) popNotice();
    else {
        const i = noticesQueue.findIndex(n => n[1] === notice);
        if (i !== -1) noticesQueue.splice(i, 1);
    }
    notice = undefined;
}

async function updateNow(auto: boolean) {
    if (status.phase === "updating") return;
    closeNotice();
    setStatus({ phase: "updating", message: "" });
    let r: UpdateResult;
    try {
        r = await Native.runUpdate(settings.store.muffinshelfUpdates);
    } catch (e) {
        r = { ok: false, error: String(e) };
    }
    Native.getInfo().then(info => setStatus({ info })).catch(() => { });

    if (!r.ok) {
        logger.error("Update failed:", r.error);
        setStatus({ phase: "error", message: r.error ?? "The update failed." });
        if (!auto || !failureShown) {
            failureShown = true;
            showNotification({
                title: "Cordmuffin couldn't update",
                body: `${r.error ?? "Something went wrong."}${r.partial ? "" : " Nothing was changed."} Click for details.`,
                onClick: openSettings,
            });
        }
        return;
    }
    if (r.upToDate) {
        setStatus(restartPending ? { phase: "updated", checkedAt: Date.now() } : { phase: "upToDate", what: [], checkedAt: Date.now() });
        return;
    }

    const what = r.updated?.length ? r.updated.map(prettyName) : status.what;
    const skipped = r.skipped?.length ? ` ${joinNames(r.skipped)} stayed on the old version, because the new one doesn't build.` : "";
    if (!r.needsRestart) {
        setStatus({ phase: "upToDate", what: [], checkedAt: Date.now() });
        showNotification({ title: "Cordmuffin updated", body: `Updated ${joinNames(what)}. Nothing else to do.`, onClick: openSettings });
        return;
    }
    restartPending = true;
    setStatus({ phase: "updated", what, checkedAt: Date.now(), message: skipped.trim() });
    showNotification({
        title: "Cordmuffin updated",
        body: `Updated ${joinNames(what)}.${skipped} Click here to restart Discord and use the new version, or it's used the next time Discord starts.`,
        onClick: relaunch,
    });
}

function openSettings() {
    SettingsRouter.openUserSettings(`${PAGE_KEY}_panel`);
}

function schedule() {
    unschedule();
    // Settings change handlers also run while the plugin is turned off.
    if (!started || !settings.store.checkForUpdates) return;
    firstTimer = setTimeout(() => checkNow(true), FIRST_CHECK_MS);
    // While a finished update waits for a restart, there's nothing more to fetch.
    interval = setInterval(() => !restartPending && checkNow(true), CHECK_EVERY_MS);
}

function unschedule() {
    clearTimeout(firstTimer);
    clearInterval(interval);
    firstTimer = interval = undefined;
}

function ago(time: number) {
    const minutes = Math.round((Date.now() - time) / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    const hours = Math.round(minutes / 60);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

function statusLine(s: Status) {
    switch (s.phase) {
        case "idle": return "Hasn't checked yet. The first check runs shortly after Discord starts.";
        case "checking": return "Checking for updates...";
        case "upToDate": return s.message ? `Everything else is up to date. ${s.message}` : "Everything is up to date.";
        case "available": return `Update ready: ${joinNames(s.what)}.`;
        case "updating": return `Updating${s.what.length ? ` ${joinNames(s.what)}` : ""}. This takes a minute or two and Discord keeps working meanwhile.`;
        case "updated": return `Updated ${joinNames(s.what)}. Restart Discord to use the new version.${s.message ? ` ${s.message}` : ""}`;
        case "error": return `The last check or update didn't work: ${s.message}`;
        case "unsupported": return s.message;
    }
}

const SETTING_KEYS = ["checkForUpdates", "autoUpdate", "equicordUpdates", "muffinshelfUpdates"] as const;

function UpdaterPage() {
    const [, tick] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
        listeners.add(tick);
        const id = setInterval(tick, 30_000);
        if (!status.info) Native.getInfo().then(info => setStatus({ info })).catch(() => { });
        return () => {
            listeners.delete(tick);
            clearInterval(id);
        };
    }, []);
    const prefs = settings.use([...SETTING_KEYS]);

    const s = status;
    const busy = s.phase === "checking" || s.phase === "updating";
    const info = s.info?.supported ? s.info : null;
    const variant = s.phase === "error" ? "warning" : s.phase === "updated" ? "success" : "primary";

    return (
        <SettingsTab>
            <Heading className={Margins.top16}>Update Preferences</Heading>
            <Paragraph className={Margins.bottom20}>
                Keeps cordmuffin's plugins, your Muffinshelf plugins and the Cordmuffin installer up to date. Equicord's own
                updater is switched off in Cordmuffin builds, because it would swap in the official Equicord and drop these
                plugins, so Equicord is updated from here as well.
            </Paragraph>

            <div className="vc-settings-switches">
                <FormSwitch
                    title="Check for updates"
                    description="Look for new versions when Discord starts and every 6 hours. Turn this off to stop all Cordmuffin updates; Check now below still works."
                    value={prefs.checkForUpdates}
                    onChange={(v: boolean) => prefs.checkForUpdates = v}
                    hideBorder
                />
                <FormSwitch
                    title="Automatically update"
                    description="Install updates by themselves in the background while Discord keeps running. When off, you get an Update now button instead. Restart Discord to use the new version."
                    value={prefs.autoUpdate}
                    onChange={(v: boolean) => prefs.autoUpdate = v}
                    disabled={!prefs.checkForUpdates}
                    hideBorder
                />
                <FormSwitch
                    title="Update Muffinshelf plugins"
                    description="Also update the plugins you installed with Muffinshelf, from the GitHub repos they came from."
                    value={prefs.muffinshelfUpdates}
                    onChange={(v: boolean) => prefs.muffinshelfUpdates = v}
                    hideBorder
                />
            </div>

            <Heading className={Margins.top20}>Equicord updates</Heading>
            <Paragraph className={Margins.bottom8}>
                Equicord changes several times a day, so its own changes wait as long as you pick here. Plugin and installer
                fixes always go out right away and take the newest Equicord along.
            </Paragraph>
            <Select
                options={equicordOptions}
                closeOnSelect
                select={(v: string) => prefs.equicordUpdates = v}
                isSelected={(v: string) => v === prefs.equicordUpdates}
                serialize={(v: string) => v}
            />

            <Divider className={Margins.top20} />

            <Heading className={Margins.top20}>Updates</Heading>
            <Card variant={variant} className={Margins.top8} defaultPadding>
                <Paragraph>{statusLine(s)}</Paragraph>
                {s.checkedAt > 0 && <Paragraph color="text-subtle">Last checked {ago(s.checkedAt)}.</Paragraph>}
                {s.phase !== "unsupported" && (
                    <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                        {s.phase === "updated" || restartPending
                            ? <Button size="small" onClick={relaunch}>Restart Discord</Button>
                            : s.phase === "available"
                                ? <Button size="small" disabled={busy} onClick={() => updateNow(false)}>Update now</Button>
                                : null}
                        <Button size="small" variant="secondary" disabled={busy} onClick={() => checkNow(false)}>
                            {s.phase === "checking" ? "Checking..." : "Check now"}
                        </Button>
                    </div>
                )}
            </Card>
            {info && (
                <Card className={Margins.top8} defaultPadding>
                    <HeadingTertiary>What's installed</HeadingTertiary>
                    <Paragraph>Installer v{info.version || "unknown"}, Equicord {info.equicord?.slice(0, 7) || "unknown"}{info.cordmuffin ? `, cordmuffin ${info.cordmuffin.slice(0, 7)}` : ""}.</Paragraph>
                    <Paragraph>Kept up to date: {joinNames(["Equicord", ...(info.plugins ?? []).map(prettyName), ...(prefs.muffinshelfUpdates ? info.muffinshelf ?? [] : [])])}.</Paragraph>
                </Card>
            )}

            <Divider className={Margins.top20} />

            <Heading className={Margins.top20}>How it works</Heading>
            <Paragraph className={Margins.bottom8}>
                Plugins are built into Equicord, so an update rebuilds it in the background with the Cordmuffin installer, the
                same way Equicord updates a copy built from its own source. Discord keeps running, and the new version is used
                from the next start.
            </Paragraph>
            <Paragraph className={Margins.bottom8}>
                Your other plugins, themes and settings stay as they are. Before a plugin is replaced, its old copy is saved in
                %LOCALAPPDATA%\Cordmuffin\plugin-backups. If a Muffinshelf plugin's new version doesn't build, it stays on
                the old one and everything else still updates. If something goes wrong nothing is changed, and the details
                are in %LOCALAPPDATA%\Cordmuffin\update.log.
            </Paragraph>
            <Paragraph color="text-subtle">
                It talks to GitHub (api.github.com, codeload.github.com, and github.com for new installer releases),
                including the repos your Muffinshelf plugins came from, plus nodejs.org and registry.npmjs.org while it
                builds.
            </Paragraph>
        </SettingsTab>
    );
}

export default definePlugin({
    name: "CordmuffinUpdater",
    description: "Keeps Cordmuffin up to date: checks for new versions of Equicord, cordmuffin's plugins, your Muffinshelf plugins and the installer, and installs them in the background.",
    authors: [{ name: "nolifepops", id: 221807880053981184n }],
    // Always on and kept out of the plugin list; its switches live on the Cordmuffin Updater settings page.
    required: true,
    hidden: true,
    settings,
    checkNow: () => checkNow(false),
    updateNow: () => updateNow(false),
    getStatus: () => status,
    openSettings,

    start() {
        started = true;
        SettingsPlugin.customEntries.push({
            key: PAGE_KEY,
            title: "Cordmuffin Updater",
            Component: wrapTab(UpdaterPage, "Cordmuffin Updater"),
            Icon: UpdaterIcon,
        });
        schedule();
    },

    stop() {
        started = false;
        removeFromArray(SettingsPlugin.customEntries, e => e.key === PAGE_KEY);
        unschedule();
        closeNotice();
    },
});
