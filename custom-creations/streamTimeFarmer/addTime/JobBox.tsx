/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { createRoot, useEffect, useRef, useState } from "@webpack/common";
import type { CSSProperties, PointerEvent } from "react";
import type { Root } from "react-dom/client";

import { settings } from "..";
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

interface Spot {
    right: number;
    top: number;
}

interface Size {
    w: number;
    h: number;
}

interface Drag {
    id: number;
    x: number;
    y: number;
    from: Spot;
    moved: boolean;
    // Where the box was last drawn, which is what gets saved: never the release or cancel event's own coordinates.
    shown: Spot | null;
}

// The stylesheet's top-right spot, used until the box is dragged somewhere else.
const DEFAULT_SPOT: Spot = { right: 16, top: 56 };
// A press that moves less than this is a click (show or hide the details), not a drag.
const DRAG_THRESHOLD = 4;
// The gap kept between the box and the window's edges.
const EDGE = 8;

// Kept fully inside the window, so a smaller window or an opened box never pushes it out of reach.
function clamp(spot: Spot, size: Size): Spot {
    return {
        right: Math.round(Math.min(Math.max(spot.right, EDGE), Math.max(EDGE, window.innerWidth - size.w - EDGE))),
        top: Math.round(Math.min(Math.max(spot.top, EDGE), Math.max(EDGE, window.innerHeight - size.h - EDGE)))
    };
}

// The box stays where it is: top right, or wherever it was dragged to by its title bar, the same way Discord's stream
// preview is moved. The spot and its size are remembered across restarts.
function JobCard() {
    const j = useJob();
    const shown = showsHere(j);
    const { jobBoxSpot: saved, jobBoxSmall: small } = settings.use(["jobBoxSpot", "jobBoxSmall"]);
    const [el, setEl] = useState<HTMLDivElement | null>(null);
    const [size, setSize] = useState<Size>({ w: 240, h: 44 });
    const drag = useRef<Drag | null>(null);
    const [live, setLive] = useState<Spot | null>(null);
    const [, rerender] = useState(0);
    useEffect(() => {
        const id = setInterval(() => rerender(n => n + 1), REFRESH_MS);
        const onResize = () => rerender(n => n + 1);
        window.addEventListener("resize", onResize);
        return () => {
            clearInterval(id);
            window.removeEventListener("resize", onResize);
        };
    }, []);
    // Its real size, measured whenever it changes (shown, opened or closed, text wrapping), so it's kept inside the
    // window from the first frame on.
    useEffect(() => {
        if (!el) return;
        const measure = () => setSize(s => s.w === el.offsetWidth && s.h === el.offsetHeight ? s : { w: el.offsetWidth, h: el.offsetHeight });
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        measure();
        return () => observer.disconnect();
    }, [el]);
    // A drag the box vanished in the middle of (the job ended) doesn't carry over to the next one.
    useEffect(() => {
        if (shown) return;
        drag.current = null;
        setLive(null);
    }, [shown]);
    if (!shown) return null;

    const percent = Math.floor(sentSeconds(j) / j.total * 100);
    const { next, left } = waitLines(j);
    const spot = live ?? clamp(saved ?? DEFAULT_SPOT, size);
    const style: CSSProperties = { right: spot.right, top: spot.top };

    const toggle = () => void (settings.store.jobBoxSmall = !small);
    const finish = (d: Drag, save: boolean) => {
        drag.current = null;
        if (d.moved) {
            if (save && d.shown) settings.store.jobBoxSpot = d.shown;
            setLive(null);
        }
    };
    const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0 || drag.current || !el) return;
        const r = el.getBoundingClientRect();
        drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: { right: window.innerWidth - r.right, top: r.top }, moved: false, shown: null };
        e.currentTarget.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        // The button was let go somewhere this box never heard about.
        if (e.buttons === 0) return finish(d, true);
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        d.moved = true;
        d.shown = clamp({ right: d.from.right - dx, top: d.from.top + dy }, size);
        setLive(d.shown);
    };
    const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        finish(d, true);
        if (!d.moved) toggle();
    };
    // Cancelled by the system, or capture lost another way (alt-tab, a modal opening): keep where it was last drawn.
    const onPointerLost = (e: PointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        if (d && d.id === e.pointerId) finish(d, true);
    };

    return (
        <div ref={setEl} className={cl("job", small && "job-small")} style={style} role="status">
            <div
                className={cl("job-head", live && "job-dragging")}
                role="button"
                tabIndex={0}
                aria-expanded={!small}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerLost}
                onLostPointerCapture={onPointerLost}
                onKeyDown={e => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    toggle();
                }}
                title={`Drag to move. Click to ${small ? "show details" : "make smaller"}.`}
            >
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
