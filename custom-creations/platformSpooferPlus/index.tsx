/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { ApplicationCommandInputType, ApplicationCommandOptionType, commands as registeredCommands, findOption, registerCommand, sendBotMessage, unregisterCommand, VencordCommand } from "@api/Commands";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { isPluginEnabled } from "@api/PluginManager";
import { definePluginSettings, migratePluginSettings, SettingsStore, useSettings } from "@api/Settings";
import { addUserAreaButton } from "@api/UserArea";
import ErrorBoundary from "@components/ErrorBoundary";
import { Notice } from "@components/Notice";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { Alerts, AuthenticationStore, Menu, SelectedChannelStore, SessionsStore, showToast, useEffect, useReducer } from "@webpack/common";

import { PlatformButton, PlatformIcon } from "./Button";
import { cancelReconnect, GatewaySocket, isReconnectPending, logger, scheduleReconnect } from "./gateway";
import { StatusPanel } from "./Panel";
import { isPlatformId, PLATFORM_IDS, PlatformId, platformLabel, PLATFORMS, SHOWS_LABEL, upgradePlatformId } from "./platforms";

const SuperProperties: { getSuperProperties(): Record<string, unknown>; } = findByPropsLazy("getSuperProperties", "getSuperPropertiesBase64");

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
            else if (settings.store.requestsConfirmed) settings.store.requestsConfirmed = false;
        }
    },
    status: {
        type: OptionType.COMPONENT,
        component: () => <ErrorBoundary><StatusPanel /></ErrorBoundary>
    }
}).withPrivateSettings<{ lastSpoof?: PlatformId; requestsConfirmed?: boolean; }>();

function confirmSpoofRequests() {
    let confirmed = false;
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
        confirmVariant: "critical-primary",
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

// Desktop on the desktop app sends exactly what Discord already sends, so treat it as off: no reconnect, fast connect kept.
export function isNoopSpoof(id: PlatformId, props?: Record<string, unknown>) {
    if (id !== "desktop") return false;
    try {
        return (props ?? SuperProperties.getSuperProperties()).browser === PLATFORMS.desktop.props.browser;
    } catch {
        return false;
    }
}

export function effectivePlatform(): PlatformId {
    const id = currentPlatform();
    return isNoopSpoof(id) ? "off" : id;
}

let verifyUntil = 0;
let lastIdentifySpoofed = false;
let lastSent: PlatformId | null = null;
let refused = false;
const refusedListeners = new Set<() => void>();
const sentListeners = new Set<() => void>();

function setLastSent(value: PlatformId) {
    if (lastSent === value) return;
    lastSent = value;
    sentListeners.forEach(fn => fn());
}

// What the live connection identified as. Null (fast connect, real properties) counts as off.
export const sentPlatform = (): PlatformId => lastSent ?? "off";

export function useSentPlatform() {
    const [, rerender] = useReducer(n => n + 1, 0);
    useEffect(() => {
        sentListeners.add(rerender);
        return () => void sentListeners.delete(rerender);
    }, []);
    return sentPlatform();
}

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

// Enabled and running since startup, so the identify patch is live. Turning it on from off needs a restart first.
export const isActive = (): boolean => isPluginEnabled(PLUGIN_NAME) && plugin.started;

export function useEnabled() {
    useSettings([`plugins.${PLUGIN_NAME}.enabled`]);
    return isActive();
}

export const isSpoofedNow = () => lastSent != null && lastSent !== "off";

// True when a reconnect would change what Discord sees: a different platform than the live one, or a retry after a refusal.
export function needsReconnect() {
    if (refused) return isActive();
    return (isActive() ? effectivePlatform() : "off") !== sentPlatform();
}

export function applyPlatform() {
    setRefused(false);
    if (!isActive() && !isSpoofedNow()) return;
    // A retry of a refused pick still differs from the real platform that was sent instead, so it reconnects;
    // picking off or a no-op Desktop after a refusal changes nothing and doesn't.
    if (!needsReconnect() && !isReconnectPending()) return;
    reconnect();
}

function syncCommand() {
    const on = isPluginEnabled(PLUGIN_NAME);
    const registered = platformCommand.name in registeredCommands;
    try {
        if (on && !registered) registerCommand(platformCommand, PLUGIN_NAME);
        else if (!on && registered) unregisterCommand(platformCommand.name);
    } catch (e) {
        logger.error("Couldn't update the /platform command", e);
    }
}

function onEnabledChange() {
    setRefused(false);
    syncCommand();
    const next = isPluginEnabled(PLUGIN_NAME) ? effectivePlatform() : "off";
    if (next !== sentPlatform()) reconnect();
}

export function pickPlatform(id: PlatformId) {
    if (settings.store.platform !== id) settings.store.platform = id;
    else applyPlatform();
}

function reconnectNow() {
    scheduleReconnect(ok => {
        if (ok) verifyUntil = Date.now() + 30_000;
        else showToast({ text: "Couldn't reconnect to Discord. Your platform changes the next time Discord connects.", variant: "critical" });
    });
}

let askingAboutCall = false;

export const isInCall = () => SelectedChannelStore.getVoiceChannelId() != null;

// A platform change needs a brand new gateway session. Voice and Go Live belong to the old one, so a call drops.
export function reconnect() {
    if (!isInCall()) {
        reconnectNow();
        return;
    }
    if (askingAboutCall) return;
    askingAboutCall = true;
    const done = () => void (askingAboutCall = false);
    Alerts.show({
        title: "Leave your call?",
        body: "Changing platform reconnects Discord as a new session. That drops your voice call and ends any stream. Your pick is saved either way and applies the next time Discord fully reconnects, like after a restart.",
        confirmText: "Reconnect now",
        cancelText: "Later",
        confirmVariant: "critical-primary",
        onConfirm: () => {
            done();
            reconnectNow();
        },
        onCancel: done,
        onCloseCallback: done
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
    if (user?.id !== AuthenticationStore.getId() || !isActive()) return;
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

const platformCommand: VencordCommand = {
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
        if (!isActive()) {
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
        const inCall = isInCall();
        pickPlatform(picked);
        sendBotMessage(ctx.channel.id, {
            content: `Switching to **${platformLabel(picked)}**. ${inCall ? "You're in a call, so Discord asks before it reconnects." : "Discord reconnects for a second."}`
        });
    }
};

const plugin = definePlugin({
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

    commands: [platformCommand],

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
        const id = currentPlatform();
        if (!isPluginEnabled(PLUGIN_NAME) || refused || id === "off" || isNoopSpoof(id, props)) {
            setLastSent("off");
            return props;
        }
        lastIdentifySpoofed = true;
        setLastSent(id);

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
        if (fast == null || !isPluginEnabled(PLUGIN_NAME) || effectivePlatform() === "off") return fast;
        logger.info("Skipping fast connect so the first identify is spoofed");
        fast.ws?.close(1000);
        return null;
    },

    onAuthFail(socket: GatewaySocket, reason: unknown) {
        if (!lastIdentifySpoofed) return false;
        lastIdentifySpoofed = false;
        verifyUntil = 0;
        setLastSent("off");
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
        const id = effectivePlatform();
        const client = SessionsStore.getSession()?.clientInfo.client;
        if (id !== "off" && client && client !== PLATFORMS[id].shows) reconnect();
    },

    stop() {
        SettingsStore.removeChangeListener(`plugins.${PLUGIN_NAME}.enabled`, onEnabledChange);
        cancelReconnect();
        verifyUntil = 0;
        if (isSpoofedNow()) reconnect();
    }
});

export default plugin;
