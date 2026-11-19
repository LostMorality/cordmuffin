/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Notice } from "@components/Notice";
import { SettingsSection } from "@components/settings/tabs/plugins/components/Common";
import { useCspPermission } from "@utils/csp";
import { OptionType } from "@utils/types";
import { SearchableSelect, useMemo } from "@webpack/common";

import { languages } from "./misc/languages";

export const YANDEX_API = "https://translate.yandex.net/api/v1/tr.json/";

// Google code -> Yandex code where they differ. Yandex "zh" is Simplified only, so zh-TW has no Yandex match.
export const toYandex: Record<string, string> = { "zh-CN": "zh", "iw": "he", "jw": "jv" };

// Target codes Yandex accepts (from its getLangs list), in Yandex form.
const YANDEX_TARGETS = new Set([
    "af", "am", "ar", "az", "be", "bg", "bn", "bs", "ca", "ceb", "cs", "cy", "da", "de", "el", "en", "eo", "es", "et",
    "eu", "fa", "fi", "fr", "ga", "gd", "gl", "gu", "he", "hi", "hr", "ht", "hu", "hy", "id", "is", "it", "ja", "jv",
    "ka", "kk", "km", "kn", "ko", "ky", "la", "lb", "lo", "lt", "lv", "mg", "mi", "mk", "ml", "mn", "mr", "ms", "mt",
    "my", "ne", "nl", "no", "pa", "pl", "pt", "ro", "ru", "si", "sk", "sl", "sq", "sr", "su", "sv", "sw", "ta", "te",
    "tg", "th", "tl", "tr", "tt", "uk", "ur", "uz", "vi", "xh", "yi", "zh", "zu"
]);

export function yandexSupports(target: string) {
    return YANDEX_TARGETS.has(toYandex[target] ?? target);
}

function AllowHostNotice() {
    const { yandex } = settings.use(["yandex"]);
    const [isAllowed, allow] = useCspPermission(YANDEX_API, ["connect-src"], "TranslateItAll");
    if (!yandex || isAllowed) return null;

    return (
        <Notice variant="warning" action={<Button size="small" variant="secondary" onClick={allow}>Allow Host</Button>}>
            Connections to translate.yandex.net are blocked. Allow this host to use Yandex Translate, then restart Discord.
        </Notice>
    );
}

function TargetPicker() {
    const { target, yandex } = settings.use(["target", "yandex"]);
    const options = useMemo(() => Object.entries(languages)
        .filter(([code]) => !["auto", "tp", "sh"].includes(code))
        .map(([value, label]) => ({ value, label })), []);

    return (
        <SettingsSection id="target" name="Target Language" description="The language messages get translated into. Clear the box, then type to search.">
            <SearchableSelect
                options={options}
                value={options.find(o => o.value === target)?.value}
                placeholder="Select a language"
                maxVisibleItems={6}
                closeOnSelect={true}
                onChange={v => settings.store.target = v}
            />
            {yandex && !yandexSupports(target) && (
                <Notice variant="info">
                    Yandex Translate has no {languages[target] ?? target}, so Google Translate is used for this language.
                </Notice>
            )}
        </SettingsSection>
    );
}

export const settings = definePluginSettings({
    target: {
        type: OptionType.STRING,
        description: "Target language",
        default: "en",
        hidden: true
    },
    targetPicker: {
        type: OptionType.COMPONENT,
        component: TargetPicker
    },
    yandex: {
        type: OptionType.BOOLEAN,
        displayName: "Use Yandex Translate",
        description: "Use Yandex Translate instead of Google Translate. Free, no account or API key needed.",
        default: false
    },
    allowHost: {
        type: OptionType.COMPONENT,
        component: AllowHostNotice
    },
    toki: {
        type: OptionType.BOOLEAN,
        displayName: "Toki Pona",
        description: "Detect Toki Pona and translate it with a Toki Pona translator.",
        default: true
    },
    sitelen: {
        type: OptionType.BOOLEAN,
        displayName: "Sitelen Pona",
        description: "Read Sitelen Pona glyphs as Toki Pona and translate them.",
        default: true
    },
    shavian: {
        type: OptionType.BOOLEAN,
        displayName: "Shavian",
        description: "Turn Shavian script into English, then translate it if needed.",
        default: true
    }
});
