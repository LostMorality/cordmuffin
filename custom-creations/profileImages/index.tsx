/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import definePlugin from "@utils/types";
import type { ReactNode } from "react";

import { BannerOverlay, ProfileButtons } from "./components";
import { settings } from "./settings";

export default definePlugin({
    name: "ProfileImages",
    description: "Adds View Avatar and View Banner buttons right on profiles (popout, full profile, DM side panel). Opens the full-size or animated image in Discord's viewer; right-click a button for server/main versions, the avatar decoration, copy link and open in browser.",
    authors: [{ name: "nolifepops", id: 221807880053981184n }],
    tags: ["Media", "Appearance"],
    searchTerms: ["ViewIcons", "avatar", "banner", "pfp"],
    settings,

    renderOverlay(original: ReactNode, props: any) {
        return (
            <>
                {original}
                <BannerOverlay
                    user={props.user}
                    guildId={props.guildId}
                    displayProfile={props.displayProfile}
                    themeType={props.vcThemeType}
                />
            </>
        );
    },

    renderRow(original: ReactNode, props: any) {
        return (
            <>
                {original}
                <ProfileButtons user={props.user} guildId={props.guildId} displayProfile={props.displayProfile} />
            </>
        );
    },

    patches: [
        // The profile banner used by the popout, the full profile and the DM side panel
        {
            find: ".themePadding:0",
            replacement: [
                {
                    match: /overlay:(\i),(?=onInteractionStart:)/,
                    replace: "overlay:$self.renderOverlay($1,arguments[0]),"
                },
                {
                    match: /themePadding:\i\?\i\.themePadding:0(?=\})/,
                    replace: "$&,vcThemeType:arguments[0].themeType"
                }
            ]
        },
        // Full profile: the Message / Add Friend / More row
        {
            find: '"UserProfileModalV2Buttons"',
            replacement: {
                match: /(className:\i\.profileButtons,children:)(\(0,\i\.jsx\)\(\i,(\{user:\i,[^}]*?\})\))/,
                replace: "$1$self.renderRow($2,$3)"
            }
        }
    ]
});
