/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { promptToRestart } from "@utils/promptToRestart";

import { Translation } from "../misc/types";
import { settings, toYandex, YANDEX_API, yandexSupports } from "../settings";

const TOKI_WORDS = new Set([
    "leko", "weka", "pan", "lete", "linja", "lipu", "suli", "nimi", "akesi", "misikeke", "selo", "ike", "sijelo", "sona", "lili",
    "pimeja", "ante", "jo", "loje", "telo", "walo", "kijetesantakalu", "kasi", "waso", "wile", "utala", "lukin", "sina", "lape",
    "ma", "pilin", "jasima", "la", "olin", "pipi", "meso", "lawa", "pi", "pakala", "oko", "tan", "ken", "jaki", "unpa", "esun",
    "seme", "sitelen", "len", "kule", "soko", "open", "ala", "tenpo", "lon", "sinpin", "pini", "kokosila", "mama", "musi",
    "monsi", "mewika", "taso", "ona", "mun", "kiwen", "tomo", "mute", "mi", "nena", "palisa", "meli", "laso", "wawa", "ale",
    "kipisi", "kulupu", "ilo", "lupa", "nanpa", "en", "mu", "jelo", "kili", "tonsi", "moku", "ni", "kama", "pu", "poki",
    "monsuta", "sin", "lasina", "poka", "soweli", "sewi", "elena", "epiku", "moli", "pona", "lanpan", "alasa", "anu", "kute",
    "uta", "luka", "suno", "sama", "awen", "namako", "suwi", "noka", "seli", "mije", "sike", "jan", "pali", "tawa", "inli",
    "nasa", "mani", "wan", "insa", "nijon", "nasin", "kalama", "ijo", "toki", "anpa", "kala", "kepeken", "ko", "kon", "pana",
    "tu", "supa", "kin", "usawi", "yupekosi", "li", "e"
]);

// Words other languages use too (Spanish "mi casa en la playa", English "open it"), so they don't count as proof alone.
const SHARED_WORDS = new Set(["la", "en", "mi", "ma", "ni", "pan", "open", "ken", "mama", "sin", "tan", "jan", "len", "e"]);

function isTokiPona(text: string) {
    const words = text.match(/\p{L}+/gu) ?? [];

    let hits = 0, distinctive = 0, misses = 0, afterToki = false;
    for (const word of words) {
        const lower = word.toLowerCase();
        if (TOKI_WORDS.has(lower)) {
            hits++;
            if (!SHARED_WORDS.has(lower)) distinctive++;
            afterToki = true;
        } else if (afterToki && /^\p{Lu}\p{Ll}/u.test(word)) {
            // Toki Pona names are capitalised and follow a head word (jan Sonja, ma Kanata); they are neither hits nor misses.
            // Requiring the head word keeps English like "Learning Toki Pona" or "I LOVE TOKI PONA" out.
            continue;
        } else {
            misses++;
            afterToki = false;
        }
    }

    return hits >= 2 && hits >= (hits + misses) * 0.8 && distinctive * 3 >= hits;
}

function isSitelen(text: string) {
    const dictionary = /(?:󱤀|󱤁|󱤂|󱤃|󱤄|󱤅|󱤆|󱤇|󱤈|󱤉|󱤊|󱤋|󱤌|󱤍|󱤎|󱤏|󱤐|󱤑|󱤒|󱤓|󱤔|󱤕|󱤖|󱤗|󱤘|󱤙|󱤚|󱤛|󱤜|󱤝|󱤞|󱤟|󱤠|󱤡|󱤢|󱤣|󱤤|󱤥|󱤦|󱤧|󱤨|󱤩|󱤪|󱤫|󱤬|󱤭|󱤮|󱤯|󱤰|󱤱|󱤲|󱤳|󱤴|󱤵|󱤶|󱤷|󱤸|󱤹|󱤺|󱤻|󱤼|󱤽|󱤾|󱤿|󱥀|󱥁|󱥂|󱥃|󱥄|󱥅|󱥆|󱥇|󱥈|󱥉|󱥊|󱥋|󱥌|󱥍|󱥎|󱥏|󱥐|󱥑|󱥒|󱥓|󱥔|󱥕|󱥖|󱥗|󱥘|󱥙|󱥚|󱥛|󱥜|󱥝|󱥞|󱥟|󱥠|󱥡|󱥢|󱥣|󱥤|󱥥|󱥦|󱥧|󱥨|󱥩|󱥪|󱥫|󱥬|󱥭|󱥮|󱥯|󱥰|󱥱|󱥲|󱥳|󱥴|󱥵|󱥶|󱥷|󱦠|󱦡|󱦢|󱦣|󱥸|󱥹|󱥺|󱥻|󱥼|󱥽|󱥾|󱥿|󱦀|󱦁|󱦂|󱦃|󱦄|󱦅|󱦆|󱦇|󱦈|󱦐|󱦑|󱦒|󱦓|󱦔|󱦕|󱦖|󱦗|󱦘|󱦙|󱦚|󱦛|󱦜|󱦝)/m;

    return dictionary.test(text);
}

function isShavian(text: string) {
    return /[\u{10450}-\u{1047F}]/u.test(text);
}

async function fetchJson(url: string, init?: RequestInit) {
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`Request to ${new URL(url).host} failed with status ${res.status}`);
    return res.json();
}

const dictionaries = new Map<string, Promise<Record<string, string>>>();

// The dictionaries are large (Shavian is ~3.7 MB), so fetch each once per session.
function loadDictionary(url: string) {
    let pending = dictionaries.get(url);
    if (!pending) {
        pending = fetchJson(url);
        pending.catch(() => dictionaries.delete(url));
        dictionaries.set(url, pending);
    }
    return pending;
}

export function clearTranslatorCaches() {
    dictionaries.clear();
}

const SHAVIAN_DICT = "https://raw.githubusercontent.com/ForkPrince/TranslatePlus/322199d5fdb1a9506591c9f4a2826338b5d67e38/shavian.json";
const SITELEN_DICT = "https://raw.githubusercontent.com/ForkPrince/TranslatePlus/5ca152b134ea11433971f21b2ef8d556d4306717/sitelen-pona.json";

const punctuationMap: Record<string, string> = {
    '"': "\"",
    "«": "\"",
    "»": "\"",
    ",": ",",
    "!": "!",
    "?": "?",
    ".": ".",
    "(": "(",
    ")": ")",
    "/": "/",
    ";": ";",
    ":": ":"
};

async function translateShavian(message: string) {
    const dictionary = await loadDictionary(SHAVIAN_DICT);

    // Keep the original whitespace between words so line breaks survive.
    return message.split(/(\s+)/).map((word, i) => {
        if (i % 2 === 1 || !word) return word;

        let before = "", after = "";
        if (word[0] in punctuationMap) {
            before = punctuationMap[word[0]];
            word = word.slice(1);
        }
        if (word && word[word.length - 1] in punctuationMap) {
            after = punctuationMap[word[word.length - 1]];
            word = word.slice(0, -1);
        }

        return before + (Object.hasOwn(dictionary, word) ? dictionary[word] : word) + after;
    }).join("").trim();
}

async function translateSitelen(message: string) {
    const dictionary = await loadDictionary(SITELEN_DICT);

    const keys = Object.keys(dictionary)
        .sort((a, b) => b.length - a.length)
        .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (!keys.length) return message;

    // Space out each glyph's word, leaving any Latin text and line breaks as written.
    return message
        .replace(new RegExp(keys.join("|"), "g"), match => ` ${dictionary[match]} `)
        .replace(/[^\S\n]+/g, " ")
        .replace(/ ?\n ?/g, "\n")
        .trim();
}

const failed = (text = "Translation failed due to an error."): Translation => ({ src: "", text, error: true });

// Google takes the text in the URL and rejects URLs over ~16k characters, so long messages go in parts.
const GOOGLE_MAX_ENCODED = 6000;

function splitForGoogle(text: string) {
    const parts: string[] = [];
    let current = "";

    const push = (piece: string) => {
        if (current && encodeURIComponent(current + piece).length > GOOGLE_MAX_ENCODED) {
            parts.push(current);
            current = "";
        }
        if (encodeURIComponent(piece).length <= GOOGLE_MAX_ENCODED) {
            current += piece;
            return;
        }
        for (const char of piece) {
            if (current && encodeURIComponent(current + char).length > GOOGLE_MAX_ENCODED) {
                parts.push(current);
                current = "";
            }
            current += char;
        }
    };

    for (const line of text.split(/(?<=\n)/)) {
        if (encodeURIComponent(line).length <= GOOGLE_MAX_ENCODED) push(line);
        else for (const sentence of line.split(/(?<=[.!?。！？]\s*)/u)) push(sentence);
    }
    if (current) parts.push(current);

    return parts;
}

async function google(target: string, text: string): Promise<Translation> {
    if (!text) return { src: "", text: "" };
    try {
        let src = "", out = "";
        for (const part of splitForGoogle(text)) {
            // Google drops whitespace at the edges of what it gets, so put the part's own spaces and line breaks back.
            const [, lead, body, trail] = part.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
            if (!body) {
                out += part;
                continue;
            }
            const translate = await fetchJson(`https://translate.googleapis.com/translate_a/single?${new URLSearchParams({ client: "gtx", sl: "auto", tl: target, dt: "t", dj: "1", source: "input", q: body })}`);
            src ||= translate.src ?? "";
            const piece: string = translate.sentences?.map(s => s.trans).filter(Boolean).join("") ?? "";
            out += lead + piece.trim() + trail;
        }

        return { src, text: out };
    } catch (error) {
        console.error("[TranslateItAll] Google Translate request failed:", error);
        return failed();
    }
}

const ucid = crypto.randomUUID().replaceAll("-", "");
const fromYandex: Record<string, string> = { "zh": "zh-CN", "he": "iw", "jv": "jw" };
const markdown: [RegExp, string][] = [
    [/\*\*(.+?)\*\*/gs, "b"],
    [/__(.+?)__/gs, "u"],
    [/\*(.+?)\*/gs, "i"],
    [/\b_(.+?)_\b/gs, "i"],
    [/~~(.+?)~~/gs, "s"],
    [/\|\|(.+?)\|\|/gs, "mark"]
];
const marks = { b: "**", u: "__", i: "*", s: "~~", mark: "||" };

function toHtml(text: string) {
    const kept: string[] = [];
    let html = text
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/```[\s\S]*?```|`[^`\n]+`|&lt;a?:\w+:\d+&gt;|&lt;(?:@!?|@&amp;|#)\d+&gt;|&lt;t:-?\d+(?::\w)?&gt;|&lt;\/[\w -]+:\d+&gt;|https?:\/\/\S+/g, m => `<var>${kept.push(m) - 1}</var>`);
    for (const [regex, tag] of markdown) html = html.replace(regex, `<${tag}>$1</${tag}>`);
    return { html, kept };
}

function fromHtml(html: string, kept: string[]) {
    return html
        .replace(/<var>\s*(\d+)\s*<\/var>/gi, (_, i) => kept[i] ?? "")
        .replace(/<\/?(b|u|i|s|mark)>/gi, (_, tag) => marks[tag.toLowerCase()])
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

async function yandex(target: string, text: string): Promise<Translation> {
    if (!text) return { src: "", text: "" };

    // Yandex has no Traditional Chinese, Hawaiian and so on; Google covers those instead of failing.
    if (!yandexSupports(target)) return google(target, text);

    if (!IS_WEB && !await VencordNative.csp.isDomainAllowed(YANDEX_API, ["connect-src"])) {
        const res = await VencordNative.csp.requestAddOverride(YANDEX_API, ["connect-src"], "TranslateItAll");
        if (res === "ok") {
            promptToRestart("relaunch");
            return failed("Yandex Translate is allowed now. Restart Discord, then translate again.");
        }
        return failed("Yandex Translate is blocked. Allow translate.yandex.net in the plugin settings to use it.");
    }

    const { html, kept } = toHtml(text);
    let res: Response;
    try {
        res = await fetch(`${YANDEX_API}translate?${new URLSearchParams({ ucid, srv: "android", format: "html" })}`, {
            method: "POST",
            body: new URLSearchParams({ text: html, lang: toYandex[target] ?? target })
        });
    } catch (error) {
        // fetch only throws when no response came back at all, which is what a host still blocked until restart looks like.
        console.error("[TranslateItAll] Yandex Translate request failed:", error);
        return failed("Couldn't reach Yandex Translate. If you just allowed it, restart Discord.");
    }

    try {
        const translate = await res.json().catch(() => {
            throw new Error(`Request failed with status ${res.status}`);
        });

        if (translate.code === 501) return failed(`Yandex Translate can't translate into "${target}". Change the target language in the plugin settings.`);
        if (translate.code !== 200) throw new Error(`Request failed with code ${translate.code}: ${translate.message}`);

        const src = translate.lang.split("-")[0];
        return {
            src: fromYandex[src] ?? src,
            text: fromHtml(translate.text.join("\n"), kept)
        };
    } catch (error) {
        console.error("[TranslateItAll] Yandex Translate request failed:", error);
        return failed("Yandex Translate failed. Try again later or switch to Google.");
    }
}

async function fromEnglish(target: string, english: string, src: string): Promise<Translation> {
    if (target === "en") return { src, text: english };

    const machine = settings.store.yandex ? yandex : google;
    const result = await machine(target, english);
    return result.error ? result : { src, text: result.text };
}

export async function translate(text: string): Promise<Translation> {
    const { target, toki, sitelen, shavian } = settings.store;

    const sitelenText = sitelen && isSitelen(text);

    if (sitelenText || (toki && isTokiPona(text))) {
        if (sitelenText) text = await translateSitelen(text);

        const translate = await fetchJson("https://aiapi.serversmp.xyz/toki", {
            method: "POST",
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                text: text,
                src: "tl",
                target: "en"
            })
        });

        const english = translate?.translation?.[0];
        if (typeof english !== "string") throw new Error("Toki Pona translator returned no translation");

        return fromEnglish(target, english, "tp");
    }

    if (shavian && isShavian(text)) return fromEnglish(target, await translateShavian(text), "sh");

    return (settings.store.yandex ? yandex : google)(target, text);
}
