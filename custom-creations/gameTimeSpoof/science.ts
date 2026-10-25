/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sleep } from "@utils/misc";
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

export async function reportPlaytime(game: ReportedGame, durationMs: number) {
    const now = Date.now();
    await RestAPI.post({ url: "/science", body: { token: await getAnalyticsToken(), events: session(game, Math.min(durationMs, MAX_SESSION_MS), now, now) } });
}

export interface CreditPlan {
    game: ReportedGame;
    durationMs: number;
    end: number;
}

export function planCredit(games: ReportedGame[], durationMs: number) {
    const now = Date.now();
    const plan: CreditPlan[] = [];
    for (const game of games) {
        for (let offset = Math.ceil(durationMs / MAX_SESSION_MS) * MAX_SESSION_MS - MAX_SESSION_MS; offset >= 0; offset -= MAX_SESSION_MS) {
            plan.push({ game, durationMs: Math.min(MAX_SESSION_MS, durationMs - offset), end: now - offset });
        }
    }
    return plan;
}

export class CreditError extends Error {
    constructor(public sent: number, public total: number, cause: unknown) {
        super(`Sent ${sent} of ${total}`, { cause });
    }
}

export async function creditPlaytime(plan: CreditPlan[], signal: AbortSignal, onProgress?: (done: number, total: number) => void) {
    let sent = 0;
    try {
        for (let i = 0; i < plan.length; i += SESSIONS_PER_REQUEST) {
            if (signal.aborted) return sent;
            const sentAt = Date.now();
            const events = plan.slice(i, i + SESSIONS_PER_REQUEST).flatMap(p => session(p.game, p.durationMs, p.end, sentAt));
            await RestAPI.post({ url: "/science", body: { token: await getAnalyticsToken(), events } });
            sent = Math.min(i + SESSIONS_PER_REQUEST, plan.length);
            onProgress?.(sent, plan.length);
            await sleep(500);
        }
    } catch (e) {
        throw new CreditError(sent, plan.length, e);
    }
    return sent;
}
