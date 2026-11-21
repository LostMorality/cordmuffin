/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button, TextButton } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { SettingsSection } from "@components/settings/tabs/plugins/components/Common";
import { classNameFactory } from "@utils/css";
import { useForceUpdater } from "@utils/react";
import { OptionType } from "@utils/types";
import { chooseFile, saveFile } from "@utils/web";
import { Alerts, TextInput, useEffect, useState } from "@webpack/common";

import { LICENSE_NOTE } from "./sources";
import { addWords, ensureSaved, forgetLearned, importWords, onWordsChange, reload, removeWord, state, syncAllToDiscord, unblockWord } from "./words";

export const cl = classNameFactory("vc-autocorrect-");

const MAX_SHOWN = 300;
const SEARCH_FROM = 12;
const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

function WordChips({ words, onRemove, empty }: { words: string[]; onRemove(w: string): void; empty: string; }) {
    if (!words.length) return <Paragraph className={cl("empty")}>{empty}</Paragraph>;
    const shown = words.slice(0, MAX_SHOWN);
    return (
        <div className={cl("chips")}>
            {shown.map(w => (
                <span key={w} className={cl("word")}>
                    {w}
                    <button className={cl("word-remove")} aria-label={`Remove ${w}`} onClick={() => onRemove(w)}>×</button>
                </span>
            ))}
            {words.length > shown.length && <span className={cl("more")}>and {words.length - shown.length} more</span>}
        </div>
    );
}

function Status() {
    if (!state.loaded && !state.readError) return <Paragraph className={cl("status")}>Loading your dictionary…</Paragraph>;
    const using = !state.running ? "Autocorrect is off." : `Using ${state.full ? "the full English word list" : "the built in starter list"}.`;
    const problem = state.readError ?? (state.running && state.loadError ? "Some word lists couldn't be downloaded, so suggestions are more limited." : null);
    return (
        <Paragraph className={cl("status")}>
            {using} {state.fixed > 0 && `Fixed ${state.fixed.toLocaleString()} ${state.fixed === 1 ? "typo" : "typos"} so far.`}
            {problem && (
                <>
                    {" "}{problem}{" "}
                    <TextButton variant="link" onClick={() => void reload()}>Try again</TextButton>
                </>
            )}
        </Paragraph>
    );
}

function DictionaryPanel() {
    const update = useForceUpdater();
    const [draft, setDraft] = useState("");
    const [filter, setFilter] = useState("");
    const [note, setNote] = useState("");
    const { shareWithDiscord } = settings.use(["shareWithDiscord"]);

    useEffect(() => {
        const off = onWordsChange(update);
        void ensureSaved();
        return off;
    }, []);

    const words = [...state.words].sort((a, b) => a.localeCompare(b));
    const searching = words.length > SEARCH_FROM && !!filter;
    const shown = searching ? words.filter(w => w.toLowerCase().includes(filter.toLowerCase())) : words;
    const blocked = [...state.blocked].sort();

    const add = () => {
        addWords(draft.split(/[\s,]+/), shareWithDiscord);
        setDraft("");
        setNote("");
    };

    const importFile = async () => {
        const file = await chooseFile("text/plain,.txt,.csv,.tsv,.dic");
        if (!file) return;
        if (file.size > IMPORT_MAX_BYTES) return setNote("That file is too big. Pick a plain text list with one word per line.");
        try {
            const { added, skipped, overCap, rejected } = importWords(await file.text(), shareWithDiscord);
            if (rejected) setNote("That file doesn't look like a word list, so nothing was added. Use a plain text file with one word per line.");
            else setNote([
                `Added ${added.toLocaleString()} ${added === 1 ? "word" : "words"}`,
                skipped && `skipped ${skipped.toLocaleString()} ${skipped === 1 ? "line" : "lines"} that weren't words`,
                overCap && `stopped after the first 20,000 words, so ${overCap.toLocaleString()} more weren't added`,
            ].filter(Boolean).join(", ") + ".");
        } catch {
            setNote("That file couldn't be read.");
        }
    };

    const exportFile = () => saveFile(new File([words.join("\n")], "autocorrect-dictionary.txt", { type: "text/plain" }));

    const forget = () => Alerts.show({
        title: "Forget learned typing?",
        body: "Autocorrect forgets which words you use most and which words you put together. Your dictionary stays.",
        confirmText: "Forget",
        cancelText: "Cancel",
        onConfirm: () => void forgetLearned(),
    });

    return (
        <SettingsSection id="dictionary" name="Your dictionary" description="Words here are never changed, and they show up as suggestions.">
            <Status />
            <div className={cl("row")}>
                <TextInput
                    value={draft}
                    placeholder="Add a word"
                    onChange={setDraft}
                    onKeyDown={(e: React.KeyboardEvent) => e.key === "Enter" && state.loaded && add()}
                />
                <Button size="small" disabled={!state.loaded || !draft.trim()} onClick={add}>Add</Button>
            </div>
            {words.length > SEARCH_FROM && (
                <TextInput value={filter} placeholder={`Search ${words.length} words`} onChange={setFilter} className={cl("search")} />
            )}
            <WordChips words={shown} onRemove={w => removeWord(w, shareWithDiscord)} empty={searching ? "No words match." : "No words yet. Right click a suggestion to add one."} />
            <div className={cl("row")}>
                <Button size="small" variant="secondary" disabled={!state.loaded} onClick={importFile}>Import</Button>
                <Button size="small" variant="secondary" disabled={!words.length} onClick={exportFile}>Export</Button>
                <Button size="small" variant="dangerSecondary" disabled={!state.loaded} onClick={forget}>Forget learned typing</Button>
            </div>
            {note && <Paragraph className={cl("status")}>{note}</Paragraph>}
            {blocked.length > 0 && (
                <>
                    <Paragraph className={cl("subhead")}>Never suggested</Paragraph>
                    <WordChips words={blocked} onRemove={unblockWord} empty="" />
                </>
            )}
            <Paragraph className={cl("credit")}>{LICENSE_NOTE}</Paragraph>
        </SettingsSection>
    );
}

export const settings = definePluginSettings({
    mode: {
        type: OptionType.SELECT,
        description: "What happens while you type. It knows English words only.",
        options: [
            { label: "Fix typos when I press space", value: "auto", default: true },
            { label: "Only show suggestions", value: "suggest" },
            { label: "Off", value: "off" },
        ],
    },
    sensitivity: {
        type: OptionType.SELECT,
        description: "How sure it has to be before fixing a word for you.",
        options: [
            { label: "Very sure (fewer fixes)", value: "modest", default: true },
            { label: "Fairly sure (more fixes)", value: "aggressive" },
        ],
    },
    nextWord: {
        type: OptionType.BOOLEAN,
        description: "Suggest the next word after you type a space.",
        default: true,
    },
    capitalizeSentences: {
        type: OptionType.BOOLEAN,
        description: "Capitalize the first word of a sentence when fixing it.",
        default: false,
    },
    tabAccepts: {
        type: OptionType.BOOLEAN,
        description: "Tab picks the highlighted suggestion. The shortcut shown on the strip always works too.",
        default: false,
    },
    editMessages: {
        type: OptionType.BOOLEAN,
        description: "Also work when editing a message.",
        default: true,
    },
    position: {
        type: OptionType.SELECT,
        description: "Where the suggestions sit above the chat box.",
        options: [
            { label: "Above the word you're typing", value: "word", default: true },
            { label: "Right", value: "right" },
            { label: "Left", value: "left" },
            { label: "Center", value: "center" },
        ],
    },
    keyHints: {
        type: OptionType.BOOLEAN,
        description: "Show which key picks the highlighted suggestion.",
        default: true,
    },
    learnFromMessages: {
        type: OptionType.BOOLEAN,
        description: "Learn which words you use from messages you send. This stays on your PC.",
        default: true,
    },
    shareWithDiscord: {
        type: OptionType.BOOLEAN,
        description: "Share your dictionary with Discord's spellcheck, so added words lose their red underline too.",
        default: true,
        onChange: (value: boolean) => value && syncAllToDiscord(),
    },
    dictionary: {
        type: OptionType.COMPONENT,
        component: DictionaryPanel,
    },
});

