/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { createRoot, useEffect, useState } from "@webpack/common";
import type { Root } from "react-dom/client";

import { BadgeKind, BadgeProgress, recordCredit } from "./badges";
import { CreditError, CreditPlan, creditPlaytime, CreditProgress } from "./science";

const cl = classNameFactory("vc-gts-");
const logger = new Logger("GameTimeSpoof");

export interface CreditJob {
    plan: CreditPlan;
    played: Set<string> | null;
    badges: Partial<Record<BadgeKind, BadgeProgress>> | null;
    describe(sent: number): string;
    progressText(p: CreditProgress): string;
    doneText(): string;
}

interface JobResult {
    kind: "success" | "stopped" | "failed";
    title: string;
    text: string;
}

interface JobState {
    progress: CreditProgress;
    text: string;
    stopping: boolean;
    result?: JobResult;
}

// Discord's toasts cut text off after two lines, so the finished run's message stays in the corner box instead.
const SUCCESS_SHOWN_MS = 15_000;

let state: JobState | null = null;
let controller: AbortController | null = null;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function update(next: JobState | null) {
    state = next;
    listeners.forEach(l => l());
}

const running = () => state !== null && !state.result;

export function useCrediting() {
    const [, rerender] = useState(0);
    useEffect(() => {
        const listener = () => rerender(n => n + 1);
        listeners.add(listener);
        return () => void listeners.delete(listener);
    }, []);
    return running();
}

// Only feeds the badge tracker; a problem here must never turn a good run into a failed one.
function logSent(job: CreditJob, sent: number) {
    try {
        tally(job, sent);
    } catch (e) {
        logger.error("Couldn't save the badge tracker entry", e);
    }
}

function tally(job: CreditJob, sent: number) {
    let ms = 0;
    const games = new Set<string>();
    for (let i = 0; i < sent; i++) {
        const session = job.plan.at(i);
        ms += session.durationMs;
        games.add(session.game.id);
    }
    const fresh = job.played ? [...games].filter(id => !job.played!.has(id)).length : 0;
    recordCredit(ms / 3_600_000, fresh, job.badges);
}

function finish(result: JobResult) {
    if (!state) return;
    update({ ...state, stopping: false, result });
    clearTimeout(closeTimer);
    if (result.kind === "success") closeTimer = setTimeout(dismiss, SUCCESS_SHOWN_MS);
}

function dismiss() {
    clearTimeout(closeTimer);
    update(null);
    unmount();
}

export async function startCredit(job: CreditJob) {
    if (running()) return;
    clearTimeout(closeTimer);
    const abort = controller = new AbortController();
    const first: CreditProgress = { sent: 0, total: job.plan.length, etaMs: null, waitingMs: 0 };
    update({ progress: first, text: "Starting...", stopping: false });
    mount();
    let result: JobResult;
    try {
        const sent = await creditPlaytime(job.plan, abort.signal, p => running() && update({ ...state!, progress: p, text: job.progressText(p) }));
        logSent(job, sent);
        result = abort.signal.aborted
            ? { kind: "stopped", title: "Stopped", text: sent ? `${job.describe(sent)} were sent and still count.` : "Nothing was sent yet." }
            : { kind: "success", title: "Play time added", text: job.doneText() };
    } catch (e) {
        logger.error("Adding play time failed", e);
        const sent = e instanceof CreditError ? e.sent : 0;
        const status = e instanceof CreditError ? (e.cause as { status?: number; } | undefined)?.status : undefined;
        logSent(job, sent);
        const reason = status ? ` (Discord answered ${status})` : "";
        result = {
            kind: "failed",
            title: sent ? "Only part of the play time was added" : "Couldn't add the play time",
            text: !(e instanceof CreditError)
                ? "Something went wrong in GameTimeSpoof before the play time could be sent. Details are in the console (Ctrl+Shift+I)."
                : !status
                    ? `The play time never reached Discord${sent ? ` after ${job.describe(sent)} were sent (those still count)` : ""}. Check your internet, and turn off anything that blocks Discord's tracking, like a DoNotTrack plugin, an ad blocker or a Pi-hole.`
                    : sent
                        ? `Discord stopped accepting play time after ${job.describe(sent)}${reason}. The ones sent still count, so don't run the same thing again right away.`
                        : `Discord didn't accept the play time${reason}. Try again in a bit.`
        };
    } finally {
        if (controller === abort) controller = null;
    }
    if (root) finish(result);
    else update(null);
}

export function stopCredit() {
    if (!running() || !controller) return;
    update({ ...state!, stopping: true });
    controller.abort();
}

function ProgressCard() {
    const [, rerender] = useState(0);
    const [small, setSmall] = useState(false);
    useEffect(() => {
        const listener = () => rerender(n => n + 1);
        listeners.add(listener);
        return () => void listeners.delete(listener);
    }, []);
    if (!state) return null;

    const { progress, text, stopping, result } = state;
    const percent = progress.total ? Math.floor(progress.sent / progress.total * 100) : 0;

    if (result) return (
        <div className={cl("job", `job-${result.kind}`)} role="status">
            <div className={cl("job-head")}>
                <span className={cl("job-title")}>{result.title}</span>
                <span className={cl("job-toggle")} onClick={dismiss} title="Close">✕</span>
            </div>
            <div className={cl("job-text", "job-result")}>{result.text}</div>
            {result.kind !== "success" && (
                <div className={cl("job-actions")}>
                    <Button size="small" variant="secondary" onClick={dismiss}>Close</Button>
                </div>
            )}
        </div>
    );

    return (
        <div className={cl("job", small && "job-small")} role="status">
            <div className={cl("job-head")} onClick={() => setSmall(s => !s)} title={small ? "Show details" : "Make smaller"}>
                <span className={cl("job-title")}>{small ? `Adding play time · ${percent}%` : "Adding play time"}</span>
                <span className={cl("job-toggle")}>{small ? "▴" : "▾"}</span>
            </div>
            <div className={cl("job-bar")}>
                <div className={cl("job-fill")} style={{ width: `${percent}%` }} />
            </div>
            {!small && (
                <>
                    <div className={cl("job-text")}>{stopping ? "Stopping..." : text}</div>
                    <div className={cl("job-actions")}>
                        <Button size="small" variant="dangerSecondary" onClick={stopCredit} disabled={stopping}>Stop</Button>
                    </div>
                </>
            )}
        </div>
    );
}

function mount() {
    if (root) return;
    container = document.createElement("div");
    container.id = "vc-gts-job-container";
    document.body.append(container);
    root = createRoot(container);
    root.render(<ErrorBoundary noop><ProgressCard /></ErrorBoundary>);
}

function unmount() {
    root?.unmount();
    container?.remove();
    root = null;
    container = null;
}

export function cancelCredit() {
    controller?.abort();
    clearTimeout(closeTimer);
    state = null;
    unmount();
}
