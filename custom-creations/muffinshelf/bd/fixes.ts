/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";

const logger = new Logger("Muffinshelf");

// Small edits to specific BetterDiscord plugin versions whose lookups no longer match today's Discord.
// Each edit is an exact find/replace on that version's code; edits that don't match are skipped.
interface PluginFix {
    version: string;
    edits: [find: string, replace: string][];
}

export const PLUGIN_FIXES: Record<string, PluginFix> = {
    BetterAnimations: {
        version: "2.1.15",
        edits: [
            // Text, Heading and Stack are plain function components now, not forwardRefs.
            ['filter: (m) => Filters.byStrings("WebkitLineClamp", "data-text-variant")(m?.render),', 'filter: (m) => Filters.byStrings("WebkitLineClamp", "data-text-variant")(m?.render ?? m),'],
            ['filter: (m) => Filters.byStrings("variant", "data-excessive-heading-level")(m?.render),', 'filter: (m) => Filters.byStrings("variant", "data-excessive-heading-level")(m?.render ?? m),'],
            ['filter: (m) => Filters.byStrings("data-direction", "data-justify")(m?.render),', 'filter: (m) => Filters.byStrings("data-direction", "data-justify")(m?.render ?? m),'],
            // The switch is no longer the module's default export.
            ['{ filter: Filters.byStrings("checked", ".controlId") }', '{ filter: Filters.byStrings("checked", ".controlId"), searchExports: true }'],
            // The chat text area is memo(function) now instead of memo(forwardRef).
            ['{ filter: (m) => Filters.byStrings("CHANNEL_TEXT_AREA", "markdown")(m?.type?.render) }', '{ filter: (m) => Filters.byStrings("CHANNEL_TEXT_AREA", "markdown")(m?.type?.render ?? m?.type) }'],
            ['Patcher_default.after(ModuleKey_default.Popouts, ChannelTextArea?.type, "render", (self, args, value) => {', 'Patcher_default.after(ModuleKey_default.Popouts, ChannelTextArea?.type?.render ? ChannelTextArea.type : ChannelTextArea, ChannelTextArea?.type?.render ? "render" : "type", (self, args, value) => {'],
            // The unread divider is a plain function export, so it's patched on its module.
            ['{ filter: (m) => Filters.byStrings("\\"span\\"", "isUnread")(m?.render) }', '{ filter: (m) => Filters.byStrings("\\"span\\"", "isUnread")(m?.render ?? m), defaultExport: false }'],
            ['Patcher_default.after(ModuleKey_default.Messages, MessageDivider, "render", (self, [props], value) => {', 'Patcher_default.after(ModuleKey_default.Messages, MessageDivider, MessageDivider?.render ? "render" : Object.keys(MessageDivider ?? {}).find((k) => typeof MessageDivider[k] === "function"), (self, [props], value) => {'],
            // Discord's newer tooltips skip the class patch that used to find TooltipLayer, so resolve it from a fresh Tooltip.
            ['if (!TooltipLayer) throw new Error("Unable to resolve TooltipLayer");', 'if (!TooltipLayer) try { const tip = new Tooltip$1({ text: "", children: () => null, position: "top" }); tip.state ??= {}; const render = Tooltip$1.prototype.renderTooltip.__originalFunction ?? Tooltip$1.prototype.renderTooltip; const base = render.call(tip); TooltipLayer = findInReactTree(ReactUtils.wrapInHooks(base.type)({ ...base.props, isVisible: true }), (m) => m?.key === "tooltip")?.type ?? null; } catch { }\n\t\tif (!TooltipLayer) throw new Error("Unable to resolve TooltipLayer");'],
            // The badge no longer contains "eyebrow" (its text variant moved into a helper); find it by its badge types instead.
            ['filter: Filters.bySource("\\"eyebrow\\"", "EARLY_ACCESS"),', 'filter: Filters.bySource("\\"early_access\\"", "BILLING_TRIAL_FREE_TRIAL_TEXT"),'],
            ['map: { Badge: Filters.byStrings("\\"eyebrow\\"") }', 'map: { Badge: Filters.byStrings("\\"early_access\\"", "EARLY_ACCESS") }'],
            // Channel items lost their drag-and-drop class wrapper: patch the memo's function instead, keeping the container ref in a hook.
            ["once(() => {\n\t\t\t\tinjectModule(value?.type?.DecoratedComponent, ModuleKey_default.ChannelList);\n\t\t\t\tPatcher_default.after(ModuleKey_default.ChannelList, value?.type?.DecoratedComponent?.prototype, \"render\", (self, args, value) => {\n\t\t\t\t\tif (!Core_default.getModule(ModuleKey_default.ChannelList).isEnabled()) return;", "once(() => {\n\t\t\t\tconst Decorated = value?.type?.DecoratedComponent;\n\t\t\t\tconst isMemo = !Decorated && typeof value?.type?.type === \"function\";\n\t\t\t\tif (Decorated) injectModule(Decorated, ModuleKey_default.ChannelList);\n\t\t\t\tPatcher_default.after(ModuleKey_default.ChannelList, Decorated ? Decorated.prototype : isMemo ? value.type : null, Decorated ? \"render\" : \"type\", (self, args, value) => {\n\t\t\t\t\tif (isMemo) self = (0, react.useRef)({}).current;\n\t\t\t\t\tif (!Core_default.getModule(ModuleKey_default.ChannelList).isEnabled()) return;"],
            // The message list became a plain function component; patch a stand-in and swap the element's type to it each render.
            ["\tfunction patchChannelMessageList() {", "\tvar __mfListHolder = {};\n\tfunction patchChannelMessageList() {"],
            ["once(() => Patcher_default.after(ModuleKey_default.Messages, findInReactTree(value?.props?.children, (m) => m?.props?.messages)?.type, \"type\", (self, [{ channel }], value) => {", "const __mfList = findInReactTree(value?.props?.children, (m) => m?.props?.messages);\n\t\t\tif (typeof __mfList?.type === \"function\" && !__mfListHolder.orig) {\n\t\t\t\t__mfListHolder.orig = __mfList.type;\n\t\t\t\t__mfListHolder.type = __mfList.type;\n\t\t\t}\n\t\t\tconst __mfSwap = typeof __mfList?.type === \"function\" && __mfList.type === __mfListHolder.orig;\n\t\t\tonce(() => Patcher_default.after(ModuleKey_default.Messages, __mfSwap ? __mfListHolder : __mfList?.type, \"type\", (self, [{ channel }], value) => {"],
            ["\t\t\t}));\n\t\t});\n\t\tpatchMessage();", "\t\t\t}));\n\t\t\tif (__mfSwap) __mfList.type = __mfListHolder.type;\n\t\t});\n\t\tpatchMessage();"],
            // ListThin and the channel view's inner component became plain functions; patch a cached stand-in and point the element at it.
            ["\tfunction patchChannelView() {", "\tvar __mfTypeHolders = new WeakMap();\n\tfunction __mfAfterType(element, fnName, callback) {\n\t\tconst type = element?.type;\n\t\tif (typeof type !== \"function\") return TinyPatcher.after(type, fnName, callback);\n\t\tlet holder = __mfTypeHolders.get(type);\n\t\tif (!holder) {\n\t\t\tholder = { [fnName]: type };\n\t\t\tTinyPatcher.after(holder, fnName, (...args) => holder.callback(...args));\n\t\t\t__mfTypeHolders.set(type, holder);\n\t\t}\n\t\tholder.callback = callback;\n\t\telement.type = holder[fnName];\n\t}\n\tfunction patchChannelView() {"],
            ["TinyPatcher.after(value?.type, \"render\", (self, args, value) => {\n\t\t\t\tconst guildChannel", "__mfAfterType(value, \"render\", (self, args, value) => {\n\t\t\t\tconst guildChannel"],
            ["once(() => patchListThin(value.type), \"scroller\");", "if (typeof value.type === \"function\") {\n\t\t\t\t\t\t\t\tlet holder = __mfTypeHolders.get(value.type);\n\t\t\t\t\t\t\t\tif (!holder) {\n\t\t\t\t\t\t\t\t\tholder = { render: value.type };\n\t\t\t\t\t\t\t\t\t__mfTypeHolders.set(value.type, holder);\n\t\t\t\t\t\t\t\t\tpatchListThin(holder);\n\t\t\t\t\t\t\t\t}\n\t\t\t\t\t\t\t\tvalue.type = holder.render;\n\t\t\t\t\t\t\t} else once(() => patchListThin(value.type), \"scroller\");"],
            // Discord removed VIEW_THREAD from the sidebar types.
            ['filter: Filters.byKeys("VIEW_THREAD", "VIEW_MOD_REPORT"),', 'filter: Filters.byKeys("VIEW_MOD_REPORT", "VIEW_CHANNEL"),'],
        ],
    },
};

export function applyFixes(name: string, version: string | undefined, code: string) {
    const fix = PLUGIN_FIXES[name];
    if (!fix || fix.version !== version) return code;
    let out = code;
    let applied = 0;
    for (const [find, replace] of fix.edits) {
        const at = out.indexOf(find);
        if (at === -1 || out.indexOf(find, at + 1) !== -1) {
            logger.warn(`Fix for ${name} ${version} didn't match: ${find.slice(0, 60)}`);
            continue;
        }
        out = out.slice(0, at) + replace + out.slice(at + find.length);
        applied++;
    }
    logger.info(`Applied ${applied}/${fix.edits.length} compatibility fixes to ${name} ${version}`);
    return out;
}
