/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useState } from "@webpack/common";

const MEASURE_EVERY_MS = 1000;

function safely<T>(measure: () => T, fallback: T) {
    try {
        return measure();
    } catch {
        return fallback;
    }
}

// Discord moves things around without telling anyone (a banner, another channel, its stream preview), so a floating
// box that has to stay clear of them measures again every second and on resize. Only a changed answer redraws.
export function useLayout<T>(measure: () => T, fallback: T): T {
    const [value, setValue] = useState(() => safely(measure, fallback));
    useEffect(() => {
        let last = JSON.stringify(value);
        const update = () => {
            const next = safely(measure, fallback);
            const json = JSON.stringify(next);
            if (json === last) return;
            last = json;
            setValue(next);
        };
        const timer = setInterval(update, MEASURE_EVERY_MS);
        window.addEventListener("resize", update);
        update();
        return () => {
            clearInterval(timer);
            window.removeEventListener("resize", update);
        };
    }, []);
    return value;
}
