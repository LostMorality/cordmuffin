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
import { Alerts, ContextMenuApi, MediaEngineStore, Menu, showToast, useEffect, useState } from "@webpack/common";

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
});

type Phase = "idle" | "downloading" | "recording" | "working";

let phase: Phase = "idle";
let progress = "";
let recording: { stream: MediaStream; ctx: AudioContext; chunks: Float32Array[]; timer: ReturnType<typeof setTimeout>; } | null = null;
const listeners = new Set<() => void>();

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
    return new Promise<boolean>(resolve => Alerts.show({ title, body, confirmText, cancelText: "Not now", onConfirm: () => resolve(true), onCancel: () => resolve(false) }));
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

async function startRecording() {
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

    Native.warmUp(model, settings.store.grammar && status.grammarInstalled).catch(e => logger.warn("Warm up failed", e));

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    processor.onaudioprocess = e => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    const gain = ctx.createGain();
    gain.gain.value = MediaEngineStore.getInputVolume() / 100;
    source.connect(gain);
    gain.connect(processor);
    processor.connect(ctx.destination);

    recording = { stream, ctx, chunks, timer: setTimeout(stopRecording, MAX_RECORD_MS) };
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
    if (!recording) return null;
    const { stream, ctx, chunks, timer } = recording;
    recording = null;
    clearTimeout(timer);
    stream.getTracks().forEach(t => t.stop());
    ctx.close();
    return chunks;
}

async function stopRecording() {
    const chunks = releaseRecording();
    if (!chunks) return;

    const samples = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    if (samples.length < SAMPLE_RATE / 2) {
        setPhase("idle");
        return showToast({ text: heldStart ? "Hold the keys down while you talk." : "That was too short to hear anything.", variant: "default" });
    }
    let offset = 0;
    for (const c of chunks) {
        samples.set(c, offset);
        offset += c.length;
    }

    setPhase("working", "Turning your voice into text");
    try {
        let text = fixMishears(await Native.transcribe(currentModel(), samples));
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
        setPhase("idle");
    }
}

function begin(held: boolean) {
    heldStart = held;
    startRecording().catch(e => {
        logger.error("Couldn't start", e);
        setPhase("idle");
        showToast({ text: `Dictation failed: ${errorText(e)}`, variant: "critical" });
    });
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

const DictationButton: ChatBarButtonFactory = ({ isMainChat }) => {
    const forceUpdate = useForceUpdater();
    useEffect(() => {
        listeners.add(forceUpdate);
        return () => void listeners.delete(forceUpdate);
    }, []);

    if (!isMainChat) return null;

    return (
        <ChatBarButton tooltip={TOOLTIPS[phase] || progress} onClick={onClick} onContextMenu={openMicMenu}>
            <svg className={cl("icon", phase)} width="20" height="20" viewBox="0 0 24 24">
                <path fill="currentColor" d="M12 15a4 4 0 0 0 4-4V5a4 4 0 1 0-8 0v6a4 4 0 0 0 4 4Z" />
                <path fill="currentColor" d="M6 11a1 1 0 1 0-2 0 8 8 0 0 0 7 7.94V21H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.06A8 8 0 0 0 20 11a1 1 0 1 0-2 0 6 6 0 0 1-12 0Z" />
            </svg>
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "Dictation",
    description: "Talk instead of typing. A free speech model turns your voice into text on your PC, with commas and punctuation added for you.",
    authors: [{ name: "cordmuffin", id: 0n }],
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
        releaseRecording();
        setPhase("idle");
        Native.unload();
    },
});
