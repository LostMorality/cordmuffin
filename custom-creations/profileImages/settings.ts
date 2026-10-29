/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    avatarButton: {
        type: OptionType.BOOLEAN,
        description: "Show the View Avatar button",
        default: true
    },
    bannerButton: {
        type: OptionType.BOOLEAN,
        description: "Show the View Banner button",
        default: true
    },
    profileRow: {
        type: OptionType.BOOLEAN,
        description: "Full profile: square buttons next to Message",
        default: true
    },
    pillsPopout: {
        type: OptionType.BOOLEAN,
        description: "Profile popout: buttons on the banner",
        default: true
    },
    pillsModal: {
        type: OptionType.BOOLEAN,
        description: "Full profile: buttons on the banner (only Banner when the square buttons are on)",
        default: true
    },
    pillsSidebar: {
        type: OptionType.BOOLEAN,
        description: "DM side panel: buttons on the banner",
        default: true
    },
    guildHeader: {
        type: OptionType.BOOLEAN,
        description: "Server header: Icon and Banner buttons on the server banner",
        default: true
    },
    pillCorner: {
        type: OptionType.SELECT,
        description: "Which corner of the banner the buttons sit in",
        options: [
            { label: "Top right", value: "right", default: true },
            { label: "Top left", value: "left" }
        ]
    },
    prefer: {
        type: OptionType.SELECT,
        description: "When someone has a server avatar or banner, which one opens first (use the arrows in the viewer for the other)",
        options: [
            { label: "Server one", value: "server", default: true },
            { label: "Main one", value: "global" }
        ]
    },
    noBanner: {
        type: OptionType.SELECT,
        description: "When someone has no banner",
        options: [
            { label: "Show their banner colour (click copies it)", value: "color", default: true },
            { label: "Hide the banner button", value: "hide" }
        ]
    },
    format: {
        type: OptionType.SELECT,
        description: "Format for still images",
        options: [
            { label: "webp", value: "webp", default: true },
            { label: "png", value: "png" },
            { label: "jpg", value: "jpg" }
        ]
    },
    animatedFormat: {
        type: OptionType.SELECT,
        description: "Format for animated images",
        options: [
            { label: "webp", value: "webp", default: true },
            { label: "gif", value: "gif" }
        ]
    },
    imgSize: {
        type: OptionType.SELECT,
        description: "Image size to open (copy and open-link use the biggest, 4096)",
        options: ["512", "1024", "2048", "4096"].map(n => ({ label: n, value: n, default: n === "1024" }))
    }
});
