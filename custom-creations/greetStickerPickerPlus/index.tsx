/*
 * cordmuffin, based on Vencord's GreetStickerPicker
 * Copyright (c) 2023 Vendicated and contributors
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings, migratePluginSetting, migratePluginSettings, Settings } from "@api/Settings";
import { FormSwitch } from "@components/FormSwitch";
import { Devs } from "@utils/constants";
import { openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import type { Channel, Message, RenderModalProps } from "@vencord/discord-types";
import { ChannelStore, ContextMenuApi, FluxDispatcher, GuildStore, Menu, MessageActions, Modal, React, SelectedChannelStore, showToast, StickersStore, TextInput, UserStore } from "@webpack/common";

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

function getStickerThumbUrl(sticker: { id: string; format_type: number; }, size = 40): string | null {
    const env = (window as any).GLOBAL_ENV ?? {};
    if (sticker.format_type === 4)
        return `https:${env.MEDIA_PROXY_ENDPOINT}/stickers/${sticker.id}.gif?size=${size}&lossless=true`;

    const ext = StickerExt[sticker.format_type];
    if (!ext) return null;
    return `https://${env.CDN_HOST}/stickers/${sticker.id}.${ext}?size=${size}&lossless=true`;
}

function StickerThumb(sticker: { id: string; format_type: number; }) {
    const url = getStickerThumbUrl(sticker);
    return function StickerThumbIcon() {
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
}

function thumbProps(sticker: { id: string; format_type: number; }) {
    const Icon = StickerThumb(sticker);
    return { icon: Icon, leadingAccessory: { type: "icon" as const, icon: Icon } };
}

const settings = definePluginSettings({
    greetMode: {
        type: OptionType.SELECT,
        options: [
            { label: "Greet (you can only greet 3 times)", value: GreetMode.Greet, default: true },
            { label: "Normal Message (you can greet spam)", value: GreetMode.NormalMessage }
        ],
        description: "Send mode for welcome stickers and the default greet sticker"
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
        description: "Only list stickers from the server this message is in (ignore cross-guild Nitro stickers)"
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

function greet(channel: Channel, message: Message | null, stickers: string[], forceMessage = false) {
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

        MessageActions._sendMessage(channel.id, msg, options);
    } else {
        MessageActions.sendGreetMessage(channel.id, stickers[0], options);
    }
}

function canSendSticker(sticker: GuildSticker, channelGuildId: string | null, premiumType: number) {
    if (sticker.available === false) return false;

    const hasNitro = premiumType === 2;

    if (sticker.type === 2)
        return sticker.guild_id === channelGuildId || hasNitro;

    return hasNitro;
}

function getSendableStickers(channelGuildId: string | null) {
    const premiumType = UserStore.getCurrentUser()?.premiumType ?? 0;
    const onlyCurrent = settings.store.onlyCurrentGuildStickers;

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

        const sendable = stickers.filter(s => canSendSticker(s, channelGuildId, premiumType));
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

function PickerModal({ modalProps, channel, message }: { modalProps: RenderModalProps; channel: Channel; message: Message | null; }) {
    const [setDefaultMode, setSetDefaultMode] = React.useState(false);
    const { defaultStickerId } = settings.use(["defaultStickerId"]);

    const onSelect = (...args: any[]) => {
        const id = extractStickerId(args);
        if (!id) return;

        if (setDefaultMode) settings.store.defaultStickerId = id;
        else greet(channel, message, [id], true);
        modalProps.onClose();
    };

    return (
        <Modal
            {...modalProps}
            size="sm"
            title="Greet Sticker Picker"
            actionBarInput={<FormSwitch title="Set as default" value={setDefaultMode} onChange={setSetDefaultMode} hideBorder />}
            actions={defaultStickerId
                ? [{ text: "Clear default greet sticker", variant: "secondary", onClick: () => { settings.store.defaultStickerId = undefined; } }]
                : []}
        >
            <div style={{ height: 460, display: "flex", flexDirection: "column" }}>
                <NativeStickerPicker channel={channel} onSelectSticker={onSelect} closePopout={modalProps.onClose} />
            </div>
        </Modal>
    );
}

function openNativePicker(channel: Channel, message: Message | null) {
    if (!NativeStickerPicker) return false;
    openModal(modalProps => <PickerModal modalProps={modalProps} channel={channel} message={message} />);
    return true;
}

function GreetMenu({ channel, message }: { message: Message | null, channel: Channel; }) {
    const s = settings.use(["greetMode", "multiGreetChoices", "enableServerStickers", "enableMultiGreet", "defaultStickerId"]);
    const { greetMode, multiGreetChoices = [], defaultStickerId } = s;
    // Discord's welcome sticker list is grabbed by a patch; until that module loads it's missing.
    const welcomeStickers: any[] = WELCOME_STICKERS ?? [];

    const [query, setQuery] = React.useState("");
    const q = query.trim().toLowerCase();

    const channelGuildId = channel.getGuildId?.() ?? (channel as any).guild_id ?? null;
    const serverStickerGroups = getSendableStickers(channelGuildId);

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

    const matches = q
        ? serverStickerGroups
            .flatMap(g => g.stickers
                .filter(st => st.name.toLowerCase().includes(q))
                .map(st => ({ st, guildName: g.guildName })))
            .slice(0, 100)
        : [];

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
                        action={() => greet(channel, message, [sticker.id])}
                    />
                ))}
            </Menu.MenuGroup>

            <Menu.MenuSeparator />

            <Menu.MenuGroup label="Default Greet (left-click)">
                <Menu.MenuItem
                    id="greet-default-set"
                    label="Set Default Greet Sticker"
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
                                        placeholder="Find the perfect sticker"
                                        autoFocus
                                    />
                                </div>
                            )}
                        />

                        {q ? (
                            matches.length === 0 ? (
                                <Menu.MenuItem id="greet-server-nomatch" label="No matches" disabled />
                            ) : (
                                matches.map(({ st, guildName }) => (
                                    <Menu.MenuItem
                                        key={st.id}
                                        id={"greet-server-sticker-" + st.id}
                                        label={st.name}
                                        subtext={guildName}
                                        {...thumbProps(st)}
                                        action={() => greet(channel, message, [st.id], true)}
                                    />
                                ))
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
                                            action={() => greet(channel, message, [sticker.id], true)}
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
                            action={() => greet(channel, message, [...multiGreetChoices])}
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
            find: "#{intl::WELCOME_CTA_LABEL}",
            predicate: () => !originalOn(),
            all: true,
            replacement: {
                match: /className:\i\.\i,(?=.{0,40}?"sticker")(?<={channel:\i(?:,message:\i)?}=(\i).+?)/g,
                replace: "$&onContextMenu:(vcEvent)=>$self.pickSticker(vcEvent, $1),onClickCapture:(vcEvent)=>$self.onGreetClick(vcEvent, $1),"
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
            find: "#{intl::EXPRESSION_PICKER_CATEGORIES_A11Y_LABEL}",
            predicate: () => !originalOn(),
            noWarn: true,
            replacement: {
                match: /(\i===\i\.\i\.STICKER&&\i\?\([^()]{1,12}\)\()([\w$.]+)(,\{)/,
                replace: "$1($self.NativeStickerPicker=$2)$3"
            }
        },
        {
            find: '"In-channel greet"',
            predicate: () => !originalOn(),
            replacement: [
                {
                    match: /onClick:\i,(children:\[\(0,\i\.jsx\)\(\i\.\i,\{sticker:)/,
                    replace: "onContextMenu:vcE=>$self.pickStickerDM(vcE),onClickCapture:vcE=>$self.onGreetClickDM(vcE),$&"
                },
                {
                    match: /(variant:"primary",size:"md",)onClick:/,
                    replace: "$1onContextMenu:vcE=>$self.pickStickerDM(vcE),onClickCapture:vcE=>$self.onGreetClickDM(vcE),onClick:"
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
        greet(props.channel, props.message ?? null, [id], true);
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
        if (wantNative && openNativePicker(props.channel, props.message ?? null)) return;

        ContextMenuApi.openContextMenu(event, () => <GreetMenu channel={props.channel} message={props.message ?? null} />);
    },

    getCurrentChannel(): Channel | null {
        const id = SelectedChannelStore.getChannelId?.();
        return id ? ChannelStore.getChannel(id) : null;
    },

    pickStickerDM(event: React.UIEvent) {
        const channel = this.getCurrentChannel();
        if (channel) this.pickSticker(event, { channel });
    },

    onGreetClickDM(event: React.MouseEvent) {
        const channel = this.getCurrentChannel();
        if (channel) this.onGreetClick(event, { channel });
    }
});
