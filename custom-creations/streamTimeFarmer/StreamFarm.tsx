/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Settings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import { Alerts, ChannelStore, RestAPI, Select, SelectedChannelStore, TextInput, useEffect, useMemo, useState, useStateFromStores } from "@webpack/common";

import { changeStreamProfile } from ".";
import { formatTime, SecondAccountCard, useStreamStatus } from "./CallWidget";
import { FARM_SOURCE, type FarmGame, type StreamProfile, useProfile } from "./profile";
import { canUseFarmWindow, captureSources, gameSlotTaken, isFarmWindow, resetStreamCount, streamFarmRunning } from "./stream";
import { ReportStatus, TrackingWarning } from "./TrackingWarning";

const cl = classNameFactory("vc-stf-");

function Choice({ label, options, value, onChange }: { label: string; options: { label: string; value: string; }[]; value: string; onChange(v: string): void; }) {
    return (
        <div className={cl("stream-row")}>
            <span className={cl("stream-label")}>{label}</span>
            <div className={cl("stream-grow")}>
                <Select options={options} select={onChange} isSelected={v => v === value} serialize={String} />
            </div>
        </div>
    );
}

function SourcePicker({ streamSource }: { streamSource: string; }) {
    const [names, setNames] = useState<string[]>([]);

    const refresh = () => captureSources()
        .then(list => setNames([...new Set(list.filter(s => s.id.startsWith("window:") && !isFarmWindow(s)).map(s => s.name))]))
        .catch(() => setNames([]));
    useEffect(() => void refresh(), []);

    const options = [{ label: canUseFarmWindow() ? "Its own window (recommended)" : "A random open window", value: FARM_SOURCE }, { label: "Entire screen", value: "screen" }, ...names.map(n => ({ label: n, value: n }))];
    // "random" was the old default and is shown as the farm window, so it isn't listed as a window of its own.
    if (streamSource && streamSource !== "random" && !options.some(o => o.value === streamSource)) options.push({ label: `${streamSource} (not open)`, value: streamSource });

    return (
        <div className={cl("stream-row")}>
            <div className={cl("stream-grow")}>
                <Select
                    options={options}
                    select={v => changeStreamProfile({ source: v })}
                    isSelected={v => v === (!streamSource || streamSource === "random" ? FARM_SOURCE : streamSource)}
                    serialize={String}
                    maxVisibleItems={10}
                />
            </div>
            <Button size="small" variant="secondary" onClick={refresh}>Refresh</Button>
        </div>
    );
}

interface DetectableApp { id: string; name: string; executables?: { os: string; name: string; is_launcher?: boolean; }[]; cover_image_hash?: string | null; icon_hash?: string | null; }

let detectable: Promise<DetectableApp[]> | null = null;
function loadDetectable() {
    detectable ??= RestAPI.get({ url: "/applications/detectable" }).then(res => (res.body as DetectableApp[]).filter(a => a?.id && a.name && a.executables?.some(e => e.os === "win32")));
    detectable.catch(() => detectable = null);
    return detectable;
}

function toFarmGame(app: DetectableApp): FarmGame {
    const exe = app.executables!.find(e => e.os === "win32" && !e.is_launcher) ?? app.executables!.find(e => e.os === "win32")!;
    const hash = app.cover_image_hash || app.icon_hash;
    return {
        id: app.id,
        name: app.name,
        exeName: exe.name.replace(/^>/, "").replace(/^.*[\\/]/, "") || `${app.name.replace(/[^\w]/g, "")}.exe`,
        cover: hash ? `https://cdn.discordapp.com/app-icons/${app.id}/${hash}.png?size=512` : ""
    };
}

// Game mode: the farm window takes a game's name and cover, and Discord shows the stream as that game.
function GamePicker({ game }: { game: FarmGame | null; }) {
    const [apps, setApps] = useState<DetectableApp[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const [query, setQuery] = useState("");
    const search = query.trim().toLowerCase();

    useEffect(() => {
        if (search.length < 2 || apps) return;
        let gone = false;
        setFailed(false);
        loadDetectable().then(list => !gone && setApps(list), () => !gone && setFailed(true));
        return () => void (gone = true);
    }, [search.length >= 2, attempt]);

    const matches = useMemo(() => {
        if (!apps || search.length < 2) return [];
        // Exact names first, then the shortest names starting with the search, so the best-known game isn't cut off.
        const starts = apps.filter(a => a.name.toLowerCase().startsWith(search))
            .sort((a, b) => Number(b.name.toLowerCase() === search) - Number(a.name.toLowerCase() === search) || a.name.length - b.name.length);
        const rest = apps.filter(a => !a.name.toLowerCase().startsWith(search) && a.name.toLowerCase().includes(search));
        return [...starts, ...rest].slice(0, 8);
    }, [apps, search]);

    const pick = (next: FarmGame | null) => {
        setQuery("");
        changeStreamProfile({ farmGame: next });
    };

    return (
        <>
            <span className={cl("stream-label")}>Show it as a game (optional)</span>
            <div className={cl("stream-row")}>
                <span className={cl("stream-grow")}>{game ? `Streaming ${game.name}` : "Not a game: it streams as itself."}</span>
                {game && <Button size="small" variant="secondary" onClick={() => pick(null)}>Stop showing as a game</Button>}
            </div>
            {game && gameSlotTaken() && (
                <div className={cl("stream-note")}>gameSessionSpoofer is showing a game right now, so the farm window streams as itself until that ends.</div>
            )}
            <div className={cl("stream-row")}>
                <div className={cl("stream-grow")}>
                    <TextInput value={query} onChange={setQuery} placeholder="Search for a game" />
                </div>
            </div>
            {search.length >= 2 && (
                <div className={cl("stream-games")}>
                    {failed ? <>Couldn't load Discord's game list. <Button size="small" variant="secondary" onClick={() => setAttempt(n => n + 1)}>Try again</Button></>
                        : !apps ? "Loading games..."
                            : !matches.length ? "No game with that name."
                                : matches.map(app => (
                                    <button key={app.id} className={cl("stream-game")} onClick={() => pick(toFarmGame(app))}>{app.name}</button>
                                ))}
                </div>
            )}
        </>
    );
}

function StreamFarmPanel() {
    const status = useStreamStatus();
    const { role, channel: channelId, where, countedMs, hostSecond, source, secondPresence, farmGame } = useProfile();
    const farmWindow = canUseFarmWindow() && (!source || source === FARM_SOURCE || source === "random");
    const channel = useStateFromStores([ChannelStore], () => channelId.trim() ? ChannelStore.getChannel(channelId.trim()) : null, [channelId]);
    // Only a server voice channel can be the meeting place; not a DM call, and not a stage (its audience can't go live).
    const serverVoiceId = useStateFromStores([SelectedChannelStore, ChannelStore], () => {
        const id = SelectedChannelStore.getVoiceChannelId();
        const type = id ? ChannelStore.getChannel(id)?.type : undefined;
        return type === 2 ? id : null;
    });
    const running = streamFarmRunning();
    const total = running ? status.countedMs : countedMs;

    const useCurrent = () => {
        if (serverVoiceId) changeStreamProfile({ channel: serverVoiceId });
    };

    // This account is the second account of another Discord: that Discord runs everything.
    if (role === "viewer") {
        return (
            <div className={cl("stream")}>
                <div className={cl("stream-status", `stream-${status.phase}`)}>
                    <div>This account is the second account of another Discord's stream farm. {status.detail}</div>
                </div>
            </div>
        );
    }

    return (
        <div className={cl("stream")}>
            <Paragraph>
                The Streaming badge only counts time with someone else in the call watching the stream. Log your other
                account in below, then press Call: this account calls it, goes live at the lowest quality with its own small
                window (see-through, behind everything and with no taskbar button, so you never notice it), and the other account joins,
                watches, and stays muted and deafened. If the stream breaks, it's reopened by itself. Hanging up (here, in the
                corner widget, or by leaving the call) ends it and closes the other account's window until the next call.
            </Paragraph>

            <TrackingWarning />

            {!Settings.plugins.DisableCallIdle?.enabled && (
                <Paragraph>Turn on the DisableCallIdle plugin, or Discord can end the call after 3 minutes alone or after a long idle.</Paragraph>
            )}

            <SecondAccountCard />

            {hostSecond && (
                <>
                    <Choice
                        label="Meet in"
                        value={where}
                        onChange={v => changeStreamProfile({ where: v as StreamProfile["where"] })}
                        options={[
                            { label: "A DM call", value: "dm" },
                            { label: "A server voice channel", value: "server" }
                        ]}
                    />

                    <Choice
                        label="Second account's online status"
                        value={secondPresence}
                        onChange={v => changeStreamProfile({ secondPresence: v as StreamProfile["secondPresence"] })}
                        options={[
                            { label: "Leave it as it is", value: "" },
                            { label: "Online", value: "online" },
                            { label: "Idle", value: "idle" },
                            { label: "Do Not Disturb", value: "dnd" },
                            { label: "Invisible", value: "invisible" }
                        ]}
                    />

                    {where === "server" && <div className={cl("stream-row")}>
                        <span className={cl("stream-label")}>Voice channel</span>
                        <span className={cl("stream-grow")}>{channel ? channel.type === 2 ? `#${channel.name}` : "Not a server voice channel" : channelId ? "Not found" : "None picked"}</span>
                        <Button size="small" variant="secondary" onClick={useCurrent} disabled={!serverVoiceId}>
                            Use the one I'm in
                        </Button>
                    </div>}
                    {where === "server" && <Paragraph>Each report restart may notify members of a small server. A DM call avoids that.</Paragraph>}

                    <span className={cl("stream-label")}>What to stream (nobody sees it but your other account)</span>
                    <SourcePicker streamSource={source} />
                    {farmWindow && <GamePicker game={farmGame} />}
                </>
            )}

            {(hostSecond || total > 0) && (
                <div className={cl("stream-time")}>Time streamed while watched (not Discord's count): {formatTime(total)}</div>
            )}
            {hostSecond && <ReportStatus />}
            {total > 0 && (
                <Button
                    size="small"
                    variant="dangerSecondary"
                    onClick={() => Alerts.show({
                        title: "Reset this total?",
                        body: "This only clears the plugin's own number. Discord's count doesn't change.",
                        confirmText: "Reset",
                        cancelText: "Cancel",
                        onConfirm: resetStreamCount
                    })}
                >
                    Reset total
                </Button>
            )}
        </div>
    );
}

export const StreamFarm = ErrorBoundary.wrap(StreamFarmPanel, { noop: true });
