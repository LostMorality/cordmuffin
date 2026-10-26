/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isPluginEnabled } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import { OptionType, PluginNative } from "@utils/types";

import { KNOWN_BROKEN } from "./bd/known";
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
    bdBroken: {
        type: OptionType.CUSTOM,
        description: "",
        default: "{}" as string,
    },
    bdDeclarationFinds: {
        type: OptionType.CUSTOM,
        description: "",
        default: [] as string[],
    },
});

export interface BrokenMark {
    version?: string;
    reason: string;
}

function readBroken(): Record<string, BrokenMark> {
    try {
        const value = JSON.parse(settings.store.bdBroken);
        return value && typeof value === "object" ? value : {};
    } catch {
        return {};
    }
}

// Plugins that failed in Muffinshelf, by name. A new version clears the mark, since it may have been fixed.
export function getBroken(name: string, version?: string): BrokenMark | undefined {
    const mark = readBroken()[name];
    if (mark && (!version || !mark.version || mark.version === version)) return mark;
    const known = KNOWN_BROKEN[name];
    return known && known.version === version ? known : undefined;
}

export function setBroken(name: string, mark: BrokenMark | null) {
    const all = readBroken();
    if (mark) all[name] = { version: mark.version, reason: mark.reason.slice(0, 300) };
    else if (name in all) delete all[name];
    else return;
    settings.store.bdBroken = JSON.stringify(all);
}

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
