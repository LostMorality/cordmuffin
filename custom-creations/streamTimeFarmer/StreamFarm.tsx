/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import { ChannelStore, Select, SelectedChannelStore, useEffect, useState, useStateFromStores } from "@webpack/common";

import { changeStreamProfile } from ".";
import { formatTime, SecondAccountCard, useStreamStatus } from "./CallWidget";
import { type StreamProfile, useProfile } from "./profile";
import { captureSources, resetStreamCount, streamFarmRunning } from "./stream";

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
        .then(list => setNames([...new Set(list.filter(s => s.id.startsWith("window:")).map(s => s.name))]))
        .catch(() => setNames([]));
    useEffect(() => void refresh(), []);

    const options = [{ label: "A random open window", value: "random" }, { label: "Entire screen", value: "screen" }, ...names.map(n => ({ label: n, value: n }))];
    if (streamSource && !options.some(o => o.value === streamSource)) options.push({ label: `${streamSource} (not open)`, value: streamSource });

    return (
        <div className={cl("stream-row")}>
            <div className={cl("stream-grow")}>
                <Select
                    options={options}
                    select={v => changeStreamProfile({ source: v })}
                    isSelected={v => v === (streamSource || "random")}
                    serialize={String}
                    maxVisibleItems={10}
                />
            </div>
            <Button size="small" variant="secondary" onClick={refresh}>Refresh</Button>
        </div>
    );
}

function StreamFarmPanel() {
    const status = useStreamStatus();
    const { role, channel: channelId, where, countedMs, hostSecond, source, secondPresence } = useProfile();
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
                The Streaming badge only counts time while someone else in the call watches your stream. Log your other
                account in below, then press Call: this account calls it, goes live with something random at the lowest
                quality, and the other account joins, watches, and stays muted and deafened. Hanging up (here, in the
                corner widget, or by leaving the call) ends it and closes the other account's window until the next call.
            </Paragraph>

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

                    <span className={cl("stream-label")}>What to stream (nobody sees it but your other account)</span>
                    <SourcePicker streamSource={source} />
                </>
            )}

            {(hostSecond || total > 0) && (
                <div className={cl("stream-time")}>Total counted for this account: {formatTime(total)}</div>
            )}
            {total > 0 && (
                <Button size="small" variant="dangerSecondary" onClick={resetStreamCount}>Reset total</Button>
            )}
        </div>
    );
}

export const StreamFarm = ErrorBoundary.wrap(StreamFarmPanel, { noop: true });
