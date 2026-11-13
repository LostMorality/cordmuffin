/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { Heading } from "@components/Heading";
import { Notice } from "@components/Notice";
import { Paragraph } from "@components/Paragraph";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, TextInput, useEffect, useState } from "@webpack/common";

import { pluginActive } from "..";
import { currentUserId, profileFor } from "../profile";
import { snowflake } from "../stream";
import { trackingState } from "../tracking";
import { formatWait, hoursText, hoursWord, jobLoaded, jobRunning, MAX_HOURS, MIN_HOURS, notify, pluginRunning, splitSends, startJob, useJob } from "./job";
import { cl } from "./JobBox";
import { MAX_CLAIM_S } from "./raiser";
import { finishAt, firstSlot, streamsFarmWindow } from "./scheduler";

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const hours = (s: number) => `${hoursText(s)} h`;

// Digits and one decimal place (the sends are split in 0.1 h steps), capped at the maximum.
function decimal(value: string) {
    let v = value.replace(/[^\d.]/g, "");
    const dot = v.indexOf(".");
    if (dot >= 0) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, "").slice(0, 1);
    v = v.replace(/^0+(?=\d)/, "");
    return Number(v) > MAX_HOURS ? String(MAX_HOURS) : v;
}

function list(names: string[]) {
    return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// Why a job can't start right now, or null when it can.
export function startProblem(): string | null {
    if (!pluginRunning()) return "Turn on StreamTimeFarmer first.";
    if (jobRunning()) return "Streaming time is already being added. Wait for it to finish, or stop it from the box in the corner.";
    if (!IS_DISCORD_DESKTOP) return "This only works in the Discord desktop app.";
    if (!jobLoaded()) return "Still loading, try again in a moment.";
    if (!pluginActive()) return "Turn on StreamTimeFarmer first.";
    const me = currentUserId();
    if (!me) return "Not logged in yet.";
    const p = profileFor(me);
    if (p.where === "server" ? !snowflake(p.channel) : !snowflake(p.partner) || p.partner.trim() === me)
        return "Set up your other account in StreamTimeFarmer first, so it can watch the stream.";
    if (!streamsFarmWindow(me)) return "StreamTimeFarmer is set to stream your screen or another window. Set its source to the farm window first.";
    const t = trackingState();
    if (t.blocked || t.blockedAtStart) return "Discord's tracking is blocked, so no stream reports go out. Allow it in StreamTimeFarmer's settings (and restart Discord if it says so).";
    if (t.usageData === false || t.personalized === false) return "Discord's usage data settings are off for this account. Turn them on in StreamTimeFarmer's settings.";
    if (t.blockers.length) return `${list(t.blockers)} may block stream reports. Turn ${t.blockers.length > 1 ? "them" : "it"} off first.`;
    return null;
}

export function summaryText(totalS: number, now = Date.now()) {
    const { count, full, rest } = splitSends(totalS);
    const parts = count < 2 ? "" : ` (${full ? `${full} x ${hours(MAX_CLAIM_S)}` : ""}${full && rest ? " + " : ""}${rest ? hours(rest) : ""})`;
    const takes = formatWait(Math.max(0, finishAt(firstSlot(now), count) - now));
    return `${hoursWord(totalS)} = ${plural(count, "send")}${parts}${count > 1 ? ", one each hour" : ""}. Takes ${takes}.`
        + " Keep Discord open; Stop keeps what's already sent.";
}

function AddStreamTime({ modalProps }: { modalProps: RenderModalProps; }) {
    const [value, setValue] = useState("12");
    const [, rerender] = useState(0);
    useJob();
    useEffect(() => {
        const id = setInterval(() => rerender(n => n + 1), 5000);
        return () => clearInterval(id);
    }, []);

    const totalS = Math.round((Number(value) || 0) * 10) * 360;
    const problem = startProblem() ?? (totalS < MIN_HOURS * 3600 ? `Enter at least ${MIN_HOURS} hour.` : null);

    function send() {
        if (problem || !startJob(totalS)) return;
        notify("Adding streaming time in the background.");
        modalProps.onClose();
    }

    return (
        <Modal
            {...modalProps}
            size="sm"
            title="Add Streaming Time"
            subtitle="Sends your stream time in reports of up to 12 hours, one each hour, while StreamTimeFarmer streams."
            actions={[
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
                { text: "Add Time", variant: "primary", onClick: send, disabled: !!problem }
            ]}
        >
            <Notice.Warning className={cl("notice")}>
                The badge doesn't change right away. Each send shows up on it about 1.5 to 3 hours after it goes out.
            </Notice.Warning>
            <div className={cl("hours")}>
                <Heading tag="h5">Hours</Heading>
                <TextInput value={value} onChange={v => setValue(decimal(v))} placeholder="12" />
            </div>
            <Paragraph>{problem ?? summaryText(totalS)}</Paragraph>
        </Modal>
    );
}

export function openAddStreamTime() {
    openModal(props => (
        <ErrorBoundary>
            <AddStreamTime modalProps={props} />
        </ErrorBoundary>
    ));
}
