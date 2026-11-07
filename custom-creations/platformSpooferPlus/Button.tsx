/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { UserAreaButton, UserAreaRenderProps } from "@api/UserArea";
import { ContextMenuApi, Menu } from "@webpack/common";

import { currentPlatform, isRefused, pickPlatform, settings, useEnabled, useRefused } from ".";
import { ClientKind, isPlatformId, PLATFORM_IDS, PlatformId, platformLabel, PLATFORMS } from "./platforms";

const PATHS: Record<ClientKind, string> = {
    desktop: "M4 3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h6v2H7a1 1 0 1 0 0 2h10a1 1 0 1 0 0-2h-3v-2h6a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H4Zm0 2h16v10H4V5Z",
    web: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm6.9 9h-3a15.6 15.6 0 0 0-1.4-6.1A8 8 0 0 1 18.9 11ZM12 4.1c.9 1.2 1.8 3.6 1.9 6.9h-3.8c.1-3.3 1-5.7 1.9-6.9ZM9.5 4.9A15.6 15.6 0 0 0 8.1 11h-3a8 8 0 0 1 4.4-6.1ZM5.1 13h3a15.6 15.6 0 0 0 1.4 6.1A8 8 0 0 1 5.1 13Zm6.9 6.9c-.9-1.2-1.8-3.6-1.9-6.9h3.8c-.1 3.3-1 5.7-1.9 6.9Zm2.5-.8a15.6 15.6 0 0 0 1.4-6.1h3a8 8 0 0 1-4.4 6.1Z",
    mobile: "M8 1a3 3 0 0 0-3 3v16a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3V4a3 3 0 0 0-3-3H8Zm0 2h8a1 1 0 0 1 1 1v14H7V4a1 1 0 0 1 1-1Zm3 16h2a1 1 0 1 1 0 2h-2a1 1 0 1 1 0-2Z",
    embedded: "M7 6a6 6 0 0 0-5.9 7.2l.8 3.9A3 3 0 0 0 4.8 19.5c1 0 1.9-.5 2.4-1.3L8.5 16h7l1.3 2.2a2.8 2.8 0 0 0 5.1-1.1l.8-3.9A6 6 0 0 0 17 6H7Zm1 3a1 1 0 0 1 1 1v1h1a1 1 0 1 1 0 2H9v1a1 1 0 1 1-2 0v-1H6a1 1 0 1 1 0-2h1v-1a1 1 0 0 1 1-1Zm8 1a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm-2 2a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z",
    vr: "M5 6a4 4 0 0 0-4 4v4a4 4 0 0 0 4 4h2.6a3 3 0 0 0 2.5-1.3l.7-1a1.5 1.5 0 0 1 2.4 0l.7 1a3 3 0 0 0 2.5 1.3H19a4 4 0 0 0 4-4v-4a4 4 0 0 0-4-4H5Zm2 4a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm10 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z"
};

const shownAs = (id: PlatformId, refused: boolean): ClientKind => id === "off" || refused ? "desktop" : PLATFORMS[id].shows;

const lastSpoof = (): Exclude<PlatformId, "off"> => {
    const id = settings.store.lastSpoof;
    return isPlatformId(id) && id !== "off" ? id : "phone";
};

function Icon({ className }: { className?: string; }) {
    settings.use(["platform"]);
    const refused = useRefused();
    return (
        <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d={PATHS[shownAs(currentPlatform(), refused)]} />
        </svg>
    );
}

export { Icon as PlatformIcon };

function toggle() {
    const id = currentPlatform();
    if (id === "off") {
        pickPlatform(lastSpoof());
        return;
    }
    if (isRefused()) {
        pickPlatform(id);
        return;
    }
    settings.store.lastSpoof = id;
    pickPlatform("off");
}

function PickerMenu() {
    const id = currentPlatform();
    return (
        <Menu.Menu navId="vc-platform-spoofer-button" onClose={ContextMenuApi.closeContextMenu}>
            {(["off", ...PLATFORM_IDS] as PlatformId[]).map(item => (
                <Menu.MenuRadioItem
                    key={item}
                    id={`vc-platform-spoofer-button-${item}`}
                    group="vc-platform-spoofer-button"
                    label={platformLabel(item)}
                    checked={id === item}
                    action={() => {
                        if (item !== "off") settings.store.lastSpoof = item;
                        pickPlatform(item);
                        ContextMenuApi.closeContextMenu();
                    }}
                />
            ))}
        </Menu.Menu>
    );
}

function tooltip(id: PlatformId, refused: boolean) {
    if (refused) return `Discord refused ${platformLabel(id)}, so you're on your real platform. Click to try again, right-click to pick.`;
    if (id === "off") return `Showing your real platform. Click for ${platformLabel(lastSpoof())}, right-click to pick.`;
    return `Showing as ${platformLabel(id)}. Click for your real platform, right-click to pick.`;
}

export function PlatformButton({ nameplate, iconForeground, hideTooltips }: UserAreaRenderProps) {
    const { showButton } = settings.use(["platform", "showButton"]);
    const enabled = useEnabled();
    const refused = useRefused();
    if (!showButton || !enabled) return null;

    const id = currentPlatform();
    const spoofing = id !== "off" && !refused;

    return (
        <UserAreaButton
            icon={<Icon className={iconForeground} />}
            tooltipText={hideTooltips ? undefined : tooltip(id, refused)}
            role="switch"
            aria-checked={spoofing}
            plated={nameplate != null}
            onClick={toggle}
            onContextMenu={e => ContextMenuApi.openContextMenu(e, () => <PickerMenu />)}
        />
    );
}
