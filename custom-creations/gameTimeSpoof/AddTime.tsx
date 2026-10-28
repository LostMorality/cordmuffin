/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { FormSwitch } from "@components/FormSwitch";
import { Heading } from "@components/Heading";
import { Notice } from "@components/Notice";
import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, showToast, TextInput, useEffect, useMemo, useRef, useState } from "@webpack/common";

import { DetectableApp, exeName } from ".";
import { BadgeKind, BadgeProgress, formatWhen, getPending, loadBadges, recordCredit, tierFor, UPDATE_WITHIN_MS } from "./badges";
import { CreditError, creditPlaytime, CreditProgress, loadPlayedIds, planCredit } from "./science";

const cl = classNameFactory("vc-gts-");

const UNITS = [["days", 86_400_000, 9999], ["hours", 3_600_000, 9999], ["minutes", 60_000, 9999]] as const;
type Unit = typeof UNITS[number][0];
const MS_PER_REQUEST = 700;
const SESSIONS_PER_REQUEST = 10;
const LONG_RUN_MS = 10 * 60_000;

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

function formatDuration(ms: number) {
    const d = Math.floor(ms / 86_400_000);
    const h = Math.floor(ms % 86_400_000 / 3_600_000);
    const m = Math.floor(ms % 3_600_000 / 60_000);
    const parts = [d && plural(d, "day"), h && plural(h, "hour"), m && plural(m, "minute")].filter(Boolean);
    return parts.length ? parts.join(" ") : "0 minutes";
}

function formatTotal(ms: number) {
    const hours = Math.floor(ms / 3_600_000);
    return ms >= 86_400_000 ? `${formatDuration(ms)} (${plural(hours, "hour")})` : formatDuration(ms);
}

function formatWait(ms: number) {
    const minutes = Math.round(ms / 60_000);
    if (minutes < 1) return "under a minute";
    if (minutes < 60) return `about ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    return `about ${minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`}`;
}

function pickRandom(pool: DetectableApp[], count: number) {
    const picked = [...pool];
    for (let i = picked.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [picked[i], picked[j]] = [picked[j], picked[i]];
    }
    return picked.slice(0, count);
}

const digits = (value: string, max: number) => {
    const n = value.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
    return n && Number(n) > max ? String(max) : n;
};

function progressText({ sent, total, etaMs, waitingMs }: CreditProgress) {
    const count = `Sent ${sent.toLocaleString()} of ${total.toLocaleString()} sessions`;
    if (waitingMs) return `${count}. Discord asked to wait, trying again in ${Math.ceil(waitingMs / 1000)} s...`;
    return etaMs == null ? `${count}...` : `${count}, ${formatWait(etaMs)} left.`;
}

type Badges = Partial<Record<BadgeKind, BadgeProgress>>;

const BADGE_LABELS: Record<BadgeKind, [string, string]> = { time: ["Game Time", "hour"], variety: ["Game Variety", "game"] };

function countedBy(at: number) {
    return `by about ${formatWhen(at + UPDATE_WITHIN_MS)}`;
}

function BadgeLine({ kind, progress, waiting, adding }: { kind: BadgeKind; progress: BadgeProgress; waiting: number; adding: number | null; }) {
    const [label, unit] = BADGE_LABELS[kind];
    const now = tierFor(progress, progress.current);
    const after = progress.current + waiting + (adding ?? 0);
    const then = tierFor(progress, after);
    const parts = [`${now.tier?.name ?? "Not earned yet"}: ${plural(progress.current, unit)}`];
    if (waiting) parts.push(`+${waiting.toLocaleString()} waiting`);
    if (adding) parts.push(`${after.toLocaleString()} after this${then.tier !== now.tier ? ` (ranks up to ${then.tier?.name})` : ""}`);
    parts.push(then.next ? `next: ${then.next.name} at ${then.next.threshold.toLocaleString()}, ${(then.next.threshold - after).toLocaleString()} to go` : "top rank");
    return (
        <div className={cl("badge-line")}>
            <Heading tag="h5">{label}</Heading>
            <Paragraph>{parts.join(" · ")}</Paragraph>
        </div>
    );
}

function AddTime({ modalProps, apps, pool, label }: { modalProps: RenderModalProps; apps: DetectableApp[]; pool?: DetectableApp[]; label: string; }) {
    const [values, setValues] = useState<Record<Unit, string>>(pool ? { days: "", hours: "", minutes: "15" } : { days: "", hours: "1", minutes: "" });
    const [count, setCount] = useState("10");
    const [newOnly, setNewOnly] = useState(true);
    const [played, setPlayed] = useState<Set<string> | null | "failed">(null);
    const [progress, setProgress] = useState<string | null>(null);
    const [badges, setBadges] = useState<Badges | null | "failed">(null);
    const running = useRef(false);
    const abort = useRef(new AbortController());

    useEffect(() => () => abort.current.abort(), []);
    useEffect(() => {
        loadPlayedIds().then(setPlayed, () => setPlayed("failed"));
        loadBadges().then(setBadges, () => setBadges("failed"));
    }, []);

    const available = useMemo(() => {
        if (!pool) return apps;
        return newOnly && played instanceof Set ? pool.filter(a => !played.has(a.id)) : pool;
    }, [pool, apps, newOnly, played]);

    const durationMs = UNITS.reduce((total, [unit, ms]) => total + (Number(values[unit]) || 0) * ms, 0);
    const gameCount = pool ? Math.min(Number(count) || 0, available.length) : apps.length;
    const sessions = gameCount * Math.ceil(durationMs / 86_400_000);
    const estimateMs = Math.ceil(sessions / SESSIONS_PER_REQUEST) * MS_PER_REQUEST;
    const problem = gameCount < 1 ? (pool && !available.length ? "No games left that you haven't played. Turn off the switch above to include them." : "Pick at least one game.")
        : durationMs < 60_000 ? "Add at least 1 minute."
            : null;

    const summary = `${formatDuration(durationMs)} per game × ${plural(gameCount, "game")} = ${formatTotal(durationMs * gameCount)} in total. Takes ${formatWait(estimateMs)}.`
        + (estimateMs > LONG_RUN_MS ? " Keep Discord open until it's done; Stop keeps what's already sent." : "");

    const knownBadges = badges && badges !== "failed" ? badges : null;
    const pending = knownBadges ? getPending(knownBadges) : null;
    const isNew = (app: DetectableApp) => played instanceof Set && !played.has(app.id);
    const newGames = pool ? (newOnly && played instanceof Set ? gameCount : null) : played instanceof Set ? apps.filter(isNew).length : null;
    const addingHours = problem ? null : Math.floor(durationMs * gameCount / 3_600_000);
    const addingGames = problem ? null : newGames;

    async function credit() {
        if (running.current || problem) return;
        running.current = true;
        setProgress("Starting...");
        const targets = pool ? pickRandom(available, gameCount) : apps;
        const plan = planCredit(targets.map(app => ({ id: app.id, name: app.name, processName: exeName(app) })), durationMs);
        const { signal } = abort.current;
        try {
            const sent = await creditPlaytime(plan, signal, p => setProgress(progressText(p)));
            logSent(plan, sent);
            if (signal.aborted) {
                if (sent) showToast({ text: `Stopped. ${sent.toLocaleString()} of ${plan.length.toLocaleString()} sessions were sent and still count.`, variant: "default" });
                return;
            }
            showToast({ text: `Credited ${formatTotal(durationMs * targets.length)} in total across ${plural(targets.length, "game")}. Your badges should update ${countedBy(Date.now())}.`, variant: "success" });
            modalProps.onClose();
        } catch (e) {
            const sent = e instanceof CreditError ? e.sent : 0;
            logSent(plan, sent);
            showToast({
                text: sent
                    ? `Discord stopped accepting play time after ${sent.toLocaleString()} of ${plan.length.toLocaleString()} sessions. The ones sent still count, so don't run the same thing again right away.`
                    : "Discord didn't accept the play time. Try again in a bit.",
                variant: "critical"
            });
            setProgress(null);
        } finally {
            running.current = false;
        }
    }

    function logSent(plan: ReturnType<typeof planCredit>, sent: number) {
        let ms = 0;
        const games = new Set<string>();
        for (let i = 0; i < sent; i++) {
            const session = plan.at(i);
            ms += session.durationMs;
            games.add(session.game.id);
        }
        const fresh = played instanceof Set ? [...games].filter(id => !played.has(id)).length : 0;
        recordCredit(ms / 3_600_000, fresh, knownBadges);
    }

    function stop() {
        abort.current.abort();
        modalProps.onClose();
    }

    const playedNote = played === null ? "Checking which games you've played..."
        : played === "failed" ? "Couldn't load your play history, so any game can be picked."
            : `${available.length.toLocaleString()} games to pick from.`;

    return (
        <Modal
            {...modalProps}
            size="sm"
            title="Add Play Time"
            subtitle={pool ? "Picks random games Discord can detect and adds time to each one." : `Adds time to ${label}${apps.length > 1 ? ` (${apps.length} games)` : ""}.`}
            actions={[
                { text: progress ? "Stop" : "Cancel", variant: "secondary", onClick: progress ? stop : modalProps.onClose },
                { text: "Add Time", variant: "primary", onClick: credit, loading: progress !== null, disabled: !!problem || progress !== null }
            ]}
        >
            <Notice.Warning className={cl("notice")}>
                Badges don't change right away. Discord updates them once a day, so new play time shows up at its next daily update, within about 24 hours.
            </Notice.Warning>
            {badges === null && <Paragraph className={cl("badges")}>Checking your badges...</Paragraph>}
            {badges === "failed" || knownBadges && !knownBadges.time && !knownBadges.variety
                ? <Paragraph className={cl("badges")}>Couldn't read your badge progress. Discord may not have these badges on your account yet.</Paragraph>
                : knownBadges && pending && (
                    <div className={cl("badges")}>
                        {knownBadges.time && <BadgeLine kind="time" progress={knownBadges.time} waiting={Math.floor(pending.hours)} adding={addingHours} />}
                        {knownBadges.variety && <BadgeLine kind="variety" progress={knownBadges.variety} waiting={pending.games} adding={addingGames} />}
                        {pending.newest != null && (
                            <Paragraph>
                                Your added time should be counted {countedBy(pending.newest)}.
                            </Paragraph>
                        )}
                    </div>
                )}
            {pool && (
                <>
                    <FormSwitch
                        title="Only games I haven't played"
                        description={`New games count toward the Game Variety badge. ${playedNote}`}
                        value={newOnly}
                        onChange={setNewOnly}
                        disabled={progress !== null}
                        hideBorder
                    />
                    <div className={cl("time-input", "count")}>
                        <Heading tag="h5">Number of Games</Heading>
                        <div className={cl("count-row")}>
                            <TextInput value={count} onChange={v => setCount(digits(v, available.length))} placeholder="10" disabled={progress !== null} />
                            <Button size="small" variant="secondary" onClick={() => setCount(String(available.length))} disabled={progress !== null || !available.length}>
                                All ({available.length.toLocaleString()})
                            </Button>
                        </div>
                    </div>
                </>
            )}
            <div className={cl("time-inputs")}>
                {UNITS.map(([unit, , max]) => (
                    <div key={unit} className={cl("time-input")}>
                        <Heading tag="h5">{unit[0].toUpperCase() + unit.slice(1)}</Heading>
                        <TextInput value={values[unit]} onChange={v => setValues(s => ({ ...s, [unit]: digits(v, max) }))} placeholder="0" disabled={progress !== null} />
                    </div>
                ))}
            </div>
            <Paragraph>{progress ?? problem ?? summary}</Paragraph>
        </Modal>
    );
}

export function openAddTime(apps: DetectableApp[], label: string, pool?: DetectableApp[]) {
    openModal(props => (
        <ErrorBoundary>
            <AddTime modalProps={props} apps={apps} pool={pool} label={label} />
        </ErrorBoundary>
    ));
}
