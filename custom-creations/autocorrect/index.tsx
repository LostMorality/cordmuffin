/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { findGroupChildrenByChildId, type NavContextMenuPatchCallback } from "@api/ContextMenu";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin from "@utils/types";
import { ChannelStore, GuildMemberStore, Menu, RelationshipStore, SelectedChannelStore, UserStore } from "@webpack/common";

import { startPlainFields, stopPlainFields } from "./float";
import { learnFromMessage, onKeyDown } from "./logic";
import { settings } from "./settings";
import { type SlateEditor, slateField } from "./slate";
import { Strip } from "./strip";
import { learnText, load, setExtraKnown, startSaving, syncAllToDiscord, unload } from "./words";

const NAMES_TTL = 60_000;
const NAMES_MAX = 20_000;
const SPLIT = /[^\p{L}'’]+/u;

let namesKey = "";
let namesAt = 0;
let names = new Set<string>();

function addName(set: Set<string>, name: string | null | undefined) {
    if (!name) return;
    for (const part of name.split(SPLIT)) if (part.length > 2 && /^\p{Lu}/u.test(part)) set.add(part.toLowerCase());
}

function isName(word: string) {
    // a name only covers a word typed with a capital, so "wierd" still gets fixed in a server with a "Wierd Al"
    if (!/^\p{Lu}/u.test(word)) return false;
    const channelId = SelectedChannelStore.getChannelId();
    const channel = channelId ? ChannelStore.getChannel(channelId) : null;
    const key = channel?.guild_id ?? channelId ?? "";

    if (key !== namesKey || Date.now() - namesAt > NAMES_TTL) {
        const next = new Set<string>();
        const addUser = (id: string) => addName(next, UserStore.getUser(id)?.globalName);
        if (channel?.guild_id) {
            for (const m of GuildMemberStore.getMembers(channel.guild_id)) {
                if (next.size > NAMES_MAX) break;
                addName(next, m.nick ?? UserStore.getUser(m.userId)?.globalName);
            }
        } else {
            channel?.recipients?.forEach(addUser);
        }
        for (const id of RelationshipStore.getFriendIDs()) {
            if (next.size > NAMES_MAX) break;
            addUser(id);
        }
        names = next;
        namesKey = key;
        namesAt = Date.now();
    }
    return names.has(word.toLowerCase());
}

const textareaMenu: NavContextMenuPatchCallback = children => {
    const group = findGroupChildrenByChildId("spellcheck", children) ?? findGroupChildrenByChildId("add-to-dictionary", children);
    const { mode } = settings.store;
    const item = (
        <Menu.MenuItem id="vc-autocorrect" label="Autocorrect">
            {([["auto", "Fix typos"], ["suggest", "Suggestions only"], ["off", "Off"]] as const).map(([value, label]) => (
                <Menu.MenuRadioItem
                    key={value}
                    id={`vc-autocorrect-${value}`}
                    group="vc-autocorrect-mode"
                    label={label}
                    checked={mode === value}
                    action={() => settings.store.mode = value}
                />
            ))}
        </Menu.MenuItem>
    );
    if (group) group.push(item);
    else children.push(<Menu.MenuGroup>{item}</Menu.MenuGroup>);
};

let running = { stopped: true };

export default definePlugin({
    name: "Autocorrect",
    description: "Phone style autocorrect for the chat box and your custom status. Suggestions show above what you type, typos get fixed when you press space, and Backspace undoes a fix.",
    authors: [{ name: "nolifepops", id: 221807880053981184n }],
    tags: ["Chat", "Utility"],
    settings,

    patches: [
        {
            find: ".CREATE_FORUM_POST||",
            replacement: {
                match: /children:\[(?=\i\|\|\i\?null:\(0,\i\.jsx\)\(\i,\{bars:\i\}\).{0,4000}?\(0,\i\.jsx\)\(\i\.\i,\{ref:(\i),channel:\i,canMentionRoles:.{0,600}?textValue:(\i),.{0,200}?editorRef:(\i),)/,
                replace: "$&$self.renderStrip({autocompleteRef:$1,textValue:$2,editorRef:$3}),"
            }
        },
        {
            find: "getSlateEditor:()=>",
            replacement: {
                match: /if\((\i)\.onKeyDown\?\.\((\i)\)===!0\)/,
                replace: "if($self.onKeyDown($1,$2)===!0||$1.onKeyDown?.($2)===!0)"
            }
        }
    ],

    contextMenus: {
        "textarea-context": textareaMenu,
    },

    renderStrip: ErrorBoundary.wrap(Strip, { noop: true }),
    onKeyDown: (editor: SlateEditor, e: KeyboardEvent) => onKeyDown(slateField(editor), e),

    onBeforeMessageSend(_, msg) {
        if (settings.store.learnFromMessages && settings.store.mode !== "off" && msg.content) learnText(learnFromMessage(msg.content));
    },

    start() {
        running = { stopped: false };
        setExtraKnown(isName);
        startSaving();
        startPlainFields();
        const signal = running;
        void load(signal).then(() => {
            if (!signal.stopped && settings.store.shareWithDiscord) syncAllToDiscord();
        });
    },

    stop() {
        running.stopped = true;
        stopPlainFields();
        setExtraKnown(null);
        names = new Set();
        namesKey = "";
        void unload();
    },
});
