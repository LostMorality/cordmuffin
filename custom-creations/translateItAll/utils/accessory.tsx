/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useForceUpdater } from "@utils/react";
import { Message } from "@vencord/discord-types";
import { ChannelStore, Parser, useEffect } from "@webpack/common";

import { languages } from "../misc/languages";
import { cl, Translation } from "../misc/types";
import { Icon } from "./icon";
import { translate } from "./translator";

const IS_COMPONENTS_V2 = 1 << 15;
const enum ComponentType {
    ActionRow = 1,
    Section = 9,
    TextDisplay = 10,
    Container = 17
}

function componentText(components: any[] | undefined, out: string[] = []) {
    for (const c of components ?? []) {
        if (!c) continue;
        if (c.type === ComponentType.TextDisplay && c.content) out.push(c.content);
        else if (c.type === ComponentType.ActionRow || c.type === ComponentType.Container) componentText(c.components, out);
        else if (c.type === ComponentType.Section) componentText([...(c.components ?? []), c.accessory], out);
    }
    return out;
}

// The text Discord's own "Copy Text" uses: the forwarded snapshot for forwards, text displays for components v2.
export function getMessageText(message: Message): string {
    const msg = message as any;
    // getContentMessage() reads messageSnapshots[0].message for any forward, so it throws when a forward has no snapshot.
    const m: any = msg.messageSnapshots?.length && typeof msg.getContentMessage === "function"
        ? msg.getContentMessage() ?? message
        : msg.messageSnapshots?.[0]?.message ?? message;

    if (m?.flags != null && (m.flags & IS_COMPONENTS_V2)) return componentText(m.components).join("\n");
    return m?.content || message.content || "";
}

interface Entry {
    source: string;
    /** undefined while the request is running. */
    translation?: Translation;
}

const MAX_ENTRIES = 200;
const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();

function emit(id: string) {
    listeners.get(id)?.forEach(update => update());
}

function setEntry(id: string, entry: Entry | undefined) {
    entries.delete(id);
    if (entry) {
        entries.set(id, entry);
        if (entries.size > MAX_ENTRIES) {
            const oldest = entries.keys().next().value!;
            entries.delete(oldest);
            emit(oldest);
        }
    }
    emit(id);
}

export function clearTranslations() {
    const ids = [...entries.keys()];
    entries.clear();
    ids.forEach(emit);
}

function languageName(code: string) {
    if (languages[code]) return languages[code];
    try {
        return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
    } catch {
        return code;
    }
}

export function Accessory({ message }: { message: Message; }) {
    const forceUpdate = useForceUpdater();
    // A forward's snapshot gets its own accessories render inside the forward block, using a copy of this
    // record with the same id and no snapshots. Discord skips that render when the channel isn't in
    // ChannelStore, so the outer record only steps aside when the inner one will show.
    const skip = !!(message as any).vencordEmbeddedBy
        || (!!(message as any).messageSnapshots?.length && ChannelStore.getChannel(message.channel_id) != null);

    useEffect(() => {
        if (skip) return;

        const own = listeners.get(message.id) ?? new Set();
        listeners.set(message.id, own);
        own.add(forceUpdate);

        return () => {
            own.delete(forceUpdate);
            if (!own.size && listeners.get(message.id) === own) listeners.delete(message.id);
        };
    }, [message.id, skip]);

    if (skip) return null;

    const entry = entries.get(message.id);
    // After an edit the stored translation belongs to the old text, so hide it.
    if (!entry || entry.source !== getMessageText(message)) return null;

    const { translation } = entry;
    if (!translation) {
        return (
            <div className={cl("accessory")}>
                <Icon height={16} width={16} />
                Translating...
            </div>
        );
    }

    const dismiss = <button onClick={() => setEntry(message.id, undefined)} className={cl("dismiss")}>Dismiss</button>;

    return (
        <div className={cl("accessory")}>
            <Icon height={16} width={16} />
            {Parser.parse(translation.text)}
            {" "}
            {translation.error
                ? <>({dismiss})</>
                : <>(translated from {languageName(translation.src)} - {dismiss})</>}
        </div>
    );
}

export async function handleTranslate(message: Message) {
    const source = getMessageText(message);
    if (!source) return;

    const current = entries.get(message.id);
    if (current && !current.translation && current.source === source) return;

    const entry: Entry = { source };
    setEntry(message.id, entry);

    let translation: Translation;
    try {
        translation = await translate(source);
    } catch (error) {
        console.error("[TranslateItAll] Translation failed:", error);
        translation = { src: "", text: "Translation failed due to an error.", error: true };
    }

    // Dismissed or started again while this request was running.
    if (entries.get(message.id) !== entry) return;

    if (!translation.text) translation = { src: "", text: "Nothing to translate.", error: true };
    entry.translation = translation;
    emit(message.id);
}
