/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { plugins } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { useState } from "@webpack/common";
import type { ComponentType } from "react";

import { buildExport, FIELDS, loadPresets, parseImport, savePresets, toCode } from "./share";
import { openExport, openImport, SharePanel } from "./ShareUI";

const logger = new Logger("CustomRPCShare");

type SettingComponent = ComponentType<any> & { __rpcShare?: true; };

let original: SettingComponent | null = null;

function customRpcConfigDef() {
    const def = plugins.CustomRPC?.settings?.def?.config as { type?: OptionType; component?: SettingComponent; } | undefined;
    return def?.type === OptionType.COMPONENT && typeof def.component === "function" ? def : null;
}

function WithShare({ Original, props }: { Original: SettingComponent; props: any; }) {
    // CustomRPC reads its preset list once when its settings open, so remount it after an import to show the new ones.
    const [version, setVersion] = useState(0);
    return (
        <>
            <ErrorBoundary noop>
                <SharePanel onImported={() => setVersion(v => v + 1)} />
            </ErrorBoundary>
            <Original key={version} {...props} />
        </>
    );
}

function wrapCustomRpc() {
    const def = customRpcConfigDef();
    if (!def) {
        logger.warn("CustomRPC's settings page wasn't found, so the buttons are only on this plugin's own page.");
        return;
    }
    if (def.component!.__rpcShare) return;
    const Original = def.component!;
    const wrapped: SettingComponent = props => <WithShare Original={Original} props={props} />;
    wrapped.__rpcShare = true;
    original = Original;
    def.component = wrapped;
}

function unwrapCustomRpc() {
    const def = customRpcConfigDef();
    if (def && original && def.component?.__rpcShare) def.component = original;
    original = null;
}

const settings = definePluginSettings({
    share: {
        type: OptionType.COMPONENT,
        component: () => (
            <ErrorBoundary>
                <SharePanel note="These buttons are also at the top of CustomRPC's settings. Imported presets show up in CustomRPC's preset list." />
            </ErrorBoundary>
        ),
    },
});

export default definePlugin({
    name: "CustomRPCShare",
    description: "Adds Export and Import buttons to CustomRPC's presets, so you can share them as a code or a .json file.",
    authors: [{ name: "nolifepops", id: 221807880053981184n }],
    tags: ["Activity", "Customisation"],
    settings,

    start: wrapCustomRpc,
    stop: unwrapCustomRpc,

    // Reachable as Vencord.Plugins.plugins.CustomRPCShare.* for scripting and tests.
    openExport,
    openImport,
    loadPresets,
    buildExport,
    parseImport,
    savePresets,
    toCode,
    FIELDS,
});
