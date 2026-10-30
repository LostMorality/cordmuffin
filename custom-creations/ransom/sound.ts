/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Sounds come from the downloaded DOORS files. Without them, the few sounds that matter get a small Web Audio
// stand-in and the rest stay silent.

export type SoundName =
    | "sign" | "coin" | "jumpscare"
    | "spawn" | "popupMain" | "popupIn" | "popupOut" | "fail" | "layer1" | "layer2" | "layer3"
    | "riser" | "goldUp" | "paid" | "success" | "error" | "deathMusic" | "easterEggMusic" | "easterEggDeath";

let ctx: AudioContext | undefined;
const doors = new Map<SoundName, AudioBuffer>();
// Songs stay compressed until they play: decoded, a few minutes of music takes tens of MB.
const songs = new Map<SoundName, ArrayBuffer>();
// Set once the plugin stops, so a late timer can't open a fresh AudioContext that nothing closes.
// Stays closed until start() opens it, so nothing plays while Ransom is off.
let closed = true;
const playing = new Set<AudioScheduledSourceNode>();

function audio() {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
}

function track<T extends AudioScheduledSourceNode>(node: T) {
    playing.add(node);
    node.onended = () => playing.delete(node);
    return node;
}

const level = (volume: number) => Math.max(0, Math.min(1, volume / 100));

function output(ac: AudioContext, volume: number, to: AudioNode = ac.destination) {
    const gain = ac.createGain();
    gain.gain.value = level(volume);
    gain.connect(to);
    return gain;
}

function tone(ac: AudioContext, out: AudioNode, type: OscillatorType, from: number, to: number, start: number, length: number, peak: number) {
    const osc = track(ac.createOscillator());
    const env = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, start);
    osc.frequency.exponentialRampToValueAtTime(to, start + length);
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(peak, start + Math.min(0.03, length / 4));
    env.gain.exponentialRampToValueAtTime(0.0001, start + length);
    osc.connect(env).connect(out);
    osc.start(start);
    osc.stop(start + length + 0.05);
}

function hiss(ac: AudioContext, out: AudioNode, seconds: number, peak: number) {
    const buffer = ac.createBuffer(1, Math.ceil(ac.sampleRate * seconds), ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const source = track(ac.createBufferSource());
    source.buffer = buffer;
    const env = ac.createGain();
    const t = ac.currentTime;
    env.gain.setValueAtTime(peak, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    source.connect(env).connect(out);
    source.start(t);
}

const synth: Partial<Record<SoundName, (ac: AudioContext, out: AudioNode) => void>> = {
    sign(ac, out) {
        hiss(ac, out, 0.9, 0.25);
        tone(ac, out, "square", 110, 104, ac.currentTime, 0.9, 0.12);
    },
    coin(ac, out) {
        const t = ac.currentTime;
        tone(ac, out, "triangle", 1568, 1570, t, 0.08, 0.25);
        tone(ac, out, "triangle", 2093, 2095, t + 0.07, 0.22, 0.25);
    },
    jumpscare(ac, out) {
        const t = ac.currentTime;
        [880, 932, 1245].forEach((f, i) => tone(ac, out, "sawtooth", f, 110 + i * 20, t, 1.4, 0.3));
        hiss(ac, out, 1.2, 0.8);
    },
    fail(ac, out) {
        synth.jumpscare?.(ac, out);
    },
    paid(ac, out) {
        const t = ac.currentTime;
        [523, 659, 784, 1047].forEach((f, i) => tone(ac, out, "triangle", f, f, t + i * 0.09, 0.35, 0.22));
    }
};

export function play(name: SoundName, volume: number) {
    const buf = doors.get(name);
    if (closed || volume <= 0 || (!buf && !synth[name])) return;
    const ac = audio();
    const out = output(ac, volume);
    if (!buf) return synth[name]!(ac, out);
    const source = track(ac.createBufferSource());
    source.buffer = buf;
    source.connect(out);
    source.start();
}

export interface Music {
    /** 0 to 2: brings in the second and third layer of the DOORS track. */
    intensity(n: number): void;
    riser(): void;
    /** 0 to 1, how loud the low end is right now, for things that pulse to the beat. */
    bass(): number;
    /** True when a whole song is playing instead of the DOORS layers. */
    readonly song: boolean;
    /** Seconds into the song where the beat drops (0 when no song is playing). */
    readonly dropTime: number;
    /** Seconds per beat after the drop (0 when no song is playing or no steady beat was found). */
    readonly beat: number;
    stop(): void;
}

interface SongShape { drop: number; beat: number; }

const shapes = new WeakMap<AudioBuffer, SongShape>();

/**
 * Where a song's beat drops and how long one beat is. The drop is the 0.1 s step with the biggest jump in loudness
 * between the 2 s before it and the 2 s after it (looked for between 6 s in and 70% of the way through). The beat is
 * the strongest repeat, 0.3 to 0.8 s apart, in how hard the bass hits in the 30 s after the drop.
 */
function songShape(buf: AudioBuffer): SongShape {
    const cached = shapes.get(buf);
    if (cached) return cached;
    const data = buf.getChannelData(0);
    const rate = buf.sampleRate;

    const tenth = Math.round(rate / 10);
    const energy: number[] = [];
    for (let i = 0; i + tenth <= data.length; i += tenth) {
        let sum = 0;
        for (let j = i; j < i + tenth; j += 4) sum += data[j] * data[j];
        energy.push(Math.sqrt(sum / (tenth / 4)));
    }
    let best = 0;
    let bestJump = 0;
    for (let i = 60; i < Math.min(energy.length - 20, energy.length * 0.7); i++) {
        let before = 0;
        let after = 0;
        for (let k = 0; k < 20; k++) {
            before += energy[i - 20 + k];
            after += energy[i + k];
        }
        if (after - before > bestJump) {
            bestJump = after - before;
            best = i;
        }
    }
    const drop = best / 10;

    // Bass only (a soft low-pass at about 120 Hz), in 10 ms steps, and how much it rises from one step to the next.
    const hundredth = Math.round(rate / 100);
    const a = 1 - Math.exp(-2 * Math.PI * 120 / rate);
    const from = Math.floor(drop * rate);
    const to = Math.min(data.length, from + 30 * rate);
    const rise: number[] = [];
    let low = 0;
    let last = 0;
    for (let i = from; i + hundredth <= to; i += hundredth) {
        let sum = 0;
        for (let j = i; j < i + hundredth; j++) {
            low += a * (data[j] - low);
            sum += low * low;
        }
        const level = Math.sqrt(sum / hundredth);
        rise.push(Math.max(0, level - last));
        last = level;
    }
    let beat = 0;
    if (rise.length > 400) {
        const mean = rise.reduce((x, y) => x + y, 0) / rise.length;
        const centered = rise.map(v => v - mean);
        let bestScore = 0;
        for (let lag = 30; lag <= 80; lag++) {
            let score = 0;
            for (let i = 0; i + lag < centered.length; i++) score += centered[i] * centered[i + lag];
            if (score > bestScore) {
                bestScore = score;
                beat = lag / 100;
            }
        }
    }
    const shape = { drop, beat };
    shapes.set(buf, shape);
    return shape;
}

/** Plays `song` from start to end if it's loaded, otherwise the three DOORS layers. */
export function startMusic(volume: number, song?: SoundName): Music {
    if (closed) return { intensity() { }, riser() { }, bass: () => 0, song: false, dropTime: 0, beat: 0, stop() { } };
    const ac = audio();
    const analyser = ac.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.72;
    analyser.connect(ac.destination);
    const master = output(ac, volume, analyser);
    const sources: AudioBufferSourceNode[] = [];
    // One slot per layer, kept in step with layer1-3 even when one of them didn't download.
    const gains: (GainNode | undefined)[] = [];
    const at = ac.currentTime + 0.05;

    const loop = (buf: AudioBuffer, gain: number) => {
        const source = track(ac.createBufferSource());
        source.buffer = buf;
        source.loop = true;
        const g = ac.createGain();
        g.gain.value = gain;
        source.connect(g).connect(master);
        source.start(at);
        sources.push(source);
        return g;
    };

    const songBuffer = song && doors.get(song);
    const shape = songBuffer ? songShape(songBuffer) : undefined;
    if (songBuffer) loop(songBuffer, 1);
    else {
        const layers = (["layer1", "layer2", "layer3"] as const).map(n => doors.get(n));
        if (layers[0]) layers.forEach((buf, i) => gains[i] = buf && loop(buf, i === 0 ? 1 : 0));
    }

    const bins = new Uint8Array(analyser.frequencyBinCount);
    let shown = 0;
    return {
        intensity(n) {
            if (n <= shown) return;
            shown = n;
            const t = ac.currentTime;
            gains.forEach((g, i) => {
                if (!g || i === 0 || i > n) return;
                g.gain.cancelScheduledValues(t);
                g.gain.setValueAtTime(g.gain.value, t);
                g.gain.linearRampToValueAtTime(1, t + 1.5);
            });
        },
        song: !!songBuffer,
        dropTime: shape?.drop ?? 0,
        beat: shape?.beat ?? 0,
        riser() {
            const buf = doors.get("riser");
            if (!buf || songBuffer) return;
            const source = track(ac.createBufferSource());
            source.buffer = buf;
            source.connect(master);
            source.start();
            sources.push(source);
        },
        bass() {
            analyser.getByteFrequencyData(bins);
            let sum = 0;
            for (let i = 1; i < 6; i++) sum += bins[i];
            return sum / (5 * 255);
        },
        stop() {
            for (const s of sources) {
                try { s.stop(); } catch { }
                playing.delete(s);
            }
            master.disconnect();
            analyser.disconnect();
        }
    };
}

/**
 * Loops `name` (or `fallback` when `name` isn't loaded) from the start; `fade` lowers it to silence over that many
 * seconds, then stops it.
 */
export function playSong(name: SoundName, volume: number, fallback?: SoundName) {
    const bytes = songs.get(name) ?? (fallback && songs.get(fallback));
    if (closed || !bytes) return { fade() { }, stop() { } };
    const ac = audio();
    const master = output(ac, volume);
    let source: AudioBufferSourceNode | undefined;
    let stopped = false;
    void ac.decodeAudioData(bytes.slice(0)).then(buf => {
        if (stopped || ac !== ctx) return;
        source = track(ac.createBufferSource());
        source.buffer = buf;
        source.loop = true;
        source.connect(master);
        source.start();
    }).catch(() => { });
    const stop = () => {
        stopped = true;
        if (source) {
            try { source.stop(); } catch { }
            playing.delete(source);
        }
        master.disconnect();
    };
    return {
        fade(seconds: number) {
            const t = ac.currentTime;
            master.gain.cancelScheduledValues(t);
            master.gain.setValueAtTime(master.gain.value, t);
            master.gain.linearRampToValueAtTime(0, t + seconds);
            setTimeout(stop, seconds * 1000 + 50);
        },
        stop
    };
}

export function stopAll() {
    for (const node of playing) {
        try { node.stop(); } catch { }
    }
    playing.clear();
}

export async function decode(bytes: ArrayBuffer) {
    return audio().decodeAudioData(bytes.slice(0));
}

export function setDoorsSounds(sounds: Partial<Record<SoundName, AudioBuffer>>, songBytes: Partial<Record<SoundName, ArrayBuffer>> = {}) {
    doors.clear();
    for (const [name, buf] of Object.entries(sounds) as [SoundName, AudioBuffer][]) doors.set(name, buf);
    songs.clear();
    for (const [name, buf] of Object.entries(songBytes) as [SoundName, ArrayBuffer][]) songs.set(name, buf);
}

export function openAudio() {
    closed = false;
}

export function closeAudio() {
    closed = true;
    stopAll();
    void ctx?.close();
    ctx = undefined;
}
