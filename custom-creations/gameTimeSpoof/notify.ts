/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { Logger } from "@utils/Logger";
import type { ToastData } from "@vencord/discord-types";
import { filters, find } from "@webpack";

const logger = new Logger("GameTimeSpoof");

// Equicord's showToast never throws when its lookup breaks, it only logs, so a lost toast looks like a shown one.
// Looking Discord's toast function up here means a missing one falls back to a notification instead of vanishing.
const TOASTER_FILTERS = [
    filters.byCode(".currentToastMap.get(", "setState"),
    filters.byCode("currentToastMap.get(", "toastKey")
];

let toaster: ((data: ToastData) => void) | null = null;

function findToaster() {
    if (toaster) return toaster;
    for (const filter of TOASTER_FILTERS) {
        const found = find(filter, { isIndirect: true });
        if (typeof found === "function") return toaster = found;
    }
    return null;
}

// A failed toast must never break what the plugin was doing.
function toast(options: ToastData) {
    try {
        const show = findToaster();
        if (!show) return false;
        show(options);
        return true;
    } catch (e) {
        logger.warn("Couldn't show a toast", e);
        return false;
    }
}

// Discord's toasts cut text off after about two lines, so longer messages go to a notification that shows all of it.
const TOAST_FITS = 50;

const COLORS = { default: undefined, success: "var(--status-positive)", critical: "var(--status-danger)" };

export function notify(text: string, variant: keyof typeof COLORS = "default", title = "GameTimeSpoof") {
    if (text.length <= TOAST_FITS && toast({ text, variant })) return;
    showNotification({ title, body: text, color: COLORS[variant] });
}
