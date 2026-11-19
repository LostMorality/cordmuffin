/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NOTICE_COLORS, showNotice, tryToast } from "../toast";

// Discord's toasts cut text off after about two lines, so longer messages go to a notification that shows all of it.
const TOAST_FITS = 50;

export function notify(text: string, variant: keyof typeof NOTICE_COLORS = "default", title = "StreamTimeFarmer") {
    if (text.length <= TOAST_FITS && tryToast({ text, variant })) return;
    showNotice(text, variant, title);
}
