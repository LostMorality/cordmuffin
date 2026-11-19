/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { filters, find } from "@webpack";
import type { showToast } from "@webpack/common";

type ToastOptions = Parameters<typeof showToast>[0];

// Equicord's showToast never throws: when its lookup misses it quietly logs instead, so a toast could vanish.
// Looking Discord's toaster up here tells a miss apart, and a miss falls through to a notification.
let toaster: ((options: ToastOptions) => void) | null = null;

function findToaster() {
    if (!toaster) {
        try {
            toaster = find(filters.byCode("currentToastMap.get(", "toastKey"), { isIndirect: true }) ?? null;
        } catch {
            toaster = null;
        }
    }
    return toaster;
}

function toast(options: ToastOptions) {
    const show = findToaster();
    if (!show) return false;
    try {
        show(options);
        return true;
    } catch {
        return false;
    }
}

// Discord's toasts cut text off after about two lines, so longer messages go to a notification that shows all of it.
const TOAST_FITS = 50;

const COLORS = { default: undefined, success: "var(--status-positive)", critical: "var(--status-danger)" };

export function notify(text: string, variant: keyof typeof COLORS = "default", title = "QuestRunner") {
    if (text.length <= TOAST_FITS && toast({ text, variant })) return;
    showNotification({ title, body: text, color: COLORS[variant] });
}
