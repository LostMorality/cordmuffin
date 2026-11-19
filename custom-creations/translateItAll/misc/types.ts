/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";

export const cl = classNameFactory("eq-transall-");

export interface Translation {
    text: string;
    src: string;
    /** Set for failures and status notes, which are not translations of the message. */
    error?: boolean;
}

export type IconProps = {
    width?: number;
    height?: number;
};
