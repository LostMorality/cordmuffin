/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { HeaderBarButton } from "@api/HeaderBar";
import { Settings } from "@api/Settings";
import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import definePlugin from "@utils/types";

import { exposeDeclarations, FACTORY_HEAD_MATCH } from "./bd/declarations";
import { installBd, removeBd, startRuntime, stopRuntime } from "./bd/runtime";
import { DECLARATION_FINDS_KEY } from "./bd/webpack";
import { settings } from "./settings";
import { openShelf } from "./Shelf";

function MuffinIcon({ width = 24, height = 24, className }: { width?: number; height?: number; className?: string; }) {
    return (
        <svg className={className} width={width} height={height} viewBox="0 0 24 24" role="img">
            <path fill="currentColor" d="M12 2.5c-4.7 0-8.5 3.1-8.5 7 0 1.3 1 2.3 2.3 2.3h12.4c1.3 0 2.3-1 2.3-2.3 0-3.9-3.8-7-8.5-7Zm-3 4.3a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm6 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm-3-1.6a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z" />
            <path fill="currentColor" d="M5.4 13.3h13.2l-1.4 7.1c-.1.6-.7 1.1-1.3 1.1H8.1c-.6 0-1.2-.5-1.3-1.1l-1.4-7.1Zm4.1 1.7.4 5h1.4l-.3-5H9.5Zm3.3 0-.3 5h1.4l.4-5h-1.5Z" />
        </svg>
    );
}

// Modules BetterDiscord plugins asked for private variables from (learned at runtime, see bd/webpack.ts).
function declarationPatches() {
    let finds: unknown;
    try {
        finds = (Settings.plugins.Muffinshelf as Record<string, unknown> | undefined)?.[DECLARATION_FINDS_KEY];
    } catch {
        return [];
    }
    if (!Array.isArray(finds)) return [];
    return finds.filter((f): f is string => typeof f === "string" && f.length >= 12).map(find => ({
        find,
        all: true,
        noWarn: true,
        predicate: () => settings.store.runBetterDiscord,
        replacement: { match: FACTORY_HEAD_MATCH, replace: exposeDeclarations as (match: string, ...groups: string[]) => string },
    }));
}

export default definePlugin({
    name: "Muffinshelf",
    description: "A plugin store for things Equicord doesn't ship: community userplugins, BetterDiscord plugins, and your own GitHub links.",
    authors: [{ name: "nolifepops", id: 221807880053981184n }],
    enabledByDefault: true,
    dependencies: ["CommandsAPI"],
    settings,
    patches: declarationPatches(),

    settingsAboutComponent: () => (
        <>
            <Button onClick={openShelf}>Open Muffinshelf</Button>
            <Paragraph>
                Muffinshelf can also be opened from the muffin button at the top of Discord. Its "How it works" tab explains where every plugin comes from and where its files go.
            </Paragraph>
        </>
    ),

    headerBarButton: {
        icon: MuffinIcon,
        render: () => <HeaderBarButton icon={MuffinIcon} tooltip="Muffinshelf" position="bottom" onClick={openShelf} />
    },

    // For scripts and other plugins: install or remove a BetterDiscord plugin file the same way the store does.
    installBdPlugin: (file: string, code: string) => installBd(file, code),
    removeBdPlugin: (file: string) => removeBd(file),

    start() {
        startRuntime();
    },

    stop() {
        stopRuntime();
    },
});
