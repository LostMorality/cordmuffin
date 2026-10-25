/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, showToast, TextInput, useEffect, useRef, useState } from "@webpack/common";

import { DetectableApp, exeName } from ".";
import { CreditError, creditPlaytime, planCredit } from "./science";

const cl = classNameFactory("vc-gts-");

const UNITS = [["days", 86_400_000, 365], ["hours", 3_600_000, 23], ["minutes", 60_000, 59]] as const;
type Unit = typeof UNITS[number][0];
const MAX_GAMES = 100;
const MAX_SESSIONS = 2000;

function formatDuration(ms: number) {
    const d = Math.floor(ms / 86_400_000);
    const h = Math.floor(ms % 86_400_000 / 3_600_000);
    const m = Math.floor(ms % 3_600_000 / 60_000);
    return `${d}d ${h}h ${m}m`;
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
    const n = value.replace(/\D/g, "").slice(0, 4);
    return n && Number(n) > max ? String(max) : n;
};

function AddTime({ modalProps, apps, pool, label }: { modalProps: RenderModalProps; apps: DetectableApp[]; pool?: DetectableApp[]; label: string; }) {
    const [values, setValues] = useState<Record<Unit, string>>(pool ? { days: "", hours: "", minutes: "15" } : { days: "", hours: "1", minutes: "" });
    const [count, setCount] = useState("10");
    const [progress, setProgress] = useState<string | null>(null);
    const running = useRef(false);
    const abort = useRef(new AbortController());

    useEffect(() => () => abort.current.abort(), []);

    const durationMs = UNITS.reduce((total, [unit, ms]) => total + (Number(values[unit]) || 0) * ms, 0);
    const gameCount = pool ? Math.min(Number(count) || 0, pool.length, MAX_GAMES) : apps.length;
    const sessions = gameCount * Math.ceil(durationMs / 86_400_000);
    const problem = gameCount < 1 ? "Pick at least one game."
        : durationMs < 60_000 ? "Add at least 1 minute."
            : sessions > MAX_SESSIONS ? `That's too much at once. Try fewer games or fewer days (up to ${MAX_SESSIONS.toLocaleString()} game-days per run).`
                : null;

    async function credit() {
        if (running.current || problem) return;
        running.current = true;
        setProgress("Starting...");
        const targets = pool ? pickRandom(pool, gameCount) : apps;
        const plan = planCredit(targets.map(app => ({ id: app.id, name: app.name, processName: exeName(app) })), durationMs);
        try {
            await creditPlaytime(plan, abort.current.signal, (done, total) => setProgress(`Sent ${done} of ${total} sessions`));
            if (abort.current.signal.aborted) return;
            showToast({ text: `Credited ${formatDuration(durationMs)} across ${targets.length} ${targets.length === 1 ? "game" : "games"}.`, variant: "success" });
            modalProps.onClose();
        } catch (e) {
            const sent = e instanceof CreditError ? e.sent : 0;
            showToast({
                text: sent
                    ? `Discord stopped accepting play time after ${sent} of ${plan.length} sessions. The ones sent still count, so don't run the same thing again right away.`
                    : "Discord didn't accept the play time. Try again in a bit.",
                variant: "critical"
            });
            setProgress(null);
        } finally {
            running.current = false;
        }
    }

    return (
        <Modal
            {...modalProps}
            size="sm"
            title="Add Play Time"
            subtitle={pool ? "Picks random games Discord can detect and adds time to each one." : `Adds time to ${label}${apps.length > 1 ? ` (${apps.length} games)` : ""}.`}
            actions={[
                { text: progress ? "Stop" : "Cancel", variant: "secondary", onClick: modalProps.onClose },
                { text: "Add Time", variant: "primary", onClick: credit, loading: progress !== null, disabled: !!problem || progress !== null }
            ]}
        >
            {pool && (
                <div className={cl("time-input", "count")}>
                    <Heading tag="h5">Number of Games (up to {Math.min(MAX_GAMES, pool.length)})</Heading>
                    <TextInput value={count} onChange={v => setCount(digits(v, Math.min(MAX_GAMES, pool.length)))} placeholder="10" />
                </div>
            )}
            <div className={cl("time-inputs")}>
                {UNITS.map(([unit, , max]) => (
                    <div key={unit} className={cl("time-input")}>
                        <Heading tag="h5">{unit[0].toUpperCase() + unit.slice(1)}</Heading>
                        <TextInput value={values[unit]} onChange={v => setValues(s => ({ ...s, [unit]: digits(v, max) }))} placeholder="0" />
                    </div>
                ))}
            </div>
            <Paragraph>
                {progress ?? problem ?? `${formatDuration(durationMs)} per game. Badges can take a day or two to update.`}
            </Paragraph>
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
