/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { findByPropsLazy } from "@webpack";

export const logger = new Logger("PlatformSpoofer+");

export interface GatewaySocket {
    sessionId: string | null;
    seq: number;
    connectionState: string;
    webSocket: WebSocket | null;
    nextReconnectIsImmediate?: boolean;
    isConnected(): boolean;
    isClosed(): boolean;
    _cleanup?(cb: (ws: WebSocket) => void): void;
    _connect?(): void;
}

const GatewayConnectionStore: { getSocket(): GatewaySocket | null | undefined; } = findByPropsLazy("getSocket", "isConnected");

export function getSocket(): GatewaySocket | null {
    try {
        return GatewayConnectionStore.getSocket() ?? null;
    } catch {
        return null;
    }
}

const MIN_GAP_MS = 4000;
let lastReconnect = 0;
let pending: ReturnType<typeof setTimeout> | null = null;

/**
 * Drops the current gateway session and opens a fresh one, so Discord runs a
 * full IDENTIFY (with our spoofed properties) instead of a RESUME.
 * Close code 1000 ends the old session right away, so it doesn't linger
 * in your session list as a second device.
 */
function reconnectNow(): boolean {
    const socket = getSocket();
    if (!socket) {
        logger.warn("Gateway socket not found, nothing to reconnect");
        return false;
    }
    if (socket.isClosed()) {
        logger.info("Gateway is closed (logged out?), skipping reconnect");
        return false;
    }

    lastReconnect = Date.now();
    socket.sessionId = null;
    socket.seq = 0;

    try {
        if (typeof socket._cleanup === "function" && typeof socket._connect === "function") {
            socket._cleanup(ws => ws.close(1000));
            socket.connectionState = "WILL_RECONNECT";
            socket.nextReconnectIsImmediate = true;
            socket._connect();
            return true;
        }
    } catch (e) {
        logger.error("Fast reconnect failed, falling back to closing the socket", e);
    }

    // Fallback: Discord's own close handler reconnects, and with sessionId gone it has to identify.
    const ws = socket.webSocket;
    if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
        ws.close(1000);
        return true;
    }
    return false;
}

/**
 * Reconnect, but never more than once every few seconds. Rapid changes are
 * folded into one reconnect that uses whatever is picked last.
 */
export function scheduleReconnect(onDone?: (ok: boolean) => void) {
    if (pending) clearTimeout(pending);
    const wait = Math.max(300, MIN_GAP_MS - (Date.now() - lastReconnect));
    pending = setTimeout(() => {
        pending = null;
        const ok = reconnectNow();
        onDone?.(ok);
    }, wait);
}

export const isReconnectPending = () => pending != null;

export function cancelReconnect() {
    if (pending) clearTimeout(pending);
    pending = null;
}
