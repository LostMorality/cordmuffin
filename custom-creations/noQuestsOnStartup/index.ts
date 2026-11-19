/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";

export default definePlugin({
    name: "NoQuestsOnStartup",
    description: "Stops Discord from opening the Quests page every time it starts. Discord opens where it normally would.",
    authors: [{ name: "nolifepops", id: 221807880053981184n }],
    tags: ["Utility"],
    searchTerms: ["quests", "quest home", "startup", "redirect"],
    patches: [
        {
            // Discord's quest campaign experiment: accounts in its redirect group get sent to Quests whenever "/app" loads.
            find: "questHomeRedirect",
            replacement: {
                match: /return (\i)\.enabled&&\1\.questHomeRedirect/,
                replace: "return false"
            }
        },
        {
            // The startup route that acts on it, in case the experiment helper changes shape.
            find: '"SessionRedirector"',
            replacement: {
                match: /\(0,\i\.\i\)\("SessionRedirector"\)/,
                replace: "false"
            }
        }
    ]
});
