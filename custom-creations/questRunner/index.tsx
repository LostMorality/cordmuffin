/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings, Settings } from "@api/Settings";
import { Button } from "@components/Button";
import { Card } from "@components/Card";
import { HeadingTertiary } from "@components/Heading";
import { Notice } from "@components/Notice";
import { Paragraph } from "@components/Paragraph";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, type PluginNative } from "@utils/types";
import type { Quest } from "@vencord/discord-types";
import { findByCodeLazy, findStoreLazy } from "@webpack";
import { ChannelStore, GuildChannelStore, QuestStore, React, RestAPI, RunningGameStore, showToast, UserStore } from "@webpack/common";

const Native = VencordNative.pluginHelpers.QuestRunner as PluginNative<typeof import("./native")>;
const logger = new Logger("QuestRunner");

const reportVideoProgress: (questId: string, timestamp: number) => Promise<void> = findByCodeLazy(".QUESTS_VIDEO_PROGRESS(");
const sendHeartbeat: (opts: { questId: string; applicationId?: string; streamKey?: string; terminal?: boolean; }) => Promise<void> = findByCodeLazy(".QUESTS_HEARTBEAT(");
const enrollQuest: (questId: string, meta: Record<string, unknown>) => Promise<{ type: string; }> = findByCodeLazy('type:"QUESTS_ENROLL_BEGIN",');
const getProxyTicket: (appId: string) => Promise<string> = findByCodeLazy(".expiresAt>", ".ticket;");

const GameStore: { getDetectableGame(id: string): { thirdPartySkus?: { distributor: string; id?: string; }[]; } | null; } = findStoreLazy("GameStore");

const QUEST_HOME_DESKTOP = 11;
const HEARTBEAT_MS = 60_000;
const DETECT_TIMEOUT_MS = 120_000;
const LOST_TIMEOUT_MS = 90_000;
const RETRY_MS = 5 * 60_000;
const ENROLL_RETRY_MS = 30 * 60_000;

type TaskType = "WATCH_VIDEO" | "WATCH_VIDEO_ON_MOBILE" | "PLAY_ON_DESKTOP" | "PLAY_ACTIVITY" | "ACHIEVEMENT_IN_ACTIVITY";
type RunKind = "video" | "game" | "direct" | "achievement";

interface Task {
    type: TaskType;
    target: number;
    applications?: { id: string; }[];
}

interface Run {
    questId: string;
    name: string;
    kind: RunKind;
    task: Task;
    appIds: string[];
    appId?: string;
    note: string;
    abort: AbortController;
}

const settings = definePluginSettings({
    status: {
        type: OptionType.COMPONENT,
        component: () => <StatusPanel />,
    },
    autoEnroll: {
        type: OptionType.BOOLEAN,
        description: "Accept new quests for you as soon as they appear. Quests you hid in Questify are skipped.",
        default: false,
        onChange: () => scheduleEvaluate(),
    },
    videos: {
        type: OptionType.BOOLEAN,
        description: "Finish video quests for you, in real time.",
        default: true,
        onChange: () => scheduleEvaluate(),
    },
    oneVideoAtATime: {
        type: OptionType.BOOLEAN,
        description: "Watch one video quest at a time, like a normal person would.",
        default: true,
        onChange: () => scheduleEvaluate(),
    },
    games: {
        type: OptionType.BOOLEAN,
        description: "Finish play quests by running a tiny invisible stand-in game.",
        default: true,
        onChange: () => scheduleEvaluate(),
    },
    oneGameAtATime: {
        type: OptionType.BOOLEAN,
        description: "Do play quests one at a time instead of all at once. Slower, but looks more like a normal person.",
        default: false,
        onChange: () => scheduleEvaluate(),
    },
    direct: {
        type: OptionType.BOOLEAN,
        description: "Also finish quests that have no game to run (activities, console-only games) by telling Discord directly. Riskier: this is the Questify way, which Discord can catch.",
        default: false,
        onChange: () => scheduleEvaluate(),
    },
    achievements: {
        type: OptionType.BOOLEAN,
        description: "Finish activity achievement quests. Gives the activity access to your account for a moment, then removes it.",
        default: false,
        onChange: () => scheduleEvaluate(),
    },
});

interface GameLaunch {
    name: string;
    exe: string | null;
    args: string[];
}

const runs = new Map<string, Run>();
const failedAt = new Map<string, number>();
const enrollFailedAt = new Map<string, number>();
const unsupported = new Set<string>();
const toasted = new Set<string>();
const lastProblem = new Map<string, string>();
const appExeCache = new Map<string, GameLaunch>();
let evaluateTimer: ReturnType<typeof setTimeout> | null = null;
let enrolling = false;
let warnedSuspended = false;
let started = false;
let generation = 0;
let userId: string | null = null;

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
    }, ms);
    function onAbort() {
        clearTimeout(t);
        reject(new Error("aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
});

const jitter = (min: number, max: number) => min + Math.random() * (max - min);

function questName(quest: Quest): string {
    return quest.config.messages?.questName ?? quest.id;
}

function progressOf(quest: Quest, task: Task): number {
    return (quest.userStatus?.progress as Record<string, { value: number; }> | undefined)?.[task.type]?.value ?? 0;
}

function isLive(quest: Quest): boolean {
    const now = Date.now();
    return new Date(quest.config.expiresAt).getTime() > now && new Date(quest.config.startsAt).getTime() <= now;
}

function pickTask(quest: Quest): { task: Task; kind: RunKind; } | null {
    const config = quest.config.taskConfigV2 as { tasks: Record<string, Task>; joinOperator?: string; } | undefined;
    const tasks = config?.tasks;
    if (!tasks || (config.joinOperator === "and" && Object.keys(tasks).length > 1)) return null;

    const s = settings.store;
    if (tasks.WATCH_VIDEO && s.videos) return { task: tasks.WATCH_VIDEO, kind: "video" };
    if (tasks.PLAY_ON_DESKTOP && (s.games || s.direct)) return { task: tasks.PLAY_ON_DESKTOP, kind: s.games ? "game" : "direct" };
    if (tasks.ACHIEVEMENT_IN_ACTIVITY && s.achievements) return { task: tasks.ACHIEVEMENT_IN_ACTIVITY, kind: "achievement" };
    if (tasks.PLAY_ACTIVITY && s.direct) return { task: tasks.PLAY_ACTIVITY, kind: "direct" };
    return null;
}

function toast(text: string, variant: "default" | "success" | "critical" = "default") {
    showToast({ text, variant });
}

function problem(run: Run, text: string, once = true) {
    run.note = text;
    lastProblem.set(run.questId, text);
    const key = `${run.questId}:${text}`;
    if (once && toasted.has(key)) return;
    toasted.add(key);
    toast(`${run.name}: ${text}`, "critical");
}

function scheduleEvaluate(delay = 750) {
    if (!started) return;
    if (evaluateTimer) clearTimeout(evaluateTimer);
    evaluateTimer = setTimeout(evaluate, delay);
}

function questifyHidden(): Set<string> {
    const q = Settings.plugins.Questify as { ignoredQuestIDs?: { questIDs?: string[]; }; } | undefined;
    return new Set(q?.ignoredQuestIDs?.questIDs ?? []);
}

function evaluate() {
    evaluateTimer = null;
    if (!started || !UserStore.getCurrentUser()) return;

    if (QuestStore.isQuestAccessSuspended) {
        if (!warnedSuspended) toast("Quest access is suspended on this account. QuestRunner is paused.", "critical");
        warnedSuspended = true;
        stopAll();
        return;
    }

    const toEnroll: Quest[] = [];
    const hidden = questifyHidden();
    const now = Date.now();

    for (const quest of QuestStore.quests.values()) {
        const status = quest.userStatus;
        const run = runs.get(quest.id);

        if (status?.completedAt || !isLive(quest)) {
            if (run) finishRun(run, !!status?.completedAt);
            continue;
        }

        const picked = pickTask(quest);
        if (run) {
            if (!picked || picked.kind !== run.kind && !(run.kind === "direct" && picked.kind === "game")) finishRun(run, false);
            continue;
        }
        if (!picked || unsupported.has(quest.id)) continue;

        if (!status?.enrolledAt) {
            if (settings.store.autoEnroll && !hidden.has(quest.id) && now - (enrollFailedAt.get(quest.id) ?? 0) > ENROLL_RETRY_MS) toEnroll.push(quest);
            continue;
        }

        if (now - (failedAt.get(quest.id) ?? 0) < RETRY_MS) continue;
        startRun(quest, picked.task, picked.kind);
    }

    if (settings.store.oneGameAtATime) {
        const games = [...runs.values()].filter(r => r.kind === "game");
        for (const extra of games.slice(1)) finishRun(extra, false);
    }

    if (toEnroll.length && !enrolling) void enrollAll(toEnroll);
}

async function enrollAll(quests: Quest[]) {
    enrolling = true;
    const run = generation;
    try {
        for (const [i, quest] of quests.entries()) {
            if (!started || run !== generation) return;
            const blockedUntil = QuestStore.questEnrollmentBlockedUntil;
            if (blockedUntil && new Date(blockedUntil).getTime() > Date.now()) return;

            let result: { type: string; } | undefined;
            try {
                result = await enrollQuest(quest.id, {
                    questContent: QUEST_HOME_DESKTOP,
                    questContentCTA: "ACCEPT_QUEST",
                    sourceQuestContent: QUEST_HOME_DESKTOP,
                    questContentPosition: i,
                    questContentRowIndex: Math.floor(i / 3),
                });
            } catch (e) {
                logger.error(`enroll ${questName(quest)} failed`, e);
            }
            logger.info(`enroll ${questName(quest)}: ${result?.type}`);
            if (result?.type !== "success") {
                enrollFailedAt.set(quest.id, Date.now());
                return;
            }

            await sleep(jitter(3000, 7000));
        }
    } finally {
        enrolling = false;
        if (run === generation) scheduleEvaluate();
    }
}

function startRun(quest: Quest, task: Task, kind: RunKind) {
    const run: Run = { questId: quest.id, name: questName(quest), kind, task, appIds: [], note: "Starting", abort: new AbortController() };
    const active = [...runs.values()];

    if (kind === "game") {
        run.appIds = [...new Set([...(task.applications ?? []).map(a => a.id), quest.config.application?.id].filter(Boolean) as string[])];
        if (!run.appIds.length) return;
        if (settings.store.oneGameAtATime && active.some(r => r.kind === "game")) return;
    }
    if (kind === "video" && settings.store.oneVideoAtATime && active.some(r => r.kind === "video")) return;

    runs.set(quest.id, run);
    lastProblem.delete(quest.id);
    const job = kind === "video" ? runVideo(run)
        : kind === "game" ? runGame(run)
            : kind === "direct" ? runDirect(run)
                : runAchievement(run);

    job.then(ok => {
        if (runs.get(run.questId) !== run || run.abort.signal.aborted) return;
        if (ok) {
            const done = !!QuestStore.getQuest(run.questId)?.userStatus?.completedAt || run.kind === "achievement";
            // Progress can land a moment after the last report; check again shortly instead of restarting right away.
            if (!done) failedAt.set(run.questId, Date.now() - RETRY_MS + 30_000);
            finishRun(run, done);
            if (!done) scheduleEvaluate(31_000);
        } else {
            failedAt.set(run.questId, Date.now());
            finishRun(run, false);
            scheduleEvaluate(RETRY_MS + 1000);
        }
    }, e => {
        if (run.abort.signal.aborted) return;
        logger.error(`${run.name} failed`, e);
        if (String(e).includes("429")) problem(run, "Discord is rate limiting quest progress. Trying again in 5 minutes.");
        failedAt.set(run.questId, Date.now());
        finishRun(run, false);
        scheduleEvaluate(RETRY_MS + 1000);
    });
}

function finishRun(run: Run, completed: boolean) {
    if (runs.get(run.questId) !== run) return;
    runs.delete(run.questId);
    run.abort.abort();

    if (run.kind === "game" && run.appId && ![...runs.values()].some(r => r.appId === run.appId)) {
        void Native.stopGame(run.appId);
    }

    if (completed) {
        lastProblem.delete(run.questId);
        toast(`Quest done: ${run.name}`, "success");
        logger.info(`completed ${run.name}`);
    }
    scheduleEvaluate();
}

function stopAll() {
    generation++;
    for (const run of [...runs.values()]) {
        runs.delete(run.questId);
        run.abort.abort();
    }
    void Native.stopAllGames();
}

// Games with no PC executable in Discord's list (often brand-new releases) can still be detected
// through their Epic SKU: Discord's native detector reads Epic's -epicapp launch argument.
async function lookupExe(appId: string): Promise<GameLaunch> {
    const cached = appExeCache.get(appId);
    if (cached) return cached;

    const res = await RestAPI.get({ url: "/applications/public", query: { application_ids: appId } });
    const app = (res.body as { id: string; name: string; executables?: { os: string; name: string; }[]; third_party_skus?: { distributor: string; id?: string; }[]; }[])?.[0];
    const exes = (app?.executables ?? []).filter(e => e.os === "win32").map(e => e.name.replace(/^>/, ""));
    const name = app?.name ?? "Game";
    let exe = exes.find(e => !/launcher|setup|crash|helper/i.test(e)) ?? exes[0] ?? null;
    let args: string[] = [];

    const epicSku = (app?.third_party_skus ?? GameStore.getDetectableGame(appId)?.thirdPartySkus ?? []).find(s => s.distributor === "epic" && s.id)?.id;
    if (!exe && epicSku) {
        exe = `${name.replace(/[^A-Za-z0-9]/g, "") || "Game"}.exe`;
        args = [`-epicapp=${epicSku}`, `-epicsandboxid=${epicSku}`, "-epicenv=Prod", "-EpicPortal"];
    }

    const info = { name, exe, args };
    appExeCache.set(appId, info);
    return info;
}

// Non-game apps (browsers, tools) show up in the non-game list but still count for play quests.
function isAppRunning(appId: string): boolean {
    const store = RunningGameStore as typeof RunningGameStore & { getRunningNonGames?(): { id?: string; }[]; };
    return store.getRunningGames().some(g => g.id === appId) || !!store.getRunningNonGames?.().some(g => g.id === appId);
}

async function runVideo(run: Run): Promise<boolean> {
    const { signal } = run.abort;
    const quest = QuestStore.getQuest(run.questId);
    if (!quest?.userStatus?.enrolledAt) return false;

    const { target } = run.task;
    let done = progressOf(quest, run.task);
    while (done < target) {
        const step = Math.min(target - done, jitter(6, 8));
        run.note = `Watching ${Math.floor(done)}/${target}s`;
        await sleep(step * 1000, signal);
        done = Math.min(target, done + step);
        await reportVideoProgress(run.questId, done >= target ? target : Number(done.toFixed(6)));
    }
    return true;
}

async function runGame(run: Run): Promise<boolean> {
    const { signal } = run.abort;

    let appId = run.appIds.find(isAppRunning);
    if (appId) {
        run.appId = appId;
        run.note = "Game already running";
    } else {
        let info: GameLaunch | null = null;
        for (const id of run.appIds) {
            const found = await lookupExe(id);
            if (signal.aborted) return false;
            if (found.exe) {
                appId = id;
                info = found;
                break;
            }
        }
        if (!appId || !info?.exe) {
            if (settings.store.direct) {
                run.kind = "direct";
                run.appId = run.appIds[0];
                return runDirect(run);
            }
            unsupported.add(run.questId);
            problem(run, "Discord has no PC executable or Epic listing for this game. Turn on direct heartbeats to finish it anyway.");
            return false;
        }

        run.appId = appId;
        const res = await Native.launchGame(appId, info.name, info.exe, info.args);
        if (signal.aborted) {
            if (res.pid && ![...runs.values()].some(r => r !== run && r.appId === appId)) void Native.stopGame(appId);
            return false;
        }
        if (res.error || !res.pid) {
            problem(run, res.error ?? "The stand-in game didn't start.");
            return false;
        }
        run.note = `Running ${res.path}`;
    }

    // Discord's own heartbeat manager takes over once its detector sees the process; progress lands through the store.
    const startedAt = Date.now();
    const startProgress = progressOf(QuestStore.getQuest(run.questId) ?? ({} as Quest), run.task);
    let seenAt = 0;
    while (!signal.aborted) {
        await sleep(5000, signal);
        const quest = QuestStore.getQuest(run.questId);
        if (!quest || quest.userStatus?.completedAt) return true;

        const progress = progressOf(quest, run.task);
        if (isAppRunning(appId)) seenAt = Date.now();

        if (seenAt || progress > startProgress) {
            if (seenAt && Date.now() - seenAt > LOST_TIMEOUT_MS && !await Native.isGameRunning(appId)) {
                problem(run, "The stand-in game was closed. It starts again in 5 minutes.", false);
                return false;
            }
            const left = Math.max(0, run.task.target - progress);
            run.note = `${Math.floor(progress / 60)}/${Math.round(run.task.target / 60)} min, about ${Math.ceil(left / 60)} min left`;
        } else if (Date.now() - startedAt > DETECT_TIMEOUT_MS) {
            problem(run, "Discord didn't detect the stand-in game. Check that game detection is on in Discord's settings (Activity Privacy).");
            return false;
        }
    }
    return false;
}

function activityStreamKey(): string | null {
    const dm = ChannelStore.getSortedPrivateChannels()[0]?.id;
    if (dm) return `call:${dm}:1`;

    const guilds = GuildChannelStore.getAllGuilds() as Record<string, { VOCAL?: { channel: { id: string; }; }[]; } | null>;
    const voice = Object.values(guilds).find(g => g?.VOCAL?.length)?.VOCAL?.[0]?.channel.id;
    return voice ? `call:${voice}:1` : null;
}

async function runDirect(run: Run): Promise<boolean> {
    const { signal } = run.abort;
    const isActivity = run.task.type === "PLAY_ACTIVITY";
    const applicationId = isActivity ? undefined : (run.appId ?? run.task.applications?.[0]?.id);
    const streamKey = isActivity ? activityStreamKey() ?? undefined : undefined;

    if (isActivity && !streamKey) {
        problem(run, "Needs at least one DM or voice channel to work.");
        return false;
    }

    while (!signal.aborted) {
        await sendHeartbeat({ questId: run.questId, applicationId, streamKey, terminal: false });
        const quest = QuestStore.getQuest(run.questId);
        const progress = quest ? progressOf(quest, run.task) : 0;
        run.note = `${Math.floor(progress / 60)}/${Math.round(run.task.target / 60)} min (direct)`;

        if (!quest || quest.userStatus?.completedAt || progress >= run.task.target) {
            await sendHeartbeat({ questId: run.questId, applicationId, streamKey, terminal: true });
            return true;
        }

        const left = (run.task.target - progress) * 1000;
        await sleep(left < HEARTBEAT_MS ? left + 1500 : HEARTBEAT_MS + jitter(0, 1500), signal);
    }
    return false;
}

async function runAchievement(run: Run): Promise<boolean> {
    const { signal } = run.abort;
    const appId = run.task.applications?.[0]?.id;
    if (!appId) return false;

    run.note = "Authorizing activity";
    const auth = await RestAPI.post({
        url: `/oauth2/authorize?client_id=${appId}&response_type=code&scope=identify%20applications.entitlements&state=`,
        body: { authorize: true },
    });
    const location = (auth.body as { location?: string; })?.location;
    const code = location ? new URL(location).searchParams.get("code") : null;

    let result: { ok: boolean; error: string | null; } = { ok: false, error: "No authorization code" };
    if (code && !signal.aborted) {
        let referrer: string | undefined;
        try {
            const url = new URL(`https://${appId}.discordsays.com/`);
            url.searchParams.set("instance_id", `i-${Math.random().toString(36).slice(2, 12)}`);
            url.searchParams.set("platform", "desktop");
            url.searchParams.set("discord_proxy_ticket", await getProxyTicket(appId));
            referrer = url.toString();
        } catch (e) {
            logger.warn("proxy ticket failed", e);
        }

        if (!signal.aborted) {
            run.note = "Posting achievement";
            result = await Native.completeActivityAchievement(appId, code, run.task.target, run.questId, referrer);
        }
    }

    try {
        const tokens = (await RestAPI.get({ url: "/oauth2/tokens" })).body as { id: string; application: { id: string; }; }[];
        for (const token of tokens.filter(t => t.application?.id === appId)) {
            await RestAPI.del({ url: `/oauth2/tokens/${token.id}` });
        }
    } catch (e) {
        logger.warn("deauthorize failed", e);
        toast(`${run.name}: couldn't remove the activity's access. Remove it in User Settings, Authorized Apps.`, "critical");
    }

    if (!result.ok) {
        logger.error(`${run.name} achievement failed`, result.error);
        if (!signal.aborted) problem(run, "The activity didn't accept the achievement.");
    }
    return result.ok && !signal.aborted;
}

// Discord attaches a stack trace to quest progress analytics; keep only Discord's own frames so client mods don't show up in it.
function cleanStack(stack: string | undefined): string {
    if (!stack) return "";
    const lines = stack.split("\n");
    return [lines[0], ...lines.slice(1).filter(l => /https:\/\/(?:\w+\.)?discord\.com\//.test(l))].join("\n");
}

type QuestifySettings = { enabled?: boolean; autoCompleteQuests?: boolean; autoCompleteQuestTypes?: Record<string, boolean>; };

function questifyFinisherOn(): boolean {
    const q = Settings.plugins.Questify as QuestifySettings | undefined;
    return !!q?.enabled && (!!q.autoCompleteQuests || Object.values(q.autoCompleteQuestTypes ?? {}).some(Boolean));
}

function turnOffQuestifyFinisher() {
    const q = Settings.plugins.Questify as QuestifySettings | undefined;
    if (!q) return;
    q.autoCompleteQuests = false;
    const types = ["WATCH_VIDEO", "WATCH_VIDEO_ON_MOBILE", "PLAY_ON_DESKTOP", "PLAY_ON_XBOX", "PLAY_ON_PLAYSTATION", "PLAY_ACTIVITY", "ACHIEVEMENT_IN_ACTIVITY"];
    q.autoCompleteQuestTypes = Object.fromEntries(types.map(k => [k, false]));
    toast("Questify's finisher is off. Restart Discord to finish switching it off.", "success");
}

function QuestifyNotice() {
    const q = Settings.plugins.Questify as QuestifySettings | undefined;

    if (questifyFinisherOn()) {
        return (
            <Notice variant="warning" action={<Button size="small" onClick={turnOffQuestifyFinisher}>Turn off Questify's finisher</Button>}>
                Questify's own quest finisher is on. Keep Questify if you like it, but turn its finisher off. Otherwise both plugins work on the same quest at once, and Questify's way is easier for Discord to catch.
            </Notice>
        );
    }
    if (q?.enabled) {
        return <Notice variant="positive">Questify is on and its finisher is off. That's the right setup: Questify runs the quest page, QuestRunner finishes the quests.</Notice>;
    }
    return <Notice variant="info">Questify is off. You don't need it for QuestRunner to work.</Notice>;
}

function waitingQuests() {
    const out: string[] = [];
    for (const quest of QuestStore.quests.values()) {
        const status = quest.userStatus;
        if (runs.has(quest.id) || !status?.enrolledAt || status.completedAt || !isLive(quest)) continue;
        const name = questName(quest);
        if (unsupported.has(quest.id)) out.push(`${name}: can't be done (${lastProblem.get(quest.id) ?? "not supported"})`);
        else if (!pickTask(quest)) out.push(`${name}: this kind of quest is turned off or not supported`);
        else if (failedAt.has(quest.id) && Date.now() - (failedAt.get(quest.id) ?? 0) < RETRY_MS) out.push(`${name}: trying again soon${lastProblem.has(quest.id) ? ` (${lastProblem.get(quest.id)})` : ""}`);
        else out.push(`${name}: waiting for its turn`);
    }
    return out;
}

function StatusPanel() {
    const [, tick] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, []);

    const list = [...runs.values()];
    const waiting = waitingQuests();

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Card>
                <HeadingTertiary>What is this?</HeadingTertiary>
                <Paragraph>QuestRunner does your Discord quests for you. Press Accept on a quest and it finishes it on its own. You only come back to claim the reward, and solve the captcha Discord shows when you claim.</Paragraph>
                <Paragraph>Video quests: it plays the video in the background in real time, reporting progress every few seconds like a real viewer, so it takes as long as the video. By default it watches one video at a time.</Paragraph>
                <Paragraph>Play quests: it starts a tiny, invisible stand-in program named after the game, so Discord's own game detection sees a process for that game. When the time is up, the quest is done and the stand-in closes. Play quests can't go faster than their real time, because Discord's servers time them, but several can run at once.</Paragraph>
                <Paragraph>While a stand-in runs, your friends see "Playing" that game on your profile, and Discord may add it to your Registered Games. Antivirus software sometimes blocks the stand-in, since it's a brand-new unsigned file. Allow it if that happens.</Paragraph>
            </Card>
            <Card>
                <HeadingTertiary>Before you use it</HeadingTertiary>
                <Paragraph>Automating quests breaks Discord's Terms of Service. Discord can suspend quest access, or worse, on accounts it catches. Use it on an account you're fine risking.</Paragraph>
            </Card>
            <Card>
                <HeadingTertiary>How is this different from Questify?</HeadingTertiary>
                <Paragraph>Questify is mostly a better quest page: sorting, hiding, alerts and more. Its quest finisher just tells Discord "I'm playing", with no game running. Discord has started suspending quest access for that.</Paragraph>
                <Paragraph>QuestRunner only finishes quests. For play quests it runs a process Discord can actually see, instead of only claiming one is running.</Paragraph>
            </Card>
            <QuestifyNotice />
            <Card>
                <HeadingTertiary>Running now</HeadingTertiary>
                {list.length
                    ? list.map(r => <Paragraph key={r.questId}>{r.name}: {r.note}</Paragraph>)
                    : <Paragraph>Nothing running. Accept a quest and it shows up here.</Paragraph>}
                {waiting.length > 0 && (
                    <>
                        <HeadingTertiary>Waiting</HeadingTertiary>
                        {waiting.map(w => <Paragraph key={w}>{w}</Paragraph>)}
                    </>
                )}
            </Card>
            <Card>
                <HeadingTertiary>Stand-in files</HeadingTertiary>
                <Paragraph>Stand-ins are kept in %APPDATA%\QuestRunner\games so the next quest for the same game starts faster. Each one is under 300 KB.</Paragraph>
                <Button
                    size="small"
                    variant="secondary"
                    disabled={list.some(r => r.kind === "game")}
                    onClick={async () => {
                        const res = await Native.deleteStandIns();
                        toast(res.ok ? "Stand-in files deleted." : res.error ?? "Couldn't delete them.", res.ok ? "success" : "critical");
                    }}
                >
                    Delete stand-in files
                </Button>
            </Card>
        </div>
    );
}

function warnQuestify() {
    if (questifyFinisherOn()) {
        toast("Questify's quest finisher is also on. Open QuestRunner's settings to turn it off.", "critical");
    }
}

function onConnectionOpen() {
    const id = UserStore.getCurrentUser()?.id ?? null;
    if (id === userId) {
        scheduleEvaluate(3000);
        return;
    }
    userId = id;
    stopAll();
    warnedSuspended = false;
    failedAt.clear();
    enrollFailedAt.clear();
    unsupported.clear();
    toasted.clear();
    lastProblem.clear();
    scheduleEvaluate(3000);
}

const onStoreChange = () => scheduleEvaluate();

export default definePlugin({
    name: "QuestRunner",
    description: "Does your Discord quests for you. Accept a quest and it finishes by itself: videos in real time, play quests by running a tiny invisible stand-in game. Open settings for the full explanation.",
    authors: [{ name: "cordmuffin", id: 0n }],
    settings,
    cleanStack,

    patches: [
        {
            find: "NetworkActionNames.QUEST_VIDEO_PROGRESS,",
            noWarn: true,
            replacement: {
                match: /stack_trace:Error\(\)\.stack\?\?""/g,
                replace: "stack_trace:$self.cleanStack(Error().stack)"
            }
        }
    ],

    flux: {
        CONNECTION_OPEN: onConnectionOpen,
        LOGOUT: () => {
            userId = null;
            stopAll();
        },
        QUESTS_FETCH_CURRENT_QUESTS_SUCCESS: () => scheduleEvaluate(),
        QUESTS_ENROLL_SUCCESS: () => scheduleEvaluate(),
        QUESTS_SEND_HEARTBEAT_SUCCESS: () => scheduleEvaluate(),
    },

    start() {
        started = true;
        userId = UserStore.getCurrentUser()?.id ?? null;
        void Native.stopAllGames();
        QuestStore.addChangeListener(onStoreChange);
        warnQuestify();
        scheduleEvaluate(3000);
    },

    stop() {
        started = false;
        QuestStore.removeChangeListener(onStoreChange);
        if (evaluateTimer) clearTimeout(evaluateTimer);
        stopAll();
    },
});
