/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isPluginEnabled } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import { OptionType, PluginNative } from "@utils/types";

import { startRuntime, stopRuntime } from "./bd/runtime";

export const Native = VencordNative.pluginHelpers.Muffinshelf as PluginNative<typeof import("./native")>;

export const settings = definePluginSettings({
    runBetterDiscord: {
        type: OptionType.BOOLEAN,
        description: "Run the BetterDiscord plugins you install from Muffinshelf.",
        default: true,
        onChange: (value: boolean) => {
            if (!value) stopRuntime();
            else if (isPluginEnabled("Muffinshelf")) startRuntime();
        },
    },
    customSources: {
        type: OptionType.CUSTOM,
        description: "",
        default: [] as string[],
    },
    disabledSources: {
        type: OptionType.CUSTOM,
        description: "",
        default: [] as string[],
    },
    bdEnabled: {
        type: OptionType.CUSTOM,
        description: "",
        default: [] as string[],
    },
    bdOrigins: {
        type: OptionType.CUSTOM,
        description: "",
        default: "{}" as string | Record<string, BdOrigin>,
    },
});

export interface BdOrigin {
    key: string;
    url: string;
    version?: string;
}

function readOrigins(): Record<string, BdOrigin> {
    const value = settings.store.bdOrigins;
    if (typeof value !== "string") return {};
    try {
        return JSON.parse(value);
    } catch {
        return {};
    }
}

export const getBdOrigin = (file: string): BdOrigin | undefined => readOrigins()[file];

export function setBdOrigin(file: string, origin: BdOrigin | null) {
    const origins = readOrigins();
    if (origin) origins[file] = { key: origin.key, url: origin.url, version: origin.version };
    else delete origins[file];
    settings.store.bdOrigins = JSON.stringify(origins);
}
