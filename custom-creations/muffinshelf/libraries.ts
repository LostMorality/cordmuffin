/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface BdLibrary {
    file: string;
    url: string;
    /** Tested against a plugin's code with comments and strings blanked out, so a changelog line naming the library doesn't count. */
    uses: RegExp;
    /** Globals the library sets when it runs, hidden while it's off or removed. BDFDB is left out: it keeps its own
     *  window.BDFDB_Global state (dependent plugins queue themselves on it), and stock BetterDiscord keeps it too. */
    globals: string[];
    /** Other libraries it needs. Its own code isn't scanned for them: BDFDB's, for one, looks up ZeresPluginLibrary
     *  only to call its updater when it happens to be there. */
    needs: string[];
}

// In load order: XenoLib needs ZeresPluginLibrary already there when it runs.
export const LIBRARIES: BdLibrary[] = [
    {
        file: "0PluginLibrary.plugin.js",
        url: "https://raw.githubusercontent.com/zerebos/BDPluginLibrary/master/release/0PluginLibrary.plugin.js",
        uses: /\b(?:ZeresPluginLibrary|ZLibrary)\b/,
        globals: ["ZeresPluginLibrary", "ZLibrary"],
        needs: [],
    },
    {
        file: "0BDFDB.plugin.js",
        url: "https://raw.githubusercontent.com/mwittrien/BetterDiscordAddons/master/Library/0BDFDB.plugin.js",
        uses: /\bBDFDB_Global\b/,
        globals: [],
        needs: [],
    },
    {
        file: "1XenoLib.plugin.js",
        url: "https://raw.githubusercontent.com/1Lighty/BetterDiscordPlugins/master/Plugins/1XenoLib.plugin.js",
        uses: /\bXenoLib\b/,
        globals: ["XenoLib"],
        needs: ["0PluginLibrary.plugin.js"],
    },
];

export const LIBRARY_FILES = new Set(LIBRARIES.map(l => l.file));

export const libraryGlobals = (file: string) => LIBRARIES.find(l => l.file === file)?.globals ?? [];

// A string that is exactly a library's name is a lookup (BdApi.Plugins.get("ZeresPluginLibrary")), so it's kept.
const NAMES = new Set(["ZeresPluginLibrary", "ZLibrary", "BDFDB_Global", "XenoLib"]);
const REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const isIdent = (c: string) => /[\w$]/.test(c);

// Blanks out comments, string and template text and regex literals, leaving the code and ${} expressions.
export function codeOnly(src: string) {
    const out: string[] = [];
    const templates: number[] = []; // open-brace count inside each ${ } being read
    let prev = "";
    let word = "";
    let joined = false; // the last character read was part of an identifier
    let i = 0;
    const n = src.length;

    const emit = (text: string, last: string) => {
        out.push(text);
        prev = last;
        word = "";
        joined = false;
    };

    const readTemplate = (from: number) => {
        let j = from;
        while (j < n && src[j] !== "`" && !(src[j] === "$" && src[j + 1] === "{")) j += src[j] === "\\" ? 2 : 1;
        if (j < n && src[j] === "$") {
            templates.push(0);
            emit("`${", "{");
            return j + 2;
        }
        emit("``", "`");
        return j + 1;
    };

    while (i < n) {
        const c = src[i];
        const next = src[i + 1];
        if (c === "/" && next === "/") {
            const end = src.indexOf("\n", i);
            i = end < 0 ? n : end;
            joined = false;
            continue;
        }
        if (c === "/" && next === "*") {
            const end = src.indexOf("*/", i + 2);
            i = end < 0 ? n : end + 2;
            out.push(" ");
            joined = false;
            continue;
        }
        if (c === "\"" || c === "'") {
            let j = i + 1;
            while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
            const body = src.slice(i + 1, j);
            emit(c + (NAMES.has(body) ? body : "") + c, c);
            i = j + 1;
            continue;
        }
        if (c === "`") {
            i = readTemplate(i + 1);
            continue;
        }
        if (templates.length && (c === "{" || c === "}")) {
            const top = templates.length - 1;
            if (c === "}" && templates[top] === 0) {
                templates.pop();
                i = readTemplate(i + 1);
                continue;
            }
            templates[top] += c === "{" ? 1 : -1;
        }
        if (c === "/") {
            const regex = prev === "" || (isIdent(prev) ? REGEX_AFTER_WORD.has(word) : !/[)\]}"'`]/.test(prev));
            if (regex) {
                let j = i + 1;
                let inClass = false;
                while (j < n && src[j] !== "\n") {
                    const r = src[j];
                    if (r === "\\") {
                        j += 2;
                        continue;
                    }
                    if (r === "[") inClass = true;
                    else if (r === "]") inClass = false;
                    else if (r === "/" && !inClass) break;
                    j++;
                }
                j++;
                while (j < n && isIdent(src[j])) j++;
                emit(" null ", ")");
                i = j;
                continue;
            }
        }
        out.push(c);
        if (isIdent(c)) {
            word = joined ? word + c : c;
            prev = c;
            joined = true;
        } else {
            joined = false;
            if (!/\s/.test(c)) {
                prev = c;
                word = "";
            }
        }
        i++;
    }
    return out.join("");
}

// The libraries a plugin file needs, including the ones those need, in load order.
export function librariesUsedBy(code: string, file: string) {
    const own = LIBRARIES.find(l => l.file === file);
    let stripped: string | undefined;
    const wanted = new Set(own ? own.needs : LIBRARIES.filter(l => l.uses.test(stripped ??= codeOnly(code))).map(l => l.file));
    for (const lib of [...LIBRARIES].reverse()) if (wanted.has(lib.file)) lib.needs.forEach(f => wanted.add(f));
    wanted.delete(file);
    return LIBRARIES.filter(l => wanted.has(l.file));
}
