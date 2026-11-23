/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isPluginEnabled } from "@api/PluginManager";
import { Settings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Paragraph } from "@components/Paragraph";
import { gitHashShort } from "@shared/vencordUserAgent";
import { copyToClipboard } from "@utils/clipboard";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, RestAPI, useEffect, useState } from "@webpack/common";

import { settings } from ".";
import { BadgeKind, BadgeProgress, loadBadges, savedPending, tierFor } from "./badges";
import { analyticsBlocked, trackingBlockers } from "./conflicts";
import { notify } from "./notify";
import { RunEntry, savedRuns, TestPart } from "./runLog";
import { clientInfo } from "./science";

const cl = classNameFactory("vc-gts-");
const logger = new Logger("GameTimeSpoof");

type Badges = Partial<Record<BadgeKind, BadgeProgress>>;

const HOUR_MS = 3_600_000;
// Discord's badge update runs once a day; past this a session that still hasn't counted won't.
const SETTLED_AFTER_MS = 48 * HOUR_MS;
// More unexplained hours than this means real play or other runs mixed into the result.
const NOISE_HOURS = 3;

const utc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const onOff = (v: unknown) => v == null ? "unknown" : v ? "on" : "off";
const ago = (ms: number) => {
    const h = Math.floor(ms / HOUR_MS);
    return h < 1 ? "under an hour ago" : h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} days ago`;
};

export function partLabel(p: TestPart) {
    return `${p.hours} h ${p.endsHoursAgo ? `ending ${p.endsHoursAgo} h in the past` : "ending now"}`;
}

async function loadConsents(): Promise<Record<string, boolean> | null> {
    try {
        const { body } = await RestAPI.get({ url: "/users/@me/consent" });
        return Object.fromEntries(Object.entries(body ?? {}).map(([k, v]: [string, any]) => [k, v?.consented === true]));
    } catch {
        return null;
    }
}

function badgeLine(name: string, unit: string, b: BadgeProgress | undefined) {
    if (!b) return `${name}: not on this account or couldn't read`;
    const { tier, next } = tierFor(b, b.current);
    return `${name}: ${b.current} ${unit} (${tier?.name ?? "no rank yet"}${next ? `, next ${next.name} at ${next.threshold}` : ", top rank"})`;
}

function runLine(r: RunEntry) {
    const what = r.kind === "test" ? "Session test" : "Add Time";
    const sent = r.sent === r.sessions ? `${r.sent} sessions` : `${r.sent}/${r.sessions} sessions`;
    const status = r.status + (r.httpStatus ? ` (HTTP ${r.httpStatus})` : "");
    const base = (r.baseHours == null && r.baseGames == null ? "badges unknown" : `badges then ${r.baseHours ?? "?"} h / ${r.baseGames ?? "?"} games`)
        + (r.waitingHours ? `, ${r.waitingHours} h still waiting` : "")
        + (r.spoofing ? ", spoofing on" : "");
    const fresh = r.newGames == null ? "" : `, ${r.newGames} unplayed`;
    return `- ${utc(r.at)} · ${what} · ${r.games} games${fresh} · ${r.hours} h in ${sent} · longest ${r.longestHours} h · ${r.backdated} dated in the past · ${status} · ${base}`;
}

// Each test session has a different length and every combination adds up to a different total,
// so the rise in badge hours shows exactly which ones Discord counted.
export function decodeTest(test: RunEntry, runs: RunEntry[], badges: Badges, now: number) {
    const parts = test.parts ?? [];
    const lines = [`Session test from ${utc(test.at)} (${ago(now - test.at)}): ${parts.map(partLabel).join(", ")}.`];
    if (test.status !== "done" || test.sent < parts.length) {
        lines.push(`It didn't finish sending (${test.status}), so it can't be read. Run it again.`);
        return lines;
    }
    const hoursNow = badges.time?.current;
    if (test.baseHours == null || hoursNow == null) {
        lines.push("Game Time hours couldn't be read, so the result can't be worked out.");
        return lines;
    }
    const later = runs.filter(r => r !== test && r.at > test.at && r.sent > 0);
    const rise = hoursNow - test.baseHours;
    const gamesRise = test.baseGames != null && badges.variety ? badges.variety.current - test.baseGames : null;
    lines.push(`Game Time went from ${test.baseHours} to ${hoursNow} h (+${rise}).${gamesRise == null ? "" : ` Game Variety went up by ${gamesRise}.`}`);

    const settled = now - test.at >= SETTLED_AFTER_MS;
    if (test.waitingHours) lines.push(`${test.waitingHours} h from earlier Add Time runs were still waiting when the test ran. If they landed since, they're mixed into this rise.`);
    if (test.spoofing) lines.push("Spoofing or real-game reporting was on during the test, so those hours can mix into this rise too.");
    if (rise <= 0 && !settled) {
        lines.push("Nothing counted yet. Discord updates badges once a day, so copy a new report after its next update (give it up to 2 days).");
        return lines;
    }

    let best = 0;
    let bestSum = 0;
    for (let mask = 1; mask < 1 << parts.length; mask++) {
        const sum = parts.reduce((s, p, i) => mask & 1 << i ? s + p.hours : s, 0);
        // One hour of slack covers Discord rounding the total down.
        if (sum <= rise + 1 && sum > bestSum) {
            best = mask;
            bestSum = sum;
        }
    }
    const counted = parts.filter((_, i) => best & 1 << i);
    const missed = parts.filter((_, i) => !(best & 1 << i));
    // Before Discord's update has surely run, a small rise can be unrelated play that happens to look like a session.
    const [yes, no] = settled ? ["COUNTED ", "MISSING "] : ["LIKELY  ", "NOT YET "];
    for (const [i, p] of parts.entries()) lines.push(`  ${best & 1 << i ? yes : no} ${partLabel(p)}`);

    const extra = rise - bestSum;
    if (extra >= NOISE_HOURS) lines.push(`${extra} more hours than the test explains came in too (real play or other runs), so treat this as a best guess.`);
    if (later.length) lines.push(`${later.length} more run${later.length === 1 ? "" : "s"} went out after the test, so ${later.length === 1 ? "its" : "their"} hours may be mixed in.`);
    const longestNow = Math.max(0, ...counted.filter(c => !c.endsHoursAgo).map(c => c.hours));

    if (!missed.length) lines.push("Result: every test session counted, so long and past-dated sessions both work right now.");
    else if (!settled) lines.push(`Result so far: +${rise} h is closest to ${counted.length ? counted.map(partLabel).join(" and ") : "none of the sessions"}, but Discord may not have counted the test yet and other play can look like a match. Copy a new report after ${utc(test.at + SETTLED_AFTER_MS)} for a real answer.`);
    else if (!counted.length) lines.push(`Result: none of the test hours counted${gamesRise ? " even though the games did" : ""}. Discord is dropping the hours of added sessions.`);
    else if (missed.some(p => !p.endsHoursAgo && p.hours <= longestNow)) lines.push(`Result: ${missed.map(partLabel).join(" and ")} didn't count while a longer session ending now did. That doesn't fit any pattern, so it's probably other play mixed in. Run the test again.`);
    else {
        const longMissed = missed.some(p => !p.endsHoursAgo && p.hours > longestNow);
        const pastMissed = missed.some(p => p.endsHoursAgo > 0) && counted.some(p => !p.endsHoursAgo);
        const causes = [longMissed && "sessions that are too long", pastMissed && "sessions dated in the past"].filter(Boolean);
        lines.push(`Result: ${missed.map(partLabel).join(" and ")} didn't count${causes.length ? `, so Discord looks to be ignoring ${causes.join(" and ")}` : ""}.`);
    }
    return lines;
}

export async function buildReport() {
    const now = Date.now();
    const [badges, consents] = await Promise.all([
        loadBadges().catch(e => {
            logger.warn("Couldn't read badges for the report", e);
            return null;
        }),
        loadConsents()
    ]);
    const client = (() => {
        try {
            return clientInfo();
        } catch {
            return null;
        }
    })();
    const noTrack = Settings.plugins.NoTrack;
    const blockers = (() => {
        try {
            return trackingBlockers();
        } catch {
            return null;
        }
    })();
    const { games, rotation, rotateMinutes, reportRealGames, updateClock } = settings.store;
    const runs = savedRuns();
    const pending = savedPending();

    const lines = [
        `GameTimeSpoof report, ${utc(now)}`,
        `Equicord ${gitHashShort} · Discord ${client?.channel ?? "?"} build ${client?.build ?? "?"} · ${client?.os ?? "?"} ${client?.osVersion ?? ""}`.trimEnd(),
        "",
        "Settings",
        `- Spoofing ${games.split(",").filter(s => s.trim()).length} game(s), rotation ${rotation} every ${rotateMinutes} min, report real games ${onOff(reportRealGames)}`,
        `- Discord "Use data to personalize": ${onOff(consents?.personalization)} · "Use data to improve Discord": ${onOff(consents?.usage_statistics)}`,
        `- NoTrack: ${isPluginEnabled("NoTrack") ? "enabled" : "disabled"}, disable analytics ${onOff(noTrack?.disableAnalytics)}, allow badge tracking ${onOff(noTrack?.allowBadgeTracking)} → Discord's own reports ${analyticsBlocked ? "blocked" : "allowed"}`,
        `- Other tracking blockers: ${blockers == null ? "couldn't check" : blockers.length ? blockers.join(", ") : "none found"}`,
        "",
        "Badges",
        ...badges ? [`- ${badgeLine("Game Time", "h", badges.time)}`, `- ${badgeLine("Game Variety", "games", badges.variety)}`] : ["- Couldn't read badges"],
        `- Daily update around ${updateClock ? `${String(Math.floor(updateClock.minuteUtc / 60)).padStart(2, "0")}:${String(updateClock.minuteUtc % 60).padStart(2, "0")} UTC (learned ${utc(updateClock.learnedAt)})` : "unknown (not seen yet)"}`,
        `- Waiting to be counted: ${pending.length ? pending.map(p => `${Math.round(p.hours * 10) / 10} h / ${p.games} games from ${utc(p.at)}`).join("; ") : "nothing"}`,
        "",
        `Runs (newest first, ${runs.length} saved)`,
        ...runs.length ? [...runs].reverse().map(runLine) : ["- None saved yet (runs are only saved from this version on)"]
    ];

    const test = [...runs].reverse().find(r => r.kind === "test");
    lines.push("", "Session length test");
    if (!test) lines.push("- Not run yet. Use Test Session Lengths in the Game Browser, then copy a new report after Discord's next daily update.");
    else lines.push(...badges ? decodeTest(test, runs, badges, now) : ["- Couldn't read badges, so the test can't be checked."]);

    return lines.join("\n");
}

function ReportModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const [text, setText] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        // Closed before the report was ready: don't overwrite whatever the user copied since.
        let closed = false;
        buildReport().then(async t => {
            if (closed) return;
            setText(t);
            try {
                await copyToClipboard("```\n" + t + "\n```");
                notify("Report copied. Paste it to whoever is helping you.", "success");
            } catch (e) {
                logger.warn("Couldn't copy the report", e);
                notify("Couldn't copy the report. Select the text and copy it yourself.", "critical");
            }
        }, e => {
            logger.error("Couldn't build the report", e);
            if (!closed) setFailed(true);
        });
        return () => void (closed = true);
    }, []);

    const copyAgain = () => text && copyToClipboard("```\n" + text + "\n```").then(
        () => notify("Report copied.", "success"),
        () => notify("Couldn't copy the report.", "critical")
    );

    return (
        <Modal
            {...modalProps}
            size="md"
            title="GameTimeSpoof Report"
            subtitle="No token, user ID or username is included."
            actions={[
                { text: "Close", variant: "secondary", onClick: modalProps.onClose },
                { text: "Copy Again", variant: "primary", onClick: copyAgain, disabled: !text }
            ]}
        >
            {failed
                ? <Paragraph>Couldn't build the report. Details are in the console (Ctrl+Shift+I).</Paragraph>
                : text
                    ? <pre className={cl("report")}>{text}</pre>
                    : <Paragraph>Checking your badges and settings...</Paragraph>}
        </Modal>
    );
}

export function openReport() {
    openModal(props => (
        <ErrorBoundary>
            <ReportModal modalProps={props} />
        </ErrorBoundary>
    ));
}
