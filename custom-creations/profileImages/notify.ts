/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { findByCodeLazy } from "@webpack";
import type { showToast } from "@webpack/common";

type ToastOptions = Parameters<typeof showToast>[0];

// Our own lookup of Discord's toast function. Equicord's showToast quietly logs to the console when its lookup fails,
// so it can't tell us the toast never showed; calling this lazy throws instead, and we fall back to a notification.
const discordToast: (options: ToastOptions) => void = findByCodeLazy(".currentToastMap.get(", "setState");

function toast(options: ToastOptions) {
    try {
        discordToast(options);
        return true;
    } catch {
        return false;
    }
}

// Discord's toasts cut text off after about two lines, so longer messages go to a notification that shows all of it.
const TOAST_FITS = 50;

const COLORS = { default: undefined, success: "var(--status-positive)", critical: "var(--status-danger)" };

export function notify(text: string, variant: keyof typeof COLORS = "default", title = "ProfileImages") {
    if (text.length <= TOAST_FITS && toast({ text, variant })) return;
    showNotification({ title, body: text, color: COLORS[variant] });
}
