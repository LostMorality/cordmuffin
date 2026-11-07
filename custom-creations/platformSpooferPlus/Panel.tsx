/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import { AuthenticationStore, SessionsStore, useStateFromStores } from "@webpack/common";

import { currentPlatform, reconnect, settings, useRefused } from ".";
import { platformLabel, PLATFORMS, SHOWS_LABEL } from "./platforms";

const cl = classNameFactory("vc-platform-spoofer-");

interface Row {
    id: string;
    client: string;
    os: string;
    mine: boolean;
}

function sameRows(a: Row[], b: Row[]) {
    return a.length === b.length && a.every((r, i) => r.id === b[i].id && r.client === b[i].client && r.os === b[i].os && r.mine === b[i].mine);
}

const KEYS: "platform"[] = ["platform"];

export function StatusPanel() {
    settings.use(KEYS);
    const refused = useRefused();
    const rows = useStateFromStores([SessionsStore, AuthenticationStore], () => {
        const mine = AuthenticationStore.getSessionId();
        return Object.values(SessionsStore.getSessions())
            .filter(s => s.sessionId !== "all")
            .map(s => ({ id: s.sessionId, client: s.clientInfo.client, os: s.clientInfo.os, mine: s.sessionId === mine }))
            .sort((a, b) => Number(b.mine) - Number(a.mine));
    }, [], sameRows);

    const picked = currentPlatform();
    const want = picked === "off" || refused ? null : PLATFORMS[picked].shows;
    const me = rows.find(r => r.mine);
    const ok = !want || me?.client === want;

    return (
        <div className={cl("panel")}>
            <Heading>What Discord sees right now</Heading>
            <Paragraph>
                Picked: <b>{platformLabel(picked)}</b>
                {refused && ". Discord refused it, so you're on your real platform until you pick again"}
                {me && <>. This session shows as <b className={cl(ok ? "ok" : "bad")}>{SHOWS_LABEL[me.client] ?? me.client}</b>.</>}
            </Paragraph>

            {rows.length > 0 && (
                <ul className={cl("sessions")}>
                    {rows.map(r => (
                        <li key={r.id}>
                            <span>{SHOWS_LABEL[r.client] ?? r.client}</span>
                            <span className={cl("os")}>{r.os}</span>
                            {r.mine && <span className={cl("tag")}>this one</span>}
                        </li>
                    ))}
                </ul>
            )}

            <Button
                size="small"
                variant="secondary"
                onClick={reconnect}
            >
                Reconnect now
            </Button>
        </div>
    );
}
