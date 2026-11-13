/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { createRoot, useEffect, useState } from "@webpack/common";
import type { Root } from "react-dom/client";

import { currentUserId } from "../profile";
import { formatWait, hoursText, sendsLeft, sendsTotal, sentSeconds, stopJob, type StreamJob, useJob } from "./job";
import { finishAt, firstSlot, plan } from "./scheduler";

export const cl = classNameFactory("vc-ast-");

const REFRESH_MS = 15_000;

export const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function progressLine(j: StreamJob) {
    return `${hoursText(sentSeconds(j))} of ${hoursText(j.total)} h sent (${j.sent.length} of ${sendsTotal(j)})`;
}

// The next send's time (or why it's waiting) and how long the rest takes.
export function waitLines(j: StreamJob, now = Date.now()) {
    const p = plan(now);
    const nextAt = p.nextEndAt ?? firstSlot(now);
    const next = p.nextEndAt == null
        ? p.note
        : p.nextEndAt <= now + 60_000
            ? `Next send any minute now. ${p.note}`
            : `Next send around ${time(p.nextEndAt)}. ${p.note}`;
    const left = `${formatWait(Math.max(0, finishAt(nextAt, sendsLeft(j)) - now))} left.`;
    return { next, left };
}

// Only in the Discord that earns the time: the hosted second-account window runs the web build.
export function showsHere(j: StreamJob | null): j is StreamJob {
    return j != null && IS_DISCORD_DESKTOP && currentUserId() === j.userId;
}

function JobCard() {
    const j = useJob();
    const [, rerender] = useState(0);
    const [small, setSmall] = useState(false);
    useEffect(() => {
        const id = setInterval(() => rerender(n => n + 1), REFRESH_MS);
        return () => clearInterval(id);
    }, []);
    if (!showsHere(j)) return null;

    const percent = Math.floor(sentSeconds(j) / j.total * 100);
    const { next, left } = waitLines(j);

    return (
        <div className={cl("job", small && "job-small")} role="status">
            <div className={cl("job-head")} onClick={() => setSmall(s => !s)} title={small ? "Show details" : "Make smaller"}>
                <span className={cl("job-title")}>{small ? `Adding streaming time · ${percent}%` : "Adding streaming time"}</span>
                <span className={cl("job-toggle")}>{small ? "▴" : "▾"}</span>
            </div>
            <div className={cl("job-bar")}>
                <div className={cl("job-fill")} style={{ width: `${percent}%` }} />
            </div>
            {!small && (
                <>
                    <div className={cl("job-text", "job-result")}>{progressLine(j)}</div>
                    <div className={cl("job-text")}>{next}</div>
                    <div className={cl("job-text")}>{left}</div>
                    <div className={cl("job-actions")}>
                        <Button size="small" variant="dangerSecondary" onClick={stopJob}>Stop</Button>
                    </div>
                </>
            )}
        </div>
    );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

export function mountJobBox() {
    if (root) return;
    container = document.createElement("div");
    container.id = "vc-ast-job-container";
    document.body.append(container);
    root = createRoot(container);
    root.render(<ErrorBoundary noop><JobCard /></ErrorBoundary>);
}

export function unmountJobBox() {
    root?.unmount();
    container?.remove();
    root = null;
    container = null;
}
