/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import { relaunch } from "@utils/native";
import { Alerts, useEffect, useState, useStateFromStores } from "@webpack/common";

import { formatTime, useStreamStatus } from "./CallWidget";
import { useProfile } from "./profile";
import { allowSecondTracking, useSecondStatus } from "./secondAccount";
import { nextReportMs } from "./stream";
import { toast } from "./toast";
import { allowTracking, ConsentStore, hasConsentStore, loadConsents, refreshStreamingBadge, reportMissing, reportsGetThrough, streamingBadgeLabel, streamingBadgeMissing, streamingBadgeUnreadable, type TrackingState, trackingState } from "./tracking";

const cl = classNameFactory("vc-stf-");

const NO_TRACK = "Equicord's NoTrack plugin";
const USAGE_SWITCH = "Discord settings → Data & Privacy: “Use data to improve Discord”";
const PERSONALIZE_SWITCH = "Discord settings → Data & Privacy: “Use data to personalize my Discord experience”";
// The same, short enough for the corner widget.
const NO_TRACK_SHORT = "NoTrack";
const USAGE_SHORT = "“Use data to improve Discord”";
const PERSONALIZE_SHORT = "“Use data to personalize”";

// Unknown stays unknown instead of looking fine, and only counts as a problem once it has had time to load.
type ItemState = "ok" | "bad" | "unknown";
// `text`/`shortText` replace the generic wording for a row that needs its own (NoTrack's two switches); `change` is
// what the confirm dialog lists for it.
interface TrackingItem { what: string; short: string; who: "this account" | "second account"; want: "OFF" | "ON"; state: ItemState; restart?: boolean; maybe?: boolean; text?: string; shortText?: string; change?: string; }

const UNKNOWN_AFTER_MS = 60_000;
const startedAt = Date.now();
const whoShort = (i: TrackingItem) => i.who === "this account" ? "you" : "second account";

function itemText(i: TrackingItem) {
    if (i.text) return `${i.text} (${i.who})`;
    if (i.restart) return `${i.what} is OFF, but keeps blocking until ${i.who === "this account" ? "Discord restarts" : "its Discord reloads"} (${i.who})`;
    if (i.state === "unknown") return `${i.what}: couldn't check yet (${i.who})`;
    if (i.maybe) return `${i.what}: ${i.want} is recommended (${i.who})`;
    return `${i.what} must be ${i.want} (${i.who})`;
}

function shortText(i: TrackingItem) {
    if (i.shortText) return `${i.shortText} (${whoShort(i)})`;
    if (i.restart) return `${i.short} is OFF, restart needed (${whoShort(i)})`;
    if (i.state === "unknown") return `${i.short}: couldn't check yet (${whoShort(i)})`;
    return `${i.short} \u2192 ${i.want} (${whoShort(i)})`;
}

const missingReportNote = (who: string) => `Discord didn't get the last stream time from ${who}. An ad blocker may be blocking it, unless Go Live just failed.`;

// NoTrack blocks stream reports while "Disable Analytics" is on and "Allow Badge Tracking" is off (or missing, in a
// NoTrack without it). Its wording says which switch is in the way and which one the fix flips.
function noTrackItem(who: TrackingItem["who"], t: TrackingState, sends: boolean, maybe: boolean): TrackingItem {
    const badge = t.badgeSwitch === true;
    const base = { what: NO_TRACK, short: NO_TRACK_SHORT, who, want: badge ? "ON" : "OFF", maybe } as const;
    const restartWhen = who === "this account" ? "Discord restarts" : "its Discord reloads";
    if (sends || !t.blocked && !t.blockedAtStart)
        return { ...base, state: "ok", text: `${NO_TRACK} lets stream reports through`, shortText: "NoTrack lets reports through" };
    if (!t.blocked)
        return { ...base, state: "bad", restart: true, text: `${NO_TRACK} is set right now, but keeps blocking stream reports until ${restartWhen}`, shortText: "NoTrack: restart needed" };
    const change = badge ? "NoTrack's “Allow Badge Tracking” → ON" : "NoTrack's “Disable Analytics” → OFF";
    return badge
        ? { ...base, state: "bad", change, text: `${NO_TRACK} blocks stream reports: “Disable Analytics” is on and “Allow Badge Tracking” is off. Turning “Allow Badge Tracking” on is enough and keeps the rest blocked`, shortText: "NoTrack: badge tracking → ON" }
        : { ...base, state: "bad", change, text: `${NO_TRACK} blocks stream reports: its “Disable Analytics” must be OFF`, shortText: "NoTrack: analytics block → OFF" };
}

const consentItem = (what: string, short: string, who: TrackingItem["who"], on: boolean | null, maybe: boolean): TrackingItem => ({
    what, short, who, want: "ON", state: on === null ? "unknown" : on ? "ok" : "bad", maybe
});

// What has to be set for the Streaming badge to count, for both accounts. Each account's own Equicord and privacy
// settings are read (the second account's only while it's running), so the list is always what's really set.
function useTracking() {
    useSettings(["plugins.NoTrack.disableAnalytics", "plugins.NoTrack.allowBadgeTracking", "plugins.Muffinshelf.bdEnabled"]);
    useStateFromStores(hasConsentStore() ? [ConsentStore] : [], () => hasConsentStore() ? ConsentStore.consents : null);
    useEffect(() => void loadConsents(), []);
    // Unknown settings and lost reports change with time, with nothing to announce it.
    const [, setTick] = useState(0);
    useEffect(() => {
        const timer = setInterval(() => setTick(n => n + 1), 30_000);
        return () => clearInterval(timer);
    }, []);
    const second = useSecondStatus();
    const mine = trackingState();
    const ready = second.phase === "ready";
    const theirs = ready ? second.tracking : undefined;

    // Reports this account and the second one are known to be getting through; see reportsGetThrough.
    const mineSends = reportsGetThrough(mine);
    const theirsSends = !!theirs && reportsGetThrough(theirs);

    const items: TrackingItem[] = [
        noTrackItem("this account", mine, mineSends, false),
        consentItem(USAGE_SWITCH, USAGE_SHORT, "this account", mine.usageData, true),
        consentItem(PERSONALIZE_SWITCH, PERSONALIZE_SHORT, "this account", mine.personalized, false)
    ];
    if (theirs) {
        items.push(
            noTrackItem("second account", theirs, theirsSends, true),
            consentItem(USAGE_SWITCH, USAGE_SHORT, "second account", theirs.usageData, true),
            consentItem(PERSONALIZE_SWITCH, PERSONALIZE_SHORT, "second account", theirs.personalized ?? null, true)
        );
    }

    // Problems the button can't change: these are only pointed out.
    const notes: string[] = [];
    if (ready && !theirs) notes.push("Your second account's window didn't answer the check. Hang up and call again so it loads afresh.");
    if (!mineSends) for (const name of mine.blockers) notes.push(`${name} may block the reports on your account. Turn it off in your plugins.`);
    if (!theirsSends) for (const name of theirs?.blockers ?? []) notes.push(`${name} may block the reports on your second account. Turn it off in its plugins.`);
    if (reportMissing(mine)) notes.push(missingReportNote("your account"));
    if (theirs && reportMissing(theirs, true)) notes.push(missingReportNote("your second account"));

    // The second account's page starts fresh with each call, so its settings get their own time to load.
    const settled = (i: TrackingItem) => Date.now() - ((i.who === "this account" ? mine.loadedAt : theirs?.loadedAt) ?? startedAt) >= UNKNOWN_AFTER_MS;
    const allOk = items.every(i => i.state === "ok" || i.state === "unknown" && !settled(i));
    // Everything's set, but NoTrack was blocking when Discord started and keeps blocking until it restarts.
    const restartOnly = mine.blockedAtStart && !mine.blocked && notes.length === 0 && items.every(i => i.restart && i.who === "this account" || i.state === "ok");
    const problem = !allOk || notes.length > 0;
    // "blocked" stops the badge counting; "maybe" is only recommended or couldn't be checked.
    const level: TrackingLevel = !problem ? "none" : items.some(i => i.state === "bad" && !i.maybe) || notes.length ? "blocked" : "maybe";
    return { items, theirs, restartOnly, notes, restartNeeded: mine.blockedAtStart, problem, level };
}

// How badly the Streaming badge is held back, for a quick sign where the full list doesn't fit.
export type TrackingLevel = "none" | "maybe" | "blocked";
export const useTrackingLevel = () => useTracking().level;

function askRestart(secondDone: boolean) {
    Alerts.show({
        title: "Restart Discord now?",
        body: secondDone
            ? "Everything's changed. NoTrack only stops blocking after a restart. The farm picks up again by itself afterwards."
            : "Your account is changed, but your second account couldn't be reached and still needs fixing. NoTrack only stops blocking after a restart. Afterwards, press Fix again once your second account is back in a call.",
        confirmText: "Restart now",
        cancelText: "Later",
        onConfirm: relaunch
    });
}

// The checklist in red and green with a button that fixes it after asking, in the settings and (compact) in the corner
// widget. Hidden once everything is right.
function TrackingWarningBody({ compact = false }: { compact?: boolean; }) {
    const { items, theirs, restartOnly, notes, restartNeeded, problem, level } = useTracking();
    const { hostSecond } = useProfile();
    const [busy, setBusy] = useState(false);
    if (!problem) return null;
    const bad = items.filter(i => i.state !== "ok");
    const changes = bad.filter(i => !i.restart);
    const secondReloads = bad.some(i => i.who === "second account" && i.what === NO_TRACK);
    const noTrackChanges = changes.filter(i => i.what === NO_TRACK);
    // Each account's own NoTrack decides which switch its fix flips.
    const badgeFix = noTrackChanges.length > 0 && noTrackChanges.every(i => i.want === "ON");

    const fix = async () => {
        setBusy(true);
        try {
            const { restart } = await allowTracking();
            const secondDone = bad.some(i => i.who === "second account") ? await allowSecondTracking() : true;
            if (!secondDone) toast({ text: "Your second account wasn't reachable. Press Fix again while it's in a call.", variant: "critical" });
            if (restart) askRestart(secondDone);
            else if (secondDone) toast({ text: "Done. Your Streaming badge counts from your next stream on.", variant: "success" });
        } catch (e: any) {
            toast({ text: `Couldn't change it: ${e?.body?.message ?? e?.message ?? "unknown error"}`, variant: "critical" });
        } finally {
            setBusy(false);
        }
    };

    const confirm = () => Alerts.show({
        title: "Let your Streaming badge count?",
        body: (
            <div className={cl("login-warning")}>
                {changes.length > 0 && (
                    <>
                        <Paragraph>This changes:</Paragraph>
                        <ul className={cl("tracking-changes")}>
                            {changes.map(i => <li key={itemText(i)}>{i.change ?? `${i.what} → ${i.want}`} ({i.who})</li>)}
                        </ul>
                    </>
                )}
                <Paragraph>
                    Discord only counts streaming time from a report your Discord sends when a stream ends, and Discord says
                    the personalize setting has to be on.
                    {noTrackChanges.length > 0 && (badgeFix
                        ? " NoTrack blocks that report unless its “Allow Badge Tracking” is on. With it on, only the reports badges need go out and the rest of Discord's tracking stays blocked."
                        : " NoTrack blocks that report while its “Disable Analytics” is on. After this, Discord gets your normal usage reports again. They can show that you use a modded Discord.")}
                </Paragraph>
                {restartNeeded && <Paragraph>Discord has to restart afterwards for NoTrack's change to apply.</Paragraph>}
                {secondReloads && (
                    <Paragraph>Your second account's hidden Discord reloads to apply it and rejoins the call by itself.</Paragraph>
                )}
                <Paragraph>Time streamed while NoTrack was blocking never reached Discord, so it can't be added back. Whether time streamed with the privacy settings off counts later isn't known.</Paragraph>
            </div>
        ),
        confirmText: changes.length ? "Change them" : secondReloads ? "Reload second account" : "Continue",
        cancelText: "Cancel",
        onConfirm: () => void fix()
    });

    return (
        <div className={cl("tracking", compact && "tracking-compact")}>
            <div className={cl("tracking-title")}>
                {restartOnly
                    ? compact ? "Restart Discord so your badge counts" : "Restart Discord so your Streaming badge counts"
                    : level === "blocked"
                        ? compact ? "Your Streaming badge won't count" : "Your Streaming badge won't count with these settings"
                        : compact ? "Your Streaming badge may not count" : "These settings may affect your Streaming badge"}
            </div>
            {restartOnly
                ? <div>NoTrack is set to let stream reports through, but that only applies once Discord restarts.</div>
                : (
                    <ul className={cl("tracking-list")}>
                        {items.map(i => (
                            <li key={itemText(i)} className={cl(i.state === "ok" ? "tracking-ok" : i.state === "bad" ? "tracking-bad" : "tracking-unknown")}>
                                {i.state === "ok" ? "✔" : i.state === "bad" ? "✖" : "?"} {compact ? shortText(i) : itemText(i)}
                            </li>
                        ))}
                        {notes.map(note => <li key={note} className={cl("tracking-bad")}>✖ {note}</li>)}
                    </ul>
                )}
            {!restartOnly && hostSecond && !theirs && (
                <div className={cl("stream-note")}>Your second account's settings are checked while it's in a call.</div>
            )}
            <div className={cl("stream-row")}>
                {restartOnly
                    ? <Button size="small" onClick={relaunch}>Restart Discord</Button>
                    : bad.length > 0 && <Button size="small" onClick={confirm} disabled={busy}>{busy ? "Changing..." : "Fix these for me"}</Button>}
            </div>
        </div>
    );
}

export const TrackingWarning = ErrorBoundary.wrap(TrackingWarningBody, { noop: true });

// When Discord last got a report, when the next one goes out, and Discord's own count, so all of it can be seen working.
export function ReportStatus() {
    const status = useStreamStatus();
    const { lastReportAt } = useProfile();
    const [, setTick] = useState(0);
    useEffect(() => {
        const update = () => void refreshStreamingBadge().then(() => setTick(n => n + 1));
        update();
        const timer = setInterval(update, 60_000);
        return () => clearInterval(timer);
    }, []);
    const label = streamingBadgeLabel();
    const next = nextReportMs();
    return (
        <div className={cl("stream-time")}>
            {lastReportAt > 0 && <div>Last report Discord accepted: {Date.now() - lastReportAt < 60_000 ? "just now" : `${formatTime(Date.now() - lastReportAt)} ago`}</div>}
            {status.phase === "counting" && <div>{next == null ? "Next report: when the stream ends" : next < 60_000 ? "Next report: in under a minute" : `Next report: in ${formatTime(next)}`}</div>}
            {label && <div>Discord's count: {label} (Discord updates this on its own schedule, and it can go up or down)</div>}
            {streamingBadgeUnreadable() && <div>Couldn't read Discord's count right now.</div>}
            {streamingBadgeMissing() && <div>Discord lists no Streaming badge on this account yet, so it may not have this feature.</div>}
        </div>
    );
}
