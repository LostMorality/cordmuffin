/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { findByPropsLazy } from "@webpack";

import { beginResend, endResend, HOUR_MS, MIN_REAL_S } from "./raiser";

const logger = new Logger("AddStreamTime");

const KEY = "AddStreamTime_report";
// Sending the same report again was credited in full at ages of one, two, three and five hours, and sending the
// same one five times over didn't wear it out. Past that a stream is ended instead, which both sends that hour's
// time and leaves a fresh report for the hours after it. Sends land near :04, so the ages actually used are the
// whole hours one to five; the half hour is only slack.
const MAX_AGE_MS = 5 * HOUR_MS + 30 * 60_000;

// Discord's own analytics sender: the report goes out exactly as one the client made itself.
const Tracker: { track(type: string, properties: object, options?: { flush?: boolean; }): void; } =
    findByPropsLazy("getSuperPropertiesBase64", "track");

type Props = Record<string, unknown>;

interface Saved {
    props: Props;
    // When the stream this report describes ended.
    at: number;
    // The account it belongs to: another account's report would be sent as that account's time.
    userId: string;
}

let saved: Saved | null = null;
let loaded = false;
let loading: Promise<void> | null = null;

// Timestamps Discord stamps itself when the report is handed to the tracker. Stale ones are dropped so the
// report isn't sent carrying the clock of the hour it was first made in.
const STAMPED_AGAIN = ["client_track_timestamp", "client_send_timestamp"];

const usable = (p: Props) =>
    typeof p.media_session_id === "string" && p.media_session_id !== ""
    && Number(p.duration) >= MIN_REAL_S
    && Number(p.max_viewers) >= 1;

function copy(p: Props): Props | null {
    try {
        return JSON.parse(JSON.stringify(p));
    } catch (e) {
        logger.error("Couldn't copy a stream report", e);
        return null;
    }
}

export function loadReport(): Promise<void> {
    if (loaded) return Promise.resolve();
    return loading ??= (async () => {
        try {
            const stored: any = await DataStore.get(KEY);
            if (stored && typeof stored === "object" && stored.props && typeof stored.at === "number" && typeof stored.userId === "string"
                && usable(stored.props))
                saved = { props: stored.props, at: stored.at, userId: stored.userId };
        } catch (e) {
            logger.error("Couldn't load the saved stream report", e);
        }
        loaded = true;
    })();
}

// Keeps the newest real report of this account's own farm stream. Called with a copy taken before it was raised,
// so what's kept is the stream's real length, exactly as Discord made it.
export function saveReport(props: Props, userId: string) {
    if (!userId || !usable(props)) return;
    const props2 = copy(props);
    if (!props2) return;
    saved = { props: props2, at: Date.now(), userId };
    loaded = true;
    DataStore.set(KEY, saved).catch(e => logger.error("Couldn't save the stream report", e));
}

export function forgetReport() {
    saved = null;
    DataStore.del(KEY).catch(e => logger.error("Couldn't clear the saved stream report", e));
}

export const reportLoaded = () => loaded;

// How long ago the saved report's stream ended, or null when there is nothing to send again.
export function reportAge(userId: string, now = Date.now()): number | null {
    if (!loaded || !saved || saved.userId !== userId) return null;
    const age = now - saved.at;
    return age >= 0 ? age : null;
}

// Whether this hour's time can be sent without ending the farm's stream.
export function canResend(userId: string, now = Date.now()) {
    const age = reportAge(userId, now);
    return age != null && age < MAX_AGE_MS;
}

// Sends the saved report again, as it is: the raiser catches it on its way out and raises it to this hour's
// claim, the same way it does for the report a real stream end makes. Returns whether it was handed over.
export function resendReport(userId: string, now = Date.now()) {
    if (!canResend(userId, now) || !saved) return false;
    const props = copy(saved.props);
    if (!props) return false;
    for (const key of STAMPED_AGAIN) delete props[key];

    // The tracker can hand the report to the network a tick or two later, so the raiser is told to expect this
    // one session for a short while rather than only during the call.
    beginResend(String(saved.props.media_session_id));
    try {
        Tracker.track("video_stream_ended", props, { flush: true });
        logger.info(`Sent the saved stream report again (${Math.round((now - saved.at) / 60_000)} min old)`);
        return true;
    } catch (e) {
        endResend();
        logger.error("Couldn't send the saved stream report again", e);
        return false;
    }
}

export const MAX_REPORT_AGE_MS = MAX_AGE_MS;
