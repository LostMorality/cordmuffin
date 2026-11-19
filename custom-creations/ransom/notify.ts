/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import type { ToastData } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";

// Discord's own toast function, looked up directly. Equicord's showToast never throws: when its lookup fails it just
// logs the text, so nothing would ever show. This lookup throws instead, and the message falls back to a notification.
const discordToast: (data: ToastData) => void = findByCodeLazy("currentToastMap.get(", "queuedToastsMap");

function toast(data: ToastData) {
    try {
        discordToast(data);
        return true;
    } catch {
        return false;
    }
}

// Discord's toasts cut text off after about two lines, so longer messages go to a notification that shows all of it.
const TOAST_FITS = 50;

const COLORS = { default: undefined, success: "var(--status-positive)", critical: "var(--status-danger)" };

export function notify(text: string, variant: keyof typeof COLORS = "default", title = "Ransom") {
    if (text.length <= TOAST_FITS && toast({ text, variant })) return;
    showNotification({ title, body: text, color: COLORS[variant] });
}
