/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Plain stand-ins used when the DOORS files couldn't be downloaded, plus the Starlight's star (the wiki only has it as
// an SVG, which isn't downloaded). They're generic shapes, not DOORS art.

function svgUrl(svg: string) {
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

export function stopSignSvg() {
    return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
<path d="M59 6 H141 L194 59 V141 L141 194 H59 L6 141 V59 Z" fill="#c8102e" stroke="#ffffff" stroke-width="8" stroke-linejoin="round"/>
<text x="100" y="118" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="52" fill="#ffffff">STOP</text>
</svg>`);
}

export function honeyPotSvg() {
    return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<path d="M18 14 H46 L42 22 C54 28 56 52 44 58 H20 C8 52 10 28 22 22 Z" fill="#a8582a" stroke="#4a2008" stroke-width="3" stroke-linejoin="round"/>
<ellipse cx="32" cy="14" rx="15" ry="5" fill="#ffc83a" stroke="#7a4a00" stroke-width="2"/>
<path d="M20 22 C22 30 26 30 26 24 C28 34 32 34 32 24 C35 31 39 31 40 22" fill="#ffc83a"/>
</svg>`);
}

export function starlightSvg() {
    return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<path d="M50 4 C53 36 64 47 96 50 C64 53 53 64 50 96 C47 64 36 53 4 50 C36 47 47 36 50 4 Z" fill="#fff4c2"/>
<path d="M50 22 C52 42 58 48 78 50 C58 52 52 58 50 78 C48 58 42 52 22 50 C42 48 48 42 50 22 Z" fill="#ffffff"/>
</svg>`);
}

export function reviveSvg() {
    return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<ellipse cx="32" cy="10" rx="14" ry="4" fill="none" stroke="#f3d27a" stroke-width="3"/>
<path d="M32 56 C14 44 6 34 8 24 C10 14 24 12 32 22 C40 12 54 14 56 24 C58 34 50 44 32 56 Z" fill="#e0566a"/>
<path d="M8 30 C2 28 0 36 6 38 C2 42 8 46 12 42 Z M56 30 C62 28 64 36 58 38 C62 42 56 46 52 42 Z" fill="#f2f2f2"/>
</svg>`);
}

export function skullSvg() {
    return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<path d="M32 6 C16 6 8 18 8 30 C8 38 12 42 18 44 V54 H46 V44 C52 42 56 38 56 30 C56 18 48 6 32 6 Z" fill="#f6d7c3"/>
<circle cx="22" cy="30" r="7" fill="#2a1f1c"/><circle cx="42" cy="30" r="7" fill="#2a1f1c"/>
<path d="M29 42 L32 36 L35 42 Z" fill="#2a1f1c"/>
</svg>`);
}

/** A pistol held in a fist, pointed straight at you. */
export function gunSvg() {
    return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 312 433">
<defs><linearGradient id="m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c9ced6"/><stop offset="0.55" stop-color="#7d838d"/><stop offset="1" stop-color="#3d4148"/></linearGradient>
<linearGradient id="s" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#f2c29b"/><stop offset="1" stop-color="#c98b62"/></linearGradient></defs>
<path d="M150 70 C215 70 300 100 300 190 C300 290 270 410 205 425 C160 432 150 380 168 330 Z" fill="url(#s)"/>
<path d="M30 60 L150 8 L205 70 L205 300 L120 330 L22 290 C8 230 8 120 30 60 Z" fill="url(#m)" stroke="#2b2e33" stroke-width="5"/>
<path d="M150 8 L205 70 L205 300" fill="none" stroke="#e7ebf0" stroke-width="4" opacity="0.6"/>
<circle cx="90" cy="175" r="62" fill="#5d626a" stroke="#2b2e33" stroke-width="5"/>
<circle cx="90" cy="175" r="42" fill="#0b0c0e"/>
<circle cx="78" cy="160" r="9" fill="#ffffff" opacity="0.18"/>
<ellipse cx="105" cy="268" rx="30" ry="24" fill="#3a3e45"/>
<ellipse cx="105" cy="268" rx="17" ry="13" fill="#0b0c0e"/>
<path d="M172 200 C215 190 250 205 252 235 C254 262 220 270 180 262 Z" fill="#e8b087" stroke="#a96d48" stroke-width="3"/>
<path d="M180 262 C225 262 262 280 260 310 C258 336 222 342 186 330 Z" fill="#dfa47b" stroke="#a96d48" stroke-width="3"/>
<path d="M186 330 C228 334 254 352 248 378 C242 402 210 404 190 392 Z" fill="#d69a70" stroke="#a96d48" stroke-width="3"/>
<path d="M175 150 C225 135 270 150 270 178 C270 202 230 210 180 200 Z" fill="#efbb92" stroke="#a96d48" stroke-width="3"/>
</svg>`);
}

/** An open hand reaching out, palm up, waiting for the gold. */
export function handSvg() {
    return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 434 325">
<defs><radialGradient id="p" cx="0.45" cy="0.45" r="0.7"><stop offset="0" stop-color="#ffd9c4"/><stop offset="1" stop-color="#e9a98a"/></radialGradient></defs>
<path d="M290 40 C330 20 400 0 425 18 C440 32 420 52 380 64 C350 74 320 90 300 110 Z" fill="#f6c3a8" stroke="#c98468" stroke-width="3"/>
<path d="M90 70 C150 40 250 30 300 70 C340 110 345 190 320 230 C290 280 200 300 130 280 C70 262 40 220 50 160 C55 120 65 90 90 70 Z" fill="url(#p)" stroke="#c98468" stroke-width="3"/>
<path d="M70 200 C40 190 8 182 4 200 C0 222 40 236 80 240 Z" fill="#f2b89b" stroke="#c98468" stroke-width="3"/>
<path d="M110 240 C95 250 82 280 92 296 C104 314 130 300 142 270 Z" fill="#f2b89b" stroke="#c98468" stroke-width="3"/>
<path d="M190 262 C185 280 190 310 208 316 C228 322 242 300 238 268 Z" fill="#efb396" stroke="#c98468" stroke-width="3"/>
<path d="M280 220 C292 238 300 262 318 260 C340 258 344 230 322 200 Z" fill="#efb396" stroke="#c98468" stroke-width="3"/>
<path d="M150 150 C190 170 240 168 270 140" fill="none" stroke="#d58f72" stroke-width="4" opacity="0.6"/>
<path d="M130 110 C170 130 220 128 250 105" fill="none" stroke="#d58f72" stroke-width="3" opacity="0.45"/>
</svg>`);
}

export function coinSvg() {
    return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<circle cx="32" cy="32" r="28" fill="#ffc83a" stroke="#7a4a00" stroke-width="4"/>
<circle cx="32" cy="32" r="20" fill="none" stroke="#d99a12" stroke-width="3"/>
<text x="32" y="41" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="24" fill="#7a4a00">G</text>
</svg>`);
}
