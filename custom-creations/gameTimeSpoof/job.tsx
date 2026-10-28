/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { createRoot, showToast, useEffect, useState } from "@webpack/common";
import type { Root } from "react-dom/client";

import { BadgeKind, BadgeProgress, recordCredit } from "./badges";
import { CreditError, CreditPlan, creditPlaytime, CreditProgress } from "./science";

const cl = classNameFactory("vc-gts-");

export interface CreditJob {
    plan: CreditPlan;
    played: Set<string> | null;
    badges: Partial<Record<BadgeKind, BadgeProgress>> | null;
    describe(sent: number): string;
    progressText(p: CreditProgress): string;
    doneText(): string;
}

interface JobState {
    progress: CreditProgress;
    text: string;
    stopping: boolean;
}

let state: JobState | null = null;
let controller: AbortController | null = null;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const listeners = new Set<() => void>();

function update(next: JobState | null) {
    state = next;
    listeners.forEach(l => l());
}

export const isCrediting = () => state !== null;

export function useCrediting() {
    const [, rerender] = useState(0);
    useEffect(() => {
        const listener = () => rerender(n => n + 1);
        listeners.add(listener);
        return () => void listeners.delete(listener);
    }, []);
    return state !== null;
}

function logSent(job: CreditJob, sent: number) {
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

export async function startCredit(job: CreditJob) {
    if (state) return;
    const abort = controller = new AbortController();
    const first: CreditProgress = { sent: 0, total: job.plan.length, etaMs: null, waitingMs: 0 };
    update({ progress: first, text: "Starting...", stopping: false });
    mount();
    try {
        const sent = await creditPlaytime(job.plan, abort.signal, p => state && update({ ...state, progress: p, text: job.progressText(p) }));
        logSent(job, sent);
        if (abort.signal.aborted) {
            if (sent) showToast({ text: `Stopped. ${job.describe(sent)} were sent and still count.`, variant: "default" });
        } else {
            showToast({ text: job.doneText(), variant: "success" });
        }
    } catch (e) {
        const sent = e instanceof CreditError ? e.sent : 0;
        logSent(job, sent);
        showToast({
            text: sent
                ? `Discord stopped accepting play time after ${job.describe(sent)}. The ones sent still count, so don't run the same thing again right away.`
                : "Discord didn't accept the play time. Try again in a bit.",
            variant: "critical"
        });
    } finally {
        if (controller === abort) controller = null;
        update(null);
        unmount();
    }
}

export function stopCredit() {
    if (!state || !controller) return;
    update({ ...state, stopping: true });
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

    const { progress, text, stopping } = state;
    const percent = progress.total ? Math.floor(progress.sent / progress.total * 100) : 0;

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
    unmount();
}
