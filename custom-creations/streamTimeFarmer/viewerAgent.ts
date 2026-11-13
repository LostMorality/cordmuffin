/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The second account's half of the stream farm, as a script to run inside its window.
//
// That window runs Equicord's own web build, straight from Equicord's releases, so it is always the current one and
// nobody has to build anything. A released build has no idea this plugin exists, so the viewer's work can't come from
// a plugin there: it comes from here. native.ts injects this after the build has booted, and it puts the same small
// surface on window.Vencord.Plugins.plugins.StreamTimeFarmer that the host side reads, so both a released build and a
// build that really does contain the plugin behave the same.
//
// It has to stand on its own: everything it needs is inside the function, because only the function's own source is
// sent to the window.

function agent() {
    const KEY = "__streamTimeFarmerAgent";
    const V = (window as any).Vencord;
    if (!V?.Webpack || (window as any)[KEY]) return;
    // A build that ships the real plugin already does this work; two of them would fight over the call.
    if (V.Plugins?.plugins?.StreamTimeFarmer?.configureStreamFarm) return;

    const TICK_MS = 5_000;
    const JOIN_RETRY_MS = 15_000;
    const WATCH_RETRY_MS = 10_000;
    // Shorter than Discord's own kick for being alone in a call.
    const LEAVE_AFTER_MS = 2 * 60_000;
    const OFFLINE_TEXT = "Offline. Watching picks up again when the internet is back.";
    const STUCK_MS = 20_000;
    // An error Discord never clears still counts again after this long, so a reopen that didn't help is tried again.
    const ERROR_RECHECK_MS = 60_000;
    // Picture data arriving with not one frame decoded for this long means this window can't show the stream.
    const NO_PICTURE_MS = 30_000;
    // Joined, but the call's voice connection hasn't worked for this long: leave and join again.
    const VOICE_DEAD_MS = 30_000;
    // Each rejoin that didn't help doubles the wait, up to this; a gap between checks starts the clock over.
    const VOICE_DEAD_MAX_MS = 10 * 60_000;
    const VOICE_CHECK_GAP_MS = 15_000;
    // While the picture can't be shown, the stream is still reopened this often in case that's changed.
    const PICTURE_RETRY_MS = 5 * 60_000;
    // Reopens in a row for a missing picture before the user is told what to change.
    const PICTURE_REOPENS_LIMIT = 3;
    const CALL_IDLE_RELOAD_MS = 60 * 60_000;
    const CONNECT = 1n << 20n;
    const VIEW_CHANNEL = 1n << 10n;

    const { Webpack } = V;
    const C = Webpack.Common;
    const store = (name: string) => { try { return Webpack.findStore(name); } catch { return null; } };
    const byProps = (...props: string[]) => { try { return Webpack.findByProps(...props); } catch { return null; } };
    const byCode = (...code: string[]) => { try { return Webpack.findByCode(...code); } catch { return null; } };

    let config = { role: "off", partner: "", muteMic: true, deafenBoth: true };
    let status = { phase: "off", detail: "", countedMs: 0, sessionMs: 0 };
    let timer: any = null;
    let lastTick = Date.now();
    let lastJoin = 0;
    let lastWatch = 0;
    let stuckSince = 0;
    let partnerGoneSince = 0;
    let joinedCall = "";
    let mutedFor = "";
    let muted = false;
    let deafened = false;
    let lastMuteTry = 0;
    // Error id -> when it was acted on. Discord reuses one id per partner, so ids are dropped again once it clears.
    const handledErrors = new Map<string, number>();
    let decode = { since: 0, packets: 0, frames: 0, gpuLost: false, checking: false };
    let pictureReopens = 0;
    let lastPictureReopen = 0;
    let voiceDeadSince = 0;
    let voiceCheckedAt = 0;
    let voiceDeadHits = 0;

    const setStatus = (phase: string, detail: string) => {
        status = { phase, detail, countedMs: 0, sessionMs: status.sessionMs };
    };

    const snowflake = (id: string) => /^\d{17,20}$/.test(String(id ?? "").trim()) ? String(id).trim() : "";
    const partnerId = () => snowflake(config.partner);
    const partnerName = (fallback: string) => C.UserStore?.getUser?.(partnerId())?.username ?? fallback;

    const streamKey = (s: any) => s.guildId
        ? `${s.streamType}:${s.guildId}:${s.channelId}:${s.ownerId}`
        : `${s.streamType}:${s.channelId}:${s.ownerId}`;

    const isLive = (s: any, channelId: string) =>
        s != null && s.channelId === channelId && s.state !== "FAILED" && s.state !== "ENDED";

    const joinedHere = (channelId: string) => C.SelectedChannelStore?.getVoiceChannelId?.() === channelId;

    // Stream errors Discord raised for the partner's outgoing picture. Each is acted on once.
    function streamErrors(userId: string): string[] {
        try {
            const active = store("AVErrorStore")?.getActiveErrors?.();
            if (!(active instanceof Map)) return [];
            return [...active.entries()]
                .filter(([, e]: any) => e && e.mediaContext === "stream" && (e.userId == null || e.userId === userId)
                    && String(e.type ?? "").startsWith("video-stream-receiver-ready-timeout"))
                .map(([id]) => id as string);
        } catch {
            return [];
        }
    }
    function freshStreamError(userId: string) {
        const now = Date.now();
        const ids = streamErrors(userId);
        for (const id of [...handledErrors.keys()]) if (!ids.includes(id)) handledErrors.delete(id);
        return ids.some(id => !handledErrors.has(id) || now - handledErrors.get(id)! >= ERROR_RECHECK_MS);
    }
    const forgetStreamErrors = (userId: string) => streamErrors(userId).forEach(id => handledErrors.set(id, Date.now()));

    // The browser connection behind the stream being watched. This window is a web build, so it's a real RTCPeerConnection.
    function streamPeer(): RTCPeerConnection | null {
        try {
            const engine = store("MediaEngineStore")?.getMediaEngine?.();
            const conn: any = [...(engine?.connections ?? [])].find((c: any) => c?.context === "stream" && !c.destroyed);
            if (!conn) return null;
            for (const value of Object.values(conn)) {
                if (value instanceof RTCPeerConnection) return value;
                if (value && typeof value === "object")
                    for (const inner of Object.values(value as object)) if (inner instanceof RTCPeerConnection) return inner;
            }
        } catch { /* a build without the media engine just skips this check */ }
        return null;
    }

    // After a graphics driver update or crash, Discord's GPU process comes back in software mode and stays there until
    // Discord restarts. The stream's video can't be decoded then, however often it's reopened.
    function gpuLost() {
        try {
            const canvas = document.createElement("canvas");
            const gl: any = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
            if (!gl) return true;
            const info = gl.getExtension("WEBGL_debug_renderer_info");
            const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
            gl.getExtension("WEBGL_lose_context")?.loseContext();
            return /basic render|swiftshader|llvmpipe|software/i.test(name);
        } catch {
            return false;
        }
    }

    // With Hardware Acceleration off, or in a virtual machine, it's in software mode from the start and streams still
    // play, so that only counts as lost when it wasn't like that when this window opened.
    const softwareAtStart = gpuLost();

    // Samples the incoming video in the background (stats are async, the tick isn't) and notes since when picture data
    // has been arriving without a single frame coming out of the decoder.
    function sampleDecode(now: number) {
        if (decode.checking) return;
        const pc = streamPeer();
        if (!pc) {
            decode = { since: 0, packets: 0, frames: 0, gpuLost: false, checking: false };
            return;
        }
        decode.checking = true;
        pc.getStats().then(stats => {
            let packets = 0, frames = 0;
            stats.forEach((r: any) => {
                if (r.type === "inbound-rtp" && r.kind === "video") {
                    packets += r.packetsReceived ?? 0;
                    frames += r.framesDecoded ?? 0;
                }
            });
            if (frames > decode.frames) pictureReopens = 0;
            if (frames > decode.frames || packets <= decode.packets) {
                decode.since = 0;
                decode.gpuLost = false;
            } else decode.since ||= now;
            decode.packets = packets;
            decode.frames = frames;
        }).catch(() => { }).finally(() => { decode.checking = false; });
    }
    const noPicture = (now: number) => decode.since > 0 && now - decode.since >= NO_PICTURE_MS;

    // A call can stay selected while its voice connection is dead, and nothing works in it until it's left.
    function voiceDead(now: number) {
        if (now - voiceCheckedAt > VOICE_CHECK_GAP_MS) voiceDeadSince = 0;
        voiceCheckedAt = now;
        let state = "";
        try {
            state = store("RTCConnectionStore")?.getState?.() ?? "";
        } catch {
            return false;
        }
        if (!state || state === "RTC_CONNECTED") {
            voiceDeadSince = voiceDeadHits = 0;
            return false;
        }
        if (!navigator.onLine) {
            voiceDeadSince = 0;
            return false;
        }
        voiceDeadSince ||= now;
        if (now - voiceDeadSince < Math.min(VOICE_DEAD_MS * 2 ** voiceDeadHits, VOICE_DEAD_MAX_MS)) return false;
        voiceDeadSince = 0;
        voiceDeadHits++;
        byProps("selectVoiceChannel", "disconnect")?.disconnect();
        return true;
    }

    // Where the streaming account is sitting, if this account may follow it there.
    function partnerSpot(partner: string) {
        const channelId = store("VoiceStateStore")?.getVoiceStateForUser?.(partner)?.channelId;
        const channel = channelId ? C.ChannelStore?.getChannel?.(channelId) : null;
        if (!channel) return null;
        if (channel.type === 1) {
            return channel.recipients?.includes(partner)
                ? { id: channel.id, name: `the call with ${partnerName("the streaming account")}`, guildId: null, dm: true }
                : null;
        }
        if (channel.type !== 2) return null;
        try {
            if (!C.PermissionStore.can(VIEW_CHANNEL, channel) || !C.PermissionStore.can(CONNECT, channel)) return null;
        } catch { /* a build without the permission check still joins; Discord refuses it if it may not */ }
        return { id: channel.id, name: channel.name, guildId: channel.guild_id ?? null, dm: false };
    }

    function join(where: any, now: number) {
        setStatus("joining", `Joining ${where.name}...`);
        if (now - lastJoin < JOIN_RETRY_MS) return;
        lastJoin = now;
        joinedCall = where.id;
        voiceDeadSince = 0;
        byProps("selectVoiceChannel", "disconnect")?.selectVoiceChannel(where.id);
    }

    // Stays muted and deafened in the call: the two accounts usually sit on one PC, and a real call joined on top of
    // this one would feed sound back both ways. Discord clears both flags when a stream starts, so the state is
    // checked on every tick rather than set once and trusted.
    function keepMuted(channelId: string) {
        const media = store("MediaEngineStore");
        const mute = byProps("setSelfMute", "toggleSelfDeaf");
        if (!media || !mute) return;
        const needMute = config.muteMic && !media.isSelfMute();
        const needDeaf = config.deafenBoth && !media.isSelfDeaf();
        if (!needMute && !needDeaf) {
            mutedFor = channelId;
            return;
        }
        const now = Date.now();
        // Deafening is a toggle, so asking again before the first answer shows up would undo it.
        if (now - lastMuteTry < 5_000) return;
        lastMuteTry = now;
        if (needMute) {
            mute.setSelfMute("default", true);
            muted = true;
        }
        if (needDeaf) {
            mute.toggleSelfDeaf();
            deafened = true;
        }
    }

    function undo() {
        const media = store("MediaEngineStore");
        const mute = byProps("setSelfMute", "toggleSelfDeaf");
        try {
            if (deafened && media?.isSelfDeaf()) mute?.toggleSelfDeaf();
            if (muted && media?.isSelfMute()) mute?.setSelfMute("default", false);
        } catch { /* leaving it muted is harmless */ }
        muted = deafened = false;
    }

    function leaveIfAlone(now: number) {
        if (!joinedCall || !joinedHere(joinedCall)) return;
        partnerGoneSince ||= now;
        if (now - partnerGoneSince < LEAVE_AFTER_MS) return;
        byProps("selectVoiceChannel", "disconnect")?.disconnect();
        joinedCall = "";
        mutedFor = "";
        undo();
    }

    function viewerTick(now: number, elapsed: number) {
        // Offline, the partner only looks gone and the stream only looks stuck, so nothing is hung up or reopened.
        if (!navigator.onLine) {
            partnerGoneSince = stuckSince = 0;
            return setStatus("waiting", OFFLINE_TEXT);
        }
        const partner = partnerId();
        const me = C.UserStore?.getCurrentUser?.();
        if (!me) return setStatus("setup", "Still signing in.");
        if (!partner) return setStatus("setup", "Waiting for your main account to call this one.");
        if (partner === me.id) return setStatus("setup", "This is the same account as the one that streams. Log into your other account here.");
        const name = partnerName("the streaming account");
        const streaming = store("ApplicationStreamingStore");
        if (!streaming) return setStatus("setup", "This window can't see streams yet. Hanging up and calling again usually fixes this.");

        const where = partnerSpot(partner);
        const stream = where && streaming.getStreamForUser(partner, where.guildId);
        const live = where != null && isLive(stream, where.id);
        // DM calls are joined as soon as the other account calls; server channels only while it's streaming there.
        if (!where || (!where.dm && !live)) {
            leaveIfAlone(now);
            return setStatus("waiting", `Waiting for ${name} to call or go live somewhere this account can join.`);
        }
        partnerGoneSince = 0;
        if (!joinedHere(where.id)) return join(where, now);
        if (voiceDead(now)) return setStatus("joining", "The call's connection dropped. Joining it again...");
        keepMuted(where.id);

        if (!live || !stream) {
            stuckSince = 0;
            return setStatus("waiting", `In ${where.name}, waiting for ${name} to go live.`);
        }
        const active = streaming.getActiveStreamForApplicationStream(stream);
        const watching = active != null && streaming.getViewerIds(stream).includes(me.id);
        if (watching && active.state === "ACTIVE") sampleDecode(now);
        else decode.since = 0;
        // Reopening can't fix a Discord that lost its graphics card, or one in software mode that can't show the picture,
        // so say what will instead of looping. Checked here, in the same tick as the reopen below, or the reopen would
        // always win and loop. The reopen still runs now and then, so a wrong guess can't keep the stream closed for good.
        if (watching && noPicture(now) && now - lastPictureReopen < PICTURE_RETRY_MS) {
            if (!softwareAtStart && (decode.gpuLost ||= gpuLost()))
                return setStatus("setup", `Discord lost its graphics card (usually after a GPU driver update), so this account can't show ${name}'s stream. Fully quit Discord from the tray and open it again to fix it.`);
            if (softwareAtStart && pictureReopens >= PICTURE_REOPENS_LIMIT)
                return setStatus("setup", "This PC can't show the stream right now. Turn on Hardware Acceleration in Discord's Advanced settings, or quit Discord fully and open it again.");
        }
        // Open but broken: failed (Discord's error 2012), no picture arriving, or stalled. Close it and open it again.
        if (active) {
            if (active.state === "ACTIVE") stuckSince = 0;
            else stuckSince ||= now;
            const why = active.state === "FAILED" ? "failed"
                : freshStreamError(partner) ? "stopped sending a picture"
                    : noPicture(now) ? "isn't showing a picture"
                        : stuckSince && now - stuckSince >= STUCK_MS ? "got stuck" : "";
            if (why) {
                if (noPicture(now)) {
                    pictureReopens++;
                    lastPictureReopen = now;
                }
                stuckSince = 0;
                decode.since = 0;
                forgetStreamErrors(partner);
                byCode('type:"STREAM_CLOSE",streamKey')?.(streamKey(stream), false);
                lastWatch = now;
                return setStatus("joining", `${name}'s stream ${why}. Opening it again...`);
            }
        } else stuckSince = 0;

        if (!watching) {
            if (now - lastWatch >= WATCH_RETRY_MS) {
                lastWatch = now;
                byCode('type:"STREAM_WATCH",streamKey')?.(stream, { noFocus: true });
            }
            return setStatus("joining", `Opening ${name}'s stream...`);
        }
        if (active.state && active.state !== "ACTIVE") return setStatus("joining", `${name}'s stream is connecting...`);
        // Watching earns the streaming account's time, not this one's, so it only shows as this call's time.
        status.sessionMs += elapsed;
        setStatus("watching", `Watching ${name}'s stream in ${where.name}. Their time is counting.`);
    }

    function tick() {
        const now = Date.now();
        // A sleeping PC or a stalled tick shouldn't count as watched time.
        const elapsed = Math.max(0, Math.min(now - lastTick, 3 * TICK_MS));
        lastTick = now;
        try {
            if (store("IdleStore")?.getSystemSuspended?.()) return;
        } catch { /* no idle store on this build */ }
        try {
            if (config.role === "viewer") viewerTick(now, elapsed);
            else setStatus("off", "");
        } catch (e: any) {
            setStatus("setup", `Something went wrong (${e?.message ?? e}). Trying again.`);
        }
    }

    function start() {
        if (timer) return;
        lastTick = Date.now();
        timer = setInterval(tick, TICK_MS);
        tick();
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
        if (joinedCall && joinedHere(joinedCall)) byProps("selectVoiceChannel", "disconnect")?.disconnect();
        joinedCall = "";
        mutedFor = "";
        pictureReopens = lastPictureReopen = 0;
        undo();
        setStatus("off", "");
    }

    // ---- The privacy side, ported from tracking.ts ----
    // The host asks this account whether its Discord can report streams at all: Equicord's NoTrack, another blocking
    // plugin, or Discord's own two privacy settings. Without an answer the host's warning would say this account
    // can't be checked, and "Fix these for me" would have nothing to call here.
    const USAGE = "usage_statistics";
    const PERSONALIZE = "personalization";
    const CONSENT_URL = "/users/@me/consent";
    const CONSENTS_EVERY_MS = 60 * 60_000;
    const CONSENTS_RETRY_MS = 60_000;
    const BLOCKER = /(do[\s_-]*not|dont|no|anti|stop)[\s_-]*track|tracking|analytics|telemetry/i;

    const loadedAt = Date.now();
    const noTrackBlocks = () => V.Settings?.plugins?.NoTrack?.disableAnalytics !== false;
    // NoTrack swaps Discord's reporting out while the page loads, so turning it off only takes effect on a reload.
    const blockedAtStart = noTrackBlocks();
    let lastReportAt = 0;

    const pluginOn = (name: string) => {
        const setting = V.Settings?.plugins?.[name];
        if (setting && typeof setting.enabled === "boolean") return setting.enabled;
        return !!V.Plugins?.plugins?.[name]?.required;
    };
    const trackingBlockers = () => Object.keys(V.Plugins?.plugins ?? {})
        .filter(name => name !== "StreamTimeFarmer" && name !== "NoTrack" && BLOCKER.test(name) && pluginOn(name));

    let consentsLoad: Promise<void> | null = null;
    let consentsAt = 0;
    let consentsTriedAt = 0;
    function loadConsents(): Promise<void> {
        const now = Date.now();
        if (!C.UserStore?.getCurrentUser?.() || now - consentsAt < CONSENTS_EVERY_MS && consentsAt) return Promise.resolve();
        if (consentsLoad) return consentsLoad;
        if (now - consentsTriedAt < CONSENTS_RETRY_MS) return Promise.resolve();
        consentsTriedAt = now;
        // Discord only loads the privacy settings when its Data & Privacy page opens, so they're fetched the same way.
        consentsLoad = C.RestAPI.get({ url: CONSENT_URL })
            .then((res: any) => {
                if (!res?.body) throw new Error("No privacy settings in the answer");
                consentsAt = Date.now();
                C.FluxDispatcher.dispatch({ type: "UPDATE_CONSENTS", consents: { ...res.body } });
            })
            .catch(() => { })
            .finally(() => void (consentsLoad = null));
        return consentsLoad!;
    }

    function trackingState() {
        void loadConsents();
        let usageData: boolean | null = null, personalized: boolean | null = null;
        try {
            const { consents } = store("ConsentStore") ?? {};
            if (consents?.[USAGE]) usageData = consents[USAGE].consented === true;
            if (consents?.[PERSONALIZE]) personalized = consents[PERSONALIZE].consented === true;
        } catch { /* a build without the consent store answers "couldn't check" */ }
        return { blocked: noTrackBlocks(), blockedAtStart, usageData, personalized, blockers: trackingBlockers(), lastReportAt, loadedAt };
    }

    async function allowTracking() {
        if (V.Settings?.plugins?.NoTrack) V.Settings.plugins.NoTrack.disableAnalytics = false;
        await loadConsents();
        const { usageData, personalized } = trackingState();
        const grant = [...usageData === true ? [] : [USAGE], ...personalized === true ? [] : [PERSONALIZE]];
        if (grant.length) {
            const res = await C.RestAPI.post({ url: CONSENT_URL, body: { grant, revoke: [] } });
            if (res?.body) C.FluxDispatcher.dispatch({ type: "UPDATE_CONSENTS", consents: { ...res.body } });
        }
        return { restart: blockedAtStart };
    }

    // The settings can look right while something else stops the reports, so the requests themselves are watched: a
    // report only counts once Discord answered it with a 2xx. Watching sends one too (as the receiver), which is the
    // one the host looks for here.
    function watchReports() {
        const scienceUrl = /\/science\b/;
        const science = new WeakSet<XMLHttpRequest>();
        const { open, send } = XMLHttpRequest.prototype;
        const fetched = window.fetch;

        const isReport = (body: unknown) => {
            if (typeof body !== "string" || !body.includes("video_stream_ended")) return false;
            try {
                const partner = partnerId();
                return JSON.parse(body).events.some((e: any) => e?.type === "video_stream_ended"
                    && (e.properties?.participant_type === "streamer"
                        || e.properties?.participant_type === "receiver" && !!partner && e.properties?.sender_user_id === partner));
            } catch {
                return false;
            }
        };

        XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: any[]) {
            if (scienceUrl.test(String(url))) science.add(this);
            return (open as any).call(this, method, url, ...rest);
        } as typeof XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: any) {
            if (science.has(this) && isReport(body)) {
                this.addEventListener("load", () => {
                    if (this.status >= 200 && this.status < 300) lastReportAt = Date.now();
                });
            }
            return send.call(this, body);
        };
        // Reports still queued when the page is hidden or closing go out through fetch instead.
        window.fetch = function (this: unknown, input: any, init?: any) {
            const result = fetched.call(window, input, init);
            const url = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
            if (scienceUrl.test(String(url)) && isReport(init?.body)) result.then((res: any) => {
                if (res.ok) lastReportAt = Date.now();
            }, () => { });
            return result;
        } as typeof window.fetch;
    }

    try {
        watchReports();
    } catch { /* without it the host just can't say whether a report went out from here */ }

    const api = {
        started: true,
        isAgent: true,
        streamFarmStatus: () => status,
        trackingState,
        allowTracking,
        configureStreamFarm(next: any) {
            config = {
                role: next?.role ?? "off",
                partner: next?.partner ?? "",
                muteMic: next?.muteMic !== false,
                deafenBoth: next?.deafenBoth !== false
            };
            if (config.role === "viewer") start();
            else stop();
            return true;
        }
    };

    (window as any)[KEY] = api;
    try {
        V.Plugins ??= {};
        V.Plugins.plugins ??= {};
        V.Plugins.plugins.StreamTimeFarmer = api;
        V.Settings.plugins.StreamTimeFarmer ??= { enabled: true };
        V.Settings.plugins.StreamTimeFarmer.enabled = true;
    } catch { /* the host falls back to the window key */ }

    // Without DisableCallIdle, Discord drops this account from a DM call after a few minutes of nobody talking. It
    // patches Discord as the page loads, so turning it on only works after one reload. When that reload happened is
    // kept in the settings, so a setting that doesn't stick can't reload the page over and over.
    try {
        const all = V.Settings?.plugins;
        const mine = all?.StreamTimeFarmer;
        if (mine && V.Plugins?.plugins?.DisableCallIdle && !all.DisableCallIdle?.enabled) {
            all.DisableCallIdle ??= { enabled: false };
            all.DisableCallIdle.enabled = true;
            if (Math.abs(Date.now() - (Number(mine.callIdleReloadAt) || 0)) >= CALL_IDLE_RELOAD_MS) {
                mine.callIdleReloadAt = Date.now();
                setTimeout(() => location.reload(), 1_000);
            }
        }
    } catch { /* the call still works, it may just be dropped when idle */ }
}

// Only the function's own source reaches the window, so it must not close over anything in this module.
// Equicord boots asynchronously, so this keeps trying until its webpack is up, then stops.
export const VIEWER_AGENT = `(() => {
    const run = ${agent.toString()};
    let tries = 0;
    const attempt = () => {
        try { run(); } catch (e) { }
        if (window.__streamTimeFarmerAgent || ++tries > 120) return;
        setTimeout(attempt, 1000);
    };
    attempt();
})();`;
