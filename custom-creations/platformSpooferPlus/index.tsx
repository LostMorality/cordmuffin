/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { isPluginEnabled } from "@api/PluginManager";
import { definePluginSettings, migratePluginSettings, SettingsStore, useSettings } from "@api/Settings";
import { addUserAreaButton } from "@api/UserArea";
import ErrorBoundary from "@components/ErrorBoundary";
import { Notice } from "@components/Notice";
import definePlugin, { OptionType } from "@utils/types";
import { findByCodeLazy } from "@webpack";
import { Alerts, AuthenticationStore, Menu, SessionsStore, showToast as equicordShowToast, useEffect, useReducer } from "@webpack/common";

import { PlatformButton, PlatformIcon } from "./Button";
import { cancelReconnect, GatewaySocket, isReconnectPending, logger, scheduleReconnect } from "./gateway";
import { StatusPanel } from "./Panel";
import { isPlatformId, PLATFORM_IDS, PlatformId, platformLabel, PLATFORMS, SHOWS_LABEL, upgradePlatformId } from "./platforms";

// Equicord's own showToast lookup broke with a Discord update in November 2026, so fall back to Discord's toast
// function directly. A failed toast must never break what the plugin was doing.
const discordToast: typeof equicordShowToast = findByCodeLazy("currentToastMap.get(", "toastKey");

function showToast(options: Parameters<typeof equicordShowToast>[0]) {
    for (const show of [equicordShowToast, discordToast]) {
        try {
            show(options);
            return;
        } catch { }
    }
}

const PLUGIN_NAME = "PlatformSpoofer+";

const OLD_NAME = "PlatformSpoofer";
const fromOldPlugin = !(PLUGIN_NAME in SettingsStore.plain.plugins) && OLD_NAME in SettingsStore.plain.plugins;
migratePluginSettings(PLUGIN_NAME, OLD_NAME);
const saved = SettingsStore.plain.plugins[PLUGIN_NAME];
if (saved) {
    let changed = false;
    // The old plugin defaulted to desktop; this one defaults to phone. Keep an unpicked old setup on desktop.
    if (fromOldPlugin && saved.platform == null) {
        saved.platform = "desktop";
        changed = true;
    }
    // Older versions had one entry per device (Android, iPhone, Xbox...); they're grouped now.
    for (const key of ["platform", "lastSpoof"]) {
        const upgraded = upgradePlatformId(saved[key]);
        if (upgraded !== saved[key]) {
            saved[key] = upgraded;
            changed = true;
        }
    }
    if (changed) SettingsStore.markAsChanged();
}

export const settings = definePluginSettings({
    platform: {
        type: OptionType.SELECT,
        description: "What platform other people see you on.",
        options: [
            { label: "Real platform (off)", value: "off" },
            ...PLATFORM_IDS.map(id => ({ label: PLATFORMS[id].label, value: id, default: id === "phone" }))
        ],
        onChange: () => applyPlatform()
    },
    showButton: {
        type: OptionType.BOOLEAN,
        description: "Show a button next to mute and deafen. Click it to flip between your real platform and your last spoofed one, right-click it to pick.",
        default: true
    },
    spoofRequests: {
        type: OptionType.BOOLEAN,
        description: "Also make Discord's normal web requests say you're on the spoofed platform, so they match. Riskier, read the warning first.",
        default: false,
        onChange: (on: boolean) => {
            if (on) confirmSpoofRequests();
            else settings.store.requestsConfirmed = false;
        }
    },
    status: {
        type: OptionType.COMPONENT,
        component: () => <ErrorBoundary><StatusPanel /></ErrorBoundary>
    }
}).withPrivateSettings<{ lastSpoof?: PlatformId; requestsConfirmed?: boolean; }>();

function confirmSpoofRequests() {
    let confirmed = false;
    settings.store.requestsConfirmed = false;
    const undo = () => {
        if (!confirmed) settings.store.spoofRequests = false;
    };
    Alerts.show({
        title: "Spoof web requests too?",
        body: (
            <>
                <p>Every request Discord sends will say you're on the platform you picked, not just your live connection.</p>
                <p>Discord picks some features and tests by platform from these requests, so parts of Discord can change, go missing or break while this is on. It also changes more of what Discord sees, so there's a higher chance it notices.</p>
                <p>If anything acts weird, turn this off again.</p>
            </>
        ),
        confirmText: "Turn it on",
        cancelText: "Keep it off",
        confirmColor: "danger",
        onConfirm: () => {
            confirmed = true;
            settings.store.requestsConfirmed = true;
        },
        onCancel: undo,
        onCloseCallback: undo
    });
}

function spoofedProps(props: Record<string, unknown>, id: Exclude<PlatformId, "off">) {
    const platform = PLATFORMS[id];
    const out: Record<string, unknown> = { ...props, ...platform.props };
    for (const key of platform.drop) delete out[key];
    return out;
}

export function currentPlatform(): PlatformId {
    const { platform } = settings.store;
    return isPlatformId(platform) ? platform : "off";
}

let verifyUntil = 0;
let lastIdentifySpoofed = false;
let lastSent: PlatformId | null = null;
let refused = false;
const refusedListeners = new Set<() => void>();

function setRefused(value: boolean) {
    if (refused === value) return;
    refused = value;
    refusedListeners.forEach(fn => fn());
}

export const isRefused = () => refused;

export function useRefused() {
    const [, rerender] = useReducer(n => n + 1, 0);
    useEffect(() => {
        refusedListeners.add(rerender);
        return () => void refusedListeners.delete(rerender);
    }, []);
    return refused;
}

export function useEnabled() {
    useSettings([`plugins.${PLUGIN_NAME}.enabled`]);
    return isPluginEnabled(PLUGIN_NAME);
}
const isSpoofedNow = () => lastSent != null && lastSent !== "off";

function applyPlatform() {
    setRefused(false);
    if (isPluginEnabled(PLUGIN_NAME) || isSpoofedNow()) reconnect();
}

function onEnabledChange() {
    setRefused(false);
    reconnect();
}

export function pickPlatform(id: PlatformId) {
    if (settings.store.platform !== id) settings.store.platform = id;
    else applyPlatform();
}

export function reconnect() {
    scheduleReconnect(ok => {
        if (ok) verifyUntil = Date.now() + 30_000;
        else showToast({ text: "Couldn't reconnect to Discord. Your platform changes the next time Discord connects.", variant: "critical" });
    });
}

function checkResult() {
    if (Date.now() > verifyUntil || isReconnectPending() || lastSent == null) return;
    const client = SessionsStore.getSession()?.clientInfo.client;
    if (!client) return;
    verifyUntil = 0;

    const id = lastSent;
    const want = id === "off" ? null : PLATFORMS[id].shows;
    const shown = SHOWS_LABEL[client] ?? client;
    if (!want || want === client) showToast({ text: `Discord now shows you on ${shown}.`, variant: "success" });
    else showToast({ text: `Discord still shows you on ${shown}. It may not accept ${platformLabel(id)}.`, variant: "critical" });
}

const userContext: NavContextMenuPatchCallback = (children, { user }) => {
    if (user?.id !== AuthenticationStore.getId() || !isPluginEnabled(PLUGIN_NAME)) return;
    const active = currentPlatform();

    children.push(
        <Menu.MenuGroup>
            <Menu.MenuItem id="vc-platform-spoofer" label="Show me as">
                {(["off", ...PLATFORM_IDS] as PlatformId[]).map(id => (
                    <Menu.MenuRadioItem
                        key={id}
                        id={`vc-platform-spoofer-${id}`}
                        group="vc-platform-spoofer"
                        label={platformLabel(id)}
                        checked={active === id}
                        action={() => pickPlatform(id)}
                    />
                ))}
            </Menu.MenuItem>
        </Menu.MenuGroup>
    );
};

// Plugins start after Discord connects, but the user area can draw earlier from cache and won't redraw for a late button.
// Registering now makes it show on every start; PlatformButton renders nothing while the plugin is off.
addUserAreaButton(PLUGIN_NAME, PlatformButton);

export default definePlugin({
    name: PLUGIN_NAME,
    description: "A revival of the removed PlatformSpoofer. Pick what platform people see you on (phone, web, console and more), switch live, and stay logged in if Discord refuses it.",
    authors: [{ name: "nolifepops", id: 221807880053981184n }],
    tags: ["Utility"],
    searchTerms: ["mobile", "phone", "status", "device", "spoof", "console", "xbox", "playstation", "vr", "web"],
    settings,
    pickPlatform,
    currentPlatform,

    settingsAboutComponent: () => (
        <Notice.Warning>
            Discord doesn't allow this, so use it at your own risk. Discord turns some features on per platform, so things like Quests or Orbs may hide while you show as something else.
        </Notice.Warning>
    ),

    patches: [
        {
            find: "_doIdentify(){",
            replacement: [
                {
                    match: /(?<=,properties:)\i(?=,presence:\i,compress:)/,
                    replace: "$self.spoofProperties($&)"
                },
                {
                    match: /window\._ws=null,null!=(\i)(?=\))/,
                    replace: "window._ws=null,$1=$self.dropFastConnect($1),null!=$1"
                },
                {
                    match: /4004===(\i)(?=\)return this\.connectionState=)/,
                    replace: "$&&&!$self.onAuthFail(this,arguments[2])"
                }
            ]
        },
        {
            find: "getSuperPropertiesBase64:()=>",
            replacement: {
                match: /getSuperPropertiesBase64:\(\)=>(\i)/,
                replace: "getSuperPropertiesBase64:()=>()=>$self.spoofHeader($1())"
            }
        }
    ],

    userAreaButton: {
        icon: PlatformIcon,
        render: PlatformButton
    },

    contextMenus: {
        "user-context": userContext
    },

    commands: [
        {
            name: "platform",
            description: "Change what platform people see you on.",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "show-as",
                    description: "Platform to show as. Leave empty to see what you show as now.",
                    type: ApplicationCommandOptionType.STRING,
                    required: false,
                    choices: (["off", ...PLATFORM_IDS] as PlatformId[]).map(id => ({ name: platformLabel(id), label: platformLabel(id), value: id }))
                }
            ],
            execute(args, ctx) {
                if (!isPluginEnabled(PLUGIN_NAME)) {
                    sendBotMessage(ctx.channel.id, { content: "PlatformSpoofer+ is turned off. Turn it on in Equicord's plugin settings first." });
                    return;
                }
                const picked = findOption<string>(args, "show-as");
                const client = SessionsStore.getSession()?.clientInfo.client ?? "unknown";
                if (!picked) {
                    sendBotMessage(ctx.channel.id, {
                        content: `Picked: **${platformLabel(currentPlatform())}**${refused ? " (Discord refused it, so you're on your real platform)" : ""}. Discord currently shows this session as **${SHOWS_LABEL[client] ?? client}**.`
                    });
                    return;
                }
                if (!isPlatformId(picked)) {
                    sendBotMessage(ctx.channel.id, { content: "That isn't one of the platforms in the list." });
                    return;
                }
                pickPlatform(picked);
                sendBotMessage(ctx.channel.id, { content: `Switching to **${platformLabel(picked)}**. Discord reconnects for a second.` });
            }
        }
    ],

    flux: {
        SESSIONS_REPLACE: checkResult,
        // A 4004 only means "refused" while answering the spoofed identify. Once connected, any later 4004 is a real auth failure.
        CONNECTION_OPEN() {
            lastIdentifySpoofed = false;
        },
        LOGOUT() {
            lastIdentifySpoofed = false;
            setRefused(false);
        }
    },

    spoofProperties(props: Record<string, unknown>) {
        lastIdentifySpoofed = false;
        lastSent = "off";
        if (!isPluginEnabled(PLUGIN_NAME) || refused) return props;
        const id = currentPlatform();
        if (id === "off") return props;
        lastIdentifySpoofed = true;
        lastSent = id;

        logger.info(`Identifying as ${PLATFORMS[id].label}`);
        return spoofedProps(props, id);
    },

    spoofHeader(base64: string | null) {
        if (base64 == null || !settings.store.spoofRequests || !settings.store.requestsConfirmed || refused || !isPluginEnabled(PLUGIN_NAME)) return base64;
        // Before the first identify, match what that identify will send (logged in only, so sign-in itself stays real).
        const id = lastSent ?? (AuthenticationStore.getId() ? currentPlatform() : "off");
        if (id === "off") return base64;
        try {
            const props = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0))));
            const bytes = new TextEncoder().encode(JSON.stringify(spoofedProps(props, id)));
            return btoa(String.fromCharCode(...bytes));
        } catch (e) {
            logger.error("Couldn't rewrite the request header, sending the real one", e);
            return base64;
        }
    },

    dropFastConnect<T extends { ws?: WebSocket; }>(fast: T | null | undefined): T | null | undefined {
        if (fast == null || !isPluginEnabled(PLUGIN_NAME) || currentPlatform() === "off") return fast;
        logger.info("Skipping fast connect so the first identify is spoofed");
        fast.ws?.close(1000);
        return null;
    },

    onAuthFail(socket: GatewaySocket, reason: unknown) {
        if (!lastIdentifySpoofed) return false;
        lastIdentifySpoofed = false;
        verifyUntil = 0;
        setRefused(true);
        socket.sessionId = null;
        socket.seq = 0;
        logger.warn("Discord closed the spoofed session as an auth failure, retrying on the real platform instead of logging out", reason);
        showToast({ text: "Discord refused the spoofed platform. Reconnecting on your real one so you don't get logged out.", variant: "critical" });
        return true;
    },

    start() {
        SettingsStore.addChangeListener(`plugins.${PLUGIN_NAME}.enabled`, onEnabledChange);
        if (settings.store.spoofRequests && !settings.store.requestsConfirmed) settings.store.spoofRequests = false;
        const id = currentPlatform();
        const client = SessionsStore.getSession()?.clientInfo.client;
        if (id !== "off" && client && client !== PLATFORMS[id].shows) reconnect();
    },

    stop() {
        SettingsStore.removeChangeListener(`plugins.${PLUGIN_NAME}.enabled`, onEnabledChange);
        cancelReconnect();
        verifyUntil = 0;
        if (isSpoofedNow()) scheduleReconnect();
    }
});
