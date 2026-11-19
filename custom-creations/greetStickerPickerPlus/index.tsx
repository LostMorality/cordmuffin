/*
 * cordmuffin, based on Vencord's GreetStickerPicker
 * Copyright (c) 2023 Vendicated and contributors
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings, migratePluginSetting, migratePluginSettings, Settings } from "@api/Settings";
import { FormSwitch } from "@components/FormSwitch";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import type { Channel, Message, RenderModalProps } from "@vencord/discord-types";
import { PremiumType } from "@vencord/discord-types/enums";
import { findByCodeLazy, findComponentByCodeLazy } from "@webpack";
import { ChannelStore, ContextMenuApi, ExpressionPickerStore, FluxDispatcher, GuildStore, Menu, MessageActions, Modal, PermissionsBits, PermissionStore, React, SelectedChannelStore, showToast, StickersStore, TextInput, UserStore } from "@webpack/common";

const logger = new Logger("GreetStickerPicker+");

// Discord's own checks, so the plugin agrees with the native sticker picker and the chat box.
const getStickerSendability: (sticker: any, user: any, channel: Channel) => number = findByCodeLazy("canUseCustomStickersEverywhere(", "USE_EXTERNAL_STICKERS");
const validateMessage: (options: any) => Promise<{ valid: boolean; }> = findByCodeLazy(".getSlowmodeCooldownGuess(", "respectCooldown:");
const StickerRenderer = findComponentByCodeLazy("enlargeScaleFactor:", "enlargeOnInteraction:");

const SENDABLE = 0;
const STICKERS_EVERYWHERE_TIERS = [PremiumType.TIER_0, PremiumType.TIER_2];
const SEARCH_LIMIT = 100;

// Takes over the original plugin's settings (and switches it off), so the two never patch the same button.
migratePluginSettings("GreetStickerPicker+", "GreetStickerPicker");
migratePluginSetting("GreetStickerPicker+", "enableMultiGreet", "unholyMultiGreetEnabled");

const originalOn = () => !!Settings.plugins.GreetStickerPicker?.enabled;

enum GreetMode {
    Greet = "Greet",
    NormalMessage = "Message"
}

interface GuildSticker {
    id: string;
    name: string;
    description?: string;
    guild_id?: string;
    type: number;
    format_type: number;
    available?: boolean;
}

const StickerExt = [, "png", "png", null, "gif"] as const;
const LOTTIE = 3;

function getStickerThumbUrl(sticker: { id: string; format_type: number; }, size = 40): string | null {
    const env = (window as any).GLOBAL_ENV ?? {};
    if (sticker.format_type === 4)
        return `https:${env.MEDIA_PROXY_ENDPOINT}/stickers/${sticker.id}.gif?size=${size}&lossless=true`;

    const ext = StickerExt[sticker.format_type];
    if (!ext) return null;
    return `https://${env.CDN_HOST}/stickers/${sticker.id}.${ext}?size=${size}&lossless=true`;
}

type ThumbSticker = { id: string; format_type: number; name?: string; };

// One component per sticker, reused across renders, so menu thumbnails don't remount on every keystroke.
const thumbCache = new Map<string, React.ComponentType>();

function StickerThumb(sticker: ThumbSticker) {
    // Keyed by format too: a sticker first seen as an unknown fallback must not keep that wrong thumbnail.
    const key = `${sticker.id}:${sticker.format_type}`;
    const cached = thumbCache.get(key);
    if (cached) return cached;

    // Lottie stickers have no image on the CDN, only animation JSON, so Discord's own renderer draws them.
    const lottie = sticker.format_type === LOTTIE ? { id: sticker.id, format_type: LOTTIE, name: sticker.name ?? "" } : null;
    const url = lottie ? null : getStickerThumbUrl(sticker);

    const StickerThumbIcon = () => {
        if (lottie) return <StickerRenderer sticker={lottie} size={24} disableAnimation />;
        if (!url) return null;
        return (
            <img
                src={url}
                width={24}
                height={24}
                loading="lazy"
                style={{ borderRadius: 4, objectFit: "contain" }}
            />
        );
    };

    thumbCache.set(key, StickerThumbIcon);
    return StickerThumbIcon;
}

function thumbProps(sticker: ThumbSticker) {
    const Icon = StickerThumb(sticker);
    return { icon: Icon, leadingAccessory: { type: "icon" as const, icon: Icon } };
}

const settings = definePluginSettings({
    greetMode: {
        type: OptionType.SELECT,
        options: [
            { label: "Greet (max 3)", value: GreetMode.Greet, default: true },
            { label: "Normal message", value: GreetMode.NormalMessage }
        ],
        description: "How welcome stickers are sent (list menu, Multi-Greet and a welcome default sticker). Greet is Discord's real greet, limited to 3 per message; Normal message sends a reply with no limit. Other stickers always go out as a reply."
    },
    useNativePicker: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Right-click the greet button to open Discord's native sticker picker (Shift+Right-click always opens the list menu)"
    },
    enableServerStickers: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "In the list menu, add a submenu to send any sticker you can use in the server"
    },
    onlyCurrentGuildStickers: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Only list stickers from the server this message is in (ignore cross-guild Nitro stickers). Has no effect in DMs, which have no server of their own."
    },
    enableMultiGreet: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Enable the Unholy Multi-Greet submenu (send up to 3 welcome stickers at once)"
    }
}).withPrivateSettings<{
    multiGreetChoices?: string[];
    defaultStickerId?: string;
}>();

let WELCOME_STICKERS: any;
let NativeStickerPicker: any;

function isWelcomeSticker(id: string) {
    return (WELCOME_STICKERS ?? []).some((x: any) => x.id === id);
}

// The same pre-send check Discord's own welcome button runs (slowmode, full send queue).
async function passesSendCheck(channel: Channel) {
    try {
        const { valid } = await validateMessage({ type: {}, content: "", channel, hasStickers: true });
        return valid;
    } catch (e) {
        logger.error("Pre-send check failed, sending anyway", e);
        return true;
    }
}

function onSendError(e: any) {
    if (e?.status === 429) showToast({ text: "Rate limited, try again in a moment.", variant: "critical" });
    else logger.error("Failed to send greet sticker", e);
}

async function greet(channel: Channel, message: Message | null, stickers: string[], forceMessage = false) {
    if (!(await passesSendCheck(channel))) return;

    const options: any = message
        ? MessageActions.getSendMessageOptionsForReply({
            channel,
            message,
            shouldMention: true,
            showMentionToggle: true
        })
        : {};

    const useMessagePath =
        forceMessage ||
        settings.store.greetMode === GreetMode.NormalMessage ||
        stickers.length > 1;

    if (useMessagePath) {
        options.stickerIds = stickers;
        const msg = {
            content: "",
            tts: false,
            invalidEmojis: [],
            validNonShortcutEmojis: []
        };

        await MessageActions._sendMessage(channel.id, msg, options);
    } else {
        await MessageActions.sendGreetMessage(channel.id, stickers[0], options);
    }
}

function sendGreet(...args: Parameters<typeof greet>) {
    greet(...args).catch(onSendError);
}

function getChannelGuildId(channel: Channel): string | null {
    return channel.getGuildId?.() ?? (channel as any).guild_id ?? null;
}

function canSendSticker(sticker: GuildSticker, channel: Channel) {
    const user = UserStore.getCurrentUser();
    try {
        return getStickerSendability(sticker, user, channel) === SENDABLE;
    } catch {
        // Discord's check wasn't found, so mirror its rules: own server always, otherwise Nitro plus permission.
        if (sticker.available === false || !GuildStore.getGuild(sticker.guild_id ?? "")) return false;

        const channelGuildId = getChannelGuildId(channel);
        if (channelGuildId && sticker.guild_id === channelGuildId) return true;
        if (!STICKERS_EVERYWHERE_TIERS.includes(user?.premiumType ?? PremiumType.NONE)) return false;
        return !channelGuildId || PermissionStore.can(PermissionsBits.USE_EXTERNAL_STICKERS, channel);
    }
}

function getSendableStickers(channel: Channel, onlyCurrentGuild: boolean) {
    const channelGuildId = getChannelGuildId(channel);
    const onlyCurrent = onlyCurrentGuild && channelGuildId != null;

    const groups: { guildId: string; guildName: string; stickers: GuildSticker[]; }[] = [];

    let entries: [string, GuildSticker[]][] = [];
    try {
        const all: any = StickersStore.getAllGuildStickers();
        if (!all) return groups;

        if (all instanceof Map) {
            entries = [...all.entries()];
        } else if (Array.isArray(all)) {
            const byGuild = new Map<string, GuildSticker[]>();
            for (const s of all as GuildSticker[]) {
                const gid = s.guild_id ?? "";
                (byGuild.get(gid) ?? byGuild.set(gid, []).get(gid)!).push(s);
            }
            entries = [...byGuild.entries()];
        } else if (typeof all === "object") {
            entries = Object.entries(all as Record<string, GuildSticker[]>);
        }
    } catch {
        return groups;
    }

    for (const [guildId, stickers] of entries) {
        if (!Array.isArray(stickers)) continue;
        if (onlyCurrent && guildId !== channelGuildId) continue;

        const sendable = stickers.filter(s => canSendSticker(s, channel));
        if (!sendable.length) continue;

        groups.push({
            guildId,
            guildName: GuildStore.getGuild(guildId)?.name ?? "Unknown Server",
            stickers: sendable.sort((a, b) => a.name.localeCompare(b.name))
        });
    }

    groups.sort((a, b) => {
        if (a.guildId === channelGuildId) return -1;
        if (b.guildId === channelGuildId) return 1;
        return a.guildName.localeCompare(b.guildName);
    });

    return groups;
}

function extractStickerId(args: any[]): string | null {
    for (const a of args) {
        if (!a) continue;
        if (typeof a === "string" && /^\d{5,}$/.test(a)) return a;
        if (typeof a === "object" && a.id) return String(a.id);
    }
    return null;
}

function describeSticker(id: string): { id: string; name: string; format_type: number; } {
    const welcome = (WELCOME_STICKERS ?? []).find((x: any) => x.id === id);
    if (welcome) return { id, name: welcome.description.split(" ")[0], format_type: welcome.format_type };

    const known = StickersStore.getStickerById?.(id);
    if (known) return { id, name: known.name ?? id, format_type: known.format_type };

    return { id, name: "Unknown sticker", format_type: 1 };
}

function CurrentDefault({ id }: { id?: string; }) {
    const sticker = id ? describeSticker(id) : null;
    const url = sticker && sticker.name !== "Unknown sticker" ? getStickerThumbUrl(sticker, 64) : null;

    return (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0 10px", color: "var(--text-default)" }}>
            {sticker?.format_type === LOTTIE
                ? <StickerRenderer sticker={sticker} size={32} disableAnimation />
                : url && <img src={url} width={32} height={32} style={{ borderRadius: 4, objectFit: "contain" }} />}
            <span style={{ fontSize: 14 }}>
                {sticker ? <>Default: <b>{sticker.name}</b></> : "No default greet sticker"}
            </span>
        </div>
    );
}

const PICKER_MAX_HEIGHT = 460;
const PICKER_MIN_HEIGHT = 240;

function PickerModal({ modalProps, channel, message }: { modalProps: RenderModalProps; channel: Channel; message: Message | null; }) {
    const [setDefaultMode, setSetDefaultMode] = React.useState(false);
    const { defaultStickerId } = settings.use(["defaultStickerId"]);

    const onSelect = (...args: any[]) => {
        const id = extractStickerId(args);
        if (!id) return;

        if (setDefaultMode) settings.store.defaultStickerId = id;
        else sendGreet(channel, message, [id], true);
        modalProps.onClose();
    };

    React.useEffect(() => clearPickerSearch, []);

    // The picker needs a fixed height; shrink it to fit the modal body instead of adding a second scrollbar.
    // Every fit starts again from the max height, so a content-sized body can't feed its own rounding back in.
    const pickerRef = React.useRef<HTMLDivElement>(null);

    React.useLayoutEffect(() => {
        const picker = pickerRef.current;
        let scroller = picker?.parentElement ?? null;
        while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
        if (!picker) return;
        const body = scroller;

        const fit = () => {
            picker.style.height = `${PICKER_MAX_HEIGHT}px`;
            if (!body || body.scrollHeight <= body.clientHeight) return;

            const offset = picker.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
            const free = body.clientHeight - offset - (parseFloat(getComputedStyle(body).paddingBottom) || 0);
            picker.style.height = `${Math.max(PICKER_MIN_HEIGHT, Math.min(PICKER_MAX_HEIGHT, Math.floor(free)))}px`;
        };

        fit();
        window.addEventListener("resize", fit);
        return () => window.removeEventListener("resize", fit);
    }, [defaultStickerId]);

    return (
        <Modal
            {...modalProps}
            size="sm"
            title="Greet Sticker Picker"
            actionBarInput={<FormSwitch title="Set as default" value={setDefaultMode} onChange={setSetDefaultMode} hideBorder />}
            actions={defaultStickerId
                ? [{ text: "Clear default", variant: "secondary", onClick: () => { settings.store.defaultStickerId = undefined; } }]
                : []}
        >
            <CurrentDefault id={defaultStickerId} />
            <div ref={pickerRef} className="vc-gsp-native-picker" style={{ display: "flex", flexDirection: "column" }}>
                {/* Discord's sticker panel is a grid that only grows to its search bar unless its parent stretches it. */}
                <style>{".vc-gsp-native-picker>[role=tabpanel]{flex:1 1 auto;min-height:0}"}</style>
                <NativeStickerPicker channel={channel} onSelectSticker={onSelect} closePopout={modalProps.onClose} />
            </div>
        </Modal>
    );
}

// Discord's sticker panel keeps its search text in the shared expression picker store, so without this the
// modal reopens on the last search. Cleared when the modal opens and closes; Discord's own picker isn't open then.
function clearPickerSearch() {
    try {
        ExpressionPickerStore.setSearchQuery("");
    } catch (e) {
        logger.warn("Couldn't clear the sticker search", e);
    }
}

function openNativePicker(channel: Channel, message: Message | null) {
    if (!NativeStickerPicker) return false;
    clearPickerSearch();
    openModal(modalProps => <PickerModal modalProps={modalProps} channel={channel} message={message} />);
    return true;
}

function GreetMenu({ channel, message }: { message: Message | null, channel: Channel; }) {
    const s = settings.use(["greetMode", "multiGreetChoices", "enableServerStickers", "enableMultiGreet", "defaultStickerId", "onlyCurrentGuildStickers"]);
    const { greetMode, multiGreetChoices = [], defaultStickerId, onlyCurrentGuildStickers } = s;
    // Discord's welcome sticker list is grabbed by a patch; until that module loads it's missing.
    const welcomeStickers: any[] = WELCOME_STICKERS ?? [];

    const [query, setQuery] = React.useState("");
    const q = query.trim().toLowerCase();

    const serverStickerGroups = React.useMemo(
        () => getSendableStickers(channel, onlyCurrentGuildStickers),
        [channel, onlyCurrentGuildStickers]
    );

    const defaultSticker: { id: string; name: string; format_type: number; } | null = (() => {
        if (!defaultStickerId) return null;

        const welcome = welcomeStickers.find((x: any) => x.id === defaultStickerId);
        if (welcome) return { id: welcome.id, name: welcome.description.split(" ")[0], format_type: welcome.format_type };

        for (const g of serverStickerGroups) {
            const st = g.stickers.find(x => x.id === defaultStickerId);
            if (st) return { id: st.id, name: `${st.name} · ${g.guildName}`, format_type: st.format_type };
        }

        const any = StickersStore.getStickerById?.(defaultStickerId);
        if (any) return { id: defaultStickerId, name: any.name ?? defaultStickerId, format_type: any.format_type };
        return { id: defaultStickerId, name: defaultStickerId, format_type: 1 };
    })();

    const allMatches = React.useMemo(
        () => q
            ? serverStickerGroups.flatMap(g => g.stickers
                .filter(st => st.name.toLowerCase().includes(q))
                .map(st => ({ st, guildName: g.guildName })))
            : [],
        [serverStickerGroups, q]
    );
    const matches = allMatches.slice(0, SEARCH_LIMIT);
    const hiddenMatches = allMatches.length - matches.length;

    return (
        <Menu.Menu
            navId="greet-sticker-picker"
            onClose={() => FluxDispatcher.dispatch({ type: "CONTEXT_MENU_CLOSE" })}
            aria-label="Greet Sticker Picker"
        >
            {NativeStickerPicker && (
                <Menu.MenuItem
                    id="greet-open-native"
                    label="Open Sticker Picker…"
                    action={() => openNativePicker(channel, message)}
                />
            )}

            <Menu.MenuGroup label="Greet Mode">
                {Object.values(GreetMode).map(mode => (
                    <Menu.MenuRadioItem
                        key={mode}
                        group="greet-mode"
                        id={"greet-mode-" + mode}
                        label={mode}
                        checked={mode === greetMode}
                        action={() => s.greetMode = mode}
                    />
                ))}
            </Menu.MenuGroup>

            <Menu.MenuSeparator />

            <Menu.MenuGroup label="Greet Stickers">
                {welcomeStickers.map((sticker: any) => (
                    <Menu.MenuItem
                        key={sticker.id}
                        id={"greet-" + sticker.id}
                        label={sticker.description.split(" ")[0]}
                        {...thumbProps(sticker)}
                        action={() => sendGreet(channel, message, [sticker.id])}
                    />
                ))}
            </Menu.MenuGroup>

            <Menu.MenuSeparator />

            <Menu.MenuGroup label="Left-click default">
                <Menu.MenuItem
                    id="greet-default-set"
                    label="Set Default Sticker"
                >
                    <Menu.MenuGroup label={defaultSticker ? "Current default" : "No default set"}>
                        {defaultSticker && (
                            <Menu.MenuItem
                                id="greet-default-current"
                                label={defaultSticker.name}
                                {...thumbProps(defaultSticker)}
                                disabled
                            />
                        )}
                        <Menu.MenuRadioItem
                            group="greet-default"
                            id="greet-default-none"
                            label={defaultSticker ? "Clear default (None)" : "None"}
                            checked={!defaultStickerId}
                            action={() => s.defaultStickerId = undefined}
                        />
                    </Menu.MenuGroup>

                    <Menu.MenuGroup label="Welcome">
                        {welcomeStickers.map((sticker: any) => (
                            <Menu.MenuRadioItem
                                key={sticker.id}
                                group="greet-default"
                                id={"greet-default-" + sticker.id}
                                label={sticker.description.split(" ")[0]}
                                {...thumbProps(sticker)}
                                checked={defaultStickerId === sticker.id}
                                action={() => s.defaultStickerId = sticker.id}
                            />
                        ))}
                    </Menu.MenuGroup>

                    {serverStickerGroups.map(group => (
                        <Menu.MenuItem
                            key={"default-guild-" + group.guildId}
                            id={"greet-default-guild-" + group.guildId}
                            label={group.guildName}
                        >
                            {group.stickers.map(sticker => (
                                <Menu.MenuRadioItem
                                    key={sticker.id}
                                    group="greet-default"
                                    id={"greet-default-server-" + sticker.id}
                                    label={sticker.name}
                                    {...thumbProps(sticker)}
                                    checked={defaultStickerId === sticker.id}
                                    action={() => s.defaultStickerId = sticker.id}
                                />
                            ))}
                        </Menu.MenuItem>
                    ))}
                </Menu.MenuItem>
            </Menu.MenuGroup>

            {s.enableServerStickers && (
                <>
                    <Menu.MenuSeparator />
                    <Menu.MenuItem
                        id="greet-server-stickers"
                        label="Server Stickers"
                    >
                        <Menu.MenuItem
                            id="greet-server-search"
                            label="Search stickers"
                            render={() => (
                                <div
                                    style={{ padding: "6px 8px" }}
                                    onKeyDown={e => e.stopPropagation()}
                                    onClick={e => e.stopPropagation()}
                                >
                                    <TextInput
                                        value={query}
                                        onChange={(v: string) => setQuery(v)}
                                        placeholder="Search stickers"
                                        autoFocus
                                    />
                                </div>
                            )}
                        />

                        {q ? (
                            matches.length === 0 ? (
                                <Menu.MenuItem id="greet-server-nomatch" label="No matches" disabled />
                            ) : (
                                <>
                                    {matches.map(({ st, guildName }) => (
                                        <Menu.MenuItem
                                            key={st.id}
                                            id={"greet-server-sticker-" + st.id}
                                            label={st.name}
                                            subtext={guildName}
                                            {...thumbProps(st)}
                                            action={() => sendGreet(channel, message, [st.id], true)}
                                        />
                                    ))}
                                    {hiddenMatches > 0 && (
                                        <Menu.MenuItem
                                            id="greet-server-more"
                                            label={`${hiddenMatches} more`}
                                            subtext="Keep typing to narrow"
                                            disabled
                                        />
                                    )}
                                </>
                            )
                        ) : serverStickerGroups.length === 0 ? (
                            <Menu.MenuItem
                                id="greet-server-stickers-empty"
                                label="No sendable stickers"
                                disabled
                            />
                        ) : (
                            serverStickerGroups.map(group => (
                                <Menu.MenuItem
                                    key={group.guildId}
                                    id={"greet-server-guild-" + group.guildId}
                                    label={group.guildName}
                                >
                                    {group.stickers.map(sticker => (
                                        <Menu.MenuItem
                                            key={sticker.id}
                                            id={"greet-server-sticker-" + sticker.id}
                                            label={sticker.name}
                                            {...thumbProps(sticker)}
                                            action={() => sendGreet(channel, message, [sticker.id], true)}
                                        />
                                    ))}
                                </Menu.MenuItem>
                            ))
                        )}
                    </Menu.MenuItem>
                </>
            )}

            {s.enableMultiGreet && (
                <>
                    <Menu.MenuSeparator />

                    <Menu.MenuItem
                        label="Unholy Multi-Greet"
                        id="unholy-multi-greet"
                    >
                        {welcomeStickers.map((sticker: any) => {
                            const checked = multiGreetChoices.some(id => id === sticker.id);

                            return (
                                <Menu.MenuCheckboxItem
                                    key={sticker.id}
                                    id={"multi-greet-" + sticker.id}
                                    label={sticker.description.split(" ")[0]}
                                    checked={checked}
                                    disabled={!checked && multiGreetChoices.length >= 3}
                                    action={() => {
                                        s.multiGreetChoices = checked
                                            ? multiGreetChoices.filter(id => id !== sticker.id)
                                            : [...multiGreetChoices, sticker.id];
                                    }}
                                />
                            );
                        })}

                        <Menu.MenuSeparator />
                        <Menu.MenuItem
                            id="multi-greet-submit"
                            label="Send Greets"
                            action={() => sendGreet(channel, message, [...multiGreetChoices])}
                            disabled={multiGreetChoices.length === 0}
                        />
                    </Menu.MenuItem>
                </>
            )}
        </Menu.Menu>
    );
}

export default definePlugin({
    name: "GreetStickerPicker+",
    description: "GreetStickerPicker with more: works on DM wave buttons too, right-click opens Discord's real sticker picker, left-click sends your default greet sticker, and any server sticker can be a greet.",
    tags: ["Emotes", "Customisation"],
    authors: [Devs.Ven, { name: "nolifepops", id: 221807880053981184n }],

    settings,

    start() {
        if (originalOn()) showToast({ text: "Turn off GreetStickerPicker, then restart. GreetStickerPicker+ replaces it.", variant: "critical" });
    },

    patches: [
        {
            // On the wave button itself, not its full-width wrapper row.
            find: "#{intl::WELCOME_CTA_LABEL}",
            predicate: () => !originalOn(),
            all: true,
            replacement: {
                match: /icon:\{type:"sticker",(?<=\{channel:\i,message:\i\}=(\i)[^]{0,1500}?)/g,
                replace: "onContextMenu:vcE=>$self.pickSticker(vcE,$1),onClickCapture:vcE=>$self.onGreetClick(vcE,$1),$&"
            }
        },
        {
            find: '"Wumpus waves hello"',
            predicate: () => !originalOn(),
            replacement: {
                match: /(?<==)(?=\[{id:"749054660769218631",format_type:\d,description:"Wumpus waves hello")/,
                replace: "$self.WELCOME_STICKERS="
            }
        },
        {
            // Grabs the sticker tab panel where it's defined, so it's ready before the chat-bar picker is ever opened.
            find: "#{intl::EXPRESSION_PICKER_CATEGORIES_A11Y_LABEL}",
            predicate: () => !originalOn(),
            replacement: {
                match: /(?<=[,;\s]\i=)(?=function\(\i\)\{let\{ref:\i,\.\.\.\i\}=\i;return\(0,\i\.\i\)\(\),\(0,\i\.jsx\)\("div",\{[^{}]{0,120}?role:"tabpanel")/,
                replace: "$self.NativeStickerPicker="
            }
        },
        {
            find: '"In-channel greet"',
            predicate: () => !originalOn(),
            replacement: [
                {
                    match: /onClick:\i,(?=children:\[\(0,\i\.jsx\)\(\i\.\i,\{sticker:)(?<=let\{channel:(\i)\}=\i[^]{0,3000}?)/,
                    replace: "onContextMenu:vcE=>$self.pickStickerDM(vcE,$1),onClickCapture:vcE=>$self.onGreetClickDM(vcE,$1),$&"
                },
                {
                    match: /(?<=let\{channel:(\i)\}=\i[^]{0,3000}?variant:"primary",size:"md",)(?=onClick:)/,
                    replace: "onContextMenu:vcE=>$self.pickStickerDM(vcE,$1),onClickCapture:vcE=>$self.onGreetClickDM(vcE,$1),"
                }
            ]
        }
    ],

    set WELCOME_STICKERS(value: any) {
        WELCOME_STICKERS = value;
    },

    set NativeStickerPicker(value: any) {
        NativeStickerPicker = value;
    },

    onGreetClick(
        event: React.MouseEvent,
        props: { channel: Channel, message?: Message; }
    ) {
        const id = settings.store.defaultStickerId;
        if (!id || (props.message as any)?.deleted) return;

        event.preventDefault();
        event.stopPropagation();

        const welcome = isWelcomeSticker(id);
        if (!welcome) {
            const sticker = StickersStore.getStickerById?.(id);
            if (!sticker || !canSendSticker(sticker, props.channel)) {
                showToast({ text: "Your default sticker can't be sent here. Right-click to pick another.", variant: "critical" });
                return;
            }
        }

        // Welcome stickers follow the greet mode; any other sticker can only go out as a reply.
        sendGreet(props.channel, props.message ?? null, [id], !welcome);
    },

    pickSticker(
        event: React.UIEvent,
        props: {
            channel: Channel,
            message?: Message;
        }
    ) {
        if ((props.message as any)?.deleted) return;

        const wantNative = settings.store.useNativePicker && !(event as React.MouseEvent).shiftKey;
        if (wantNative && openNativePicker(props.channel, props.message ?? null)) {
            // Keeps the message row's own context menu from opening on top of the picker.
            event.preventDefault();
            event.stopPropagation();
            return;
        }

        ContextMenuApi.openContextMenu(event, () => <GreetMenu channel={props.channel} message={props.message ?? null} />);
    },

    getCurrentChannel(): Channel | null {
        const id = SelectedChannelStore.getChannelId?.();
        return id ? ChannelStore.getChannel(id) : null;
    },

    pickStickerDM(event: React.UIEvent, channel?: Channel) {
        channel ??= this.getCurrentChannel() ?? undefined;
        if (channel) this.pickSticker(event, { channel });
    },

    onGreetClickDM(event: React.MouseEvent, channel?: Channel) {
        channel ??= this.getCurrentChannel() ?? undefined;
        if (channel) this.onGreetClick(event, { channel });
    }
});
