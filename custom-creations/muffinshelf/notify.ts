/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { filters, find } from "@webpack";
import type { showToast } from "@webpack/common";

type ToastOptions = Parameters<typeof showToast>[0];
type Toaster = (options: ToastOptions) => void;

// Equicord's showToast never throws: when its lookup misses, it quietly logs to the console instead. So Discord's toast
// function is looked up here, by either shape it has had, and a miss sends the message to a notification instead.
const TOASTER_SHAPES = [[".currentToastMap.get(", "setState"], ["currentToastMap.get(", "toastKey"]];
let toaster: Toaster | undefined;

function findToaster() {
    if (toaster) return toaster;
    for (const code of TOASTER_SHAPES) {
        const found = find(filters.byCode(...code), { isIndirect: true });
        if (typeof found === "function") return toaster = found;
    }
    return undefined;
}

export function toast(options: ToastOptions) {
    try {
        const show = findToaster();
        if (!show) return false;
        show(options);
        return true;
    } catch {
        return false;
    }
}

// Discord's toasts cut text off after about two lines, so longer messages go to a notification that shows all of it.
const TOAST_FITS = 50;

const COLORS = { default: undefined, success: "var(--status-positive)", critical: "var(--status-danger)" };

export function notify(text: string, variant: keyof typeof COLORS = "default", title = "Muffinshelf", duration?: number) {
    if (text.length <= TOAST_FITS && toast({ text, variant, duration })) return;
    showNotification({ title, body: text, color: COLORS[variant] });
}
