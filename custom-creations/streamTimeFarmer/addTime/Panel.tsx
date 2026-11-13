/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Paragraph } from "@components/Paragraph";
import { useEffect, useReducer } from "@webpack/common";

import { openAddStreamTime } from "./AddStreamTime";
import { hoursText, loadJob, pluginRunning, stopJob, useJob } from "./job";
import { cl, progressLine, showsHere, waitLines } from "./JobBox";
import { clearLedger, ledgerRows, loadLedger, onLedger, type RowStatus, statusOk } from "./ledger";
import { HOUR_MS } from "./raiser";

const dateTime = (t: number) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const streamed = (s: number) => s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : `${hoursText(s)} h`;
const statusLabel = (s: RowStatus) => s === "pending" ? "Waiting" : statusOk(s) ? "Sent" : "Failed";
const statusClass = (s: RowStatus) => statusOk(s) ? cl("ok") : s === "pending" ? undefined : cl("bad");

function PanelBody() {
    const job = useJob();
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
        // Loads a kept job and the log, so both show (and the job can be stopped) while the plugin is off.
        void loadJob();
        void loadLedger();
        const off = onLedger(rerender);
        const id = setInterval(rerender, 5000);
        return () => {
            off();
            clearInterval(id);
        };
    }, []);

    const rows = ledgerRows().slice().reverse();
    const here = showsHere(job);

    function statusLine() {
        if (!job) return "Nothing being added right now.";
        if (!showsHere(job)) return "Streaming time is being added from your other account.";
        if (!pluginRunning()) return <>Paused: <b>{progressLine(job)}</b>. Turn on StreamTimeFarmer to keep adding the time.</>;
        const { next, left } = waitLines(job);
        return <>Adding streaming time: <b>{progressLine(job)}</b>. {next} {left}</>;
    }

    return (
        <div className={cl("panel")}>
            <div className={cl("row")}>
                <Button onClick={openAddStreamTime}>Add Streaming Time</Button>
                {here && <Button variant="dangerSecondary" onClick={stopJob}>Stop</Button>}
            </div>
            <Paragraph>{statusLine()}</Paragraph>
            <div className={cl("row")}>
                <Paragraph weight="semibold">Sends ({rows.length})</Paragraph>
                <Button size="small" variant="secondary" disabled={!rows.length} onClick={clearLedger}>Clear log</Button>
            </div>
            {rows.length
                ? (
                    <div className={cl("log")}>
                        <table>
                            <thead>
                                <tr>
                                    <th>Hour</th>
                                    <th>Sent at</th>
                                    <th>Streamed</th>
                                    <th>Added</th>
                                    <th>Viewers</th>
                                    <th>Result</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map(r => (
                                    <tr key={r.id}>
                                        <td>{dateTime(r.hour * HOUR_MS)}</td>
                                        <td>{dateTime(r.sentAt)}</td>
                                        <td>{streamed(r.real)}</td>
                                        <td>{hoursText(r.claimed)} h</td>
                                        <td>{r.viewers}</td>
                                        <td className={statusClass(r.status)} title={String(r.status)}>{statusLabel(r.status)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )
                : <Paragraph>Nothing sent yet.</Paragraph>}
        </div>
    );
}

export const Panel = ErrorBoundary.wrap(PanelBody, { noop: true });
