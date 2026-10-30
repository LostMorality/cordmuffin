/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Message } from "@vencord/discord-types";
import { Parser, useEffect, useState } from "@webpack/common";

import { languages } from "../misc/languages";
import { cl, Translation } from "../misc/types";
import { Icon } from "./icon";
import { translate } from "./translator";

// A message can be on screen twice (chat and search), so keep every copy's setter.
type Setters = Set<(translation: Translation | undefined) => void>;
const setters = new Map<string, Setters>();

export function Accessory({ message }: { message: Message; }) {
    const [translation, setTranslation] = useState<Translation | undefined>(undefined);

    useEffect(() => {
        if ((message as any).vencordEmbeddedBy) return;

        const own: Setters = setters.get(message.id) ?? new Set();
        setters.set(message.id, own);
        own.add(setTranslation);

        return () => {
            own.delete(setTranslation);
            if (!own.size && setters.get(message.id) === own) setters.delete(message.id);
        };
    }, []);

    if (!translation) return null;

    return (
        <div className={cl("accessory")}>
            <Icon height={16} width={16} />
            {Parser.parse(translation.text)}
            {" "}
            (translated from {languages[translation.src] ?? translation.src} - <button onClick={() => setTranslation(undefined)} className={cl("dismiss")}>Dismiss</button>)
        </div>
    );
}

export async function handleTranslate(message: Message) {
    const own = setters.get(message.id);
    if (!own?.size) return;

    let translation: Translation;
    try {
        translation = await translate(message.content);
    } catch (error) {
        console.error("[TranslateItAll] Translation failed:", error);
        translation = { src: "en", text: "Translation failed due to an error." };
    }

    for (const set of own) set(translation);
}
