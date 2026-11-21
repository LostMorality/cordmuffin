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
import { RestAPI, UserStore, useEffect, useState } from "@webpack/common";

const cl = classNameFactory("vc-gts-");

const ShowCurrentGame = getUserSettingLazy<boolean>("status", "showCurrentGame")!;

// NoTrack's switches only take effect after a restart, so the values Discord started with are the ones in force.
// Its badge tracking option (on by default) lets Discord's own game reports through even while analytics are blocked.
export const analyticsBlocked = Settings.plugins.NoTrack?.disableAnalytics !== false && Settings.plugins.NoTrack?.allowBadgeTracking === false;

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

// Discord's badge page names "Use data to personalize my Discord experience" as required for Game Time and Game
// Variety progress. With it off, the play time is accepted and then never counted.
const PERSONALIZE = "personalization";
type Consent = boolean | null | "unknown";
let consent: Consent = null;
let consentFor = "";
let consentLoad: Promise<void> | null = null;
const consentListeners = new Set<() => void>();

function setConsent(next: Consent) {
    consent = next;
    consentListeners.forEach(l => l());
}

function readConsent(body: any): Consent {
    const entry = body?.[PERSONALIZE];
    return entry && typeof entry.consented === "boolean" ? entry.consented : "unknown";
}

function loadConsent() {
    const me = UserStore.getCurrentUser()?.id ?? "";
    if (consentLoad || consentFor === me && consent !== null && consent !== "unknown") return consentLoad;
    consentFor = me;
    consentLoad = RestAPI.get({ url: "/users/@me/consent" })
        .then(res => setConsent(readConsent(res?.body)), () => setConsent("unknown"))
        .finally(() => void (consentLoad = null));
    return consentLoad;
}

async function grantConsent() {
    const res = await RestAPI.post({ url: "/users/@me/consent", body: { grant: [PERSONALIZE], revoke: [] } });
    setConsent(readConsent(res?.body));
}

/** true = on, false = off (play time won't count), null = still checking, "unknown" = couldn't check. */
export function usePersonalization() {
    const [, rerender] = useState(0);
    useEffect(() => {
        const listener = () => rerender(n => n + 1);
        consentListeners.add(listener);
        void loadConsent();
        return () => void consentListeners.delete(listener);
    }, []);
    return consent;
}

function ConsentWarning() {
    const state = usePersonalization();
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
    if (state !== false) return null;

    const turnOn = () => {
        setBusy(true);
        setFailed(false);
        grantConsent().catch(() => setFailed(true)).finally(() => setBusy(false));
    };

    return (
        <Notice.Danger
            className={cl("notice")}
            action={<Button size="small" onClick={turnOn} disabled={busy}>{busy ? "Turning on..." : "Turn On"}</Button>}
        >
            Discord's "Use data to personalize my Discord experience" setting is off, so Discord ignores the play time. Turn it on first (Settings → Data &amp; Privacy).
            {failed && " Couldn't change it from here, so switch it on in Discord's settings."}
        </Notice.Danger>
    );
}

function list(names: string[]) {
    return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function Conflicts({ spoofing }: { spoofing?: boolean; }) {
    const showing = ShowCurrentGame.useSetting();
    const blockers = trackingBlockers();

    return (
        <>
            <ConsentWarning />
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
