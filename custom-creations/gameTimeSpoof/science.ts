/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByPropsLazy } from "@webpack";
import { RestAPI } from "@webpack/common";

const SuperProperties: { getSuperProperties(): Record<string, unknown>; } = findByPropsLazy("getSuperProperties");

export interface ReportedGame {
    id: string;
    name: string;
    processName: string;
    fingerprint?: string;
}

let analyticsToken: string | null = null;
let sequence = 0;

async function getAnalyticsToken() {
    if (analyticsToken) return analyticsToken;
    const { body } = await RestAPI.get({ url: "/users/@me", query: { with_analytics_token: true } });
    analyticsToken = body.analytics_token as string;
    return analyticsToken;
}

function sessionIds() {
    const props = SuperProperties.getSuperProperties();
    return {
        client_heartbeat_session_id: props.client_heartbeat_session_id ?? crypto.randomUUID(),
        launch_signature: props.launch_signature ?? crypto.randomUUID(),
        rendered_locale: props.system_locale ?? "en-US"
    };
}

function heartbeat(game: ReportedGame, durationMs: number, sessionId: string, initial: boolean, at: number) {
    const { client_heartbeat_session_id, launch_signature } = sessionIds();
    return {
        type: "running_game_heartbeat",
        properties: {
            client_track_timestamp: at,
            client_heartbeat_session_id,
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
            launch_signature,
            client_app_state: "focused",
            client_send_timestamp: at
        }
    };
}

function launch(game: ReportedGame, at: number) {
    return {
        type: "launch_game",
        properties: {
            ...sessionIds(),
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
            client_send_timestamp: at,
            ...game.fingerprint && { executable_fingerprint: game.fingerprint }
        }
    };
}

function session(game: ReportedGame, durationMs: number, end: number) {
    const sessionId = crypto.randomUUID();
    const start = end - durationMs;
    return [heartbeat(game, 0, sessionId, true, start), launch(game, start), heartbeat(game, durationMs, sessionId, false, end)];
}

export async function reportPlaytime(game: ReportedGame, durationMs: number) {
    await RestAPI.post({ url: "/science", body: { token: await getAnalyticsToken(), events: session(game, durationMs, Date.now()) } });
}

const MAX_SESSION_MS = 24 * 60 * 60_000;
const SESSIONS_PER_REQUEST = 10;

export async function creditPlaytime(games: ReportedGame[], durationMs: number, onProgress?: (done: number, total: number) => void) {
    const now = Date.now();
    const sessions: ReturnType<typeof session>[] = [];
    for (const game of games) {
        for (let offset = 0; offset < durationMs; offset += MAX_SESSION_MS) {
            sessions.push(session(game, Math.min(MAX_SESSION_MS, durationMs - offset), now - offset));
        }
    }

    for (let i = 0; i < sessions.length; i += SESSIONS_PER_REQUEST) {
        await RestAPI.post({ url: "/science", body: { token: await getAnalyticsToken(), events: sessions.slice(i, i + SESSIONS_PER_REQUEST).flat() } });
        onProgress?.(Math.min(i + SESSIONS_PER_REQUEST, sessions.length), sessions.length);
        await new Promise(r => setTimeout(r, 500));
    }
}
