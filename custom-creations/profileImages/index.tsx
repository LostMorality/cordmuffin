/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import definePlugin from "@utils/types";
import type { Guild } from "@vencord/discord-types";
import type { ReactNode } from "react";

import { BannerOverlay, GuildBannerPills, ProfileButtons } from "./components";
import { settings } from "./settings";

export default definePlugin({
    name: "ProfileImages",
    description: "Adds View Avatar and View Banner buttons right on profiles (popout, full profile, DM side panel) and Icon/Banner buttons on server banners. Opens the full-size or animated image in Discord's viewer; right-click a button for server/main versions, the avatar decoration, copy link and open in browser.",
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

    renderGuildBanner(original: ReactNode, guild: Guild) {
        return (
            <>
                {original}
                <GuildBannerPills guild={guild} />
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
        // Server banner at the top of the channel list
        {
            find: "*90}px)`)},children:",
            replacement: {
                match: /children:(\(0,\i\.jsx\)\("img",\{className:.{0,80}?getGuildBannerURL\(\{id:(\i)\.id,banner:\i\},\i\).{0,40}?"aria-hidden":!0\}\))/,
                replace: "children:$self.renderGuildBanner($1,$2)"
            }
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
