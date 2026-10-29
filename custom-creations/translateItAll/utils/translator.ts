/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { promptToRestart } from "@utils/promptToRestart";

import { settings, YANDEX_API } from "../settings";

function isTokiPona(text: string) {
    const dictionary = /\b(?:leko|weka|pan|lete|linja|lipu|suli|nimi|akesi|misikeke|selo|ike|sijelo|sona|lili|pimeja|ante|jo|loje|telo|walo|kijetesantakalu|kasi|waso|wile|utala|lukin|sina|lape|ma|pilin|jasima|la|olin|pipi|meso|lawa|pi|pakala|oko|tan|ken|jaki|unpa|esun|seme|sitelen|len|kule|soko|open|ala|tenpo|lon|sinpin|pini|kokosila|mama|musi|monsi|mewika|taso|ona|mun|kiwen|tomo|mute|mi|nena|palisa|meli|laso|wawa|ale|kipisi|kulupu|ilo|lupa|nanpa|en|mu|jelo|kili|tonsi|moku|ni|kama|pu|poki|monsuta|sin|lasina|poka|soweli|sewi|elena|epiku|moli|pona|lanpan|alasa|anu|kute|uta|luka|suno|sama|awen|namako|suwi|noka|seli|mije|sike|jan|pali|tawa|inli|nasa|mani|wan|insa|nijon|nasin|kalama|ijo|toki|anpa|kala|kepeken|ko|kon|pana|tu|supa|kin|usawi|yupekosi)\b/gm;

    return (text.match(dictionary) || []).length >= text.split(/\s+/).length * 0.5;
}

function isSitelen(text: string) {
    const dictionary = /(?:󱤀|󱤁|󱤂|󱤃|󱤄|󱤅|󱤆|󱤇|󱤈|󱤉|󱤊|󱤋|󱤌|󱤍|󱤎|󱤏|󱤐|󱤑|󱤒|󱤓|󱤔|󱤕|󱤖|󱤗|󱤘|󱤙|󱤚|󱤛|󱤜|󱤝|󱤞|󱤟|󱤠|󱤡|󱤢|󱤣|󱤤|󱤥|󱤦|󱤧|󱤨|󱤩|󱤪|󱤫|󱤬|󱤭|󱤮|󱤯|󱤰|󱤱|󱤲|󱤳|󱤴|󱤵|󱤶|󱤷|󱤸|󱤹|󱤺|󱤻|󱤼|󱤽|󱤾|󱤿|󱥀|󱥁|󱥂|󱥃|󱥄|󱥅|󱥆|󱥇|󱥈|󱥉|󱥊|󱥋|󱥌|󱥍|󱥎|󱥏|󱥐|󱥑|󱥒|󱥓|󱥔|󱥕|󱥖|󱥗|󱥘|󱥙|󱥚|󱥛|󱥜|󱥝|󱥞|󱥟|󱥠|󱥡|󱥢|󱥣|󱥤|󱥥|󱥦|󱥧|󱥨|󱥩|󱥪|󱥫|󱥬|󱥭|󱥮|󱥯|󱥰|󱥱|󱥲|󱥳|󱥴|󱥵|󱥶|󱥷|󱦠|󱦡|󱦢|󱦣|󱥸|󱥹|󱥺|󱥻|󱥼|󱥽|󱥾|󱥿|󱦀|󱦁|󱦂|󱦃|󱦄|󱦅|󱦆|󱦇|󱦈|󱦐|󱦑|󱦒|󱦓|󱦔|󱦕|󱦖|󱦗|󱦘|󱦙|󱦚|󱦛|󱦜|󱦝)/gm;

    return dictionary.test(text);
}

function isShavian(text: string) {
    const shavianRegex = /[\u{10450}-\u{1047F}]+/u;

    return shavianRegex.test(text);
}

async function translateShavian(message: string) {
    const dictionary = await (await fetch("https://raw.githubusercontent.com/ForkPrince/TranslatePlus/322199d5fdb1a9506591c9f4a2826338b5d67e38/shavian.json")).json();

    const punctuationMap = {
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

    let translated = "";
    const words = message.split(/\s+/);

    for (let word of words) {
        let punctuationBefore = "", punctuationAfter = "";

        if (word[0] in punctuationMap) {
            punctuationBefore = punctuationMap[word[0]];
            word = word.slice(1);
        }

        if (word[word.length - 1] in punctuationMap) {
            punctuationAfter = punctuationMap[word[word.length - 1]];
            word = word.slice(0, -1);
        }

        translated += punctuationBefore;

        if (word in dictionary) translated += dictionary[word];
        else translated += word;

        translated += punctuationAfter + " ";
    }

    return translated.trim();
}

async function translateSitelen(message: string) {
    message = Array.from(message).join(" ");

    const dictionary = await (await fetch("https://raw.githubusercontent.com/ForkPrince/TranslatePlus/5ca152b134ea11433971f21b2ef8d556d4306717/sitelen-pona.json")).json();

    const sorted = Object.keys(dictionary).sort((a, b) => b.length - a.length);

    const pattern = new RegExp(`(${sorted.join("|")})`, "g");

    const translate = message.replace(pattern, match => dictionary[match]);

    return translate;
}

async function google(target: string, text: string) {
    if (!text) return { src: "", text: "" };
    try {
        const res = await fetch(`https://translate.googleapis.com/translate_a/single?${new URLSearchParams({ client: "gtx", sl: "auto", tl: target, dt: "t", dj: "1", source: "input", q: text })}`);
        if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
        const translate = await res.json();

        return {
            src: translate.src,
            text: translate.sentences?.map(s => s.trans).filter(Boolean).join("\n")
        };
    } catch (error) {
        console.error("[TranslatePlus] Google Translate request failed:", error);
        return { src: "en", text: "Translation failed due to an error." };
    }
}

const ucid = crypto.randomUUID().replaceAll("-", "");
const toYandex: Record<string, string> = { "zh-CN": "zh", "zh-TW": "zh", "iw": "he", "jw": "jv" };
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

async function yandex(target: string, text: string) {
    if (!text) return { src: "", text: "" };

    if (!IS_WEB && !await VencordNative.csp.isDomainAllowed(YANDEX_API, ["connect-src"])) {
        const res = await VencordNative.csp.requestAddOverride(YANDEX_API, ["connect-src"], "TranslateItAll");
        if (res === "ok") {
            promptToRestart("relaunch");
            return { src: "en", text: "Yandex Translate is allowed now. Restart Discord, then translate again." };
        }
        return { src: "en", text: "Yandex Translate is blocked. Allow translate.yandex.net in the plugin settings to use it." };
    }

    try {
        const { html, kept } = toHtml(text);
        const res = await fetch(`${YANDEX_API}translate?${new URLSearchParams({ ucid, srv: "android", format: "html" })}`, {
            method: "POST",
            body: new URLSearchParams({ text: html, lang: toYandex[target] ?? target })
        });
        const translate = await res.json();

        if (translate.code === 501) return { src: "en", text: `Yandex Translate can't translate into "${target}". Change the target language in the plugin settings.` };
        if (translate.code !== 200) throw new Error(`Request failed with code ${translate.code}: ${translate.message}`);

        const src = translate.lang.split("-")[0];
        return {
            src: fromYandex[src] ?? src,
            text: fromHtml(translate.text.join("\n"), kept)
        };
    } catch (error) {
        console.error("[TranslateItAll] Yandex Translate request failed:", error);
        return { src: "en", text: "Translation failed due to an error. If you just allowed Yandex Translate, restart Discord." };
    }
}

export async function translate(text: string): Promise<any> {
    const { target, toki, sitelen, shavian } = settings.store;
    const machine = settings.store.yandex ? yandex : google;

    const output = { src: "", text: "" };

    if ((isTokiPona(text) || isSitelen(text)) && (toki || sitelen)) {
        if (isSitelen(text) && sitelen) text = await translateSitelen(text);

        console.log(text);

        const translate = await (await fetch("https://aiapi.serversmp.xyz/toki", {
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
        })).json();

        console.log(translate);

        output.src = "tp";
        output.text = target === "en" ? translate.translation[0] : (await machine(target, translate.translation[0])).text;
    } else if (isShavian(text) && shavian) {
        const translate = await translateShavian(text);

        output.src = "sh";
        output.text = target === "en" ? translate : (await machine(target, translate)).text;
    } else {
        const translate = await machine(target, text);

        output.src = translate.src;
        output.text = translate.text;
    }

    return output;
}
