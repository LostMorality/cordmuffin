/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import type { RenderModalProps } from "@vencord/discord-types";
import { ChannelStore, GuildStore, Modal, openModal, SelectedChannelStore, SelectedGuildStore, useEffect, UserStore, useState } from "@webpack/common";

import { isWrecked, openRevive } from "./aftermath";
import { blockedReason, getStats, isRunning, jumpscare, onStatsChange, resetStats, showSign, type Stats } from "./challenge";
import { clearFound, type FoundItem, getFound, hideHere, itemInfo, ITEMS, onFoundChange } from "./hunt";
import { image, onImagesChange } from "./images";
import { notify } from "./notify";
import { settings } from "./settings";
import { play } from "./sound";

const cl = classNameFactory("vc-ransom-");

export function StopIcon({ width = 24, height = 24, className }: { width?: number; height?: number; className?: string; }) {
    return (
        <svg width={width} height={height} viewBox="0 0 24 24" className={className} fill="currentColor">
            <path fillRule="evenodd" d="M8.1 2h7.8L22 8.1v7.8L15.9 22H8.1L2 15.9V8.1L8.1 2Zm-1.6 8.5v3h11v-3h-11Z" />
        </svg>
    );
}

/** Your gold total in Discord's top bar, next to the Ransom button. Opens the Ransom window when clicked. */
export function TopGold() {
    const [gold, setGold] = useState<number | null>(null);
    const [up, setUp] = useState(0);
    const [, setImages] = useState(0);
    useEffect(() => onImagesChange(() => setImages(n => n + 1)), []);
    useEffect(() => {
        let alive = true;
        void getStats().then(s => alive && setGold(s.goldFound));
        const off = onStatsChange(s => {
            setGold(old => {
                if (old !== null && s.goldFound > old) setUp(n => n + 1);
                return s.goldFound;
            });
        });
        return () => {
            alive = false;
            off();
        };
    }, []);
    if (gold === null) return null;
    return (
        <div key={up} className={cl("topgold", up ? "topgold-up" : "")} title={isWrecked() ? "Revive Discord" : "Your gold"} role="button" tabIndex={0} onClick={() => openRevive() || openPanel()}>
            <img src={image("coin")} alt="" />
            {gold.toLocaleString()}
        </div>
    );
}

function placeName(f: FoundItem) {
    const channel = ChannelStore.getChannel(f.channelId);
    if (f.guildId) {
        const guild = GuildStore.getGuild(f.guildId);
        return { group: guild?.name ?? "A server you left", place: channel?.name ? `#${channel.name}` : "a channel" };
    }
    if (!channel) return { group: "DMs", place: "a closed DM" };
    if (channel.name) return { group: "DMs", place: channel.name };
    const user = UserStore.getUser(channel.recipients?.[0]);
    return { group: "DMs", place: user ? (user.globalName ?? user.username) : "a DM" };
}

function FoundTab() {
    const [found, setFound] = useState<FoundItem[]>();
    useEffect(() => {
        const load = () => void getFound().then(setFound);
        load();
        return onFoundChange(load);
    }, []);
    if (!found) return null;
    if (!found.length) return <Paragraph>Nothing found yet. Open DMs and server channels and keep an eye out for small spooky things. {settings.store.hunt ? "" : "Hidden items are turned off in the settings."}</Paragraph>;

    const counts = new Map<string, number>();
    found.forEach(f => counts.set(f.item, (counts.get(f.item) ?? 0) + 1));
    const groups = new Map<string, Map<string, FoundItem[]>>();
    const dms = found.filter(f => !f.guildId);
    const servers = found.filter(f => f.guildId);
    for (const f of [...dms, ...servers]) {
        const { group, place } = placeName(f);
        const key = f.guildId ? `server:${group}` : "dm:DMs";
        if (!groups.has(key)) groups.set(key, new Map());
        const places = groups.get(key);
        places?.set(place, [...(places.get(place) ?? []), f]);
    }

    return (
        <div className={cl("found")}>
            <div className={cl("tally")}>
                {ITEMS.map(item => (
                    <div key={item.id} className={cl("tally-item")} title={item.name}>
                        <span className={cl("tally-emoji")}>{counts.has(item.id) ? item.emoji : "❔"}</span>
                        <span>{counts.get(item.id) ?? 0}</span>
                    </div>
                ))}
            </div>
            <div className={cl("section-title")}>DMs ({dms.length})</div>
            {!dms.length && <Paragraph>None found in DMs yet.</Paragraph>}
            {[...groups].filter(([k]) => k.startsWith("dm:")).map(([key, places]) => <Group key={key} places={places} />)}
            <div className={cl("section-title")}>Servers ({servers.length})</div>
            {!servers.length && <Paragraph>None found in servers yet.</Paragraph>}
            {[...groups].filter(([k]) => k.startsWith("server:")).map(([key, places]) => (
                <div key={key} className={cl("server")}>
                    <div className={cl("server-name")}>{key.slice(7)}</div>
                    <Group places={places} />
                </div>
            ))}
            <Button size="small" variant="dangerSecondary" onClick={() => void clearFound()}>Forget everything found</Button>
        </div>
    );
}

function Group({ places }: { places: Map<string, FoundItem[]>; }) {
    return (
        <div className={cl("places")}>
            {[...places].map(([place, items]) => (
                <div key={place} className={cl("place")}>
                    <span className={cl("place-name")}>{place}</span>
                    <span>{items.map(i => itemInfo(i.item).emoji).join(" ")}</span>
                </div>
            ))}
        </div>
    );
}

function ScoresTab() {
    const [stats, setStats] = useState<Stats>();
    useEffect(() => void getStats().then(setStats), []);
    if (!stats) return null;
    const rows: [string, string | number][] = [
        ["Times Ransom showed up", stats.signs],
        ["Times you held still", stats.stayedStill],
        ["Times you got caught", stats.hunts],
        ["Ransoms paid", stats.won],
        ["Ran out of time", stats.lost],
        ["Gold paid", stats.goldPaid],
        ["Gold you have", stats.goldFound],
        ["Revives", stats.revives],
        ["Deaths to Ransom", stats.deaths],
        ["Honey Pots broken", stats.honeyPots],
        ["Fastest payment", stats.bestSeconds ? `${stats.bestSeconds} seconds` : "none yet"]
    ];
    return (
        <div className={cl("scores")}>
            {rows.map(([label, value]) => (
                <div key={label} className={cl("score")}>
                    <span>{label}</span>
                    <b>{value}</b>
                </div>
            ))}
            <Button size="small" variant="secondary" onClick={() => void resetStats().then(() => getStats().then(setStats))}>Reset scores</Button>
        </div>
    );
}

const TABS = ["Found", "Scores"] as const;

function RansomPanel({ modalProps }: { modalProps: RenderModalProps; }) {
    const [tab, setTab] = useState<typeof TABS[number]>("Found");
    return (
        <Modal {...modalProps} size="md" title="Ransom" subtitle="Your finds and scores">
            <div className={cl("tabs")}>
                {TABS.map(t => <Button key={t} size="small" variant={t === tab ? "primary" : "secondary"} onClick={() => setTab(t)}>{t}</Button>)}
            </div>
            {tab === "Found" && <FoundTab />}
            {tab === "Scores" && <ScoresTab />}
        </Modal>
    );
}

export function openPanel() {
    openModal(props => (
        <ErrorBoundary>
            <RansomPanel modalProps={props} />
        </ErrorBoundary>
    ));
}

export function tryChallenge() {
    const reason = blockedReason();
    if (reason && reason !== "A window is open.") return notify(`No challenge right now: ${reason}`, "critical");
    // A short, silent pause so the click that started it doesn't count as moving.
    setTimeout(() => {
        const late = blockedReason();
        if (late && late !== "A window is open.") return;
        showSign();
    }, 1500);
}

export function SettingsButtons() {
    return (
        <div className={cl("buttons")}>
            <Button size="small" onClick={openPanel}>Open finds and scores</Button>
            <Button size="small" variant="secondary" onClick={tryChallenge}>Try a challenge</Button>
            <Button size="small" variant="secondary" onClick={() => isRunning() ? notify("Ransom is already here.", "critical") : jumpscare(true)}>Test the jumpscare</Button>
            <Button size="small" variant="secondary" onClick={() => play("coin", settings.store.soundVolume)}>Test sound volume</Button>
            <Button size="small" variant="secondary" onClick={() => {
                const channelId = SelectedChannelStore.getChannelId();
                if (!channelId) return notify("Open a DM or channel first.", "critical");
                const guildId = SelectedGuildStore.getGuildId() ?? undefined;
                if (!settings.store.hunt || (guildId ? !settings.store.huntServers : !settings.store.huntDMs)) return notify("Item hunting is off for this kind of chat. Turn it on in the settings first.", "critical");
                void hideHere(channelId, guildId);
                notify("Hid an item in the chat you have open.", "success");
            }}>Hide an item in this chat</Button>
        </div>
    );
}
