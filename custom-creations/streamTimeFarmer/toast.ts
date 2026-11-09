/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByCodeLazy } from "@webpack";
import { showToast } from "@webpack/common";

type ToastOptions = Parameters<typeof showToast>[0];

// Equicord's own showToast lookup broke with a Discord update in November 2026, so fall back to finding Discord's
// toast function directly. A toast is never worth crashing the farm over, so failures are swallowed.
const discordToast: (options: ToastOptions) => void = findByCodeLazy("currentToastMap.get(", "toastKey");

export function toast(options: ToastOptions) {
    try {
        showToast(options);
        return;
    } catch { }
    try {
        discordToast(options);
    } catch { }
}
