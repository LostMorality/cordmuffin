/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button, type ButtonProps } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { OptionType, PluginNative } from "@utils/types";
import { useEffect, useState } from "@webpack/common";

import type { Status } from "./native";

// Undefined on Discord on the web, where there's no native side.
export const Native = VencordNative.pluginHelpers.DiscrubLoader as PluginNative<typeof import("./native")> | undefined;

let current: Status | null = null;
let running = false;
const listeners = new Set<(s: Status) => void>();

export function setStatus(status: Status) {
    // IPC results are plain already, but copy anyway so nothing keeps a reference into settings.
    current = { ...status, bad: [...status.bad] };
    listeners.forEach(l => l(current!));
    return current;
}

export const getStatus = () => current;

// Equicord shows a plugin's settings while it's off; the buttons only work while it's on.
export const isRunning = () => running;
export function setRunning(value: boolean) {
    running = value;
    if (current) setStatus(current);
}

// Filled in by index.tsx so the settings page can trigger the same actions as the top-bar button.
export const actions = {
    checkNow: async () => { },
    applyUpdate: async () => { },
};

// A disabled primary button only fades a little, so while the plugin is off it turns grey instead.
// The wrapper carries the cursor and hint, since a disabled button gets no pointer events.
export function PluginButton({ off, disabled, variant, ...props }: ButtonProps & { off: boolean; }) {
    const button = <Button {...props} variant={off ? "secondary" : variant} disabled={off || disabled} />;
    return off ? <span className="vc-discrub-btn-off" title="Turn the plugin on first.">{button}</span> : button;
}

function when(ms: number | null) {
    return ms ? new Date(ms).toLocaleString() : "never";
}

function StatusPanel() {
    const [status, set] = useState<Status | null>(current);
    const [working, setWorking] = useState(false);

    useEffect(() => {
        listeners.add(set);
        Native?.getStatus().then(setStatus).catch(() => { });
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
    const off = !running;
    return (
        <div className="vc-discrub-panel">
            <dl className="vc-discrub-status">
                <dt>Installed</dt>
                <dd>{status.installed ? `v${status.installed}` : "not yet (press the broom at the top of Discord)"}</dd>
                <dt>Running here</dt>
                <dd>{status.loaded ? `v${status.loaded}` : "no"}</dd>
                <dt>Newest in the store</dt>
                <dd>{status.latest ? `v${status.latest}` : "unknown"}</dd>
                <dt>Update waiting</dt>
                <dd>{status.staged ? `v${status.staged} (downloaded and checked)` : "none"}</dd>
                <dt>Last check</dt>
                <dd>{when(status.lastCheck)}</dd>
            </dl>
            {status.notice && <div className="vc-discrub-error">{status.notice}</div>}
            {status.lastError && <div className="vc-discrub-error">{status.lastError}</div>}
            {off && <Paragraph className="vc-discrub-off">Turn the plugin on to use these buttons.</Paragraph>}
            <div className="vc-discrub-buttons">
                <PluginButton size="small" off={off} disabled={working} onClick={run(actions.checkNow)}>Check now</PluginButton>
                {status.staged && (
                    <PluginButton size="small" off={off} disabled={working} onClick={run(actions.applyUpdate)}>
                        Use v{status.staged} now
                    </PluginButton>
                )}
            </div>
        </div>
    );
}

export const settings = definePluginSettings({
    startWith: {
        type: OptionType.SELECT,
        description: "Which Discrub the broom opens. \"Ask each time\" shows Discrub's own start screen with no countdown. Classic is the old version and no longer gets updates.",
        options: [
            { label: "Ask each time", value: "ask", default: true },
            { label: "New Discrub", value: "web" },
            { label: "Discrub Classic", value: "classic" },
        ],
    },
    updateMode: {
        type: OptionType.SELECT,
        description: "Ask: offers each new version once (\"Check now\" offers it again). Automatic: downloads and checks it on its own. Stay: no background checks at all, only \"Check now\". Every download must be signed by Discrub's developer and match the file list Discrub publishes on GitHub.",
        options: [
            { label: "Ask before updating", value: "ask", default: true },
            { label: "Update automatically", value: "auto" },
            { label: "Stay on this version", value: "pinned" },
        ],
    },
    status: {
        type: OptionType.COMPONENT,
        component: StatusPanel,
    },
});
