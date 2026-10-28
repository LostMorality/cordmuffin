/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByPropsLazy } from "@webpack";
import { RestAPI, UserStore } from "@webpack/common";

const SuperProperties: { getSuperProperties(): Record<string, unknown>; } = findByPropsLazy("getSuperProperties");

export interface ReportedGame {
    id: string;
    name: string;
    processName: string;
    fingerprint?: string;
}

const MAX_SESSION_MS = 24 * 60 * 60_000;
const SESSIONS_PER_REQUEST = 10;

let token: { userId: string; value: string; } | null = null;
let sequence = 0;
const fallbackIds = { client_heartbeat_session_id: crypto.randomUUID(), launch_signature: crypto.randomUUID() };

async function getAnalyticsToken() {
    const userId = UserStore.getCurrentUser()?.id ?? "";
    if (token?.userId === userId) return token.value;
    const { body } = await RestAPI.get({ url: "/users/@me", query: { with_analytics_token: true } });
    token = { userId, value: body.analytics_token as string };
    return token.value;
}

function sessionIds() {
    const props = SuperProperties.getSuperProperties();
    return {
        client_heartbeat_session_id: props.client_heartbeat_session_id ?? fallbackIds.client_heartbeat_session_id,
        launch_signature: props.launch_signature ?? fallbackIds.launch_signature
    };
}

function heartbeat(game: ReportedGame, durationMs: number, sessionId: string, initial: boolean, at: number, sentAt: number) {
    return {
        type: "running_game_heartbeat",
        properties: {
            client_track_timestamp: at,
            ...sessionIds(),
            event_sequence_number: ++sequence,
            game_id: game.id,
            game_name: game.name,
            game_metadata: null,
            game_executable: game.processName,
            game_detection_enabled: true,
            initial_heartbeat: initial,
            final_heartbeat: !initial,
            game_session_id: sessionId,
            duration_tracked_ms: durationMs,
            rtc_connection_id: null,
            media_session_id: null,
            client_app_state: "focused",
            client_send_timestamp: sentAt
        }
    };
}

function launch(game: ReportedGame, at: number, sentAt: number) {
    return {
        type: "launch_game",
        properties: {
            ...sessionIds(),
            rendered_locale: SuperProperties.getSuperProperties().system_locale ?? "en-US",
            client_track_timestamp: at,
            event_sequence_number: ++sequence,
            game: game.name,
            game_id: game.id,
            verified: true,
            elevated: false,
            is_launcher: false,
            game_platform: "desktop",
            detection_method: "verified_game",
            is_overlay_enabled: false,
            is_overlay_game_enabled: true,
            is_overlay_game_source: "OOP_DEFAULT_DATABASE",
            fullscreen_type: "UNKNOWN",
            hardware_display_count: 1,
            overlay_method: "Disabled",
            activity_status_enabled: true,
            activity_status_shared_guilds: [],
            current_user_status: "online",
            game_detection_enabled: true,
            executable_path: game.processName,
            voice_channel_id: null,
            voice_channel_type: null,
            voice_channel_bitrate: null,
            voice_channel_guild_id: null,
            hidden_by_distributor: false,
            game_metadata: null,
            client_performance_cpu: null,
            client_performance_memory: null,
            cpu_core_count: null,
            accessibility_features: 0,
            client_rtc_state: null,
            client_app_state: "focused",
            client_send_timestamp: sentAt,
            ...game.fingerprint && { executable_fingerprint: game.fingerprint }
        }
    };
}

function session(game: ReportedGame, durationMs: number, end: number, sentAt: number) {
    const sessionId = crypto.randomUUID();
    const start = end - durationMs;
    return [heartbeat(game, 0, sessionId, true, start, sentAt), launch(game, start, sentAt), heartbeat(game, durationMs, sessionId, false, end, sentAt)];
}

// Tracking blockers that swallow the request hand back nothing, or a fake failure, instead of Discord's answer.
async function send(events: unknown[]) {
    const res = await RestAPI.post({ url: "/science", body: { token: await getAnalyticsToken(), events } });
    if (!res?.ok) throw Object.assign(new Error("Discord did not receive the play time"), { status: res?.status, blocked: res?.status == null });
}

export async function reportPlaytime(game: ReportedGame, durationMs: number) {
    const now = Date.now();
    await send(session(game, Math.min(durationMs, MAX_SESSION_MS), now, now));
}

export interface CreditPlan {
    length: number;
    at(index: number): { game: ReportedGame; durationMs: number; end: number; };
}

export function planCredit(games: ReportedGame[], durationMs: number): CreditPlan {
    const now = Date.now();
    const perGame = Math.ceil(durationMs / MAX_SESSION_MS);
    return {
        length: games.length * perGame,
        at(index) {
            const offset = (perGame - 1 - index % perGame) * MAX_SESSION_MS;
            return { game: games[Math.floor(index / perGame)], durationMs: Math.min(MAX_SESSION_MS, durationMs - offset), end: now - offset };
        }
    };
}

export class CreditError extends Error {
    constructor(public sent: number, public total: number, cause: unknown) {
        super(`Sent ${sent} of ${total}`, { cause });
    }
}

const SEND_GAP_MS = 500;
const MAX_FAILURES = 5;

function wait(ms: number, signal: AbortSignal) {
    return new Promise<void>(resolve => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
        }
        signal.addEventListener("abort", done);
    });
}

function retryAfterMs(e: any) {
    const seconds = Number(e?.body?.retry_after ?? e?.headers?.["retry-after"]);
    return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) + 250 : 5000;
}

export interface CreditProgress {
    sent: number;
    total: number;
    etaMs: number | null;
    waitingMs: number;
}

export async function creditPlaytime(plan: CreditPlan, signal: AbortSignal, onProgress?: (progress: CreditProgress) => void) {
    let sent = 0;
    let failures = 0;
    let busyMs = 0;
    let gapMs = SEND_GAP_MS;
    const report = (waitingMs = 0) => {
        const left = Math.ceil((plan.length - sent) / SESSIONS_PER_REQUEST);
        const perRequest = sent ? busyMs / Math.ceil(sent / SESSIONS_PER_REQUEST) : null;
        onProgress?.({ sent, total: plan.length, etaMs: perRequest == null ? null : left * perRequest + waitingMs, waitingMs });
    };

    while (sent < plan.length && !signal.aborted) {
        const started = Date.now();
        const batch = Array.from({ length: Math.min(SESSIONS_PER_REQUEST, plan.length - sent) }, (_, i) => plan.at(sent + i));
        try {
            const sentAt = Date.now();
            await send(batch.flatMap(p => session(p.game, p.durationMs, p.end, sentAt)));
        } catch (e: any) {
            if (signal.aborted) break;
            if (e?.blocked) throw new CreditError(sent, plan.length, e);
            const status = e?.status;
            if (status === 429) {
                const delay = retryAfterMs(e);
                gapMs = Math.min(gapMs * 2, 10_000);
                report(delay);
                await wait(delay, signal);
                continue;
            }
            if ((status == null || status >= 500) && ++failures <= MAX_FAILURES) {
                const delay = 2000 * 2 ** (failures - 1);
                report(delay);
                await wait(delay, signal);
                continue;
            }
            throw new CreditError(sent, plan.length, e);
        }
        failures = 0;
        gapMs = Math.max(SEND_GAP_MS, gapMs * 0.9);
        sent += batch.length;
        await wait(gapMs, signal);
        busyMs += Date.now() - started;
        report();
    }
    return sent;
}

export async function loadPlayedIds() {
    const { body } = await RestAPI.get({ url: "/users/@me/activities/statistics/applications" });
    return new Set((body as { application_id: string; }[]).map(s => s.application_id));
}
