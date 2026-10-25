/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, showToast, TextInput, useState } from "@webpack/common";

import { DetectableApp, exeName } from ".";
import { creditPlaytime } from "./science";

const cl = classNameFactory("vc-gts-");

const UNITS = [["days", 86_400_000], ["hours", 3_600_000], ["minutes", 60_000]] as const;
type Unit = typeof UNITS[number][0];

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

function AddTime({ modalProps, apps, pool, label }: { modalProps: RenderModalProps; apps: DetectableApp[]; pool?: DetectableApp[]; label: string; }) {
    const [values, setValues] = useState<Record<Unit, string>>(pool ? { days: "", hours: "", minutes: "15" } : { days: "", hours: "1", minutes: "" });
    const [count, setCount] = useState("10");
    const [progress, setProgress] = useState<string | null>(null);
    const durationMs = UNITS.reduce((total, [unit, ms]) => total + (Number(values[unit]) || 0) * ms, 0);
    const gameCount = pool ? Math.min(Number(count) || 0, pool.length) : apps.length;

    async function credit() {
        setProgress("Starting...");
        try {
            const targets = pool ? pickRandom(pool, gameCount) : apps;
            await creditPlaytime(
                targets.map(app => ({ id: app.id, name: app.name, processName: exeName(app) })),
                durationMs,
                (done, total) => setProgress(`Sent ${done} of ${total} sessions`)
            );
            showToast({ text: `Credited ${formatDuration(durationMs)} across ${targets.length} ${targets.length === 1 ? "game" : "games"}.`, variant: "success" });
            modalProps.onClose();
        } catch {
            showToast({ text: "Discord didn't accept the play time. Try again in a bit.", variant: "critical" });
            setProgress(null);
        }
    }

    return (
        <Modal
            {...modalProps}
            size="sm"
            title="Add Play Time"
            subtitle={pool ? "Picks random games Discord can detect and adds time to each one." : `Adds time to ${label}${apps.length > 1 ? ` (${apps.length} games)` : ""}.`}
            actions={[
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
                { text: "Add Time", variant: "primary", onClick: credit, loading: progress !== null, disabled: durationMs < 60_000 || gameCount < 1 }
            ]}
        >
            {pool && (
                <div className={cl("time-input", "count")}>
                    <Heading tag="h5">Number of Games</Heading>
                    <TextInput value={count} onChange={v => setCount(v.replace(/\D/g, ""))} placeholder="10" />
                </div>
            )}
            <div className={cl("time-inputs")}>
                {UNITS.map(([unit]) => (
                    <div key={unit} className={cl("time-input")}>
                        <Heading tag="h5">{unit[0].toUpperCase() + unit.slice(1)}</Heading>
                        <TextInput value={values[unit]} onChange={v => setValues(s => ({ ...s, [unit]: v.replace(/\D/g, "") }))} placeholder="0" />
                    </div>
                ))}
            </div>
            <Paragraph>
                {progress ?? `${formatDuration(durationMs)} per game. Badges can take a day or two to update.`}
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
