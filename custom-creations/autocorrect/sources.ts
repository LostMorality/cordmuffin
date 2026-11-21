/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const BASE = "https://cdn.jsdelivr.net/gh/wolfgarbe/SymSpell@91fe939e9c1259813ee817e95239629c5badf8ec/SymSpell";

export const SOURCES = {
    unigrams: {
        url: `${BASE}/frequency_dictionary_en_82_765.txt`,
        sha256: "c604e1121e398ae7c7fbf777f11e0a0f2fa66eda932cb9fba1321466cf3acd7b",
        bytes: 1332881,
    },
    bigrams: {
        url: `${BASE}/frequency_bigramdictionary_en_243_342.txt`,
        sha256: "fd892a160184101dd7ae807ac5a302d01fcea1c47304181a8ed7ed9c94545bcd",
        bytes: 5137213,
    },
} as const;

export const LICENSE_NOTE =
    "Word and word-pair frequencies (including the built-in core list) come from SymSpell by Wolf Garbe, "
    + "https://github.com/wolfgarbe/SymSpell, MIT License, Copyright (c) 2018 Wolf Garbe. "
    + "SymSpell built them from Google Books Ngram counts intersected with SCOWL.";
