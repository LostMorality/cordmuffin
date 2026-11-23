/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { Notice } from "@components/Notice";
import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, useEffect, useState } from "@webpack/common";

import { DetectableApp, exeName, loadDetectable, settings } from ".";
import { BadgeKind, BadgeProgress, getPending, loadBadges, prunePending } from "./badges";
import { Conflicts, usePersonalization } from "./conflicts";
import { startCredit, useCrediting } from "./job";
import { notify } from "./notify";
import { partLabel } from "./report";
import { savedRuns, TestPart } from "./runLog";
import { CreditPlan, loadPlayedIds } from "./science";

const cl = classNameFactory("vc-gts-");

const HOUR_MS = 3_600_000;
// Every combination of these adds up to a different total (0, 6, 12, 18, 24, 30, 36, 42), six hours apart,
// so the rise in badge hours shows which ones counted even with a little real play mixed in.
const PARTS: TestPart[] = [
    { hours: 12, endsHoursAgo: 0 },
    { hours: 24, endsHoursAgo: 0 },
    { hours: 6, endsHoursAgo: 24 }
];
const TOTAL_HOURS = PARTS.reduce((s, p) => s + p.hours, 0);
const RECENT_TEST_MS = 48 * HOUR_MS;

type Badges = Partial<Record<BadgeKind, BadgeProgress>>;

function pick(pool: DetectableApp[], count: number) {
    const picked = [...pool];
    for (let i = picked.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [picked[i], picked[j]] = [picked[j], picked[i]];
    }
    return picked.slice(0, count);
}

function testPlan(apps: DetectableApp[]): CreditPlan {
    const now = Date.now();
    const games = apps.map(app => ({ id: app.id, name: app.name, processName: exeName(app) }));
    return {
        length: PARTS.length,
        at: i => ({ game: games[i], durationMs: PARTS[i].hours * HOUR_MS, end: now - PARTS[i].endsHoursAgo * HOUR_MS })
    };
}

function SessionTest({ modalProps }: { modalProps: RenderModalProps; }) {
    const [pool, setPool] = useState<DetectableApp[] | null | "failed">(null);
    const [badges, setBadges] = useState<Badges | null | "failed">(null);
    const busy = useCrediting();
    const personalized = usePersonalization();

    useEffect(() => {
        Promise.all([loadDetectable(), loadPlayedIds()])
            .then(([apps, played]) => setPool(apps.filter(a => !played.has(a.id))), () => setPool("failed"));
        loadBadges().then(b => {
            setBadges(b);
            prunePending(b);
        }, () => setBadges("failed"));
    }, []);

    const known = badges && badges !== "failed" ? badges : null;
    const waiting = known ? Math.floor(getPending(known).hours) : 0;
    const lastTest = [...savedRuns()].reverse().find(r => r.kind === "test" && r.status === "done");
    const recentTest = lastTest && Date.now() - lastTest.at < RECENT_TEST_MS;
    const { games, rotation, reportRealGames } = settings.use(["games", "rotation", "reportRealGames"]);
    const spoofing = !!games.trim() || rotation !== "off";

    const problem = busy ? "Play time is already being added. Wait for it to finish first."
        : personalized === false ? "Turn on \"Use data to personalize my Discord experience\" first, or nothing will count."
        : pool === "failed" ? "Couldn't load the game list or your play history. Try again in a bit."
        : badges === "failed" || known && !known.time ? "Couldn't read your Game Time badge, so the result couldn't be checked later."
        : pool === null || badges === null ? "Checking your badges and games..."
        : pool.length < PARTS.length ? "There aren't enough games you haven't played left to test with."
            : null;

    function run() {
        if (problem || !Array.isArray(pool)) return;
        const apps = pick(pool, PARTS.length);
        startCredit({
            kind: "test",
            parts: PARTS,
            spoofing: spoofing || reportRealGames,
            plan: testPlan(apps),
            played: new Set(),
            badges: known,
            describe: sent => `${sent} of ${PARTS.length} test sessions`,
            progressText: ({ sent }) => `Sending test sessions, ${sent} of ${PARTS.length} sent...`,
            doneText: () => "Test sent. After Discord's next daily update (give it up to 2 days), press Copy Report in the Game Browser to see which sessions counted."
        });
        notify("Sending the test sessions.");
        modalProps.onClose();
    }

    return (
        <Modal
            {...modalProps}
            size="sm"
            title="Test Session Lengths"
            subtitle="Finds out which kinds of added play time Discord still counts."
            actions={[
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
                { text: "Run Test", variant: "primary", onClick: run, disabled: !!problem }
            ]}
        >
            <Conflicts />
            <Paragraph>Sends one session each to {PARTS.length} random games you haven't played:</Paragraph>
            <ul className={cl("test-list")}>
                {PARTS.map(p => <li key={partLabel(p)}><Paragraph>{partLabel(p)}</Paragraph></li>)}
            </ul>
            <Paragraph>
                That's {TOTAL_HOURS} hours, and whatever counts stays on your Game Time badge. Each session has a different length, so the rise in your badge hours shows exactly which ones Discord took.
                After Discord's next daily update (give it up to 2 days), press Copy Report: it works out the result for you.
            </Paragraph>
            {waiting > 0 && (
                <Notice.Warning className={cl("notice")}>
                    {waiting} hours from an earlier Add Time are still waiting to be counted. If they land at the same update, they'll mix into the result. It's best to run this when nothing is waiting.
                </Notice.Warning>
            )}
            {spoofing && (
                <Notice.Warning className={cl("notice")}>
                    A spoofed game is running or rotation is on. Its hours land on the same badge and can look like a test session, so stop spoofing until the test is counted.
                </Notice.Warning>
            )}
            {recentTest && (
                <Notice.Warning className={cl("notice")}>
                    A test was already sent recently. Running another one before the first is counted makes both harder to read.
                </Notice.Warning>
            )}
            {problem && <Paragraph>{problem}</Paragraph>}
        </Modal>
    );
}

export function openSessionTest() {
    openModal(props => (
        <ErrorBoundary>
            <SessionTest modalProps={props} />
        </ErrorBoundary>
    ));
}
