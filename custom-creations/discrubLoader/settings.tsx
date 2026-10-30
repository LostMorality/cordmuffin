/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { OptionType, PluginNative } from "@utils/types";
import { useEffect, useState } from "@webpack/common";

import type { Status } from "./native";

export const Native = VencordNative.pluginHelpers.DiscrubLoader as PluginNative<typeof import("./native")>;

let current: Status | null = null;
const listeners = new Set<(s: Status) => void>();

export function setStatus(status: Status) {
    // IPC results are plain already, but copy anyway so nothing keeps a reference into settings.
    current = { ...status, bad: [...status.bad] };
    listeners.forEach(l => l(current!));
    return current;
}

export const getStatus = () => current;

// Filled in by index.tsx so the settings page can trigger the same actions as the top-bar button.
export const actions = {
    checkNow: async () => { },
    applyUpdate: async () => { },
};

function when(ms: number | null) {
    return ms ? new Date(ms).toLocaleString() : "never";
}

function StatusPanel() {
    const [status, set] = useState<Status | null>(current);
    const [working, setWorking] = useState(false);

    useEffect(() => {
        listeners.add(set);
        Native.getStatus().then(setStatus);
        return () => void listeners.delete(set);
    }, []);

    const run = (job: () => Promise<void>) => async () => {
        setWorking(true);
        try {
            await job();
        } finally {
            setWorking(false);
        }
    };

    if (!status) return null;
    return (
        <div>
            <dl className="vc-discrub-status">
                <dt>Installed</dt>
                <dd>{status.installed ? `v${status.installed}` : "not yet (press the broom at the top of Discord)"}</dd>
                <dt>Running in this window</dt>
                <dd>{status.loaded ? `v${status.loaded}` : "no"}</dd>
                <dt>Newest on the Chrome Web Store</dt>
                <dd>{status.latest ? `v${status.latest}` : "unknown"}</dd>
                <dt>Update waiting</dt>
                <dd>{status.staged ? `v${status.staged} (downloaded and checked)` : "none"}</dd>
                <dt>Last check</dt>
                <dd>{when(status.lastCheck)}</dd>
            </dl>
            {status.lastError && <div className="vc-discrub-error">{status.lastError}</div>}
            <div className="vc-discrub-buttons">
                <Button size="small" disabled={working} onClick={run(actions.checkNow)}>Check now</Button>
                {status.staged && (
                    <Button size="small" disabled={working} onClick={run(actions.applyUpdate)}>
                        Use v{status.staged} now
                    </Button>
                )}
            </div>
        </div>
    );
}

export const settings = definePluginSettings({
    startWith: {
        type: OptionType.SELECT,
        description: "Which Discrub opens from the top-bar button.",
        options: [
            { label: "Ask each time (Discrub's own start screen)", value: "ask", default: true },
            { label: "New Discrub", value: "web" },
            { label: "Discrub Classic (the old version, no longer updated)", value: "classic" },
        ],
    },
    updateMode: {
        type: OptionType.SELECT,
        description: "How new Discrub versions are handled. Every download must be signed by Discrub's developer and match the file list Discrub publishes on GitHub.",
        options: [
            { label: "Ask before updating", value: "ask", default: true },
            { label: "Always take the latest (downloads and checks it on its own)", value: "auto" },
            { label: "Stay on the installed version (only \"Check now\" looks for updates)", value: "pinned" },
        ],
    },
    status: {
        type: OptionType.COMPONENT,
        component: StatusPanel,
    },
});
