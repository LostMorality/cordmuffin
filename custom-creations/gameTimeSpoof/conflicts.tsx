/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isPluginEnabled, plugins } from "@api/PluginManager";
import { Settings } from "@api/Settings";
import { getUserSettingLazy } from "@api/UserSettings";
import { Button } from "@components/Button";
import { Notice } from "@components/Notice";
import { classNameFactory } from "@utils/css";

const cl = classNameFactory("vc-gts-");

const ShowCurrentGame = getUserSettingLazy<boolean>("status", "showCurrentGame")!;

// NoTrack's analytics switch only takes effect after a restart, so the value Discord started with is the one in force.
export const analyticsBlocked = Settings.plugins.NoTrack?.disableAnalytics !== false;

const BLOCKER = /(do[\s_-]*not|dont|no|anti|stop)[\s_-]*track|tracking|analytics|telemetry/i;

// Equicord's own NoTrack is fine: it only drops Discord's own reports, and the plugin sends its reports itself.
export function trackingBlockers() {
    const found = Object.keys(plugins).filter(name => name !== "NoTrack" && BLOCKER.test(name) && isPluginEnabled(name));
    if (isPluginEnabled("Muffinshelf")) {
        const bd = Settings.plugins.Muffinshelf?.bdEnabled;
        if (Array.isArray(bd)) {
            for (const file of bd) {
                const name = String(file).replace(/\.plugin\.js$/i, "");
                if (BLOCKER.test(name)) found.push(name);
            }
        }
    }
    return found;
}

function list(names: string[]) {
    return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function Conflicts({ spoofing }: { spoofing?: boolean; }) {
    const showing = ShowCurrentGame.useSetting();
    const blockers = trackingBlockers();

    return (
        <>
            {spoofing && showing === false && (
                <Notice.Warning
                    className={cl("notice")}
                    action={<Button size="small" variant="secondary" onClick={() => ShowCurrentGame.updateSetting(true)}>Turn On</Button>}
                >
                    Discord's "Share your detected activities with others" setting is off, so nobody can see the games you spoof. Play time still counts.
                    {blockers.some(n => /donottrack/i.test(n)) && " DoNotTrack turns this off by itself; switch off its Stop Process Monitor option to keep it on."}
                </Notice.Warning>
            )}
            {blockers.length > 0 && (
                <Notice.Warning className={cl("notice")}>
                    {list(blockers)} may block the play time GameTimeSpoof sends to Discord. If adding time fails, turn {blockers.length > 1 ? "them" : "it"} off and try again.
                </Notice.Warning>
            )}
        </>
    );
}
