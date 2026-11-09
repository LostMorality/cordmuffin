/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { findByCodeLazy } from "@webpack";
import { showToast } from "@webpack/common";

type ToastOptions = Parameters<typeof showToast>[0];

// Equicord's own showToast lookup broke with a Discord update in November 2026, so fall back to Discord's toast
// function directly. A failed toast must never break what the plugin was doing.
const discordToast: (options: ToastOptions) => void = findByCodeLazy("currentToastMap.get(", "toastKey");

function toast(options: ToastOptions) {
    for (const show of [showToast, discordToast]) {
        try {
            show(options);
            return true;
        } catch { }
    }
    return false;
}

// Discord's toasts cut text off after about two lines, so longer messages go to a notification that shows all of it.
const TOAST_FITS = 50;

const COLORS = { default: undefined, success: "var(--status-positive)", critical: "var(--status-danger)" };

export function notify(text: string, variant: keyof typeof COLORS = "default", title = "Muffinshelf") {
    if (text.length <= TOAST_FITS && toast({ text, variant })) return;
    showNotification({ title, body: text, color: COLORS[variant] });
}
