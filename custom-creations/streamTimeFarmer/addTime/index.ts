/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { currentUserId } from "../profile";
import { claimSeconds, currentJob, hoursText, jobId, loadJob, noteResult, notify, onJob, reconcileJob, sendsTotal, sentSeconds, setPluginRunning } from "./job";
import { mountJobBox, unmountJobBox } from "./JobBox";
import { type LedgerRow, ledgerRows, loadLedger } from "./ledger";
import { configureRaiser, idleRaiserHooks, installHooks, removeHooks } from "./raiser";
import { loadReport, saveReport } from "./resend";
import { noteSendResult, noteStreamerReport, startScheduler, stopScheduler, whyNotEarning } from "./scheduler";

export { openAddStreamTime } from "./AddStreamTime";
export { Panel as AddTimePanel } from "./Panel";

let running = false;
let offJob: (() => void) | undefined;
// Runs after every plugin's start(), so a report watcher installed at the same time sits under this one.
let lateSync: ReturnType<typeof setTimeout> | undefined;

// A real report of this account's own farm stream is kept so later hours can send it again instead of
// ending the stream for each one.
function onRaised(props: Record<string, unknown>) {
    saveReport(props, currentUserId());
}

function onResult(row: LedgerRow, ok: boolean) {
    noteSendResult(ok);
    noteResult(row, ok);
}

// Only the account that started the job earns, and only in the desktop app (the hosted second-account window is web).
const isEnabled = () => {
    const job = currentJob();
    return running && job != null && IS_DISCORD_DESKTOP && currentUserId() === job.userId;
};

// Hooks and the corner box exist only while a job does; without one nothing is ever edited.
function syncJob() {
    if (running && currentJob() && IS_DISCORD_DESKTOP) {
        installHooks();
        mountJobBox();
    } else {
        removeHooks();
        unmountJobBox();
    }
}

export function startAddTime() {
    if (running) return;
    running = true;
    setPluginRunning(true);
    configureRaiser({ whyNot: whyNotEarning, onRaised, claimSeconds, jobId, onStreamerReport: noteStreamerReport, onResult });
    const ledgerReady = loadLedger();
    void loadReport();
    offJob = onJob(syncJob);
    startScheduler(isEnabled);
    void Promise.all([loadJob(), ledgerReady]).then(([job]) => {
        if (!running) return;
        if (job) reconcileJob(ledgerRows());
        job = currentJob();
        syncJob();
        if (job && IS_DISCORD_DESKTOP && currentUserId() === job.userId)
            notify(`Continuing to add streaming time: ${hoursText(sentSeconds(job))} of ${hoursText(job.total)} h sent (${job.sent.length} of ${sendsTotal(job)}).`);
    });
    lateSync = setTimeout(syncJob, 0);
}

export function stopAddTime() {
    if (!running) return;
    running = false;
    setPluginRunning(false);
    clearTimeout(lateSync);
    offJob?.();
    offJob = undefined;
    stopScheduler();
    removeHooks();
    unmountJobBox();
    // A send still waiting for its answer must still come off the kept job when it's accepted.
    configureRaiser({ ...idleRaiserHooks, onResult: noteResult });
}
