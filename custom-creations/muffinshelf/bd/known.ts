/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// BetterDiscord store plugins that failed when every store plugin was tried in Muffinshelf, by name and the version tested.
// A newer version isn't hidden, since it may have been fixed.
export const KNOWN_BROKEN: Record<string, { version: string; reason: string; }> = {
    BetterFolders: { version: "3.8.1", reason: "Made for an older Discord. The part of Discord it changes is now hidden inside another component. Equicord has its own BetterFolders." },
    enhancecodeblocks: { version: "1.0.27", reason: "Made for an older Discord. The code highlighter it uses is no longer there." },
};
