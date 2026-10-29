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
    const { target } = settings.use(["target"]);
    const options = useMemo(() => Object.entries(languages)
        .filter(([code]) => !["auto", "tp", "sh"].includes(code))
        .map(([value, label]) => ({ value, label })), []);

    return (
        <SettingsSection id="target" name="Target Language" description="The language messages get translated into. Type to search.">
            <SearchableSelect
                options={options}
                value={options.find(o => o.value === target)?.value}
                placeholder="Select a language"
                maxVisibleItems={6}
                closeOnSelect={true}
                onChange={v => settings.store.target = v}
            />
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
        description: "Use Yandex Translate instead of Google Translate. Free, no account or API key needed.",
        default: false
    },
    allowHost: {
        type: OptionType.COMPONENT,
        component: AllowHostNotice
    },
    toki: {
        type: OptionType.BOOLEAN,
        description: "Enable Toki Pona",
        default: true,
        restartNeeded: true
    },
    sitelen: {
        type: OptionType.BOOLEAN,
        description: "Enable Sitelen Pona",
        default: true,
        restartNeeded: true
    },
    shavian: {
        type: OptionType.BOOLEAN,
        description: "Enable Shavian",
        default: true,
        restartNeeded: true
    }
});
