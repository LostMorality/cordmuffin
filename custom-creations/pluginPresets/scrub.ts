/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { plugins } from "@api/PluginManager";
import { OptionType, PluginSettingDef } from "@utils/types";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json; };

export interface Removed {
    plugin: string;
    setting: string;
    reason: string;
}

// Plugins whose text and number settings are private as a whole (accounts, servers, API keys, rich presence text).
const PRIVATE_PLUGINS = new Set([
    "customrpc", "statuspresets", "rpceditor", "richpresence", "musicrichpresence", "lastfmrichpresence",
    "listenbrainzrpc", "fileupload", "clipupload", "songspotlight", "steamstatussync", "triviaai", "questify",
    "voicemessagetranscriber", "messagetranslate", "translateplus", "translateitall", "customstatustimeouts",
    "webhookmanager", "encryptcord", "settingssync", "cloudsync",
]);

// Single settings known to hold keys or account data, for plugins that are otherwise fine to share.
const PRIVATE_SETTINGS: Record<string, string[]> = {
    translate: ["deeplApiKey", "autoTranslate"],
    messageloggerenhanced: ["blacklistedIds", "whitelistedIds", "ignoreUsers", "ignoreChannels", "ignoreGuilds"],
    messagelogger: ["ignoreUsers", "ignoreChannels", "ignoreGuilds"],
    reviewdb: ["user", "token"],
    decor: ["token"],
    themelibrary: ["token", "authToken"],
};

const KEY_RULES: [RegExp, string][] = [
    [/pass(word|wd|phrase)?$|secret|token|api_?key|access_?key|private_?key|client_?(id|secret)|credential|auth|bearer|jwt|cookie|session|oauth|webhook|signature|cert(ificate)?$|salt$|seed$/i, "looks like a password, token or key"],
    [/(^|_)key$/i, "looks like a password, token or key"],
    [/(^id$|^ids$|[a-z0-9_](Id|ID|Ids|IDs)$|_ids?$)/, "may hold account, channel or server IDs"],
    [/users?|channels?|guilds?|servers?|members?|friends?|roles?|accounts?|authors?|owners?|dms?$|whitelist|blacklist|allowlist|blocklist|denylist|ignore/i, "may list accounts, channels or servers"],
    [/path|dir(ectory)?$|folder|file(name)?s?$|location/i, "may hold a file path"],
    [/url|uri$|link|host|endpoint|domain|proxy|^ip$|ip_?address|address|email|phone|instance/i, "may point at a private server or address"],
    [/name$|nick|bio|about|status|note|message|reply|text|template|greeting|caption|title|description|reason|custom|content|words?$|phrases?|keywords?|prefix|suffix|regex|pattern|trigger|response|label|tags?$|emoji|sticker|sound|image|avatar|banner/i, "free text that may be personal"],
];

const VALUE_RULES: [RegExp, string][] = [
    [/[\w-]{23,28}\.[\w-]{6,7}\.[\w-]{27,}/, "looks like a Discord token"],
    [/mfa\.[\w-]{20,}/, "looks like a Discord token"],
    [/eyJ[\w-]{8,}\.[\w-]{8,}/, "looks like a login token"],
    [/\b(sk|pk|rk)[-_][\w-]{16,}|\bgh[pousr]_\w{20,}|\bxox[abprs]-[\w-]{10,}|\bAIza[\w-]{30,}|\bAKIA[0-9A-Z]{16}|\bya29\.[\w-]+/, "looks like an API key"],
    [/discord(app)?\.com\/api\/(v\d+\/)?webhooks/i, "Discord webhook"],
    [/(?<!\d)\d{17,20}(?!\d)/, "contains a Discord ID"],
    [/[\w.+-]+@[\w-]+\.[\w.-]+/, "email address"],
    [/^[a-z]:[\\/]|\\\\|(^|[\s"'=])\/(home|users|mnt|media|var|opt|root|tmp|private)\/|~[\\/]|%[a-z]+%/i, "file path"],
    [/\b\d{1,3}(\.\d{1,3}){3}\b/, "IP address"],
    [/[a-z][a-z\d+.-]*:\/\/|\bwww\./i, "web address"],
    [/[a-f0-9]{24,}/i, "looks like a key"],
];

const SAFE_TEXT = /^[\p{L}\p{N} #.,:;%+\-_()'/!?*&=<>[\]{}|^~]*$/u;

// Long unbroken mixes of letters and digits are how keys and tokens look.
function looksLikeSecret(text: string) {
    for (const word of text.split(/[\s,;]+/)) {
        if (word.length >= 32 && /^[\w\-+/=.:]+$/.test(word)) return true;
        if (word.length >= 16 && /\d/.test(word) && /[a-z]/i.test(word) && /^[\w\-+/=.]+$/.test(word)) return true;
    }
    return false;
}

export function valueProblem(text: string): string | null {
    for (const [re, reason] of VALUE_RULES) if (re.test(text)) return reason;
    if (looksLikeSecret(text)) return "looks like a key or token";
    if (/\d{6,}/.test(text)) return "contains a long number (may be an ID)";
    return null;
}

function keyProblem(key: string) {
    if (/hot_?key|keybind|shortcut|modifier/i.test(key)) return null;
    for (const [re, reason] of KEY_RULES) if (re.test(key)) return reason;
    return null;
}

function isSafeText(text: string) {
    return text.length <= 40 && SAFE_TEXT.test(text) && !valueProblem(text);
}

export function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a as object), kb = Object.keys(b as object);
    return ka.length === kb.length && ka.every(k => deepEqual((a as any)[k], (b as any)[k]));
}

export function defaultOf(def: PluginSettingDef | undefined): unknown {
    if (!def) return undefined;
    if (def.type === OptionType.SELECT) return def.options.find(o => o.default)?.value;
    return "default" in def ? def.default : undefined;
}

function isEmpty(value: Json) {
    return value === "" || value === null || (Array.isArray(value) && !value.length)
        || (typeof value === "object" && value !== null && !Array.isArray(value) && !Object.keys(value).length);
}

/**
 * Splits one plugin's settings into what's safe to share and what isn't. Anything that can't be shown to be
 * harmless is dropped: only switches, choices from the plugin's own list, plain numbers, default values and short
 * plain words survive. Empty values carry nothing, so they're dropped without being reported.
 */
export function scrubSettings(plugin: string, values: Record<string, Json>) {
    const kept: Record<string, Json> = {};
    const removed: Removed[] = [];
    const defs = plugins[plugin]?.settings?.def ?? {};
    const lower = plugin.toLowerCase();
    const privatePlugin = PRIVATE_PLUGINS.has(lower);
    const privateKeys = new Set(PRIVATE_SETTINGS[lower] ?? []);

    for (const [key, value] of Object.entries(values)) {
        const def: PluginSettingDef | undefined = Object.prototype.hasOwnProperty.call(defs, key) ? defs[key] : undefined;
        const drop = (reason: string) => { if (!isEmpty(value)) removed.push({ plugin, setting: key, reason }); };

        if (!def || def.type === OptionType.COMPONENT) {
            drop("data the plugin stores for itself, not a listed setting");
            continue;
        }
        if (def.type === OptionType.BOOLEAN) {
            if (typeof value === "boolean") kept[key] = value;
            else drop("not a valid on/off value");
            continue;
        }
        if (def.type === OptionType.SELECT) {
            if (def.options.some(o => o.value === value)) kept[key] = value;
            else drop("not one of the plugin's choices");
            continue;
        }

        const fallback = defaultOf(def);
        if (fallback !== undefined && typeof fallback !== "bigint" && deepEqual(value, fallback)) {
            kept[key] = value;
            continue;
        }
        if (privatePlugin) {
            drop("this plugin's settings hold account or server details");
            continue;
        }
        if (privateKeys.has(key)) {
            drop("known private setting for this plugin");
            continue;
        }

        switch (def.type) {
            case OptionType.NUMBER:
            case OptionType.SLIDER: {
                const reason = keyProblem(key);
                if (typeof value !== "number" || !Number.isFinite(value)) drop("not a valid number");
                else if (Math.abs(value) >= 1e10) drop("number large enough to be an ID");
                else if (reason && /IDs|accounts/.test(reason)) drop(reason);
                else kept[key] = value;
                break;
            }
            case OptionType.STRING: {
                if (typeof value !== "string") {
                    drop("not valid text");
                    break;
                }
                if (value === "") {
                    kept[key] = value;
                    break;
                }
                const reason = keyProblem(key) ?? valueProblem(value);
                if (reason) drop(reason);
                else if (!isSafeText(value)) drop("free text that may be personal");
                else kept[key] = value;
                break;
            }
            case OptionType.BIGINT:
                drop("number large enough to be an ID");
                break;
            default:
                drop("custom data the plugin stores; it can't be checked for private details");
        }
    }

    return { kept, removed };
}
