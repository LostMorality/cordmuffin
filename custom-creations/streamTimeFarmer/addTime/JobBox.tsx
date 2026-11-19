/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { createRoot, useEffect, useState } from "@webpack/common";
import type { CSSProperties } from "react";
import type { Root } from "react-dom/client";

import { useLayout } from "../layout";
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
    const wait = formatWait(Math.max(0, finishAt(nextAt, sendsLeft(j)) - now));
    // It starts a sentence of its own, in the box and after the status line's full stop.
    const left = `${wait[0].toUpperCase()}${wait.slice(1)} left.`;
    return { next, left };
}

// Only in the Discord that earns the time: the hosted second-account window runs the web build.
export function showsHere(j: StreamJob | null): j is StreamJob {
    return j != null && IS_DISCORD_DESKTOP && currentUserId() === j.userId;
}

// The narrowest right-hand column (member list, DM profile) the box still fits in, at its smaller width plus margins.
const MIN_SIDE_COLUMN = 256;

interface Place {
    style: CSSProperties;
    inChat: boolean;
}

// Floating cards that live in the bottom-right corner, over the same column: StreamTimeFarmer's call widget,
// GameTimeSpoof's box and Discord's own picture-in-picture stream preview. None of them moves because of this box,
// so stacking above them can't make them chase each other.
const BOTTOM_CARDS = '.vc-stf-call-widget, .vc-gts-job, [class*="pictureInPictureWindow_"]';
const GAP = 8;
// The open box's height, for when it isn't on screen to measure.
const BOX_HEIGHT = 192;

// Where the column's own content stops: the bottom of its main scroller, which is above a footer like the DM
// profile's "View Full Profile" button. The column's bottom when it has no scroller.
function contentBottom(column: Element | undefined, fallback: number) {
    let best: DOMRect | null = null;
    for (const el of column?.querySelectorAll('[class*="scroller"]') ?? []) {
        const r = el.getBoundingClientRect();
        if (r.height > (best?.height ?? 0)) best = r;
    }
    return best ? Math.min(fallback, best.bottom) : fallback;
}

// Top-right corner of the chat, below the channel header so its buttons stay free, when nothing sits right of the
// chat; it starts small there. When a column sits right of the chat (member list, DM profile, threads) the box goes at
// the bottom of that column instead, narrowed to fit: its top holds the DM profile's banner (ProfileImages' buttons,
// Discord's own) and the start of the member list. It stays above the column's footer and above the corner cards when
// there's room for it. Without a chat on screen it keeps the stylesheet's spot.
function anchor(): Place | null {
    const chatEl = document.querySelector('[class*="chatContent_"]');
    const chat = chatEl?.getBoundingClientRect();
    if (!chatEl || !chat || chat.width < 360) return null;
    const side = Math.round(window.innerWidth - chat.right);
    if (side < MIN_SIDE_COLUMN) {
        // 40 clears Discord's 32 px bar at the top of the messages (unread / Mark As Read, topic pill).
        return { style: { top: Math.round(chat.top) + 40, right: Math.max(8, side + 16) }, inChat: true };
    }

    const column = [...chatEl.parentElement?.children ?? []].find(c => {
        const r = c.getBoundingClientRect();
        return c !== chatEl && r.width > 0 && r.left >= chat.right - 1;
    });
    // A side panel outside the chat's parent (thread or forum post) has its own text box at the bottom: keep to its top.
    if (!column) return { style: { top: Math.round(chat.top) + GAP, right: GAP, maxWidth: side - 2 * GAP }, inChat: false };
    const top = (column?.getBoundingClientRect().top ?? chat.top) + GAP;
    let limit = contentBottom(column, Math.min(chat.bottom, window.innerHeight)) - GAP;
    const height = document.querySelector<HTMLElement>(".vc-ast-job")?.offsetHeight || BOX_HEIGHT;
    const right = window.innerWidth - GAP, left = chat.right;
    for (const el of document.querySelectorAll(BOTTOM_CARDS)) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || r.right <= left || r.left >= right || r.top >= limit + GAP) continue;
        // A tall open call widget on a short window can leave too little room above it; then the box keeps the
        // content's bottom and the two overlap, rather than the box climbing back over the banner.
        if (r.top - GAP - top >= height) limit = Math.min(limit, r.top - GAP);
    }
    return { style: { top: "auto", bottom: Math.round(window.innerHeight - limit), right: GAP, maxWidth: side - 2 * GAP }, inChat: false };
}

function JobCard() {
    const j = useJob();
    const place = useLayout(anchor, null);
    const [, rerender] = useState(0);
    // Until the user picks a size it follows the spot: small when it has to sit over the chat.
    const [picked, setSmall] = useState<boolean | null>(null);
    const small = picked ?? place?.inChat ?? false;
    useEffect(() => {
        const id = setInterval(() => rerender(n => n + 1), REFRESH_MS);
        return () => clearInterval(id);
    }, []);
    if (!showsHere(j)) return null;

    const percent = Math.floor(sentSeconds(j) / j.total * 100);
    const { next, left } = waitLines(j);

    return (
        <div className={cl("job", small && "job-small")} style={place?.style} role="status">
            <div className={cl("job-head")} onClick={() => setSmall(!small)} title={small ? "Show details" : "Make smaller"}>
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
