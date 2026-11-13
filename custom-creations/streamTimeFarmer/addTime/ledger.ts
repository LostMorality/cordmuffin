/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";

const logger = new Logger("AddStreamTime");

const KEY = "AddStreamTime_log";
// Sends the old StreamBoost build made; read only, so a job doesn't make a second report in an hour it already used.
const LEGACY_KEY = "StreamBoost_ledger";
const MAX_ROWS = 200;
const HOUR_MS = 3_600_000;

export type RowStatus = number | "beacon" | "failed" | "pending";

export interface LedgerRow {
    id: string;
    // UTC hour index: Math.floor(ms / 3_600_000).
    hour: number;
    sentAt: number;
    real: number;
    claimed: number;
    viewers: number;
    status: RowStatus;
    // startedAt of the job the report was sent for.
    job: number;
}

let rows: LedgerRow[] = [];
let legacyHours = new Set<number>();
let loaded = false;
let loading: Promise<void> | null = null;
let seq = 0;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach(l => l());

export function onLedger(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}

export const ledgerRows = () => rows;
export const ledgerLoaded = () => loaded;

export const statusOk = (s: RowStatus) => s === "beacon" || typeof s === "number" && s >= 200 && s < 300;

export const hourDone = (hour: number) => legacyHours.has(hour) || rows.some(r => r.hour === hour && statusOk(r.status));

// Pending counts as taken, so a second report in the same hour isn't raised while the first one's answer is out.
export const hourTaken = (hour: number) => hourDone(hour) || rows.some(r => r.hour === hour && r.status === "pending");

export const pendingFor = (job: number) => rows.some(r => r.job === job && r.status === "pending");

const isRow = (r: any): r is LedgerRow => r && typeof r.id === "string" && typeof r.hour === "number" && typeof r.sentAt === "number"
    && typeof r.real === "number" && typeof r.claimed === "number" && typeof r.viewers === "number";

const LOAD_RETRY_MS = 30_000;

function persist() {
    DataStore.set(KEY, rows).catch(e => logger.error("Couldn't save the send log", e));
}

// Reads the stored log once per page: later plugin restarts keep the in-memory rows, so an upload still in
// flight across a stop/start stays pending instead of reopening its hour.
export function loadLedger(): Promise<void> {
    if (loaded) {
        emit();
        return Promise.resolve();
    }
    // One shared read, so a second caller can't put an older copy over rows added since the first one finished.
    return loading ??= (async () => {
        let saved: LedgerRow[] = [];
        try {
            const stored = await DataStore.get<unknown[]>(KEY);
            // A row still pending was cut off by a restart before Discord answered, so it never counted as done.
            if (Array.isArray(stored))
                saved = stored.filter(isRow).map(r => ({
                    ...r,
                    job: typeof r.job === "number" ? r.job : 0,
                    status: r.status === "pending" ? "failed" as const : r.status
                }));
        } catch (e) {
            // Without the log an hour that already has a send would look open, so nothing is sent until it reads.
            logger.error("Couldn't load the send log, trying again shortly", e);
            loading = null;
            setTimeout(() => void loadLedger(), LOAD_RETRY_MS);
            return;
        }
        rows = [...saved.filter(s => !rows.some(r => r.id === s.id)), ...rows].slice(-MAX_ROWS);
        try {
            const old = await DataStore.get<unknown[]>(LEGACY_KEY);
            const recent = Math.floor(Date.now() / HOUR_MS) - 1;
            if (Array.isArray(old))
                legacyHours = new Set(old.filter((r: any) => r && typeof r.hour === "number" && r.hour >= recent && statusOk(r.status)).map((r: any) => r.hour as number));
        } catch (e) {
            logger.error("Couldn't read the old StreamBoost log", e);
        }
        loaded = true;
        emit();
    })();
}

export function addRow(row: Omit<LedgerRow, "id">): string {
    const id = `${row.sentAt}-${++seq}`;
    rows = [...rows, { ...row, id }].slice(-MAX_ROWS);
    persist();
    emit();
    return id;
}

// First answer wins: a row is settled once, from pending only. Returns the settled row.
export function settleRow(id: string, status: Exclude<RowStatus, "pending">): LedgerRow | null {
    const row = rows.find(r => r.id === id && r.status === "pending");
    if (!row) return null;
    const settled = { ...row, status };
    rows = rows.map(r => r.id === id ? settled : r);
    persist();
    emit();
    return settled;
}

// Rows from this and the last UTC hour stay: they're what stops a second send in an hour that already has one.
export function clearLedger() {
    const recent = Math.floor(Date.now() / HOUR_MS) - 1;
    rows = rows.filter(r => r.status === "pending" || r.hour >= recent);
    persist();
    emit();
}
