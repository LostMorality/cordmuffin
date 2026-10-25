/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addContextMenuPatch, NavContextMenuPatchCallback, removeContextMenuPatch } from "@api/ContextMenu";
import { popNotice, showNotice } from "@api/Notices";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import { FormSwitch } from "@components/FormSwitch";
import { Logger as VcLogger } from "@utils/Logger";
import { Alerts, ContextMenuApi, Menu, Modal, openModal, React, ReactDOM, Select, showToast, Slider, Text, TextInput, Tooltip, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { Native } from "../settings";
import { makePatcher } from "./patcher";
import * as Runtime from "./runtime";
import { Webpack } from "./webpack";

const logger = new VcLogger("Muffinshelf");
const STYLE_ROOT_ID = "vc-muffinshelf-bd-styles";

export const dataCache: Record<string, Record<string, any>> = {};
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleWrite(name: string) {
    clearTimeout(pendingWrites.get(name));
    pendingWrites.set(name, setTimeout(() => {
        pendingWrites.delete(name);
        Native.writeBdData(name, JSON.stringify(dataCache[name] ?? {}, null, 4)).catch(e => logger.error(`Saving data for ${name} failed`, e));
    }, 250));
}

const Data = {
    load: (plugin: string, key: string) => dataCache[plugin]?.[key],
    save(plugin: string, key: string, value: any) {
        (dataCache[plugin] ??= {})[key] = value;
        scheduleWrite(plugin);
    },
    delete(plugin: string, key: string) {
        if (!dataCache[plugin]) return;
        delete dataCache[plugin][key];
        scheduleWrite(plugin);
    },
    recache: () => true,
};

function styleRoot() {
    let root = document.getElementById(STYLE_ROOT_ID);
    if (!root) {
        root = document.createElement("bd-styles");
        root.id = STYLE_ROOT_ID;
        document.head.append(root);
    }
    return root;
}

const cssId = (id: string) => "bd-" + id.replace(/[^\w-]/g, "-");

const DOM = {
    addStyle(id: string, css?: string) {
        if (css === undefined) [id, css] = ["unnamed", id];
        DOM.removeStyle(id);
        const style = document.createElement("style");
        style.id = cssId(id);
        style.textContent = css;
        styleRoot().append(style);
    },
    removeStyle(id = "unnamed") {
        document.getElementById(cssId(id))?.remove();
    },
    onRemoved(node: Node, callback: () => void) {
        const observer = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                for (const removed of mutation.removedNodes) {
                    if (removed === node || removed.contains(node)) {
                        observer.disconnect();
                        callback();
                        return;
                    }
                }
            }
        });
        observer.observe(document.body, { subtree: true, childList: true });
        return () => observer.disconnect();
    },
    onAdded(selector: string, callback: (el: Element) => void) {
        const existing = document.body.querySelector(selector);
        if (existing) {
            callback(existing);
            return () => { };
        }
        const observer = new MutationObserver(() => {
            const el = document.body.querySelector(selector);
            if (!el) return;
            observer.disconnect();
            callback(el);
        });
        observer.observe(document.body, { subtree: true, childList: true });
        return () => observer.disconnect();
    },
    createElement(tag: string, options: Record<string, any> = {}, ...children: (Node | string)[]) {
        const { className, id, target, ...rest } = options;
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (id) el.id = id;
        Object.assign(el, rest);
        el.append(...children);
        if (target) document.querySelector(target)?.append(el);
        return el;
    },
    parseHTML(html: string, asFragment = false) {
        const template = document.createElement("template");
        template.innerHTML = html;
        if (asFragment) return template.content.cloneNode(true);
        const nodes = template.content.childNodes;
        return nodes.length === 1 ? nodes[0] : nodes;
    },
    escapeHTML: (html: string) => html.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`),
    injectScript: async (_id: string, url: string) => {
        const res = await Net.fetch(url);
        (0, eval)(await res.text() + `\n//# sourceURL=${url}`);
    },
    removeScript: () => { },
    get screenWidth() {
        return Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
    },
    get screenHeight() {
        return Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
    },
};

export function toNode(content: any): ReactNode {
    if (content == null) return null;
    if (typeof content === "string") return content.split("\n").map((line, i) => <Text key={i} variant="text-md/normal">{line}</Text>);
    if (Array.isArray(content)) return content.map((c, i) => <React.Fragment key={i}>{toNode(c)}</React.Fragment>);
    if (content instanceof Node) return <NodeHost node={content} />;
    if (typeof content === "function") return React.createElement(content);
    return content;
}

function NodeHost({ node }: { node: Node; }) {
    const ref = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
        ref.current?.replaceChildren(node);
    }, [node]);
    return <div ref={ref} />;
}

const toastVariant = (type?: string) => type === "success" ? "success" : type === "error" || type === "danger" ? "critical" : "default";

const UI = {
    showToast(content: string, options: { type?: string; timeout?: number; } = {}) {
        showToast({ text: String(content), variant: toastVariant(options.type), duration: options.timeout });
    },
    alert(title: string, content: any) {
        Alerts.show({ title, body: toNode(content) });
    },
    showConfirmationModal(title: string, content: any, options: Record<string, any> = {}) {
        Alerts.show({
            title,
            body: toNode(content),
            confirmText: options.confirmText ?? "Okay",
            cancelText: options.cancelText === null ? undefined : options.cancelText ?? "Cancel",
            onConfirm: options.onConfirm,
            onCancel: options.onCancel,
        });
        return "";
    },
    showNotice(content: any, options: { buttons?: { label: string; onClick?(close: () => void): void; }[]; timeout?: number; } = {}) {
        const button = options.buttons?.[0];
        showNotice(typeof content === "string" ? content : toNode(content), button?.label ?? "Close", () => button?.onClick?.(popNotice));
        if (options.timeout) setTimeout(popNotice, options.timeout);
        return popNotice;
    },
    createTooltip(node: HTMLElement, content: any) {
        if (typeof content === "string") node.title = content;
        return { show() { }, hide() { }, label: content, node };
    },
    openDialog: (options: Record<string, any>) => Native.showDialog(options),
    buildSettingsPanel: (options: { settings: SettingItem[]; onChange?(category: string | null, id: string, value: any): void; }) =>
        <SettingsPanel settings={options.settings} onChange={options.onChange} />,
    showChangelogModal(options: { title?: string; subtitle?: string; changes?: { title: string; type?: string; items: string[]; }[]; footer?: any; }) {
        return openModal(props => (
            <ErrorBoundary>
                <Modal {...props} title={options.title ?? "Changelog"} subtitle={options.subtitle} actions={[{ text: "Close", variant: "secondary", onClick: props.onClose }]}>
                    {options.changes?.map(change => (
                        <div key={change.title} className="vc-muffinshelf-changelog">
                            <Text variant="heading-md/semibold">{change.title}</Text>
                            <ul>{change.items.map(item => <li key={item}><Text variant="text-md/normal">{item}</Text></li>)}</ul>
                        </div>
                    ))}
                    {toNode(options.footer)}
                </Modal>
            </ErrorBoundary>
        ));
    },
};

interface SettingItem {
    type: string;
    id: string;
    name?: string;
    note?: string;
    value?: any;
    disabled?: boolean;
    options?: { label: string; value: any; }[];
    min?: number;
    max?: number;
    markers?: number[];
    settings?: SettingItem[];
    children?: any;
    onClick?(): void;
    collapsible?: boolean;
    shown?: boolean;
}

function SettingRow({ item, category, onChange }: { item: SettingItem; category: string | null; onChange?(category: string | null, id: string, value: any): void; }) {
    const [value, setValue] = useState(item.value);
    const update = (v: any) => {
        setValue(v);
        onChange?.(category, item.id, v);
    };

    switch (item.type) {
        case "switch":
            return <FormSwitch title={item.name} description={item.note} value={!!value} disabled={item.disabled} onChange={update} />;
        case "dropdown":
        case "radio":
            return (
                <div className="vc-muffinshelf-setting">
                    <Text variant="text-md/semibold">{item.name}</Text>
                    {item.note && <Text variant="text-sm/normal">{item.note}</Text>}
                    <Select options={item.options ?? []} select={update} isSelected={v => v === value} serialize={String} isDisabled={item.disabled} />
                </div>
            );
        case "slider":
            return (
                <div className="vc-muffinshelf-setting">
                    <Text variant="text-md/semibold">{item.name}</Text>
                    {item.note && <Text variant="text-sm/normal">{item.note}</Text>}
                    <Slider initialValue={value} minValue={item.min ?? 0} maxValue={item.max ?? 100} markers={item.markers} onValueChange={update} disabled={item.disabled} />
                </div>
            );
        case "button":
            return <Button size="small" onClick={item.onClick} disabled={item.disabled}>{item.name}</Button>;
        case "custom":
            return <>{toNode(item.children)}</>;
        case "category":
            return (
                <details className="vc-muffinshelf-category" open={item.shown !== false}>
                    <summary><Text variant="heading-md/semibold">{item.name}</Text></summary>
                    {item.settings?.map(s => <SettingRow key={s.id} item={s} category={item.id} onChange={onChange} />)}
                </details>
            );
        default:
            return (
                <div className="vc-muffinshelf-setting">
                    <Text variant="text-md/semibold">{item.name}</Text>
                    {item.note && <Text variant="text-sm/normal">{item.note}</Text>}
                    <TextInput
                        type={item.type === "number" ? "number" : item.type === "color" ? "color" : "text"}
                        value={value == null ? "" : String(value)}
                        disabled={item.disabled}
                        onChange={(v: string) => update(item.type === "number" ? Number(v) : v)}
                    />
                </div>
            );
    }
}

function SettingsPanel({ settings, onChange }: { settings: SettingItem[]; onChange?(category: string | null, id: string, value: any): void; }) {
    return (
        <Flex flexDirection="column" gap="12px">
            {settings.map(item => <SettingRow key={item.id} item={item} category={null} onChange={onChange} />)}
        </Flex>
    );
}

function base64ToBytes(base64: string) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

function bytesToBase64(bytes: Uint8Array) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

export const Net = {
    async fetch(url: string | URL, init: RequestInit = {}) {
        const headers: Record<string, string> = {};
        new Headers(init.headers).forEach((v, k) => headers[k] = v);
        let body: string | undefined;
        let bodyBase64: string | undefined;
        if (typeof init.body === "string") body = init.body;
        else if (init.body instanceof ArrayBuffer) bodyBase64 = bytesToBase64(new Uint8Array(init.body));
        else if (ArrayBuffer.isView(init.body)) bodyBase64 = bytesToBase64(new Uint8Array(init.body.buffer, init.body.byteOffset, init.body.byteLength));
        else if (init.body instanceof URLSearchParams) body = init.body.toString();

        const res = await Native.netFetch(String(url), { method: init.method, headers, body, bodyBase64 });
        const noBody = res.status === 204 || res.status === 304 || (res.status >= 100 && res.status < 200);
        const response = new Response(noBody ? null : base64ToBytes(res.bodyBase64), { status: res.status, statusText: res.statusText, headers: res.headers });
        Object.defineProperty(response, "url", { value: res.url });
        return response;
    },
};

function findInTree(tree: any, filter: (node: any) => boolean, { walkable = null as string[] | null, ignore = [] as string[] } = {}): any {
    if (typeof filter === "string") return tree?.[filter];
    const seen = new Set();
    const walk = (node: any): any => {
        if (node == null || typeof node !== "object" || seen.has(node)) return undefined;
        seen.add(node);
        try {
            if (filter(node)) return node;
        } catch { }
        const keys = walkable ?? Object.keys(node);
        for (const key of keys) {
            if (ignore.includes(key)) continue;
            let child: any;
            try {
                child = node[key];
            } catch {
                continue;
            }
            const found = walk(child);
            if (found !== undefined) return found;
        }
        return undefined;
    };
    return walk(tree);
}

function extend(target: any, ...sources: any[]) {
    for (const source of sources) {
        for (const key in source) {
            const value = source[key];
            if (value && typeof value === "object" && !Array.isArray(value)) target[key] = extend(target[key] && typeof target[key] === "object" ? target[key] : {}, value);
            else target[key] = value;
        }
    }
    return target;
}

function className(...args: any[]): string {
    return args.flatMap(arg => {
        if (!arg) return [];
        if (typeof arg === "string" || typeof arg === "number") return [String(arg)];
        if (Array.isArray(arg)) return [className(...arg)];
        if (typeof arg === "object") return Object.keys(arg).filter(k => arg[k]);
        return [];
    }).filter(Boolean).join(" ");
}

function semverCompare(a: string, b: string) {
    const pa = String(a).split(".").map(n => parseInt(n) || 0);
    const pb = String(b).split(".").map(n => parseInt(n) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
        if (diff) return Math.sign(diff);
    }
    return 0;
}

const Utils = {
    findInTree,
    extend,
    className,
    semverCompare,
    debounce<T extends (...args: any[]) => void>(fn: T, delay: number) {
        let timer: ReturnType<typeof setTimeout>;
        return (...args: Parameters<T>) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), delay);
        };
    },
    escapeHTML: DOM.escapeHTML,
    getNestedValue: (obj: any, path: string) => path.split(".").reduce((o, k) => o?.[k], obj),
    forceLoad: () => Promise.resolve([]),
};

function fiberOf(node: any) {
    if (!node) return undefined;
    const key = Object.keys(node).find(k => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance"));
    return key ? node[key] : undefined;
}

const ReactUtils = {
    get rootInstance() {
        return fiberOf(document.getElementById("app-mount"))?.child;
    },
    getInternalInstance: fiberOf,
    getOwnerInstance(node: any, { include, exclude = ["Popout", "Tooltip", "Scroller", "BackgroundFlash"], filter = (_: any) => true }: { include?: string[]; exclude?: string[]; filter?(i: any): boolean; } = {}) {
        const names = include ?? exclude;
        const excluding = !include;
        for (let fiber = fiberOf(node); fiber; fiber = fiber.return) {
            const instance = fiber.stateNode;
            if (!instance || instance instanceof HTMLElement || typeof instance !== "object") continue;
            const name = fiber.type?.displayName ?? fiber.type?.name;
            if (name && names.includes(name) === excluding) continue;
            if (filter(instance)) return instance;
        }
        return null;
    },
    wrapElement: (element: HTMLElement) => () => <NodeHost node={element} />,
    wrapInHooks: (component: any) => component,
};

const menuPatches = new WeakMap<object, [string, NavContextMenuPatchCallback][]>();

const ContextMenu = {
    patch(navId: string | string[], callback: (tree: any, props: any) => void) {
        const ids = [navId].flat();
        const entries = ids.map(id => {
            const wrapped: NavContextMenuPatchCallback = (children, props) => {
                const tree = { type: Menu.Menu, props: { ...props, navId: id, children } };
                callback(tree, props);
                if (tree.props.children !== children) {
                    const next = Array.isArray(tree.props.children) ? tree.props.children : [tree.props.children];
                    children.splice(0, children.length, ...next);
                }
            };
            addContextMenuPatch(id, wrapped);
            return [id, wrapped] as [string, NavContextMenuPatchCallback];
        });
        menuPatches.set(callback, [...menuPatches.get(callback) ?? [], ...entries]);
        return () => ContextMenu.unpatch(navId, callback);
    },
    unpatch(navId: string | string[], callback: any) {
        const ids = [navId].flat();
        const entries = menuPatches.get(callback) ?? [];
        for (const [id, wrapped] of entries) if (ids.includes(id)) removeContextMenuPatch(id, wrapped);
        menuPatches.set(callback, entries.filter(([id]) => !ids.includes(id)));
    },
    buildItem(props: Record<string, any>): ReactNode {
        const { type, label, items, children, ...rest } = props;
        const id = rest.id ?? (typeof label === "string" ? label.toLowerCase().replace(/\W+/g, "-") : `item-${Math.random().toString(36).slice(2)}`);
        if (type === "separator") return <Menu.MenuSeparator />;
        if (type === "group") return <Menu.MenuGroup {...rest}>{ContextMenu.buildMenuChildren(items ?? children ?? [])}</Menu.MenuGroup>;
        if (type === "toggle") return <Menu.MenuCheckboxItem {...rest} id={id} label={label} checked={rest.checked ?? rest.active} action={rest.action ?? rest.onClick} />;
        if (type === "radio") return <Menu.MenuRadioItem {...rest} id={id} group={rest.group ?? id} label={label} checked={rest.checked ?? rest.active} action={rest.action ?? rest.onClick} />;
        if (type === "control") return <Menu.MenuControlItem {...rest} id={id} label={label} control={rest.control} />;
        const sub = type === "submenu" || items || children ? ContextMenu.buildMenuChildren(items ?? children ?? []) : undefined;
        return <Menu.MenuItem {...rest} id={id} label={label} action={rest.action ?? rest.onClick}>{sub}</Menu.MenuItem>;
    },
    buildMenuChildren(setup: any[]): ReactNode[] {
        if (!Array.isArray(setup)) return [setup];
        return setup.map((item, i) => {
            if (item?.type === "group" && item.items) return <Menu.MenuGroup key={i}>{ContextMenu.buildMenuChildren(item.items)}</Menu.MenuGroup>;
            return <React.Fragment key={i}>{item && typeof item === "object" && !item.$$typeof ? ContextMenu.buildItem(item) : item}</React.Fragment>;
        });
    },
    buildMenu(setup: any[]) {
        return (props: Record<string, any>) => <Menu.Menu navId="muffinshelf-bd-menu" onClose={ContextMenuApi.closeContextMenu} {...props}>{ContextMenu.buildMenuChildren(setup)}</Menu.Menu>;
    },
    open(event: MouseEvent, menuComponent: any) {
        ContextMenuApi.openContextMenu(event as any, (props: any) => React.createElement(menuComponent, { ...props, onClose: ContextMenuApi.closeContextMenu }));
    },
    close: () => ContextMenuApi.closeContextMenu(),
    get Item() {
        return Menu.MenuItem;
    },
    get Separator() {
        return Menu.MenuSeparator;
    },
    get Group() {
        return Menu.MenuGroup;
    },
    get Menu() {
        return Menu.Menu;
    },
    get CheckboxItem() {
        return Menu.MenuCheckboxItem;
    },
    get RadioItem() {
        return Menu.MenuRadioItem;
    },
    get ControlItem() {
        return Menu.MenuControlItem;
    },
};

const makeLogger = (name?: string) => {
    const log = (level: "log" | "info" | "warn" | "error" | "debug") => (...args: any[]) => {
        const [prefix, ...rest] = name ? [name, ...args] : args;
        console[level](`%c[${prefix}]`, "color:#e5a04b;font-weight:bold", ...rest);
    };
    return { log: log("log"), info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug"), stacktrace: log("error") };
};

const Components = {
    get Tooltip() {
        return Tooltip;
    },
    get Text() {
        return Text;
    },
    Button,
    Flex,
    ErrorBoundary,
    SwitchInput: ({ value, onChange, disabled }: { value: boolean; onChange(v: boolean): void; disabled?: boolean; }) =>
        <FormSwitch title="" value={value} onChange={onChange} disabled={disabled} hideBorder />,
    SettingItem: ({ name, note, children }: { name?: string; note?: string; children?: ReactNode; }) => (
        <div className="vc-muffinshelf-setting">
            <Text variant="text-md/semibold">{name}</Text>
            {note && <Text variant="text-sm/normal">{note}</Text>}
            {children}
        </div>
    ),
    SettingGroup: ({ name, children }: { name?: string; children?: ReactNode; }) => (
        <details className="vc-muffinshelf-category" open>
            <summary><Text variant="heading-md/semibold">{name}</Text></summary>
            {children}
        </details>
    ),
    TextInput: (props: any) => <TextInput {...props} />,
};

const Plugins = {
    get folder() {
        return Runtime.info.bdFolder;
    },
    getAll: () => Runtime.getAll().map(p => p.instance ?? p.meta),
    get: (idOrName: string) => {
        const p = Runtime.find(idOrName);
        return p ? { ...p.meta, instance: p.instance, filename: p.file } : undefined;
    },
    isEnabled: (idOrName: string) => !!Runtime.find(idOrName)?.enabled,
    enable: (idOrName: string) => Runtime.setEnabled(idOrName, true),
    disable: (idOrName: string) => Runtime.setEnabled(idOrName, false),
    toggle: (idOrName: string) => Runtime.setEnabled(idOrName, !Runtime.find(idOrName)?.enabled),
    reload: (idOrName: string) => Runtime.reload(idOrName),
};

const Themes = {
    folder: "",
    getAll: () => [],
    get: () => undefined,
    isEnabled: () => false,
    enable() { },
    disable() { },
    toggle() { },
    reload() { },
};

let fullReactDOM: Record<string, any> | undefined;

const sharedApi = {
    Webpack,
    UI,
    Utils,
    ReactUtils,
    ContextMenu,
    Components,
    Plugins,
    Themes,
    Net,
    get React() {
        return React;
    },
    get ReactDOM() {
        return fullReactDOM ??= { ...ReactDOM, ...Webpack.getByKeys("createRoot") };
    },
    version: "1.13.0",
};

class BdApiClass {
    static Patcher = makePatcher();
    static Data = Data;
    static DOM = DOM;
    static Logger = makeLogger();

    Patcher!: ReturnType<typeof makePatcher>;
    Data!: { load(key: string): any; save(key: string, value: any): void; delete(key: string): void; recache(): boolean; };
    DOM!: typeof DOM;
    Logger!: ReturnType<typeof makeLogger>;

    constructor(pluginName: string) {
        if (!pluginName) return BdApi as any;
        Object.assign(this, sharedApi);
        this.Patcher = makePatcher(pluginName);
        this.Data = {
            load: key => Data.load(pluginName, key),
            save: (key, value) => Data.save(pluginName, key, value),
            delete: key => Data.delete(pluginName, key),
            recache: () => true,
        };
        this.DOM = {
            ...DOM,
            addStyle: (id: string, css?: string) => css === undefined ? DOM.addStyle(pluginName, id) : DOM.addStyle(`${pluginName}-${id}`, css),
            removeStyle: (id?: string) => DOM.removeStyle(id ? `${pluginName}-${id}` : pluginName),
        } as typeof DOM;
        this.Logger = makeLogger(pluginName);
    }
}

for (const [key, desc] of Object.entries(Object.getOwnPropertyDescriptors(sharedApi))) {
    Object.defineProperty(BdApiClass, key, desc);
}

const legacy = {
    findModule: (filter: any) => Webpack.getModule(filter),
    findAllModules: (filter: any) => Webpack.getModules(filter),
    findModuleByProps: (...props: string[]) => Webpack.getByKeys(...props),
    findModuleByPrototypes: (...protos: string[]) => Webpack.getByPrototypeKeys(...protos),
    findModuleByDisplayName: (name: string) => Webpack.getByDisplayName(name),
    getInternalInstance: fiberOf,
    injectCSS: (id: string, css: string) => DOM.addStyle(id, css),
    clearCSS: (id: string) => DOM.removeStyle(id),
    loadData: Data.load,
    getData: Data.load,
    saveData: Data.save,
    setData: Data.save,
    deleteData: Data.delete,
    showToast: UI.showToast,
    alert: UI.alert,
    showConfirmationModal: UI.showConfirmationModal,
    onRemoved: DOM.onRemoved,
    isSettingEnabled: () => false,
    enableSetting() { },
    disableSetting() { },
    linkJS: DOM.injectScript,
    unlinkJS() { },
    monkeyPatch(what: any, methodName: string, options: Record<string, any>) {
        const { before, after, instead, once = false, silent = false } = options;
        const caller = "MonkeyPatch";
        const unpatches: (() => void)[] = [];
        const cancel = () => unpatches.forEach(u => u());
        const wrap = (fn: (data: any) => any) => (thisObject: any, methodArguments: any[], extra?: any) => {
            const data = { thisObject, methodArguments, returnValue: extra, cancelPatch: cancel, originalMethod: what[methodName].__originalFunction, callOriginalMethod: () => data.returnValue = data.originalMethod.apply(thisObject, methodArguments) };
            const ret = fn(data);
            if (once) cancel();
            return ret ?? data.returnValue;
        };
        if (!silent) logger.debug(`monkeyPatch on ${methodName}`);
        if (before) unpatches.push(BdApiClass.Patcher.before(caller, what, methodName, wrap(before)));
        if (instead) unpatches.push(BdApiClass.Patcher.instead(caller, what, methodName, (t: any, a: any[]) => wrap(instead)(t, a)));
        if (after) unpatches.push(BdApiClass.Patcher.after(caller, what, methodName, (t: any, a: any[], r: any) => wrap(after)(t, a, r)));
        return cancel;
    },
};

Object.assign(BdApiClass, legacy);

export const BdApi = BdApiClass as typeof BdApiClass & typeof sharedApi & typeof legacy;
export { ContextMenu, Data, DOM, UI };
