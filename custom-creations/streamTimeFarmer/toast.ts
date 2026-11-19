/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { Logger } from "@utils/Logger";
import type { ToastData } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";

const logger = new Logger("StreamTimeFarmer");

// Equicord's own showToast never fails: when it can't find Discord's toasts it only writes the text to the console.
// So Discord's toast function is looked up here directly, by two of its tells, and a toast that can't be shown
// becomes a notification instead of disappearing.
const toasters: ((options: ToastData) => void)[] = [
    findByCodeLazy("currentToastMap.get(", "toastKey"),
    findByCodeLazy(".currentToastMap.get(", "setState")
];

export const NOTICE_COLORS = { default: undefined, success: "var(--status-positive)", critical: "var(--status-danger)" };

export function showNotice(text: string, variant: keyof typeof NOTICE_COLORS = "default", title = "StreamTimeFarmer") {
    showNotification({ title, body: text, color: NOTICE_COLORS[variant] })
        .catch(e => logger.warn("Couldn't show a notification:", text, e));
}

// Whether Discord's toast showed it.
export function tryToast(options: ToastData) {
    for (const show of toasters) {
        try {
            show(options);
            return true;
        } catch { }
    }
    return false;
}

export function toast(options: ToastData) {
    if (!tryToast(options)) showNotice(options.text, options.variant);
}
