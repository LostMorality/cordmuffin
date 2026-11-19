/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { findByCodeLazy } from "@webpack";
import type { showToast } from "@webpack/common";

type ToastOptions = Parameters<typeof showToast>[0];

// Discord's own toast function, looked up directly. Equicord's showToast quietly turns into a console log when its
// lookup misses, so it can't tell us a toast failed. This lazy throws when called if the lookup misses, which sends the
// message to a notification instead. A failed toast must never break what the plugin was doing.
const discordToast: (options: ToastOptions) => void = findByCodeLazy("currentToastMap.get(", "toastKey");

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

export function notify(text: string, variant: keyof typeof COLORS = "default", onClick?: () => void) {
    if (text.length <= TOAST_FITS && !onClick && toast({ text, variant })) return;
    showNotification({ title: "Discrub Loader", body: text, color: COLORS[variant], onClick });
}
