/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings, migratePluginSettings } from "@api/Settings";
import { getUserSettingLazy } from "@api/UserSettings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Text } from "@components/Text";
import { classNameFactory } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import type { Channel, Emoji } from "@vencord/discord-types";
import { AccessibilityStore, EmojiStore, TextInput, UserStore, useMemo, useState, useStateFromStores, WindowStore } from "@webpack/common";
import type { ReactNode } from "react";

import managedStyle from "./style.css?managed";
import { ANIMATIONS, ANNOUNCED_WORDS, emojisAllowed, emojiUrl, errorText, getSavedStyle, getUserStyle, normalize, sameEmoji, sameStyle, saveStyle, soleTyperId, type StyleEmoji, typedEmoji, type TypingStyle, verbFor, WORDS } from "./utils";

const cl = classNameFactory("vc-cti-");
const EMPTY: TypingStyle = { emojis: [], animation: 0, typingSuggestion: 0 };
const AnimateEmoji = getUserSettingLazy<boolean>("textAndImages", "animateEmoji");
// Same intention Discord's own pickers use for emoji you can send anywhere.
const PICKER_INTENTION = 15;

function useMotion(live?: boolean) {
    const reduced = useStateFromStores([AccessibilityStore], () => AccessibilityStore.useReducedMotion);
    const focused = useStateFromStores([WindowStore], () => WindowStore.isFocused());
    const animateEmoji = AnimateEmoji?.useSetting() ?? true;
    return { reduced, playGifs: animateEmoji && !reduced && (!live || focused) };
}

function EmojiImg({ emoji, size, animate = true }: { emoji: StyleEmoji; size: number; animate?: boolean; }) {
    const src = emojiUrl(emoji, animate);
    return src
        ? <img className={cl("emoji")} src={src} alt={emoji.name} width={size} height={size} draggable={false} />
        : <span className={cl("emoji")} style={{ fontSize: size * 0.85, lineHeight: `${size}px` }}>{emoji.name}</span>;
}

function Emojis({ style, size, live }: { style: TypingStyle; size: number; live?: boolean; }) {
    const { reduced, playGifs } = useMotion(live);
    const anim = reduced ? "none" : ANIMATIONS[style.animation].toLowerCase();
    return (
        <span className={cl("emojis", `anim-${anim}`, live && "live")} aria-hidden>
            {style.emojis.slice(0, 3).map((e, i) => <EmojiImg key={i} emoji={e} size={size} animate={playGifs} />)}
        </span>
    );
}

function toneOf(e: Emoji): Emoji {
    const tone = EmojiStore.diversitySurrogate;
    if (!tone || e.type !== 0) return e;
    const child = (e as Emoji & { diversityChildren?: Record<string, Emoji>; }).diversityChildren?.[tone.codePointAt(0)!.toString(16)];
    return child ?? e;
}

function toStyleEmoji(raw: Emoji): StyleEmoji {
    const e = toneOf(raw);
    return e.type === 1 ? { id: e.id, name: e.name, animated: e.animated } : { name: e.surrogates };
}

function emojiKey(e: Emoji) {
    return e.type === 1 ? e.id : e.surrogates;
}

function emojiLabel(e: Emoji) {
    return `:${e.type === 1 ? e.name : e.uniqueName ?? e.name}:`;
}

function usable(e: Emoji) {
    return e.type !== 1 || ((e as Emoji & { available?: boolean; }).available !== false && !!EmojiStore.getUsableCustomEmojiById(e.id));
}

function EmojiGrid({ onPick, disabled }: { onPick(e: StyleEmoji): void; disabled: boolean; }) {
    const [query, setQuery] = useState("");
    const { playGifs } = useMotion();
    const results = useMemo(() => {
        const q = query.trim().replace(/:/g, "");
        let pool: Emoji[];
        if (q) {
            try {
                pool = EmojiStore.searchWithoutFetchingLatest({ channel: null as unknown as Channel, query: q, count: 120, intention: PICKER_INTENTION }).unlocked;
            } catch {
                const lower = q.toLowerCase();
                pool = EmojiStore.getDisambiguatedEmojiContext(null).getDisambiguatedEmoji()
                    .filter(e => (e.type === 1 ? e.name : e.uniqueName ?? "").toLowerCase().includes(lower));
            }
        } else {
            const ctx = EmojiStore.getDisambiguatedEmojiContext(null);
            pool = [...ctx.favoriteEmojisWithoutFetchingLatest, ...ctx.getFrequentlyUsedEmojisWithoutFetchingLatest()];
            if (!pool.length) pool = ctx.getDisambiguatedEmoji();
        }
        const seen = new Set<string>();
        return pool.filter(e => {
            if (!usable(e)) return false;
            const k = emojiKey(e);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        }).slice(0, 80);
    }, [query]);
    const typed = results.length ? null : typedEmoji(query);

    return (
        <div className={cl("picker")}>
            <TextInput value={query} onChange={setQuery} placeholder="Search emoji, or type one in" aria-label="Search emoji" disabled={disabled} />
            <div className={cl("grid")}>
                {results.map(e => (
                    <Button key={emojiKey(e)} variant="none" size="iconOnly" className={cl("cell")} title={emojiLabel(e)} aria-label={emojiLabel(e)} disabled={disabled} onClick={() => onPick(toStyleEmoji(e))}>
                        <EmojiImg emoji={toStyleEmoji(e)} size={28} animate={playGifs} />
                    </Button>
                ))}
                {typed && (
                    <Button variant="none" size="iconOnly" className={cl("cell")} title={typed} aria-label={typed} disabled={disabled} onClick={() => onPick({ name: typed })}>
                        <EmojiImg emoji={{ name: typed }} size={28} />
                    </Button>
                )}
                {!results.length && !typed && <Text size="sm" color="text-muted">No emoji found.</Text>}
            </div>
        </div>
    );
}

function Choice({ options, value, onChange, disabled }: { options: readonly string[]; value: number; onChange(v: number): void; disabled: boolean; }) {
    return (
        <div className={cl("choices")} role="radiogroup">
            {options.map((label, i) => (
                <Button key={label} size="small" variant={value === i ? "primary" : "secondary"} role="radio" aria-checked={value === i} disabled={disabled} onClick={() => onChange(i)}>
                    {label}
                </Button>
            ))}
        </div>
    );
}

const SAVED = "Saved to your account. People on Discord's phone app, and desktop users with this plugin, see it when you're the only one typing.";
const REMOVED = "Removed. You're back to the normal typing dots.";
const NOT_REMOVED = "Discord didn't remove it. Your style is still on your account, so try again later.";
const NEEDS_NITRO = "Discord didn't save it. This needs full Nitro (not Nitro Basic).";
const NOT_SAVED = "Discord didn't save it. Your account may not have this yet, or the plugin needs a newer app version.";

function Editor() {
    const user = useStateFromStores([UserStore], () => UserStore.getCurrentUser());
    const saved = useStateFromStores([UserStore], () => getSavedStyle(), [], sameStyle);
    const [draft, setDraft] = useState<TypingStyle>(() => saved ?? EMPTY);
    const [slot, setSlot] = useState(0);
    const [busy, setBusy] = useState<"save" | "remove" | null>(null);
    const [status, setStatus] = useState<{ ok: boolean; text: string; } | null>(null);
    const { reduced, playGifs } = useMotion();

    const fullNitro = user?.premiumType === 2;
    const dirty = !sameStyle(normalize(draft), saved);
    const complete = draft.emojis.length === 3;

    const edit = (f: (d: TypingStyle) => TypingStyle) => {
        setStatus(null);
        setDraft(f);
    };

    // The first pick fills every empty slot, like the phone app.
    const pick = (e: StyleEmoji) => {
        edit(d => ({ ...d, emojis: [0, 1, 2].map(i => i === slot ? e : d.emojis[i] ?? e) }));
        setSlot(s => (s + 1) % 3);
    };

    const surprise = () => {
        const ctx = EmojiStore.getDisambiguatedEmojiContext(null);
        const pool = [...ctx.favoriteEmojisWithoutFetchingLatest, ...ctx.getFrequentlyUsedEmojisWithoutFetchingLatest(), ...ctx.getDisambiguatedEmoji().slice(0, 400)]
            .filter(usable);
        const picked: StyleEmoji[] = [];
        for (let tries = 0; picked.length < 3 && tries < 200 && pool.length; tries++) {
            const e = toStyleEmoji(pool[Math.floor(Math.random() * pool.length)]);
            if (!picked.some(p => sameEmoji(p, e))) picked.push(e);
        }
        edit(() => ({
            emojis: picked,
            animation: 1 + Math.floor(Math.random() * (ANIMATIONS.length - 1)),
            typingSuggestion: ANNOUNCED_WORDS[Math.floor(Math.random() * ANNOUNCED_WORDS.length)]
        }));
    };

    const apply = async (style: TypingStyle | null) => {
        setBusy(style ? "save" : "remove");
        setStatus(null);
        try {
            const confirmed = await saveStyle(style);
            if (!style) {
                setStatus(confirmed ? { ok: true, text: REMOVED } : { ok: false, text: NOT_REMOVED });
                if (confirmed) {
                    setDraft(EMPTY);
                    setSlot(0);
                }
            } else {
                setStatus(confirmed ? { ok: true, text: SAVED } : { ok: false, text: fullNitro ? NOT_SAVED : NEEDS_NITRO });
            }
        } catch (e) {
            setStatus({ ok: false, text: errorText(e) });
        } finally {
            setBusy(null);
        }
    };

    const name = (user as { globalName?: string; } | undefined)?.globalName || user?.username || "You";
    const locked = busy != null;

    return (
        <div className={cl("editor")}>
            {!fullNitro && (
                <Text size="sm" color="text-danger">
                    Discord only saves this with full Nitro (not Nitro Basic). You can still try out styles here.
                </Text>
            )}

            <div className={cl("preview")}>
                {complete ? <Emojis style={draft} size={20} live /> : <span className={cl("dots")}><i /><i /><i /></span>}
                <Text size="sm" tag="span"><strong>{name}</strong> {verbFor(draft.typingSuggestion)}</Text>
            </div>
            <Text size="xs" color="text-muted">
                This is how others see you. You never see your own while typing.
                {reduced && " Reduced Motion is on, so the preview stays still."}
            </Text>

            <Text size="sm" weight="semibold">Emoji</Text>
            <div className={cl("slots")} role="radiogroup" aria-label="Emoji slot">
                {[0, 1, 2].map(i => (
                    <Button key={i} variant={slot === i ? "primary" : "secondary"} size="small" className={cl("slot")} role="radio" aria-checked={slot === i} aria-label={`Emoji ${i + 1}`} disabled={locked} onClick={() => setSlot(i)}>
                        {draft.emojis[i] ? <EmojiImg emoji={draft.emojis[i]} size={24} animate={playGifs} /> : "+"}
                    </Button>
                ))}
            </div>
            <EmojiGrid onPick={pick} disabled={locked} />

            <Text size="sm" weight="semibold">Animation</Text>
            <Choice options={ANIMATIONS} value={draft.animation} disabled={locked} onChange={animation => edit(d => ({ ...d, animation }))} />

            <Text size="sm" weight="semibold">Text</Text>
            <Choice options={WORDS.map(w => `is ${w}…`)} value={draft.typingSuggestion} disabled={locked} onChange={typingSuggestion => edit(d => ({ ...d, typingSuggestion }))} />
            <Text size="xs" color="text-muted">Discord hasn't announced the last 5 words yet, so some phones may not show them.</Text>

            <div className={cl("actions")}>
                <Button disabled={locked || !complete || !dirty} onClick={() => apply(normalize(draft))}>{busy === "save" ? "Saving…" : "Apply"}</Button>
                <Button variant="secondary" disabled={locked} onClick={surprise}>Surprise me</Button>
                <Button variant="secondary" disabled={locked || !dirty} onClick={() => edit(() => saved ?? EMPTY)}>Reset</Button>
                <Button variant="dangerSecondary" disabled={locked || !saved} onClick={() => apply(null)}>{busy === "remove" ? "Removing…" : "Remove"}</Button>
            </div>
            {!complete && <Text size="xs" color="text-muted">Pick 3 emoji to apply.</Text>}
            {status && <Text size="sm" color={status.ok ? "text-default" : "text-danger"}>{status.text}</Text>}
        </div>
    );
}

const settings = definePluginSettings({
    editor: {
        type: OptionType.COMPONENT,
        component: ErrorBoundary.wrap(Editor, { message: "The typing indicator editor crashed. Report it with the error below." })
    },
    showOthers: {
        type: OptionType.BOOLEAN,
        description: "Show other people's custom typing style instead of the plain dots",
        default: true
    }
});

interface TypingProps {
    channel?: Channel;
    typingUsers?: unknown[];
}

function styleFor(props: TypingProps) {
    if (!settings.store.showOthers || props.typingUsers?.length !== 1 || !props.channel) return null;
    const userId = soleTyperId(props.channel.id);
    const style = userId ? getUserStyle(userId) : null;
    return style && userId ? { style, userId, channel: props.channel } : null;
}

migratePluginSettings("OfficialCustomTypingIndicator", "CustomTypingIndicator");

export default definePlugin({
    name: "OfficialCustomTypingIndicator",
    description: "Discord's own Nitro Custom Typing Indicator, now on desktop. Anyone on Discord's phone app sees yours, no plugin needed.",
    authors: [{ name: "nolifepops", id: 221807880053981184n }],
    settings,
    managedStyle,

    patches: [
        {
            find: "#{intl::SEVERAL_USERS_TYPING_STRONG}",
            group: true,
            replacement: [
                {
                    match: /(?<=\.length>0&&!1!==\i&&)(\(\i\?.{0,80}?dotRadius:3\.5,themed:!0\}\)\))/,
                    replace: "$self.renderDots(arguments[0],$1)"
                },
                {
                    match: /(1===\i\.length\?\i=)(\i\.\i\.format\(\i\.\i#{intl::ONE_USER_TYPING},\{a:\i\}\))/,
                    replace: "$1$self.oneUserText(arguments[0],$2)"
                }
            ]
        }
    ],

    renderDots(props: TypingProps, dots: ReactNode) {
        try {
            const found = styleFor(props);
            if (!found || found.style.emojis.length !== 3) return dots;
            if (!emojisAllowed(found.style, found.channel, found.userId)) return dots;
            return <ErrorBoundary noop><Emojis style={found.style} size={14} live /></ErrorBoundary>;
        } catch {
            return dots;
        }
    },

    oneUserText(props: TypingProps, text: ReactNode) {
        try {
            const found = styleFor(props);
            if (!found?.style.typingSuggestion) return text;
            return [<strong key="u">{props.typingUsers?.[0] as ReactNode}</strong>, ` ${verbFor(found.style.typingSuggestion)}`];
        } catch {
            return text;
        }
    }
});
