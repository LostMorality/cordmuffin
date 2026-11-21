/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CORE_WORDS } from "./core";

export interface Candidate { word: string; score: number; kind: "correction" | "completion" | "prediction"; }

export interface SuggestResult {
    typed: string;
    known: boolean;
    skip: boolean;
    candidates: Candidate[];
    autoCorrect: string | null;
}

export type Sensitivity = "off" | "modest" | "aggressive";

export interface EngineData {
    /** lowercase words, most frequent first */
    words: string[];
    counts: Float64Array;
    flags: Uint8Array;
    total: number;
    maxLen: number;
    /** built from the small bundled list only */
    core: boolean;
    /** lowercase -> display form ("monday" -> "Monday"); a leading "*" means fix the case on Space too */
    casing: Record<string, string>;
    /** packed trie: children of node n are tFirst[n] .. tFirst[n] + tNum[n] - 1 */
    tChar: Uint8Array;
    tNum: Uint8Array;
    tFirst: Int32Array;
    tWord: Int32Array;
    tBest: Int32Array;
    /** bigrams: followers of word p are bWord/bCount[bStart[p] .. bStart[p + 1]), sorted by word index */
    bStart: Int32Array;
    bWord: Int32Array;
    bCount: Float32Array;
}

export interface Unigrams { words: string[]; counts: number[]; }
export interface Bigrams { first: string[]; second: string[]; counts: number[]; }

const Flag = { NoSuggest: 1, NotKnown: 2 } as const;

export const TUNING = {
    adjSub: 0.66,
    vowelSub: 0.64,
    otherSub: 1.32,
    aposSub: 0.8,
    transpose: 0.55,
    doubleIns: 0.4,
    doubleOmit: 0.21,
    aposOmit: 0.08,
    aposIns: 0.2,
    adjIns: 0.72,
    vowelOmit: 0.42,
    first: 0.4,
    lambda: 7.9,
    completion: 2.9,
    completionChar: 0.22,
    context: 0.5,
    narrow: 1.35,
    bounds: [0, 1.05, 1.05, 1.35, 1.7, 2.0, 2.0, 2.3, 2.3, 2.6],
    widen: -17,
    minHits: 1,
    soundSub: 0.8,
    bareBonus: 3,
    hintBonus: 2,
    userWordP: 3e-6,
    userMix: 0.15,
    keep: { modest: -19, aggressive: -20 } as Record<string, number>,
    ratio: { modest: 3, aggressive: 1.25 } as Record<string, number>,
    maxAutoCost: { modest: 1.6, aggressive: 2.2 } as Record<string, number>,
};

const APOS = 27;
const OTHER = 28;
const SIZE = 29;
const TIER_RANK = [0, 150, 700, 2500, 9000, 25000];

const CHAT_WORDS = `
1 lol ok okay yeah yea yep nah hey hi hello thanks pls please gonna wanna gotta idk omg lmao bro dude guys kinda tho cuz cool
2 btw tbh ngl imo brb ty np rn bc smh irl dm dms vc pfp lmk wyd hbu ikr jk nvm ofc fr oof bruh yikes welp yay yup nope mhm hmm huh ugh meh lmfao xd haha hahaha hehe ahh ohh wow whoa damn dang heck sus vibe vibes lowkey legit literally bet deadass fam homie bestie sis thx
3 alright aight dunno sorta lemme gimme outta lotta tryna finna imma wassup sup yo ayo ayy ooh aww uwu owo hype hyped pog poggers kek copium based cringe cringey mid goated simp yeet noob rekt nerf nerfed buff buffed meta grind afk lag laggy ping pinged emoji emojis emote emotes gif gifs meme memes selfie screenshot screenshots livestream streamer streamers subreddit reddit twitch tiktok instagram insta snapchat twitter discord youtube youtuber spotify netflix xbox playstation nintendo minecraft fortnite roblox valorant anime manga cosplay kpop wifi bluetooth app apps login logout username email emails online offline website blog vlog podcast hashtag dev devs bot bots mod mods admin admins server servers lobby ranked teammate teammates gameplay playthrough speedrun modded spam spammed spamming troll trolling trolled toxic glitch glitchy buggy hotfix devlog lowkey highkey vibing ratio stan wtf wth ftw gtg omw otw hmu tmi fyi asap idc istg iirc afaik imho tbf tldr ily wbu ttyl gn gm gl gg ez wp ggs ffs fml rip pov smth bday hbd ppl thru plz srsly obv prob probs def defo bestie besties whatevs coz cos tmrw tonite nite yw nty brainrot unalive skibidi rizz delulu slay slayed bussin fanart fanfic lore npc npcs dlc fps rpg mmo pvp pve
4 pre css html js json api url gpu cpu ram ssd hdd usb pc os ui ux ai ip dns vpn pdf png jpg jpeg sql php npm git ide cli sdk rgb hdmi wasd dpi lan wtv bf gf bff ex lmk btw
4 lolol lmaoo hahah hehehe ehh ahhh mmm hm ya ur u w l sry soz tysm tyvm ngl gj hf og ig tbqh asl wym ikr omfg rofl stfu gtfo smol chonk heckin doggo pupper boi gurl bruv mate cheers innit yall imma ive
4 kk ff umm uhm uhh mb frfr lfg hru wru alr bae yolo altho wbu ttys gnite ofc istg nm nmu wyd idek
`;
const NO_SUGGEST = "fr bc rn np ty dm vc gg gl gn gm ez wp hf gj yw jk og ig ur u w l ya yo sis sup bet cap mid goat ratio stan rip pov ima cos coz nty sth def prob asl kk ff mb frfr lfg hru wru alr nm nmu idek ttys";
const BANNED = "nigger niggers nigga niggas faggot faggots fag fags retard retards retarded tranny trannies chink chinks spic spics kike kikes";

const CONTRACTIONS = `
120 i'm 130 it's 150 don't 300 that's 300 can't 350 i'll 350 didn't 400 you're 500 i've 500 doesn't 600 what's 700 isn't 700 won't
700 there's 700 let's 900 wasn't 900 i'd 900 he's 900 they're 1100 we're 1200 she's 1300 wouldn't 1500 couldn't 1500 haven't 1500 you'll
1600 aren't 1800 you've 1800 we'll 2000 shouldn't 2000 it'll 2000 ain't 2000 y'all 2500 they'll 2500 who's 2500 here's 2500 we've 3000 he'll
3000 that'll 3000 where's 3000 hasn't 3000 would've 3000 should've 3500 weren't 3500 they've 3500 you'd 4000 she'll 4000 hadn't 4000 could've
4000 how's 4500 they'd 4500 we'd 4500 he'd 5000 it'd 5000 o'clock 6000 she'd 6000 might've 6000 must've 7000 why'd 8000 how'd 8000 what're
8000 who'd 9000 who'll 9000 why's 12000 mustn't 15000 needn't 15000 how'll 15000 who're 15000 why're 15000 how're 9000 what'll 9000 there'll
`;
const EXPANSION = new Map(Object.entries({
    "i'm": "i", "i'll": "i", "i've": "i", "i'd": "i", "it's": "it", "it'll": "it", "it'd": "it", "won't": "will", "can't": "can",
    "we're": "we", "we'll": "we", "we'd": "we", "we've": "we", "he's": "he", "he'll": "he", "he'd": "he", "she's": "she", "she'll": "she",
    "she'd": "she", "let's": "let", "you're": "you", "you'll": "you", "they're": "they", "that's": "that", "what's": "what", "who's": "who",
}));
const HINTS = new Map(`
won't:i,you,we,they,he,she,it,that,this,u,who,people
it's:think,know,because,cause,cuz,bc,but,and,so,if,said,guess,hope,maybe,when,now,yeah,lol,oh,well,ok,okay
i'll:maybe,think,guess,probably,prob,hope
we're:think,guess,hope
i'd:think,guess,said
he'll:maybe,think,guess,hope,said
we'll:maybe,think,guess,hope
`.trim().split(/\s+/).map(l => { const [w, list] = l.split(":"); return [w, new Set(list.split(","))] as const; }));
const FORCED = "cant dont didnt doesnt isnt wasnt werent arent havent hasnt hadnt couldnt wouldnt shouldnt mustnt neednt aint im ive youre youve youll youd theyre theyve theyll theyd weve thats whats wheres theres heres whos hows whys itll thatll couldve wouldve shouldve mightve mustve yall hes shes whatre whod wholl";
const JUNK = "you'v";

const CASING = `
*I *I'm *I'll *I've *I'd *Monday *Tuesday *Wednesday *Thursday *Friday *Saturday *Sunday *January *February *April *June *July *September *October *November *December
March May August *English *Spanish *French *German *Italian *Portuguese *Russian *Chinese *Japanese *Korean *Arabic *Hindi *Dutch *Swedish *Norwegian Danish *Finnish
*Greek *Turkish Polish *Ukrainian *Vietnamese *Thai *Indonesian *Filipino *Irish *Scottish *Welsh *British *American *Canadian *Australian *Mexican *Brazilian *Indian
*African *European *Asian *Latino *Hebrew *Persian *Egyptian *Swiss *Austrian *Belgian *Hungarian *Czech *Romanian *Argentinian *Colombian *Chilean *Peruvian
*America *Canada *Mexico *Brazil *England *France *Germany *Italy *Spain *Japan *Korea China *India *Russia *Australia *Europe *Asia *Africa *Ireland *Scotland *Ukraine
*Sweden *Norway *Denmark *Finland *Netherlands *Poland *Portugal *Egypt *Israel *Iran *Iraq *Pakistan *Vietnam *Thailand *Philippines *Indonesia *Argentina *Texas *California *Florida
*London *Paris *Tokyo *Berlin *Chicago *Toronto *Sydney *Seattle *Boston Discord *YouTube *YouTuber *Google *iPhone *iPad *iOS *macOS Android Windows *Microsoft *Netflix *Spotify
*Twitch *Reddit *TikTok *Instagram *Facebook *Twitter *Snapchat *WhatsApp *Xbox *PlayStation *Nintendo *Minecraft *Fortnite *Roblox *Valorant *Pokemon *Linux *Bluetooth
*ChatGPT *GitHub *PayPal *LinkedIn *Wikipedia *Christmas *Halloween *Easter *Thanksgiving *Jesus *Mr *Mrs *Dr *John *Michael *David *Sarah *Emily *Jessica *Ashley *Kevin
*Jason *Daniel *Emma *Olivia *Ryan *Alex *Chris *Matt Mike Josh *Steve *Elon Trump *Obama *Biden *Covid *NASA *Amazon Apple Steam Nitro *Mario *Zelda Sonic
`;

const US_OR = "colour flavour favour honour humour labour neighbour behaviour harbour rumour vapour vigour valour savour splendour odour armour parlour rigour candour clamour endeavour fervour tumour saviour";
const US_ER = "centre theatre fibre litre calibre sombre spectre lustre sabre meagre";
const US_L = /^(travel|cancel|model|label|fuel|counsel|marvel|level|signal|total|channel|quarrel|tunnel|duel|jewel|rival|shovel|spiral|grovel|panel|pedal|pencil|dial|fuel|gruel|libel|tassel|towel|vessel)l(ed|ing|er|ers|ous)$/;
const US_WORDS = "mum:mom mums:moms mummy:mommy defence:defense offence:offense pretence:pretense licence:license plough:plow mould:mold aluminium:aluminum programme:program cosy:cozy pyjamas:pajamas sceptic:skeptic sceptical:skeptical manoeuvre:maneuver aeroplane:airplane ageing:aging judgement:judgment artefact:artifact enrol:enroll fulfil:fulfill skilful:skillful encyclopaedia:encyclopedia mediaeval:medieval catalogue:catalog dialogue:dialog analogue:analog jewellery:jewelry analyse:analyze analysed:analyzed analysing:analyzing paralyse:paralyze paralysed:paralyzed catalyse:catalyze grey:gray kerb:curb tyre:tire cheque:check whilst:while momma:momma";

function americanVariants(w: string): string[] {
    const out: string[] = [];
    for (const stem of US_OR.split(" ")) if (w.startsWith(stem)) out.push(stem.slice(0, -2) + "r" + w.slice(stem.length));
    if (w.startsWith("favourit")) out.push("favorit" + w.slice(8));
    for (const stem of US_ER.split(" ")) if (w.startsWith(stem)) out.push(stem.slice(0, -2) + "er" + w.slice(stem.length));
    const l = US_L.exec(w);
    if (l) out.push(l[1] + l[2]);
    return out;
}

const INFLECTIONS: [string, string][] = [
    ["ies", "y"], ["ied", "y"], ["ier", "y"], ["iest", "y"], ["ily", "y"], ["es", ""], ["s", ""], ["ed", ""], ["ed", "e"], ["d", ""],
    ["ing", ""], ["ing", "e"], ["er", ""], ["er", "e"], ["r", ""], ["ers", ""], ["ers", "e"], ["est", ""], ["est", "e"], ["st", ""], ["ly", ""],
];
const CLOSED_CLASS = new Set("the and was for you are but not all can her his him one our out has had how its who she they this that with have from what were when your them then than there their these those will would could should into onto upon been also just very much more most some such only".split(" "));
const MAX_LEARNED_WORDS = 20_000;
const MAX_LEARNED_PAIRS = 60_000;
const SIDE_MAX_LEN = 40;

const QWERTY = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const VOWELS = "aeiouy";
const SOUNDS = ["cs", "ck", "sz", "kq", "gj", "cq", "iy", "fv", "td", "mn"];
const LAUGH = /^(?:(?:a?ha){2,}h?|(?:he){2,}h?|(?:ja){2,}|(?:ha|he|hi)+|l+o+l+(?:o+l+)*|l+m+a+o+|l+m+f+a+o+|x+d+|h+m+|u+g+h+|a+h+|o+h+|w+o+w+|b+r+u+h+|h+u+h+|m+h?m+|e+h+|a+w+|y+a+y+|o+o+f+|u+h+|e+r+m+|z+)$/;

function charCode(c: number): number {
    if (c >= 97 && c <= 122) return c - 96;
    if (c >= 65 && c <= 90) return c - 64;
    if (c === 39 || c === 8217) return APOS;
    return 0;
}

function normalize(w: string): string {
    return w.toLowerCase().replace(/’/g, "'");
}

function encode(w: string): Uint8Array | null {
    const out = new Uint8Array(w.length);
    for (let i = 0; i < w.length; i++) {
        const c = charCode(w.charCodeAt(i));
        if (!c) return null;
        out[i] = c;
    }
    return out;
}

export function parseUnigrams(text: string): Unigrams {
    const words: string[] = [];
    const counts: number[] = [];
    let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    const len = text.length;
    while (pos < len) {
        let end = text.indexOf("\n", pos);
        if (end < 0) end = len;
        const sp = text.indexOf(" ", pos);
        if (sp > pos && sp < end) {
            const count = parseFloat(text.slice(sp + 1, end));
            if (count > 0) {
                words.push(text.slice(pos, sp).toLowerCase());
                counts.push(count);
            }
        }
        pos = end + 1;
    }
    return { words, counts };
}

export function parseBigrams(text: string): Bigrams {
    const first: string[] = [];
    const second: string[] = [];
    const counts: number[] = [];
    let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    const len = text.length;
    while (pos < len) {
        let end = text.indexOf("\n", pos);
        if (end < 0) end = len;
        const a = text.indexOf(" ", pos);
        const b = a < 0 ? -1 : text.indexOf(" ", a + 1);
        if (a > pos && b > a + 1 && b < end) {
            const count = parseFloat(text.slice(b + 1, end));
            if (count > 0) {
                first.push(text.slice(pos, a).toLowerCase());
                second.push(text.slice(a + 1, b).toLowerCase());
                counts.push(count);
            }
        }
        pos = end + 1;
    }
    return { first, second, counts };
}

function parseCore(text: string): Unigrams {
    const words: string[] = [];
    const counts: number[] = [];
    const groups = text.split("|");
    let level = parseInt(groups[0], 10);
    for (let g = 1; g < groups.length; g++, level--) {
        if (!groups[g]) continue;
        const count = Math.pow(10, level / 4);
        for (const w of groups[g].split(" ")) if (w) { words.push(w); counts.push(count); }
    }
    return { words, counts };
}

interface Trie {
    tChar: Uint8Array;
    tNum: Uint8Array;
    tFirst: Int32Array;
    tWord: Int32Array;
    tBest: Int32Array;
}

/** words must be lowercase, encodable and ordered most frequent first */
function packTrie(words: string[]): Trie {
    const n = words.length;
    let chars = 1;
    for (const w of words) chars += w.length;
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => words[a] < words[b] ? -1 : words[a] > words[b] ? 1 : 0);
    const codes = order.map(i => encode(words[i])!);

    const tChar = new Uint8Array(chars);
    const tNum = new Uint8Array(chars);
    const tFirst = new Int32Array(chars);
    const tWord = new Int32Array(chars).fill(-1);
    const qLo = new Int32Array(chars);
    const qHi = new Int32Array(chars);
    const qDepth = new Uint8Array(chars);
    qLo[0] = 0; qHi[0] = n;
    let nodes = 1;
    for (let node = 0; node < nodes; node++) {
        let lo = qLo[node];
        const hi = qHi[node], d = qDepth[node];
        if (lo < hi && codes[lo].length === d) tWord[node] = order[lo++];
        tFirst[node] = nodes;
        while (lo < hi) {
            const c = codes[lo][d];
            let end = lo + 1;
            while (end < hi && codes[end][d] === c) end++;
            tChar[nodes] = c;
            qLo[nodes] = lo; qHi[nodes] = end; qDepth[nodes] = d + 1;
            nodes++;
            lo = end;
        }
        tNum[node] = nodes - tFirst[node];
    }
    const best0 = new Int32Array(nodes);
    for (let node = nodes - 1; node >= 0; node--) {
        let best = tWord[node] >= 0 ? tWord[node] : 0x7fffffff;
        for (let k = tFirst[node], e = k + tNum[node]; k < e; k++) if (best0[k] < best) best = best0[k];
        best0[node] = best;
    }
    // lay the trie out again with each node's children ordered most frequent first, so the search finds good words early
    const oChar = new Uint8Array(nodes), oNum = new Uint8Array(nodes), oFirst = new Int32Array(nodes);
    const oWord = new Int32Array(nodes), tBest = new Int32Array(nodes), from = new Int32Array(nodes);
    const kids: number[] = [];
    let next = 1;
    for (let o = 0; o < next; o++) {
        const old = from[o];
        oChar[o] = tChar[old]; oWord[o] = tWord[old]; tBest[o] = best0[old]; oNum[o] = tNum[old];
        oFirst[o] = next;
        kids.length = 0;
        for (let k = tFirst[old], e = k + tNum[old]; k < e; k++) kids.push(k);
        kids.sort((a, b) => best0[a] - best0[b]);
        for (const k of kids) from[next++] = k;
    }
    return { tChar: oChar, tNum: oNum, tFirst: oFirst, tWord: oWord, tBest };
}

function build(uni: Unigrams, bi: Bigrams | null, core: boolean): EngineData {
    const base = new Map<string, number>();
    const junk = new Set(JUNK.split(" "));
    for (let i = 0; i < uni.words.length; i++) {
        const w = uni.words[i];
        if (junk.has(w) || !encode(w)) continue;
        base.set(w, Math.max(base.get(w) ?? 0, uni.counts[i]));
    }

    for (const [w, c] of [...base]) for (const v of americanVariants(w)) if (!base.has(v)) base.set(v, c);
    for (const pair of US_WORDS.split(" ")) {
        const [uk, us] = pair.split(":");
        const c = base.get(uk);
        if (c && (base.get(us) ?? 0) < c) base.set(us, c);
    }

    const sorted = Float64Array.from(base.values()).sort().reverse();
    const at = (rank: number) => sorted[Math.min(rank, sorted.length - 1)] ?? 1;
    const lift = (w: string, count: number) => {
        if (encode(w)) base.set(w, Math.max(base.get(w) ?? 0, count));
    };

    const flagged = new Map<string, number>();
    const flag = (w: string, f: number) => flagged.set(w, (flagged.get(w) ?? 0) | f);

    for (const line of CHAT_WORDS.trim().split("\n")) {
        const [tier, ...words] = line.trim().split(/\s+/);
        for (const w of words) lift(w, at(TIER_RANK[+tier]));
    }
    const tokens = CONTRACTIONS.trim().split(/\s+/);
    for (let i = 0; i + 1 < tokens.length; i += 2) lift(tokens[i + 1], at(+tokens[i]));

    const casing: Record<string, string> = {};
    for (const raw of CASING.trim().split(/\s+/)) {
        const shown = raw.replace("*", "");
        const lower = shown.toLowerCase();
        casing[lower] = raw.startsWith("*") ? "*" + shown : shown;
        if (!base.has(lower)) lift(lower, at(TIER_RANK[5]));
    }

    for (const w of NO_SUGGEST.split(" ")) flag(w, Flag.NoSuggest);
    for (const w of BANNED.split(" ")) flag(w, Flag.NoSuggest);
    for (const w of FORCED.split(" ")) if (base.has(w)) flag(w, Flag.NotKnown | Flag.NoSuggest);

    const entries = [...base.entries()].sort((a, b) => b[1] - a[1]);
    const n = entries.length;
    const words = new Array<string>(n);
    const counts = new Float64Array(n);
    const flags = new Uint8Array(n);
    let total = 0, maxLen = 0;
    const index = new Map<string, number>();
    for (let i = 0; i < n; i++) {
        const [w, c] = entries[i];
        words[i] = w;
        counts[i] = c;
        flags[i] = flagged.get(w) ?? 0;
        total += c;
        if (w.length > maxLen) maxLen = w.length;
        index.set(w, i);
    }

    const trie = packTrie(words);

    const bStart = new Int32Array(n + 1);
    let bWord = new Int32Array(0);
    let bCount = new Float32Array(0);
    if (bi) {
        const m = bi.counts.length;
        const pa = new Int32Array(m), pb = new Int32Array(m);
        for (let i = 0; i < m; i++) {
            pa[i] = index.get(bi.first[i]) ?? -1;
            pb[i] = pa[i] < 0 ? -1 : index.get(bi.second[i]) ?? -1;
            if (pb[i] >= 0) bStart[pa[i] + 1]++;
        }
        for (let i = 0; i < n; i++) bStart[i + 1] += bStart[i];
        bWord = new Int32Array(bStart[n]);
        bCount = new Float32Array(bStart[n]);
        const fill = bStart.slice(0, n);
        for (let i = 0; i < m; i++) {
            if (pb[i] < 0) continue;
            const k = fill[pa[i]]++;
            bWord[k] = pb[i];
            bCount[k] = bi.counts[i];
        }
        const idx: number[] = [];
        for (let p = 0; p < n; p++) {
            const s = bStart[p], e = bStart[p + 1];
            if (e - s < 2) continue;
            idx.length = 0;
            for (let k = s; k < e; k++) idx.push(k);
            idx.sort((x, y) => bWord[x] - bWord[y]);
            const w = idx.map(k => bWord[k]), c = idx.map(k => bCount[k]);
            for (let k = 0; k < w.length; k++) { bWord[s + k] = w[k]; bCount[s + k] = c[k]; }
        }
    }

    return {
        words, counts, flags, total, maxLen, core, casing,
        ...trie,
        bStart, bWord, bCount,
    };
}

export function buildEngineData(unigramText: string, bigramText: string | null): EngineData {
    return build(parseUnigrams(unigramText), bigramText ? parseBigrams(bigramText) : null, false);
}

export function buildCoreData(): EngineData {
    return build(parseCore(CORE_WORDS), null, true);
}

type Shape = "lower" | "title" | "upper";

function shapeOf(w: string): Shape | null {
    const lower = w.toLowerCase(), upper = w.toUpperCase();
    if (w === lower) return "lower";
    if (w.length > 1 && w === upper) return "upper";
    if (w[0] === upper[0] && w.slice(1) === lower.slice(1)) return "title";
    return null;
}

interface Side extends Trie {
    words: string[];
    odd: string[];
    maxLen: number;
    logP: Float32Array;
}

interface Scratch {
    rows: Float32Array;
    path: Uint8Array;
    stack: Int32Array;
    cWord: Int32Array;
    cCost: Float32Array;
    sNode: Int32Array;
    sCost: Float32Array;
    lo: Int32Array;
    hi: Int32Array;
}

const MAX_HITS = 4096;
const PRUNE_K = 5;
const PRUNE_SLACK = 2.5;
const INF = 1e9;

export class Engine {
    private d: EngineData;
    private sub = new Float32Array(SIZE * SIZE);
    private adj = new Uint8Array(SIZE * SIZE);
    private vowel = new Uint8Array(SIZE);
    private scratch: Scratch;
    private userWords = new Map<string, string>();
    private blocked = new Set<string>();
    private external: ((w: string) => boolean) | null = null;
    private userUni = new Map<string, number>();
    private userBi = new Map<string, Map<string, number>>();
    private userBiTotal = new Map<string, number>();
    private userTotal = 0;
    private learnedOutside = new Set<string>();
    private side: Side | null = null;
    private reverts = new Map<string, number>();
    private bare = new Map<string, number>();
    private logP: Float32Array;
    private topEst = new Float32Array(PRUNE_K);

    constructor(data: EngineData) {
        this.d = data;
        this.setCosts();
        this.logP = Float32Array.from(data.counts, c => Math.log(c / data.total));
        data.words.forEach((w, i) => {
            if (!w.includes("'")) return;
            const b = w.replace(/'/g, "");
            const j = this.find(b);
            if (j < 0 || data.flags[j] & Flag.NotKnown) this.bare.set(b, i);
        });
        const depth = Math.max(data.maxLen, SIDE_MAX_LEN) + 8;
        this.scratch = {
            rows: new Float32Array(depth * 40),
            path: new Uint8Array(depth),
            stack: new Int32Array(Math.max(1024, data.tChar.length)),
            cWord: new Int32Array(MAX_HITS),
            cCost: new Float32Array(MAX_HITS),
            sNode: new Int32Array(MAX_HITS),
            sCost: new Float32Array(MAX_HITS),
            lo: new Int32Array(depth),
            hi: new Int32Array(depth),
        };
    }

    /** rebuilds the cost tables from TUNING (only the eval harness needs to call this) */
    setCosts() {
        const T = TUNING;
        const pos: Array<[number, number]> = [];
        QWERTY.forEach((row, r) => { for (let c = 0; c < row.length; c++) pos[row.charCodeAt(c) - 96] = [r, c]; });
        for (const v of VOWELS) this.vowel[v.charCodeAt(0) - 96] = 1;
        for (let a = 1; a < SIZE; a++) {
            for (let b = 1; b < SIZE; b++) {
                let near = false;
                if (a !== b && a < APOS && b < APOS) {
                    const [ra, ca] = pos[a], [rb, cb] = pos[b];
                    near = (ra === rb && Math.abs(ca - cb) === 1)
                        || (rb === ra + 1 && (cb === ca || cb === ca - 1))
                        || (ra === rb + 1 && (ca === cb || ca === cb - 1));
                }
                this.adj[a * SIZE + b] = near ? 1 : 0;
                this.sub[a * SIZE + b] = a === b ? 0
                    : a === OTHER || b === OTHER ? T.otherSub
                            : a === APOS || b === APOS ? T.aposSub
                                : near ? T.adjSub
                                    : this.vowel[a] && this.vowel[b] ? T.vowelSub : T.otherSub;
            }
        }
        for (const [x, y] of SOUNDS) {
            const a = x.charCodeAt(0) - 96, b = y.charCodeAt(0) - 96;
            this.sub[a * SIZE + b] = this.sub[b * SIZE + a] = Math.min(this.sub[a * SIZE + b], T.soundSub);
        }
    }

    private find(w: string): number {
        const { tChar, tFirst, tNum, tWord } = this.d;
        let node = 0;
        for (let i = 0; i < w.length; i++) {
            const c = charCode(w.charCodeAt(i));
            if (!c) return -1;
            let next = -1;
            for (let k = tFirst[node], e = k + tNum[node]; k < e; k++) if (tChar[k] === c) { next = k; break; }
            if (next < 0) return -1;
            node = next;
        }
        return tWord[node];
    }

    private baseKnown(lower: string): boolean {
        if (this.userWords.has(lower) || (this.userUni.get(lower) ?? 0) >= 3) return true;
        const i = this.find(lower);
        return i >= 0 && !(this.d.flags[i] & Flag.NotKnown);
    }

    isKnown(word: string): boolean {
        if (!word) return false;
        const lower = normalize(word);
        if (this.baseKnown(lower)) return true;
        if (this.external) {
            try {
                if (this.external(word) || (lower !== word && this.external(lower))) return true;
            } catch { /* external lookups must never break typing */ }
        }
        if (LAUGH.test(lower)) return true;
        if (lower.endsWith("'s") && lower.length > 3 && this.baseKnown(lower.slice(0, -2))) return true;
        if (/(.)\1\1/.test(lower)) {
            const one = lower.replace(/(.)\1+/g, "$1"), two = lower.replace(/(.)\1{2,}/g, "$1$1");
            if (this.baseKnown(two) || this.baseKnown(one) || LAUGH.test(one)) return true;
        }
        if (lower.length >= 4 && lower.endsWith("in") && this.baseKnown(lower + "g")) return true;
        if (this.d.core && this.coreInflection(lower)) return true;
        if (lower.includes("-")) return lower.split("-").every(p => !p || this.isKnown(p));
        return false;
    }

    /** the starter list has few inflected forms, so a regular ending on a known stem counts as known */
    private coreInflection(lower: string): boolean {
        // "thats", "shes" and other contractions missing their apostrophe must stay fixable
        const i = this.find(lower);
        if ((i >= 0 && this.d.flags[i] & Flag.NotKnown) || this.bare.has(lower)) return false;
        const m =/^(.*?([b-df-hj-np-tv-z]))\2(ed|ing|er|ers|est|y)$/.exec(lower);
        if (m && /^[^aeiouy]*[aeiou][b-df-hj-np-tv-z]$/.test(m[1]) && this.baseKnown(m[1]) && !this.baseKnown(m[1] + m[3])) return true;
        for (const [suffix, add] of INFLECTIONS) {
            if (!lower.endsWith(suffix)) continue;
            const stem = lower.slice(0, -suffix.length);
            if (stem.length < (suffix === "ly" ? 4 : 3)) continue;
            if (suffix === "s" && /[sxz]$|[cs]h$/.test(stem)) continue;
            if (suffix === "es" && !/[sxzo]$|[cs]h$/.test(stem)) continue;
            if ((suffix === "d" || suffix === "r" || suffix === "st") && !stem.endsWith("e")) continue;
            if (CLOSED_CLASS.has(stem)) continue;
            if (!add && /^(ed|er|ers|est|ing)$/.test(suffix) && stem.endsWith("e")) continue;
            // a short consonant-vowel-consonant stem doubles its last letter (stopped, planned), so "stoped" is a typo
            if (!add && /^(ed|er|ers|est|ing)$/.test(suffix) && /^[^aeiouy]*[aeiou][b-df-hj-np-tvz]$/.test(stem)) continue;
            // truly, duly, basically, publicly: "truely" and "basicly" are typos
            if (suffix === "ly" && /(?:[^aeiou]ue|ic)$/.test(stem) && stem !== "public") continue;
            if (/([b-df-hj-np-tv-z])\1$/.test(stem) && this.baseKnown(stem.slice(0, -1) + suffix)) continue;
            if (this.baseKnown(stem + add)) return true;
        }
        return false;
    }

    addUserWord(word: string): void {
        const w = word.trim();
        if (w) this.userWords.set(normalize(w), w);
        this.side = null;
    }

    removeUserWord(word: string): void {
        this.userWords.delete(normalize(word));
        this.side = null;
    }

    hasUserWord(word: string): boolean {
        return this.userWords.has(normalize(word));
    }

    blockSuggestion(word: string): void {
        this.blocked.add(normalize(word));
    }

    unblockSuggestion(word: string): void {
        this.blocked.delete(normalize(word));
    }

    setExternalKnown(fn: ((w: string) => boolean) | null): void {
        this.external = fn;
    }

    learn(prev: string | null, word: string): void {
        const w = normalize(word);
        if (!w || w.length > 25 || /[\d_]/.test(w)) return;
        const n = (this.userUni.get(w) ?? 0) + 1;
        this.userUni.set(w, n);
        this.userTotal++;
        if (n === 3) this.noteLearned(w);
        if (prev) this.addBigram(normalize(prev), w, 1);
        this.prune();
    }

    private pairCount = 0;

    /** keeps the learned tables bounded: once over the cap, only the most used three quarters stay */
    private prune() {
        if (this.userUni.size > MAX_LEARNED_WORDS) {
            const keep = [...this.userUni].sort((a, b) => b[1] - a[1]).slice(0, MAX_LEARNED_WORDS * 3 / 4);
            this.userUni = new Map(keep);
            this.userTotal = keep.reduce((sum, [, n]) => sum + n, 0);
            for (const w of this.learnedOutside) if ((this.userUni.get(w) ?? 0) < 3) this.learnedOutside.delete(w);
            this.side = null;
        }
        if (this.pairCount > MAX_LEARNED_PAIRS) {
            const all: [string, string, number][] = [];
            for (const [p, m] of this.userBi) for (const [w, n] of m) all.push([p, w, n]);
            all.sort((a, b) => b[2] - a[2]);
            this.userBi.clear();
            this.userBiTotal.clear();
            this.pairCount = 0;
            for (const [p, w, n] of all.slice(0, MAX_LEARNED_PAIRS * 3 / 4)) this.addBigram(p, w, n);
        }
    }

    private noteLearned(w: string) {
        const i = this.find(w);
        if (encode(w) ? i < 0 || this.d.flags[i] & Flag.NotKnown : true) {
            this.learnedOutside.add(w);
            this.side = null;
        }
    }

    private addBigram(p: string, w: string, n: number) {
        let m = this.userBi.get(p);
        if (!m) this.userBi.set(p, m = new Map());
        if (!m.has(w)) this.pairCount++;
        m.set(w, (m.get(w) ?? 0) + n);
        this.userBiTotal.set(p, (this.userBiTotal.get(p) ?? 0) + n);
    }

    exportLearned(): { unigrams: Record<string, number>; bigrams: Record<string, number>; } {
        const unigrams: Record<string, number> = {}, bigrams: Record<string, number> = {};
        for (const [w, n] of this.userUni) unigrams[w] = n;
        for (const [p, m] of this.userBi) for (const [w, n] of m) bigrams[p + " " + w] = n;
        return { unigrams, bigrams };
    }

    importLearned(data: { unigrams: Record<string, number>; bigrams: Record<string, number>; }): void {
        this.userUni.clear();
        this.userBi.clear();
        this.userBiTotal.clear();
        this.userTotal = 0;
        this.pairCount = 0;
        this.learnedOutside.clear();
        this.side = null;
        for (const [w, n] of Object.entries(data?.unigrams ?? {})) {
            if (typeof n !== "number" || !(n > 0)) continue;
            this.userUni.set(w, n);
            this.userTotal += n;
            if (n >= 3) this.noteLearned(w);
        }
        for (const [key, n] of Object.entries(data?.bigrams ?? {})) {
            const sp = key.indexOf(" ");
            if (sp > 0 && typeof n === "number" && n > 0) this.addBigram(key.slice(0, sp), key.slice(sp + 1), n);
        }
        this.prune();
    }

    exportReverts(): [string, number][] {
        return [...this.reverts].slice(-2000);
    }

    importReverts(list: [string, number][] | undefined): void {
        if (!Array.isArray(list)) return;
        for (const item of list) {
            if (!Array.isArray(item) || typeof item[0] !== "string" || typeof item[1] !== "number") continue;
            this.reverts.set(item[0], Math.max(item[1], this.reverts.get(item[0]) ?? 0));
        }
    }

    noteRevert(typed: string, fixed: string): boolean {
        const key = normalize(typed) + "\u0000" + normalize(fixed);
        const n = (this.reverts.get(key) ?? 0) + 1;
        this.reverts.set(key, n);
        return n === 2;
    }

    private pUni(i: number, lower: string): number {
        let base = i >= 0 ? this.d.counts[i] / this.d.total : 0;
        if (base < TUNING.userWordP && this.userWords.has(lower)) base = TUNING.userWordP;
        if (!this.userTotal) return base;
        const u = (this.userUni.get(lower) ?? 0) / (this.userTotal + 20);
        return (1 - TUNING.userMix) * base + TUNING.userMix * u;
    }

    private pCtx(i: number, lower: string, prev: number, prevWord: string | null): number {
        const uni = this.pUni(i, lower);
        if (!prevWord) return uni;
        let big = 0;
        if (prev >= 0 && i >= 0) {
            const c = this.bigram(prev, i);
            if (c) big = Math.min(1, c / this.d.counts[prev]);
        }
        const ut = this.userBiTotal.get(prevWord);
        if (ut) big += 10 * (this.userBi.get(prevWord)!.get(lower) ?? 0) / (ut + 5);
        if (prev < 0 && !ut) return uni;
        return (1 - TUNING.context) * uni + TUNING.context * big;
    }

    private bigram(p: number, w: number): number {
        const { bStart, bWord, bCount } = this.d;
        let lo = bStart[p], hi = bStart[p + 1] - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1, v = bWord[mid];
            if (v === w) return bCount[mid];
            if (v < w) lo = mid + 1; else hi = mid - 1;
        }
        return 0;
    }

    private logScore(i: number, lower: string, prev: number, prevWord: string | null): number {
        const exp = prevWord ? EXPANSION.get(lower) : undefined;
        let p: number;
        if (exp) {
            const e = this.find(exp);
            const pe = this.pUni(e, exp);
            p = pe > 0 ? this.pUni(i, lower) * this.pCtx(e, exp, prev, prevWord) / pe : this.pUni(i, lower);
        } else {
            p = this.pCtx(i, lower, prev, prevWord);
        }
        return Math.log(p > 0 ? p : 1e-14);
    }

    private casingOf(lower: string): string | undefined {
        return Object.prototype.hasOwnProperty.call(this.d.casing, lower) ? this.d.casing[lower] : undefined;
    }

    private display(lower: string): string {
        const user = this.userWords.get(lower);
        if (user && user !== user.toLowerCase()) return user;
        const c = this.casingOf(lower);
        return c ? c.replace("*", "") : lower;
    }

    private shape(lower: string, shape: Shape, curly: boolean): string {
        let w = this.display(lower);
        if (shape === "upper") w = w.toUpperCase();
        else if (shape === "title" && w.slice(1) === w.slice(1).toLowerCase()) w = w[0].toUpperCase() + w.slice(1);
        return curly ? w.replace(/'/g, "’") : w;
    }

    private suggestable(i: number, lower: string): boolean {
        if (this.blocked.has(lower)) return false;
        if (this.userWords.has(lower)) return true;
        return i < 0 ? (this.userUni.get(lower) ?? 0) >= 3 : !(this.d.flags[i] & Flag.NoSuggest);
    }

    private weightedDistance(t: Uint8Array, w: string, bound: number): number {
        const folded = w.normalize("NFD").replace(/[̀-ͯ]/g, "");
        const n = t.length, m = folded.length, T = TUNING;
        const c = new Uint8Array(m);
        for (let k = 0; k < m; k++) c[k] = charCode(folded.charCodeAt(k)) || OTHER;
        let prev2 = new Float32Array(n + 1), prev = new Float32Array(n + 1), cur = new Float32Array(n + 1);
        for (let j = 1; j <= n; j++) prev[j] = prev[j - 1] + this.insCost(t, j - 1) + (j === 1 ? T.first : 0);
        let best = Infinity;
        for (let d = 1; d <= m; d++) {
            const ch = c[d - 1], pc = d > 1 ? c[d - 2] : 0;
            const omit = ch === pc ? T.doubleOmit : ch === APOS ? T.aposOmit : this.vowel[ch] ? T.vowelOmit : 1;
            cur[0] = prev[0] + omit + (d === 1 ? T.first : 0);
            let min = cur[0];
            for (let j = 1; j <= n; j++) {
                const tj = t[j - 1];
                let s = prev[j - 1] + (ch === tj ? 0 : this.sub[ch * SIZE + tj] + (d === 1 && j === 1 ? T.first : 0));
                const o = prev[j] + omit; if (o < s) s = o;
                const ins = cur[j - 1] + this.insCost(t, j - 1); if (ins < s) s = ins;
                if (d > 1 && j > 1 && ch === t[j - 2] && pc === tj && ch !== tj) {
                    const x = prev2[j - 2] + T.transpose; if (x < s) s = x;
                }
                cur[j] = s;
                if (s < min) min = s;
            }
            if (min > bound) return Infinity;
            best = cur[n];
            const tmp = prev2; prev2 = prev; prev = cur; cur = tmp;
        }
        return best;
    }

    private insCost(t: Uint8Array, j: number): number {
        const tj = t[j], before = j > 0 ? t[j - 1] : 0, after = j + 1 < t.length ? t[j + 1] : 0, T = TUNING;
        if (tj === before) return T.doubleIns;
        if (tj === APOS) return T.aposIns;
        if ((before && this.adj[tj * SIZE + before]) || (after && this.adj[tj * SIZE + after])) return T.adjIns;
        return 1;
    }

    /** branch-and-bound weighted Damerau-Levenshtein over the trie; returns [corrections, completion seeds] */
    private search(trie: Trie, logP: Float32Array, t: Uint8Array, bound: number, complBound: number, fresh = true, maxLen = this.d.maxLen): [number, number] {
        const T = TUNING, n = t.length, W = n + 1;
        const { tChar, tFirst, tNum, tWord, tBest } = trie;
        const s = this.scratch;
        const maxD = Math.min(maxLen, n + 4, s.path.length - 1);
        if (s.rows.length < (maxD + 1) * W) s.rows = new Float32Array((maxD + 1) * W * 2);
        const { rows, path, stack, cWord, cCost, sNode, sCost, lo, hi } = s;
        const { sub, vowel, topEst: top } = this;
        const ins = new Float32Array(W);
        for (let j = 1; j <= n; j++) ins[j] = this.insCost(t, j - 1);

        rows[0] = 0;
        lo[0] = 0; hi[0] = 0;
        for (let j = 1; j <= n; j++) {
            rows[j] = rows[j - 1] + ins[j] + (j === 1 ? T.first : 0);
            if (rows[j] <= bound) hi[0] = j;
        }
        let hits = 0, seeds = 0, sp = 0;
        for (let k = tFirst[0] + tNum[0] - 1; k >= tFirst[0]; k--) { stack[sp++] = k; stack[sp++] = 1; stack[sp++] = 0; }
        const { lambda } = T;
        if (fresh) top.fill(-Infinity);
        let floor = top[0];

        while (sp > 0) {
            const seeded = stack[--sp], d = stack[--sp], node = stack[--sp];
            const ch = tChar[node];
            path[d] = ch;
            const base = d * W, pb = base - W, ppb = pb - W;
            const pc = d > 1 ? path[d - 1] : 0;
            const omit = ch === pc ? T.doubleOmit : ch === APOS ? T.aposOmit : vowel[ch] ? T.vowelOmit : 1;
            const plo = lo[d - 1], reach = Math.max(hi[d - 1] + 1, d > 1 ? hi[d - 2] + 2 : 0);
            let v = INF, min = INF, rlo = -1, rhi = -1, j = plo;
            for (let k = 0; k < plo; k++) rows[base + k] = INF;
            if (j === 0) {
                v = rows[pb] + omit + (d === 1 ? T.first : 0);
                rows[base] = v;
                min = v;
                if (v <= bound) rlo = rhi = 0;
                j = 1;
            }
            const subRow = ch * SIZE;
            for (; j <= n; j++) {
                const tj = t[j - 1];
                v = rows[pb + j - 1] + (ch === tj ? 0 : sub[subRow + tj] + (d === 1 && j === 1 ? T.first : 0));
                const o = rows[pb + j] + omit; if (o < v) v = o;
                const i = rows[base + j - 1] + ins[j]; if (i < v) v = i;
                if (d > 1 && j > 1 && ch === t[j - 2] && pc === tj && ch !== tj) {
                    const x = rows[ppb + j - 2] + T.transpose; if (x < v) v = x;
                }
                rows[base + j] = v;
                if (v < min) min = v;
                if (v <= bound) { if (rlo < 0) rlo = j; rhi = j; } else if (j > reach) { j++; break; }
            }
            for (; j <= n; j++) rows[base + j] = INF;
            if (rlo < 0) continue;
            lo[d] = rlo; hi[d] = rhi;
            if (min > bound || logP[tBest[node]] + PRUNE_SLACK - lambda * min < floor) continue;
            const fin = rows[base + n];
            const w = tWord[node];
            if (w >= 0 && fin <= bound && hits < MAX_HITS) {
                cWord[hits] = w; cCost[hits++] = fin;
                const est = logP[w] - lambda * fin;
                if (est > top[0]) {
                    let i = 0;
                    while (i + 1 < PRUNE_K && top[i + 1] < est) { top[i] = top[i + 1]; i++; }
                    top[i] = est;
                    floor = top[0];
                }
            }
            let childSeeded = seeded;
            if (!seeded && d >= n && fin <= complBound && seeds < MAX_HITS) { sNode[seeds] = node; sCost[seeds++] = fin; childSeeded = 1; }
            if (d < maxD && sp + 3 * 28 < stack.length) {
                for (let k = tFirst[node] + tNum[node] - 1; k >= tFirst[node]; k--) { stack[sp++] = k; stack[sp++] = d + 1; stack[sp++] = childSeeded; }
            }
        }
        return [hits, seeds];
    }

    private topInSubtree(trie: Trie, node: number, k: number, out: number[]) {
        const { tFirst, tNum, tWord, tBest } = trie;
        const heapP: number[] = [tBest[node]], heapN: number[] = [node], heapW: boolean[] = [false];
        while (heapP.length && out.length < k) {
            let m = 0;
            for (let i = 1; i < heapP.length; i++) if (heapP[i] < heapP[m]) m = i;
            const n = heapN[m], isWord = heapW[m];
            const last = heapP.length - 1;
            heapP[m] = heapP[last]; heapN[m] = heapN[last]; heapW[m] = heapW[last];
            heapP.pop(); heapN.pop(); heapW.pop();
            if (isWord) { out.push(tWord[n]); continue; }
            if (tWord[n] >= 0) { heapP.push(tWord[n]); heapN.push(n); heapW.push(true); }
            for (let c = tFirst[n], e = c + tNum[n]; c < e; c++) { heapP.push(tBest[c]); heapN.push(c); heapW.push(false); }
            if (heapP.length > 64) break;
        }
    }

    suggest(word: string, prev: string | null, max: number, sensitivity: Sensitivity, sentenceStart: boolean): SuggestResult {
        const result: SuggestResult = { typed: word, known: false, skip: false, candidates: [], autoCorrect: null };
        if (!word) {
            result.candidates = this.predict(prev, max).map((w, i) => ({ word: w, score: -i, kind: "prediction" }));
            return result;
        }
        result.known = this.isKnown(word);
        const shape = shapeOf(word);
        const letters = word.replace(/['’-]/g, "");
        if (
            !shape || word.length > 25 || /[^A-Za-z'’-]/.test(word) || /^['’-]|['’-]$/.test(word)
            || (word.length === 1 && !/[aiI]/.test(word))
            || (shape === "upper" && letters.length <= 5 && word !== "I")
            || word.includes("-")
        ) {
            result.skip = true;
            return result;
        }

        const lower = normalize(word);
        const curly = word.includes("’");
        const t = encode(lower)!;
        const n = t.length;
        const prevWord = prev ? normalize(prev) : null;
        const prevIdx = prevWord ? this.find(prevWord) : -1;
        const T = TUNING;

        const bound = T.bounds[Math.min(n, T.bounds.length - 1)];
        const complBound = n <= 2 ? 0 : n === 3 ? 0.35 : n <= 5 ? 0.7 : 1.0;
        const narrow = Math.min(bound, T.narrow);
        let [hits, seeds] = this.search(this.d, this.logP, t, narrow, complBound);
        if (bound > narrow && (hits < T.minHits || this.topEst[PRUNE_K - 1] < T.widen)) [hits, seeds] = this.search(this.d, this.logP, t, bound, complBound, false);
        const s = this.scratch;

        const best = new Map<string, Candidate & { cost: number; idx: number; }>();
        const offer = (idx: number, w: string, cost: number, kind: "correction" | "completion", bonus = 0) => {
            if (w === lower || !this.suggestable(idx, w)) return;
            let score = this.logScore(idx, w, prevIdx, prevWord) - T.lambda * cost + bonus;
            if (prevWord && HINTS.get(w)?.has(prevWord)) score += T.hintBonus;
            if (kind === "completion") score -= T.completion + T.completionChar * (w.length - n);
            const old = best.get(w);
            if (!old || old.score < score) best.set(w, { word: w, score, kind, cost, idx });
        };
        const contraction = this.bare.get(lower);
        if (contraction !== undefined && !result.known) offer(contraction, this.d.words[contraction], 0, "correction", T.bareBonus);
        for (let k = 0; k < hits; k++) offer(s.cWord[k], this.d.words[s.cWord[k]], s.cCost[k], "correction");
        const sub: number[] = [];
        for (let k = 0; k < seeds; k++) {
            sub.length = 0;
            this.topInSubtree(this.d, s.sNode[k], 3, sub);
            for (const idx of sub) {
                const w = this.d.words[idx];
                if (w.length > n) offer(idx, w, s.sCost[k], "completion");
            }
        }
        const side = this.sideWords();
        if (side.words.length) {
            const [sh, ss] = this.search(side, side.logP, t, bound, complBound, true, side.maxLen);
            for (let k = 0; k < sh; k++) { const w = side.words[s.cWord[k]]; offer(this.find(w), w, s.cCost[k], "correction"); }
            for (let k = 0; k < ss; k++) {
                sub.length = 0;
                this.topInSubtree(side, s.sNode[k], 3, sub);
                for (const i of sub) { const w = side.words[i]; if (w.length > n) offer(this.find(w), w, s.sCost[k], "completion"); }
            }
        }
        for (const w of side.odd) if (w.length + 3 >= n && w.length <= n + 6) this.offerSide(t, w, bound, complBound, offer);

        const ranked = [...best.values()].sort((a, b) => b.score - a.score);
        result.candidates = ranked.slice(0, Math.max(0, max)).map(c => ({ word: this.shape(c.word, shape, curly), score: c.score, kind: c.kind }));

        if (sensitivity === "off") return result;
        const finish = (w: string) => {
            let out = this.shape(w, shape, curly);
            if (sentenceStart && out[0] !== out[0].toUpperCase() && !/\p{Lu}/u.test(out.slice(1))) out = out[0].toUpperCase() + out.slice(1);
            return out === word ? null : out;
        };

        if (result.known) {
            const c = this.casingOf(lower);
            const user = this.userWords.get(lower);
            const cased = user ? user !== lower : c?.startsWith("*");
            if (shape === "lower" && cased && !this.blocked.has(lower) && !this.reverted(lower, lower)) result.autoCorrect = finish(lower);
            if (sensitivity === "aggressive" && prevWord && !this.userWords.has(lower)) {
                const top = ranked[0];
                if (top && top.kind === "correction" && top.word.replace(/'/g, "") === lower && EXPANSION.has(top.word) && HINTS.get(top.word)?.has(prevWord)
                    && top.score - this.logScore(this.find(lower), lower, prevIdx, prevWord) >= Math.log(4) && !this.reverted(lower, top.word)) {
                    result.autoCorrect = finish(top.word);
                }
            }
            return result;
        }

        const corrections = ranked.filter(c => c.kind === "correction");
        const top = corrections[0];
        if (!top || top.cost > T.maxAutoCost[sensitivity] || top.word.length * 2 < n || this.reverted(lower, top.word)) return result;
        const second = corrections[1]?.score ?? -Infinity;
        if (top.score - second < T.ratio[sensitivity] || top.score < T.keep[sensitivity]) return result;
        result.autoCorrect = finish(top.word);
        return result;
    }

    private sideWords(): Side {
        if (this.side) return this.side;
        const words: string[] = [], odd: string[] = [];
        const add = (w: string) => {
            const i = this.find(w);
            if (i >= 0 && !(this.d.flags[i] & Flag.NotKnown)) return;
            if (!encode(w) || w.length > SIDE_MAX_LEN) odd.push(w);
            else words.push(w);
        };
        for (const w of this.userWords.keys()) add(w);
        for (const w of this.learnedOutside) if (!this.userWords.has(w)) add(w);
        const trie = packTrie(words);
        const maxLen = words.reduce((m, w) => Math.max(m, w.length), 0);
        return this.side = { ...trie, words, odd, maxLen, logP: new Float32Array(words.length) };
    }

    private offerSide(t: Uint8Array, w: string, bound: number, complBound: number, offer: (i: number, w: string, c: number, k: "correction" | "completion") => void) {
        const cost = this.weightedDistance(t, w, bound);
        if (cost <= bound) offer(-1, w, cost, "correction");
        if (w.length > t.length && complBound > 0) {
            const pre = this.weightedDistance(t, w.slice(0, t.length), complBound);
            if (pre <= complBound) offer(-1, w, pre, "completion");
        }
    }

    private reverted(typed: string, fixed: string): boolean {
        return (this.reverts.get(typed + "\u0000" + normalize(fixed)) ?? 0) >= 2;
    }

    predict(prev: string | null, max: number): string[] {
        if (max <= 0) return [];
        const scores = new Map<string, number>();
        const p = prev ? normalize(prev) : null;
        if (p) {
            const i = this.find(p);
            if (i >= 0) {
                const { bStart, bWord, bCount, words, counts } = this.d;
                for (let k = bStart[i]; k < bStart[i + 1]; k++) scores.set(words[bWord[k]], bCount[k] / counts[i]);
            }
            const m = this.userBi.get(p), ut = this.userBiTotal.get(p) ?? 0;
            if (m) for (const [w, c] of m) scores.set(w, (scores.get(w) ?? 0) + 10 * c / (ut + 5));
        }
        if (!scores.size && !p) {
            for (const [w, c] of this.userUni) if (c >= 3) scores.set(w, c / (this.userTotal + 20));
            ["i", "the", "lol", "yeah", "it", "what"].forEach((w, k) => scores.set(w, (scores.get(w) ?? 0) + 0.01 / (k + 1)));
        }
        const out: string[] = [];
        for (const [w] of [...scores].sort((a, b) => b[1] - a[1])) {
            if (out.length >= max) break;
            const i = this.find(w);
            if (!this.suggestable(i, w) || (i >= 0 && (this.d.flags[i] & Flag.NotKnown))) continue;
            out.push(this.display(w));
        }
        return out;
    }
}
