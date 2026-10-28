/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { GameControllerIcon } from "@components/Icons";
import { classNameFactory } from "@utils/css";
import type { RenderModalProps } from "@vencord/discord-types";
import { findByPropsLazy } from "@webpack";
import { Modal, openModal, RunningGameStore, Select, TextInput, useEffect, useMemo, useRef, useState } from "@webpack/common";

import { DetectableApp, isSpoofing, loadDetectable, settings } from ".";
import { openAddTime } from "./AddTime";
import { Conflicts } from "./conflicts";
import { notify } from "./notify";

const cl = classNameFactory("vc-gts-");
const GameProfileActions: { openGameProfileModal(options: { gameId: string; gameProfileModalChecks: { shouldOpenGameProfile: boolean; gameId: string; }; source: string; }): void; } = findByPropsLazy("openGameProfileModal");
const PAGE_SIZE = 60;

const TABS = { all: "All Games", favorites: "Favorites", detected: "Detected" } as const;
type Tab = keyof typeof TABS;

const appImage = (id: string, hash: string, size: number) => `https://cdn.discordapp.com/app-icons/${id}/${hash}.webp?size=${size}`;

function spoof(app: DetectableApp) {
    settings.store.games = app.id;
}

function stopSpoof(app: DetectableApp) {
    settings.store.games = settings.store.games.split(",").map(s => s.trim())
        .filter(e => e && e !== app.id && e.toLowerCase() !== app.name.toLowerCase())
        .join(", ");
}

function toggleFavorite(id: string) {
    const { favorites } = settings.store;
    settings.store.favorites = favorites.includes(id) ? favorites.filter(f => f !== id) : [...favorites, id];
}

function StarIcon({ filled }: { filled: boolean; }) {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24">
            <path
                fill={filled ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
                d="m12 2.8 2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3-4.6-4.4 6.3-.9L12 2.8Z"
            />
        </svg>
    );
}

function scrollParent(el: Element | null) {
    for (let p = el?.parentElement; p; p = p.parentElement) {
        const { overflowY } = getComputedStyle(p);
        if (overflowY === "auto" || overflowY === "scroll") return p;
    }
    return null;
}

function openGameProfile(id: string) {
    try {
        GameProfileActions.openGameProfileModal({ gameId: id, gameProfileModalChecks: { shouldOpenGameProfile: true, gameId: id }, source: "quick_switcher" });
    } catch {
        notify("Discord's game page couldn't be opened.", "critical");
    }
}

function GameCard({ app, spoofing, favorite }: { app: DetectableApp; spoofing: boolean; favorite: boolean; }) {
    return (
        <div className={cl("card", spoofing && "card-active")}>
            <div
                className={cl("cover")}
                role="button"
                tabIndex={0}
                title="View game page"
                onClick={() => openGameProfile(app.id)}
                onKeyDown={e => {
                    if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault();
                        openGameProfile(app.id);
                    }
                }}
            >
                {app.cover_image_hash
                    ? <img src={appImage(app.id, app.cover_image_hash, 300)} loading="lazy" alt="" />
                    : app.icon_hash
                        ? <img className={cl("cover-icon")} src={appImage(app.id, app.icon_hash, 128)} loading="lazy" alt="" />
                        : <GameControllerIcon className={cl("cover-icon")} width={48} height={48} />}
                <button
                    className={cl("star", favorite && "star-on")}
                    onClick={e => {
                        e.stopPropagation();
                        toggleFavorite(app.id);
                    }}
                    aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
                    aria-pressed={favorite}
                >
                    <StarIcon filled={favorite} />
                </button>
                {spoofing && <div className={cl("badge")}>Playing</div>}
            </div>
            <div className={cl("name")} title={app.name}>{app.name}</div>
            <div className={cl("themes")}>{app.themes.slice(0, 2).join(" · ") || " "}</div>
            <Button
                size="small"
                variant={spoofing ? "dangerPrimary" : "primary"}
                className={cl("spoof")}
                onClick={() => spoofing ? stopSpoof(app) : spoof(app)}
            >
                {spoofing ? "Stop" : "Spoof"}
            </Button>
            <Button size="small" variant="secondary" className={cl("spoof")} onClick={() => openAddTime([app], app.name)}>
                Add Time
            </Button>
        </div>
    );
}

function GameBrowser({ modalProps }: { modalProps: RenderModalProps; }) {
    const { games, favorites } = settings.use(["games", "favorites"]);
    const [apps, setApps] = useState<DetectableApp[] | null>(null);
    const [error, setError] = useState(false);
    const [tab, setTabState] = useState<Tab>("all");
    const [query, setQueryState] = useState("");
    const [genre, setGenreState] = useState("");
    const [limit, setLimit] = useState(PAGE_SIZE);
    const [attempt, setAttempt] = useState(0);
    const sentinel = useRef<HTMLDivElement>(null);

    const setTab = (value: Tab) => { setLimit(PAGE_SIZE); setTabState(value); };
    const setQuery = (value: string) => { setLimit(PAGE_SIZE); setQueryState(value); };
    const setGenre = (value: string) => { setLimit(PAGE_SIZE); setGenreState(value); };

    useEffect(() => {
        setError(false);
        loadDetectable()
            .then(list => setApps([...list].sort((a, b) => Number(!a.cover_image_hash) - Number(!b.cover_image_hash) || a.name.localeCompare(b.name))))
            .catch(() => setError(true));
    }, [attempt]);

    const genres = useMemo(() => {
        const counts = new Map<string, number>();
        for (const app of apps ?? []) for (const theme of app.themes) counts.set(theme, (counts.get(theme) ?? 0) + 1);
        return [...counts.keys()].sort();
    }, [apps]);

    const favoriteKey = favorites.join(",");
    const appIds = useMemo(() => new Set(apps?.map(a => a.id)), [apps]);
    const favoriteSet = useMemo(() => new Set(favorites.filter(id => !apps || appIds.has(id))), [favoriteKey, appIds]);
    const detectedSet = useMemo(() => new Set(RunningGameStore.getGamesSeen(true).map(g => g.id)), []);

    const filtered = useMemo(() => {
        if (!apps) return [];
        const q = query.trim().toLowerCase();
        const pinned = apps.filter(app => isSpoofing(app, games));
        const matches = apps.filter(app =>
            !pinned.includes(app)
            && (tab !== "favorites" || favoriteSet.has(app.id))
            && (tab !== "detected" || detectedSet.has(app.id))
            && (!genre || app.themes.includes(genre))
            && (!q || app.name.toLowerCase().includes(q) || app.aliases.some(alias => alias.toLowerCase().includes(q)))
        );
        if (q) matches.sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)));
        return [...pinned, ...matches];
    }, [apps, tab, query, genre, favoriteSet, detectedSet, games]);

    useEffect(() => {
        if (!sentinel.current) return;
        const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) setLimit(l => l + PAGE_SIZE);
        }, { root: scrollParent(sentinel.current), rootMargin: "400px" });
        observer.observe(sentinel.current);
        return () => observer.disconnect();
    }, [filtered, limit]);

    const emptyText = error
        ? "Couldn't load Discord's game list."
        : !apps
            ? "Loading games..."
            : tab === "favorites" && !favoriteSet.size
                ? "No favorites yet. Click the star on a game to add it here."
                : "No games match your search.";

    return (
        <Modal
            {...modalProps}
            size="xxl"
            title="Game Browser"
            subtitle={apps ? `${filtered.length.toLocaleString()} games` : undefined}
        >
            <Conflicts spoofing />
            <div className={cl("toolbar")}>
                <div className={cl("tabs")}>
                    {(Object.keys(TABS) as Tab[]).map(key => (
                        <Button key={key} size="small" variant={tab === key ? "primary" : "secondary"} aria-pressed={tab === key} onClick={() => setTab(key)}>
                            {TABS[key]}{key === "favorites" && favoriteSet.size ? ` (${favoriteSet.size})` : ""}
                        </Button>
                    ))}
                </div>
                <div className={cl("tabs")}>
                    {apps && (
                        <Button size="small" variant="positive" onClick={() => openAddTime([], "random games", apps.filter(a => a.cover_image_hash))}>
                            Add Random Games
                        </Button>
                    )}
                    {tab === "favorites" && favoriteSet.size > 0 && apps && (
                        <Button size="small" variant="positive" onClick={() => openAddTime(apps.filter(a => favoriteSet.has(a.id)), "your favorites")}>
                            Add Time to All
                        </Button>
                    )}
                </div>
                <div className={cl("search")}>
                    <TextInput value={query} onChange={setQuery} placeholder="Search games" autoFocus />
                </div>
                <div className={cl("genre")}>
                    <Select
                        placeholder="All genres"
                        options={[{ label: "All genres", value: "" }, ...genres.map(g => ({ label: g, value: g }))]}
                        select={setGenre}
                        isSelected={v => v === genre}
                        serialize={String}
                        maxVisibleItems={12}
                    />
                </div>
            </div>
            {filtered.length
                ? (
                    <div className={cl("grid")}>
                        {filtered.slice(0, limit).map(app => (
                            <GameCard key={app.id} app={app} spoofing={isSpoofing(app, games)} favorite={favoriteSet.has(app.id)} />
                        ))}
                    </div>
                )
                : (
                    <div className={cl("empty")}>
                        {emptyText}
                        {error && <Button size="small" variant="secondary" className={cl("retry")} onClick={() => setAttempt(a => a + 1)}>Try again</Button>}
                    </div>
                )}
            {limit < filtered.length && <div ref={sentinel} className={cl("sentinel")} />}
        </Modal>
    );
}

export function openGameBrowser() {
    openModal(props => (
        <ErrorBoundary>
            <GameBrowser modalProps={props} />
        </ErrorBoundary>
    ));
}
