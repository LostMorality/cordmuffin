/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType } from "@utils/types";

import { Manager } from "./Manager";
import { applyPreset, captureCurrent, deletePreset, isManaged, isOfficial, loadPresets, planApply, savePreset } from "./presets";
import { buildExport, prepareImport, toCode } from "./share";

const settings = definePluginSettings({
    manager: {
        type: OptionType.COMPONENT,
        component: () => <ErrorBoundary><Manager /></ErrorBoundary>,
    },
});

export default definePlugin({
    name: "PluginPresets",
    description: "Save which plugins are on, with their settings, as named presets. Switch between them, and share them with private settings left out.",
    authors: [{ name: "nolifepops", id: 221807880053981184n }],
    settings,

    // Reachable as Vencord.Plugins.plugins.PluginPresets.* for scripting and tests.
    captureCurrent,
    isManaged,
    isOfficial,
    planApply,
    applyPreset,
    buildExport,
    prepareImport,
    loadPresets,
    savePreset,
    deletePreset,
    toCode,
});
