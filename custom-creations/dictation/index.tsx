/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { ChatBarButton, type ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import { insertTextIntoChatInputBox } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { sleep } from "@utils/misc";
import { useForceUpdater } from "@utils/react";
import definePlugin, { OptionType, type PluginNative } from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { Alerts, ContextMenuApi, MediaEngineStore, Menu, ReactDOM, showToast, useEffect, useState } from "@webpack/common";

const Native = VencordNative.pluginHelpers.Dictation as PluginNative<typeof import("./native")>;
const logger = new Logger("Dictation");
const cl = classNameFactory("vc-dictation-");

const AudioDeviceMenu = findComponentByCodeLazy<{ onClose(): void; renderInputDevices?: boolean; renderInputProfiles?: boolean; renderInputVolume?: boolean; renderSettingsButton?: boolean; }>('navId:"audio-device-context"', "maybeRenderInputMeter");

const SAMPLE_RATE = 16000;
const MAX_RECORD_MS = 10 * 60_000;

const MODIFIERS = ["ctrl", "alt", "shift", "meta"] as const;
const MODIFIER_KEYS: Record<string, string> = { Control: "ctrl", Alt: "alt", Shift: "shift", Meta: "meta" };

let capturingShortcut = false;
let heldStart = false;
let holding = false;

const keyName = (code: string) => code.replace(/^Key|^Digit/, "").replace(/^Numpad/, "Num ");
const formatShortcut = (combo: string[]) => combo.length
    ? combo.map(k => MODIFIERS.includes(k as typeof MODIFIERS[number]) ? k[0].toUpperCase() + k.slice(1) : keyName(k)).join(" + ")
    : "Not set";

function ShortcutRecorder() {
    const [listening, setListening] = useState(false);
    const { shortcut } = settings.use(SHORTCUT_KEYS);

    useEffect(() => {
        if (!listening) return;
        capturingShortcut = true;

        function onKeyDown(e: KeyboardEvent) {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === "Escape") return setListening(false);
            if (e.key === "Backspace" || e.key === "Delete") {
                settings.store.shortcut = [];
                return setListening(false);
            }
            if (e.key in MODIFIER_KEYS) return;

            settings.store.shortcut = [...MODIFIERS.filter(m => e[`${m}Key`]), e.code];
            setListening(false);
        }

        function onBlur() {
            setListening(false);
        }

        document.addEventListener("keydown", onKeyDown, true);
        window.addEventListener("blur", onBlur);
        return () => {
            capturingShortcut = false;
            document.removeEventListener("keydown", onKeyDown, true);
            window.removeEventListener("blur", onBlur);
        };
    }, [listening]);

    return (
        <div className={cl("shortcut")}>
            <div>
                <BaseText size="md" weight="semibold">Hold to talk shortcut</BaseText>
                <Paragraph>Hold these keys while you talk, and let go to insert the text. Press Backspace while setting it to turn it off.</Paragraph>
            </div>
            <Button variant="secondary" onClick={() => setListening(true)}>
                {listening ? "Press keys..." : formatShortcut(shortcut)}
            </Button>
        </div>
    );
}

const SHORTCUT_KEYS = ["shortcut"] as ("shortcut" | "punctuation" | "grammar" | "speechModel")[];

const settings = definePluginSettings({
    shortcut: {
        type: OptionType.COMPONENT,
        default: ["alt", "KeyD"] as string[],
        component: ShortcutRecorder,
    },
    punctuation: {
        type: OptionType.BOOLEAN,
        description: "Add commas, periods and question marks to what you say. Turn off to get just the words.",
        default: true,
    },
    grammar: {
        type: OptionType.BOOLEAN,
        description: "Fix grammar too, using a small AI model that runs on your PC. It's downloaded the first time you turn this on, and the size is picked for your computer.",
        default: false,
        onChange: (on: boolean) => {
            if (on) ensureGrammar();
        },
    },
    speechModel: {
        type: OptionType.SELECT,
        description: "Which speech model to use.",
        options: [
            { label: "Pick for my computer", value: "auto", default: true },
            { label: "Most accurate (1.6 GB, needs a stronger PC)", value: "cohere" },
            { label: "Fastest (460 MB, fine on older PCs)", value: "parakeet" },
        ],
    },
    liveText: {
        type: OptionType.BOOLEAN,
        description: "Show the words above the chat box while you talk. The final text still goes in when you stop.",
        default: true,
    },
});

type Phase = "idle" | "downloading" | "recording" | "working";

// Audio is checked in 16 ms frames to tell talking apart from background sound.
const FRAME = 256;
const FRAME_SEC = FRAME / SAMPLE_RATE;
const LOUD_DB = -35;
const QUIET_DB = -52;
const ABOVE_FLOOR_DB = 15;
const DIGITAL_SILENCE_DB = -90;
const MIN_RUN_FRAMES = 6;
const MIN_VOICE_FRAMES = 12;
const PAUSE_FRAMES = 40;
const HINT_AFTER_MS = 2500;
const PREVIEW_EVERY = SAMPLE_RATE * 0.6;
const MAX_SEGMENT = SAMPLE_RATE * 25;

interface Recording {
    stream: MediaStream;
    ctx: AudioContext;
    timer: ReturnType<typeof setTimeout>;
    started: number;
    buf: Float32Array;
    length: number;
    carry: number;
    frames: number[];
    floor: number;
    voiceRun: number;
    silentRun: number;
    talking: boolean;
    heardVoice: boolean;
    segStart: number;
    segVoiced: number;
    lastPreview: number;
    busy: boolean;
    commits: { start: number; end: number; index: number; }[];
    texts: string[];
    tentative: string;
}

let phase: Phase = "idle";
let progress = "";
let recording: Recording | null = null;
// Opening the mic takes a moment; a second click meanwhile mustn't open it twice.
let starting = false;
// Bumped when the plugin stops, so a start that was still opening the mic lets it go.
let generation = 0;
let liveText = "";
let liveHint = "";
const listeners = new Set<() => void>();
const meters = new Set<HTMLElement>();

const isVoiced = (db: number, floor: number) => db > LOUD_DB || (db > QUIET_DB && db > floor + ABOVE_FLOOR_DB);

function setLive(text: string, hint = "") {
    if (text === liveText && hint === liveHint) return;
    liveText = text;
    liveHint = hint;
    listeners.forEach(fn => fn());
}

function showLevel(level: number, talking: boolean) {
    for (const el of meters) {
        el.style.setProperty("--vc-dictation-level", level.toFixed(2));
        el.classList.toggle(cl("talking"), talking);
    }
}

function setPhase(next: Phase, text = "") {
    phase = next;
    progress = text;
    listeners.forEach(fn => fn());
}

let recommended: "cohere" | "parakeet" = "cohere";
let fromDictation = false;

const currentModel = () => {
    const { speechModel } = settings.store;
    return speechModel === "cohere" || speechModel === "parakeet" ? speechModel : recommended;
};
const errorText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

function confirm(title: string, body: string, confirmText: string) {
    return new Promise<boolean>(resolve => Alerts.show({ title, body, confirmText, cancelText: "Not now", onConfirm: () => resolve(true), onCancel: () => resolve(false), onCloseCallback: () => resolve(false) }));
}

async function download(what: "cohere" | "parakeet" | "grammar", title: string, body: string, doneText: string) {
    if (phase !== "idle" || !await confirm(title, body, "Download")) return false;

    setPhase("downloading", "Starting download");
    const job = Native.install(what);
    let done = false;
    job.finally(() => done = true).catch(() => { });

    while (!done) {
        const { download } = await Native.getStatus(currentModel());
        if (download?.total) setPhase("downloading", `Downloading ${download.label}: ${Math.floor(download.received / download.total * 100)}%`);
        else if (download?.label) setPhase("downloading", `Unpacking ${download.label}`);
        await sleep(1000);
    }

    try {
        await job;
        showToast({ text: doneText, variant: "success" });
        return true;
    } catch (e) {
        logger.error("Download failed", e);
        showToast({ text: `Download failed: ${errorText(e)}`, variant: "critical" });
        return false;
    } finally {
        setPhase("idle");
    }
}

async function ensureGrammar() {
    const status = await Native.getStatus(currentModel());
    if (!status.grammarSupported) {
        settings.store.grammar = false;
        return showToast({ text: "Grammar fixing isn't available on this kind of computer.", variant: "critical" });
    }
    if (status.grammarInstalled) return;

    const ok = await download(
        "grammar",
        "Download the grammar model?",
        `Grammar fixing needs a one time download of about ${status.grammarSizeMb.toLocaleString()} MB, picked to suit your computer. It's free and runs fully on your PC.`,
        "Grammar fixing is ready."
    );
    if (!ok) settings.store.grammar = false;
}

function fixMishears(text: string) {
    return text.replace(/\bMike(?= (?:test|check|testing)\b)/g, (_, offset: number) => offset === 0 || /[.!?]\s*$/.test(text.slice(0, offset)) ? "Mic" : "mic");
}

// Both models are set to English, so text in another alphabet is the model making things up from noise.
function cleanText(text: string) {
    const letters = text.match(/\p{L}/gu) ?? [];
    const latin = text.match(/\p{Script=Latin}/gu) ?? [];
    if (!letters.length || latin.length / letters.length < 0.8) return "";
    return fixMishears(text);
}

function samplesOf(rec: Recording, start: number, end: number) {
    return rec.buf.slice(start, end);
}

// The part of the clip with talking in it, padded a little, or null when nobody talked.
function voicedRange(rec: Recording) {
    const { frames } = rec;
    const heard = frames.filter(db => db > DIGITAL_SILENCE_DB).sort((a, b) => a - b);
    const floor = heard[Math.floor(heard.length / 10)] ?? QUIET_DB;
    let first = -1, last = -1, voiced = 0, run = 0;
    for (let i = 0; i <= frames.length; i++) {
        if (i < frames.length && isVoiced(frames[i], floor)) {
            run++;
            continue;
        }
        if (run >= MIN_RUN_FRAMES) {
            voiced += run;
            if (first < 0) first = i - run;
            last = i;
        }
        run = 0;
    }
    if (voiced < MIN_VOICE_FRAMES) return null;
    return {
        start: Math.max(0, (first - 20) * FRAME),
        end: Math.min(rec.length, (last + 30) * FRAME),
    };
}

function onAudio(rec: Recording, input: Float32Array) {
    if (rec.length + input.length > rec.buf.length) {
        const bigger = new Float32Array(rec.buf.length * 2);
        bigger.set(rec.buf.subarray(0, rec.length));
        rec.buf = bigger;
    }
    rec.buf.set(input, rec.length);
    rec.length += input.length;

    let level = 0;
    while (rec.carry + FRAME <= rec.length) {
        let sum = 0;
        for (let i = rec.carry; i < rec.carry + FRAME; i++) sum += rec.buf[i] * rec.buf[i];
        rec.carry += FRAME;
        const db = 10 * Math.log10(sum / FRAME + 1e-12);
        rec.frames.push(db);
        level = Math.max(level, Math.min(1, Math.max(0, (db + 60) / 45)));

        // Mics start with a moment of pure digital silence, which isn't the room's real noise level.
        if (db > DIGITAL_SILENCE_DB) {
            if (rec.floor <= DIGITAL_SILENCE_DB) rec.floor = db;
            rec.floor = db < rec.floor ? rec.floor * 0.7 + db * 0.3 : rec.floor + 0.1;
        }

        if (isVoiced(db, rec.floor)) {
            rec.voiceRun++;
            rec.silentRun = 0;
            if (rec.voiceRun >= MIN_RUN_FRAMES) rec.talking = true;
            if (rec.voiceRun === MIN_RUN_FRAMES) rec.segVoiced += MIN_RUN_FRAMES;
            else if (rec.voiceRun > MIN_RUN_FRAMES) rec.segVoiced++;
            if (rec.segVoiced >= MIN_VOICE_FRAMES) rec.heardVoice = true;
        } else {
            rec.voiceRun = 0;
            rec.silentRun++;
            if (rec.silentRun >= 15) rec.talking = false;
        }

        const segLength = rec.carry - rec.segStart;
        const paused = rec.silentRun >= PAUSE_FRAMES;
        if (rec.segVoiced < MIN_VOICE_FRAMES) {
            // Only background sound so far: drop it so it's never sent to the model.
            if (paused) {
                rec.segStart = rec.carry - (PAUSE_FRAMES / 2) * FRAME;
                rec.segVoiced = 0;
            }
        } else if (paused || segLength >= MAX_SEGMENT) {
            const end = paused ? rec.carry - (PAUSE_FRAMES / 2) * FRAME : rec.carry;
            rec.texts.push(rec.tentative);
            rec.commits.push({ start: rec.segStart, end, index: rec.texts.length - 1 });
            rec.tentative = "";
            rec.segStart = end;
            rec.lastPreview = end;
            rec.segVoiced = 0;
        }
    }
    showLevel(level, rec.talking);

    if (!settings.store.liveText) return;
    const hint = !rec.heardVoice && Date.now() - rec.started > HINT_AFTER_MS ? "Not hearing anything. Is your mic muted or too quiet?" : "";
    setLive(livePreview(rec), hint);
    pumpPreview(rec);
}

const livePreview = (rec: Recording) => [...rec.texts, rec.tentative].filter(Boolean).join(" ");

// One decode at a time: finished pieces first, then a fresh guess at the piece being spoken.
async function pumpPreview(rec: Recording) {
    if (rec.busy || recording !== rec) return;
    const commit = rec.commits.shift();
    const start = commit?.start ?? rec.segStart;
    const end = commit?.end ?? rec.length;
    if (!commit && (rec.segVoiced < MIN_VOICE_FRAMES || end - rec.lastPreview < PREVIEW_EVERY)) return;

    rec.busy = true;
    if (!commit) rec.lastPreview = end;
    try {
        const text = cleanText((await Native.transcribe(currentModel(), samplesOf(rec, start, end))).trim());
        if (recording !== rec) return;
        if (commit) rec.texts[commit.index] = text;
        else if (start === rec.segStart) rec.tentative = text;
        setLive(livePreview(rec), "");
    } catch (e) {
        logger.warn("Live preview failed", e);
    } finally {
        rec.busy = false;
    }
    pumpPreview(rec);
}

async function startRecording() {
    // Taken first: stopping the plugin while the status lookup below runs must still cancel this start.
    const gen = generation;
    const model = currentModel();
    const status = await Native.getStatus(model);
    if (!status.supported) return showToast({ text: "Dictation isn't available on this kind of computer yet.", variant: "critical" });
    if (!status.speechInstalled) {
        await download(
            model,
            "Download the speech model?",
            `Dictation needs a one time download of about ${status.speechSizeMb.toLocaleString()} MB. It's free and runs fully on your PC, so your voice never leaves it.`,
            "Speech model ready. Click the mic or hold your shortcut to talk."
        );
        return;
    }

    let stream: MediaStream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: await discordMicConstraints() });
    } catch (e) {
        return showToast({ text: `Couldn't open your microphone: ${errorText(e)}`, variant: "critical" });
    }
    if (gen !== generation) {
        stream.getTracks().forEach(t => t.stop());
        return;
    }

    Native.warmUp(model, settings.store.grammar && status.grammarInstalled).catch(e => logger.warn("Warm up failed", e));

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(1024, 1, 1);
    const gain = ctx.createGain();
    gain.gain.value = MediaEngineStore.getInputVolume() / 100;
    source.connect(gain);
    gain.connect(processor);
    processor.connect(ctx.destination);

    const rec: Recording = {
        stream, ctx,
        timer: setTimeout(stopRecording, MAX_RECORD_MS),
        started: Date.now(),
        buf: new Float32Array(SAMPLE_RATE * 30),
        length: 0,
        carry: 0,
        frames: [],
        floor: -Infinity,
        voiceRun: 0,
        silentRun: 0,
        talking: false,
        heardVoice: false,
        segStart: 0,
        segVoiced: 0,
        lastPreview: 0,
        busy: false,
        commits: [],
        texts: [],
        tentative: "",
    };
    processor.onaudioprocess = e => onAudio(rec, e.inputBuffer.getChannelData(0));
    recording = rec;
    setLive("", "");
    setPhase("recording");
    if (heldStart && !holding) stopRecording();
}

async function discordMicConstraints(): Promise<MediaTrackConstraints> {
    const deviceId = MediaEngineStore.getInputDeviceId();
    const name = MediaEngineStore.getInputDevices()[deviceId]?.name ?? "";
    const mics = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput");
    const match = deviceId === "default" ? null : mics.find(d => d.label === name) ?? mics.find(d => name && d.label.includes(name));

    const profile = String(MediaEngineStore.getActiveInputProfile());
    const custom = MediaEngineStore.isInputProfileCustom();
    const studio = !custom && profile === "STUDIO";
    return {
        deviceId: match ? { exact: match.deviceId } : undefined,
        channelCount: 1,
        echoCancellation: custom ? MediaEngineStore.getEchoCancellation() : !studio,
        noiseSuppression: custom ? MediaEngineStore.getNoiseSuppression() || MediaEngineStore.getNoiseCancellation() : !studio,
        autoGainControl: custom ? MediaEngineStore.getAutomaticGainControl() : !studio,
    };
}

function closeMicMenu() {
    fromDictation = false;
    ContextMenuApi.closeContextMenu();
}

function openMicMenu(e: React.MouseEvent) {
    fromDictation = true;
    ContextMenuApi.openContextMenu(e, () => (
        <AudioDeviceMenu
            onClose={closeMicMenu}
            renderInputDevices
            renderInputProfiles
            renderInputVolume
            renderSettingsButton
        />
    ));
}

function releaseRecording() {
    const rec = recording;
    if (!rec) return null;
    recording = null;
    clearTimeout(rec.timer);
    rec.stream.getTracks().forEach(t => t.stop());
    rec.ctx.close();
    showLevel(0, false);
    return rec;
}

function finish() {
    setLive("", "");
    setPhase("idle");
}

async function stopRecording() {
    const rec = releaseRecording();
    if (!rec) return;

    if (rec.length < SAMPLE_RATE / 2) {
        finish();
        return showToast({ text: heldStart ? "Hold the keys down while you talk." : "That was too short to hear anything.", variant: "default" });
    }
    const range = voicedRange(rec);
    if (!range) {
        finish();
        return showToast({ text: "Didn't hear you talking, so nothing was added. Check that your mic is on.", variant: "default" });
    }

    setPhase("working", "Turning your voice into text");
    try {
        let text = cleanText(await Native.transcribe(currentModel(), samplesOf(rec, range.start, range.end)));
        if (!text) return showToast({ text: "Didn't catch anything. Try again a bit louder.", variant: "default" });

        if (settings.store.grammar) {
            setPhase("working", "Fixing grammar");
            text = await Native.fixGrammar(text).catch(e => {
                logger.warn("Grammar fix failed", e);
                showToast({ text: `Grammar fix skipped: ${errorText(e)}`, variant: "default" });
                return text;
            });
        }
        if (!settings.store.punctuation) text = text.replace(/[.,!?;:]+(?=\s|$)/g, "");

        insertTextIntoChatInputBox(text + " ");
    } catch (e) {
        logger.error("Transcription failed", e);
        showToast({ text: `Dictation failed: ${errorText(e)}`, variant: "critical" });
    } finally {
        finish();
    }
}

function begin(held: boolean) {
    if (starting) return;
    starting = true;
    heldStart = held;
    startRecording().catch(e => {
        logger.error("Couldn't start", e);
        setPhase("idle");
        showToast({ text: `Dictation failed: ${errorText(e)}`, variant: "critical" });
    }).finally(() => starting = false);
}

function onClick() {
    if (phase === "idle") begin(false);
    else if (phase === "recording") stopRecording();
}

function matchesShortcut(e: KeyboardEvent) {
    const combo = settings.store.shortcut;
    return combo.length > 0 && e.code === combo[combo.length - 1] && MODIFIERS.every(m => e[`${m}Key`] === combo.includes(m));
}

function onKeyDown(e: KeyboardEvent) {
    if (capturingShortcut || !matchesShortcut(e)) return;
    e.preventDefault();
    if (e.repeat || holding) return;
    holding = true;
    if (phase === "idle") begin(true);
}

function release() {
    if (!holding) return;
    holding = false;
    if (heldStart && phase === "recording") stopRecording();
}

function onKeyUp(e: KeyboardEvent) {
    const combo = settings.store.shortcut;
    if (e.code === combo[combo.length - 1] || combo.includes(MODIFIER_KEYS[e.key])) release();
}

const TOOLTIPS: Record<Phase, string> = {
    idle: "Dictate (right click for settings)",
    downloading: "",
    recording: "Stop and insert text",
    working: "",
};

const meterRef = (el: HTMLElement | SVGElement | null) => {
    if (!el) return;
    meters.add(el as HTMLElement);
    return () => void meters.delete(el as HTMLElement);
};

function LiveBubble({ anchor }: { anchor: Element | null; }) {
    const box = anchor?.closest("form")?.getBoundingClientRect() ?? anchor?.getBoundingClientRect();
    if (!box) return null;

    return ReactDOM.createPortal(
        <div className={cl("live")} style={{ left: box.left, width: box.width, bottom: window.innerHeight - box.top + 8 }}>
            <div ref={meterRef} className={cl("meter", phase === "recording" ? "" : "done")}>
                <span /><span /><span /><span /><span />
            </div>
            <div className={cl("live-text", liveText ? "" : "placeholder")}>
                {liveText || liveHint || (phase === "recording" ? "Listening..." : progress)}
            </div>
        </div>,
        document.body
    );
}

const DictationButton: ChatBarButtonFactory = ({ isMainChat }) => {
    const forceUpdate = useForceUpdater();
    const [anchor, setAnchor] = useState<SVGSVGElement | null>(null);
    useEffect(() => {
        listeners.add(forceUpdate);
        window.addEventListener("resize", forceUpdate);
        return () => {
            listeners.delete(forceUpdate);
            window.removeEventListener("resize", forceUpdate);
        };
    }, []);

    if (!isMainChat) return null;

    const showBubble = settings.store.liveText && (phase === "recording" || (phase === "working" && !!liveText));

    return (
        <ChatBarButton tooltip={TOOLTIPS[phase] || progress} onClick={onClick} onContextMenu={openMicMenu}>
            <svg ref={el => { setAnchor(el); return meterRef(el); }} className={cl("icon", phase)} width="20" height="20" viewBox="0 0 24 24">
                <path fill="currentColor" d="M12 15a4 4 0 0 0 4-4V5a4 4 0 1 0-8 0v6a4 4 0 0 0 4 4Z" />
                <path fill="currentColor" d="M6 11a1 1 0 1 0-2 0 8 8 0 0 0 7 7.94V21H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.06A8 8 0 0 0 20 11a1 1 0 1 0-2 0 6 6 0 0 1-12 0Z" />
            </svg>
            {showBubble && <LiveBubble anchor={anchor} />}
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "Dictation",
    description: "Talk instead of typing. A free speech model turns your voice into text on your PC, with commas and punctuation added for you.",
    authors: [{ name: "nolifepops", id: 221807880053981184n }],
    settings,

    chatBarButton: {
        icon: () => (
            <svg width="20" height="20" viewBox="0 0 24 24">
                <path fill="currentColor" d="M12 15a4 4 0 0 0 4-4V5a4 4 0 1 0-8 0v6a4 4 0 0 0 4 4Z" />
            </svg>
        ),
        render: DictationButton,
    },

    contextMenus: {
        "audio-device-context"(children) {
            if (!fromDictation) return;
            const { punctuation, grammar, speechModel } = settings.store;
            children.push(
                <Menu.MenuGroup key="vc-dictation">
                    <Menu.MenuCheckboxItem id="vc-dictation-punctuation" label="Add Punctuation" checked={punctuation} action={() => settings.store.punctuation = !punctuation} />
                    <Menu.MenuCheckboxItem id="vc-dictation-grammar" label="Fix Grammar" subtext="Uses a small AI model on your PC" checked={grammar} action={() => settings.store.grammar = !grammar} />
                    <Menu.MenuItem id="vc-dictation-model" label="Speech Model" subtext={speechModel === "cohere" ? "Most accurate" : speechModel === "parakeet" ? "Fastest" : "Picked for your computer"}>
                        {([["auto", "Pick for my computer"], ["cohere", "Most accurate"], ["parakeet", "Fastest"]] as const).map(([value, label]) => (
                            <Menu.MenuRadioItem key={value} id={`vc-dictation-model-${value}`} group="vc-dictation-model" label={label} checked={speechModel === value} action={() => settings.store.speechModel = value} />
                        ))}
                    </Menu.MenuItem>
                </Menu.MenuGroup>
            );
        },
    },

    start() {
        Native.recommendedSpeechModel().then(m => recommended = m);
        document.addEventListener("keydown", onKeyDown, true);
        document.addEventListener("keyup", onKeyUp, true);
        window.addEventListener("blur", release);
    },

    stop() {
        document.removeEventListener("keydown", onKeyDown, true);
        document.removeEventListener("keyup", onKeyUp, true);
        window.removeEventListener("blur", release);
        holding = false;
        generation++;
        releaseRecording();
        finish();
        Native.unload();
    },
});
