/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { React, Tooltip, useEffect, useMemo, useRef } from "@webpack/common";
import type { KeyboardEvent, ReactNode } from "react";

const cl = classNameFactory("vc-btv-");
const logger = new Logger("BadgeTierViewer");

interface Requirement {
    threshold?: number | null;
    unit?: string;
}

interface Progress {
    current?: number | null;
    unit?: string;
}

interface Tier {
    key: string;
    name?: string;
    rarity?: number;
    owned?: boolean;
    milestone_text?: string;
    requirements?: Requirement[] | null;
    simple_icon_url?: string;
    complex_icon_static_url?: string;
    complex_icon_animated_url?: string;
}

interface PreviewState {
    locked: boolean;
    revealed: boolean;
    need?: string;
    real: Badge;
}

interface Badge {
    badge_id: number;
    owned?: boolean;
    current_tier?: string;
    next_tier?: string;
    rarity?: number;
    obtained_at?: string | null;
    tier_obtained_at?: Record<string, string>;
    tiers?: Tier[] | null;
    progress?: Progress[] | null;
    simple_icon_url?: string;
    complex_icon_static_url?: string;
    complex_icon_animated_url?: string;
    __btv?: PreviewState;
}

interface HeroProps {
    badge?: Badge;
    isViewingOtherUser?: boolean;
}

// Discord's badge ids for the two badges that only keep counting while you pay for them.
const SUBSCRIPTION_BADGES = new Set([1, 12]);
const DAY = 86_400_000;

const settings = definePluginSettings({
    revealLocked: {
        type: OptionType.BOOLEAN,
        description: "Show locked badge tiers the way they look once unlocked (same as the eye button in Your Badges).",
        default: false
    }
});

// Picked tier per badge, keyed by Discord's own badge object: each user's badges are separate objects, so picks never
// cross between your badges and someone else's. Lives outside React so the big preview and the tier grid share it.
const picked = new WeakMap<object, string>();
const listeners = new Set<() => void>();
let version = 0;

function subscribe(cb: () => void) {
    listeners.add(cb);
    return () => void listeners.delete(cb);
}

function emit() {
    version++;
    listeners.forEach(l => l());
}

const real = (b: Badge) => b.__btv?.real ?? b;
const defaultTier = (b: Badge) => {
    const r = real(b);
    return (r.owned ? r.current_tier : r.next_tier) ?? r.tiers?.[0]?.key;
};
const pickedTier = (b: Badge) => picked.get(real(b)) ?? defaultTier(b);

function useStore() {
    return React.useSyncExternalStore(subscribe, () => version);
}

function amount(n: number, unit: string): string {
    if (unit === "months" && n >= 12 && n % 12 === 0) return amount(n / 12, "years");
    return `${n.toLocaleString()} ${n === 1 ? unit.replace(/s$/, "") : unit}`;
}

// What a locked tier takes, and on your own badges how far off it is. Only uses numbers Discord sent for this badge.
function needText(badge: Badge, tier: Tier, own: boolean): string | undefined {
    if (tier.owned) return;
    const req = tier.requirements?.[0];
    const threshold = req?.threshold;
    if (typeof threshold !== "number" || !req?.unit) return tier.milestone_text ? `Needs ${tier.milestone_text}` : undefined;

    const { unit } = req;
    const progress = own ? badge.progress?.[0] : undefined;
    const current = progress?.current;
    if (typeof current === "number") {
        // Time tiers are set in months or years but counted in days, so give a date instead of a mixed-unit gap.
        if ((unit === "months" || unit === "years") && progress!.unit === "days" && badge.owned) {
            // Counted from the days Discord reports, so time a lapsed subscription didn't count is left out.
            const start = new Date(Date.now() - current * DAY);
            start.setMonth(start.getMonth() + threshold * (unit === "years" ? 12 : 1));
            if (start.getTime() > Date.now()) {
                const date = start.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
                return `Unlocks around ${date}${SUBSCRIPTION_BADGES.has(badge.badge_id) ? " if you stay subscribed" : ""}`;
            }
        } else if (progress!.unit === unit && threshold > current) {
            return `Needs ${amount(threshold, unit)} (${(threshold - current).toLocaleString()} to go)`;
        }
    }
    return `Needs ${amount(threshold, unit)}`;
}

// Swaps the badge the big preview reads for a copy showing the picked tier; Discord's tier picker then lands on that tier.
function useHeroProps<P extends HeroProps>(props: P): P {
    useStore();
    const { revealLocked } = settings.use(["revealLocked"]);
    const seen = useRef(new Set<object>());

    // Closing the window resets this window's picks only; another badges window opening at the same time keeps its own.
    useEffect(() => () => {
        seen.current.forEach(b => picked.delete(b));
        seen.current.clear();
        emit();
    }, []);

    const badge = props?.badge;
    const tiers = badge?.tiers;
    if (badge) seen.current.add(badge);
    const key = badge && tiers?.length ? pickedTier(badge) : undefined;
    const tier = key && tiers ? tiers.find(t => t.key === key) ?? tiers[0] : undefined;
    const own = !props?.isViewingOtherUser;

    const shown = useMemo(() => {
        if (!badge || !tier || !tiers) return badge;
        try {
            const owned = !!tier.owned;
            const locked = !owned && !revealLocked;
            const isDefault = tier.key === defaultTier(badge);
            // Locked art stays still: Discord plays the tier's own animation first, so it has to go from the tier too.
            const animated = locked ? undefined : tier.complex_icon_animated_url ?? (isDefault ? badge.complex_icon_animated_url : undefined);
            return {
                ...badge,
                tiers: animated === tier.complex_icon_animated_url ? tiers : tiers.map(t => t === tier ? { ...t, complex_icon_animated_url: animated } : t),
                current_tier: tier.key,
                next_tier: tier.key,
                owned: owned || revealLocked,
                rarity: tier.rarity ?? badge.rarity,
                // Same fallbacks Discord uses for the tier it would show anyway; a different tier only uses its own data.
                obtained_at: badge.tier_obtained_at?.[tier.key] ?? (isDefault && badge.owned ? badge.obtained_at : null) ?? null,
                complex_icon_animated_url: animated,
                complex_icon_static_url: tier.complex_icon_static_url ?? (isDefault ? badge.complex_icon_static_url : undefined) ?? tier.simple_icon_url ?? badge.complex_icon_static_url,
                simple_icon_url: tier.simple_icon_url ?? badge.simple_icon_url,
                __btv: { locked, revealed: !owned && revealLocked, need: needText(badge, tier, own), real: badge }
            } satisfies Badge;
        } catch (e) {
            logger.error("Couldn't build the tier preview", e);
            return badge;
        }
    }, [badge, tier, tiers, revealLocked, own]);

    return shown === badge ? props : { ...props, badge: shown };
}

function LockIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M7 10V7a5 5 0 0 1 10 0v3h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1Zm2 0h6V7a3 3 0 0 0-6 0v3Z" />
        </svg>
    );
}

function EyeIcon({ open }: { open: boolean; }) {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
            <circle cx="12" cy="12" r="3" />
            {!open && <path d="M3 3l18 18" />}
        </svg>
    );
}

function EyeButton({ idle }: { idle: boolean; }) {
    const { revealLocked } = settings.use(["revealLocked"]);
    const tip = idle ? "Only changes locked tiers" : revealLocked ? "Show as locked" : "Show unlocked look";
    return (
        <Tooltip text={tip}>
            {tooltip => (
                <button
                    {...tooltip}
                    type="button"
                    className={cl("eye", idle && "eye-idle")}
                    aria-label="Show locked tiers unlocked"
                    aria-pressed={revealLocked}
                    onClick={() => { settings.store.revealLocked = !revealLocked; }}
                >
                    <EyeIcon open={revealLocked} />
                </button>
            )}
        </Tooltip>
    );
}

function HeroFrame({ badge, children }: { badge: Badge; children: ReactNode; }) {
    const state = badge?.__btv;
    const locked = !!state?.locked;
    const hasLocked = !!badge?.tiers?.some(t => !t.owned);
    return (
        <span className={cl("hero", locked && "hero-locked")}>
            {children}
            {locked && <span className={cl("lock")}><LockIcon /></span>}
            {hasLocked && <EyeButton idle={!state || (!state.locked && !state.revealed)} />}
        </span>
    );
}

function selectTier(badge: Badge, key: string) {
    if (key === defaultTier(badge)) picked.delete(real(badge));
    else picked.set(real(badge), key);
    emit();
}

const realBadgeProps = <P extends { badge?: Badge; }>(props: P): P =>
    props?.badge?.__btv ? { ...props, badge: props.badge.__btv.real } : props;

export default definePlugin({
    name: "BadgeTierViewer",
    description: "In Your Badges, click any tier to preview it in the big badge view. An eye button next to it shows locked tiers either locked or the way they look once unlocked.",
    tags: ["Appearance", "Utility"],
    authors: [{ name: "nolifepops", id: 221807880053981184n }],
    settings,

    patches: [
        {
            find: 'parentComponent:"BadgeDirectoryModal"',
            // These only make sense together: if a Discord update breaks one, the whole set stays off instead of half working.
            group: true,
            replacement: [
                {
                    // Detail panel (new + old layout): read the badge through the tier preview.
                    match: /(onViewOwnCatalog:\i\}=)(\i)(?=,.{0,30}?\(0,\i\.\i\)\()/g,
                    replace: "$1$self.useHeroProps($2)"
                },
                {
                    // Big badge art: wrap it so it can show a lock and the eye button.
                    match: /("aria-labelledby":\i\((\i)\.badge_id\),.{0,700}?)null!=(\i)&&(\(0,\i\.jsx\)\("img",\{className:\i\(\)\(\i\.\i,.{0,60}?\),src:\3,alt:"","aria-hidden":!0,draggable:!1\}\))/g,
                    replace: "$1null!=$3&&$self.renderHero($2,$4)"
                },
                {
                    // Tier grid: always draw from the real badge (its dimming depends on real ownership), and re-render on picks.
                    match: /(function \i\((\i)\)\{)(let\{badge:\i,isViewingOtherUser:[^}]{0,80}?isViewerOnUpgradeableNitro:[^}]{0,20}\}=\2,)/g,
                    replace: "$1$2=$self.realBadgeProps($2);$3btvVersion=$self.useStore(),"
                },
                {
                    // Tier grid items: clickable, with the picked one marked.
                    match: /(\i)\.tiers\.map\((\i)=>\{(?=.{0,300}?isViewerOnUpgradeableNitro)(.{0,400}?)role:"listitem",/g,
                    replace: '$1.tiers.map($2=>{$3role:"listitem",...$self.tierItemProps($1,$2),'
                }
            ]
        },
        {
            find: 'parentComponent:"BadgeDirectoryModal"',
            replacement: [
                {
                    // Title: show the previewed tier's name even when it isn't unlocked.
                    match: /null!=(\i)&&(\i)\.owned\?\{isNitro:(\i),eyebrow:(\i),displayName:\1\}/,
                    replace: "null!=$1&&$self.isShown($2)?{isNitro:$3,eyebrow:$4,displayName:$1}"
                },
                {
                    // Rarity tag: show it for the previewed tier too.
                    match: /(\i)\.owned(&&\i!==\i\.\i\.COMMON&&null!=\i)/,
                    replace: "$self.isShown($1)$2"
                },
                {
                    // Status line: what a locked tier needs, and plainly say when one is only being previewed.
                    match: /(\(0,\i\.H5\)\((\i)\),.{0,1000}?key:"status",node:\(0,\i\.jsx\)\(\i\.\i,\{.{0,120}?children:)(\i)\}/,
                    replace: "$1$self.statusText($2,$3)}"
                },
                {
                    // Old layout's status line: wrap the finished text, which covers locked tiers as well.
                    match: /(let \i,\i,\{badge:(\i),isOwnProfile:\i,.{0,500}?return\{statusText:)(\i)(,toggleText:\i\}\})/,
                    replace: "$1$self.statusText($2,$3)$4"
                },
                {
                    // Tier grid: a short line saying the tiers can be clicked.
                    match: /(\(0,\i\.jsx\)\("div",\{className:\i\.\i,role:"list","aria-label":\i\?void 0:(\i)\.name)/g,
                    replace: "$self.gridHint($2),$1"
                },
                {
                    // Analytics: report the tier you actually have, never the one being previewed.
                    match: /(function \i\((\i)\)\{)(let\{actionName:\i,badge:\i,displayedUserId:)/,
                    replace: "$1$2=$self.realBadgeProps($2);$3"
                }
            ]
        }
    ],

    useStore,
    useHeroProps,
    realBadgeProps,

    renderHero(badge: Badge, img: ReactNode) {
        return (
            <ErrorBoundary key={badge?.badge_id} fallback={() => img}>
                <HeroFrame badge={badge}>{img}</HeroFrame>
            </ErrorBoundary>
        );
    },

    gridHint(badge: Badge) {
        if (!badge?.tiers || badge.tiers.length < 2) return null;
        return <div className={cl("hint")}>Click a tier to see it above.</div>;
    },

    isShown(badge: Badge) {
        return !!badge?.owned || badge?.__btv != null;
    },

    statusText(badge: Badge, native: ReactNode) {
        const state = badge?.__btv;
        if (state?.revealed) return `Preview • ${state.need ?? "Not unlocked yet"}`;
        if (state?.locked && state.need) return state.need;
        return native;
    },

    tierItemProps(badge: Badge, tier: Tier) {
        try {
            if (!badge || !tier?.key) return {};
            const selected = tier.key === pickedTier(badge);
            // The grid sits below the big preview, so bring the preview back into view when a tier is picked.
            const pick = (e: { currentTarget: EventTarget | null; }) => {
                // Read the element before re-rendering: React clears currentTarget once the picked tier re-renders the grid.
                const el = e.currentTarget instanceof Element ? e.currentTarget : null;
                selectTier(badge, tier.key);
                el?.closest("#badge-details")?.querySelector("[class*=\"detailScroller\"]")?.scrollTo({ top: 0 });
            };
            return {
                role: "button",
                tabIndex: 0,
                "aria-pressed": selected,
                "aria-description": "Shows this tier in the big badge view",
                "data-btv-tier": "",
                "data-btv-selected": selected ? "true" : undefined,
                onClick: pick,
                onKeyDown: (e: KeyboardEvent) => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        pick(e);
                    }
                }
            };
        } catch (e) {
            logger.error("Couldn't set up a tier", e);
            return {};
        }
    }
});
