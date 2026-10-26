/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// BetterDiscord plugins can ask for a module's private variables (module.declarations). Discord doesn't expose them,
// so Muffinshelf rewrites the few modules plugins have asked for: on load, each gets a declarations object that reads
// its top-level variables live. Which modules is learned at runtime and applied on the next start.

const KEYWORDS_BEFORE_REGEX = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"]);
const RESERVED = new Set([...KEYWORDS_BEFORE_REGEX, "var", "let", "const", "function", "class", "if", "for", "while", "switch", "try", "catch", "finally", "this", "null", "true", "false", "undefined", "extends", "super", "import", "export", "default", "break", "continue", "with", "debugger", "async", "static", "get", "set", "eval", "arguments"]);
const IDENT = /[\w$]/;

interface Token {
    type: "id" | "punct" | "other";
    value: string;
    depth: number;
}

// A small tokenizer: enough to tell code from strings, template literals, regex literals and comments in minified code,
// and to track bracket depth relative to the start of the scanned text.
function tokenize(src: string): Token[] {
    const tokens: Token[] = [];
    const templateDepths: number[] = [];
    let depth = 0;
    let i = 0;
    let last: Token | undefined;
    const push = (t: Token) => {
        tokens.push(t);
        last = t;
    };
    const regexAllowed = () => !last || (last.type === "punct" && !")]}".includes(last.value)) || (last.type === "id" && KEYWORDS_BEFORE_REGEX.has(last.value));

    const skipString = (quote: string) => {
        i++;
        while (i < src.length && src[i] !== quote) i += src[i] === "\\" ? 2 : 1;
        i++;
    };

    // Reads template text up to the closing backtick or a ${, which opens a nested expression.
    const skipTemplate = () => {
        while (i < src.length) {
            const c = src[i];
            if (c === "\\") i += 2;
            else if (c === "`") {
                i++;
                return;
            } else if (c === "$" && src[i + 1] === "{") {
                i += 2;
                templateDepths.push(depth);
                depth++;
                return;
            } else i++;
        }
    };

    while (i < src.length) {
        const c = src[i];
        if (c === " " || c === "\n" || c === "\t" || c === "\r") {
            i++;
        } else if (c === "/" && src[i + 1] === "/") {
            while (i < src.length && src[i] !== "\n") i++;
        } else if (c === "/" && src[i + 1] === "*") {
            const end = src.indexOf("*/", i + 2);
            i = end === -1 ? src.length : end + 2;
        } else if (c === "\"" || c === "'") {
            skipString(c);
            push({ type: "other", value: "str", depth });
        } else if (c === "`") {
            i++;
            skipTemplate();
            push({ type: "other", value: "tpl", depth });
        } else if (c === "/" && regexAllowed()) {
            i++;
            let inClass = false;
            while (i < src.length) {
                const r = src[i];
                if (r === "\\") i += 2;
                else {
                    if (r === "[") inClass = true;
                    else if (r === "]") inClass = false;
                    else if (r === "/" && !inClass) break;
                    i++;
                }
            }
            i++;
            while (i < src.length && /[a-z]/i.test(src[i])) i++;
            push({ type: "other", value: "re", depth });
        } else if (IDENT.test(c)) {
            let j = i + 1;
            while (j < src.length && IDENT.test(src[j])) j++;
            push({ type: /^\d/.test(c) ? "other" : "id", value: src.slice(i, j), depth });
            i = j;
        } else if (c === "{" || c === "(" || c === "[") {
            push({ type: "punct", value: c, depth });
            depth++;
            i++;
        } else if (c === "}" || c === ")" || c === "]") {
            depth--;
            i++;
            if (c === "}" && templateDepths.length && templateDepths[templateDepths.length - 1] === depth) {
                templateDepths.pop();
                skipTemplate();
                push({ type: "other", value: "tpl", depth });
            } else push({ type: "punct", value: c, depth });
        } else {
            push({ type: "punct", value: c, depth });
            i++;
        }
    }
    return tokens;
}

// Names bound by a destructuring pattern starting at tokens[start] ({ or [); returns the names and the index after it.
function patternNames(tokens: Token[], start: number): [string[], number] {
    const base = tokens[start].depth;
    const names: string[] = [];
    let i = start + 1;
    for (; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type === "punct" && (t.value === "}" || t.value === "]") && t.depth === base) break;
        const next = tokens[i + 1];
        // In { a: b = 1 }, b is the binding; in { a }, a is. Skip default values and computed keys.
        if (t.type === "id" && !RESERVED.has(t.value) && !(next?.type === "punct" && next.value === ":")) {
            const prev = tokens[i - 1];
            const spread = prev?.value === "." && tokens[i - 2]?.value === "." && tokens[i - 3]?.value === ".";
            if (spread || !(prev?.type === "punct" && (prev.value === "=" || prev.value === "."))) names.push(t.value);
        }
    }
    return [names, i + 1];
}

// Top-level variable, function and class names in a module factory body.
export function topLevelNames(body: string): string[] {
    const tokens = tokenize(body);
    const names = new Set<string>();
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.depth !== 0 || t.type !== "id") continue;
        const prev = tokens[i - 1];
        if (prev && prev.type === "punct" && prev.value === ".") continue;

        if (t.value === "function" || t.value === "class") {
            const name = tokens[i + 1]?.value === "*" ? tokens[i + 2] : tokens[i + 1];
            if (name?.type === "id" && !RESERVED.has(name.value)) names.add(name.value);
            continue;
        }
        if (t.value !== "var" && t.value !== "let" && t.value !== "const") continue;

        // var a = x, b, { c } = y; ... declarators are separated by commas at the same depth.
        let j = i + 1;
        while (j < tokens.length) {
            const d = tokens[j];
            if (d.type === "id" && !RESERVED.has(d.value)) {
                names.add(d.value);
                j++;
            } else if (d.type === "punct" && (d.value === "{" || d.value === "[")) {
                const [found, next] = patternNames(tokens, j);
                found.forEach(n => names.add(n));
                j = next;
            } else break;
            // Skip the initializer up to the next comma or the end of the statement at this depth.
            while (j < tokens.length) {
                const s = tokens[j];
                if (s.depth < t.depth) break;
                if (s.depth === t.depth && s.type === "punct" && (s.value === "," || s.value === ";")) break;
                if (s.depth === t.depth && s.type === "id" && ["var", "let", "const"].includes(s.value) && j > i + 1) break;
                j++;
            }
            if (tokens[j]?.type === "punct" && tokens[j].value === ",") j++;
            else break;
        }
        i = j - 1;
    }
    return [...names];
}

// Up to and including the opening brace and any "use strict" prologue, which has to stay first.
const FACTORY_HEAD = /^[^(]*\(([\w$]+)[^)]*\)\s*(?:=>\s*)?\{(?:\s*["']use strict["'];?)?/;

// The patch replacement: called with the factory head as the match and the whole factory source as the last argument.
export function exposeDeclarations(head: string, moduleParam: string, ...rest: any[]) {
    const source: string = rest[rest.length - 1];
    if (typeof source !== "string") return head;
    let names: string[];
    try {
        names = topLevelNames(source.slice(head.length));
    } catch {
        return head;
    }
    if (!names.length) return head;
    const getters = names.map(n => `get ${n}(){try{return ${n}}catch{}},set ${n}(v){try{${n}=v}catch{}}`).join(",");
    // Built on first use, then kept; the getters read the variables live.
    return `${head}Object.defineProperty(${moduleParam},"declarations",{configurable:true,get(){return Object.defineProperty(this,"declarations",{configurable:true,value:{${getters}}}).declarations}});`;
}

export const FACTORY_HEAD_MATCH = FACTORY_HEAD;
