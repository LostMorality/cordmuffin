/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type ClientKind = "desktop" | "web" | "mobile" | "embedded" | "vr";

export interface Platform {
    label: string;
    shows: ClientKind;
    props: Record<string, string>;
    drop: readonly string[];
}

const WINDOWS_ONLY = ["os_version", "os_sdk_version", "os_build_revision", "os_version_is_release"] as const;
const DESKTOP_APP_ONLY = [...WINDOWS_ONLY, "client_version", "native_build_number", "os_arch", "app_arch", "client_launch_id", "launch_signature"] as const;

// One entry per icon other people can see. Each sends what one real app sends: Phone is the Android app, Console is the Xbox app.
export const PLATFORMS = {
    desktop: {
        label: "Desktop",
        shows: "desktop",
        props: { os: "Windows", browser: "Discord Client" },
        drop: []
    },
    web: {
        label: "Web",
        shows: "web",
        props: {
            os: "Windows",
            browser: "Chrome",
            device: "",
            browser_user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
            browser_version: "142.0.0.0",
            os_version: "10"
        },
        drop: DESKTOP_APP_ONLY.filter(k => k !== "os_version")
    },
    phone: {
        label: "Phone",
        shows: "mobile",
        props: { os: "Android", browser: "Discord Android", device: "panther", os_version: "34", browser_user_agent: "", browser_version: "" },
        drop: DESKTOP_APP_ONLY.filter(k => k !== "os_version")
    },
    console: {
        label: "Console",
        shows: "embedded",
        props: { os: "Xbox", browser: "Discord Embedded", device: "" },
        drop: DESKTOP_APP_ONLY
    },
    vr: {
        label: "VR headset",
        shows: "vr",
        props: { os: "android", browser: "Discord VR", device: "Discord VR", browser_user_agent: "", browser_version: "" },
        drop: DESKTOP_APP_ONLY
    }
} as const satisfies Record<string, Platform>;

export type PlatformId = keyof typeof PLATFORMS | "off";

export const PLATFORM_IDS = Object.keys(PLATFORMS) as (keyof typeof PLATFORMS)[];

export const SHOWS_LABEL: Record<string, string> = {
    desktop: "Desktop",
    web: "Web",
    mobile: "Mobile",
    embedded: "Console",
    vr: "VR",
    unknown: "Unknown"
};

// Ids used by older versions and by the original PlatformSpoofer.
const OLD_IDS: Record<string, keyof typeof PLATFORMS> = {
    android: "phone",
    ios: "phone",
    xbox: "console",
    playstation: "console",
    mac: "desktop",
    linux: "desktop"
};

export const upgradePlatformId = (v: unknown): unknown => typeof v === "string" && Object.hasOwn(OLD_IDS, v) ? OLD_IDS[v] : v;

export const isPlatformId = (v: unknown): v is PlatformId => v === "off" || (typeof v === "string" && Object.hasOwn(PLATFORMS, v));

export const platformLabel = (id: PlatformId) => id === "off" ? "Real platform (off)" : PLATFORMS[id].label;
