/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { registerCommand, sendBotMessage, unregisterCommand } from "@api/Commands";
import { showNotification } from "@api/Notifications";
import { Button } from "@components/Button";
import { openInviteModal } from "@utils/discord";
import { Checkbox, closeModal, ColorPicker, Modal, openModal, React, Select, Slider, Text, TextInput, useEffect, useReducer, useRef, useState } from "@webpack/common";
import type { ComponentType, ReactElement, ReactNode } from "react";

// BdApi pieces modelled on BetterDiscord's own versions (src/betterdiscord/ui, stores/base, modules/nodepatcher).

const MEMO = Symbol.for("react.memo");
const FORWARD_REF = Symbol.for("react.forward_ref");

export function getType(type: any) {
    for (let i = 0; i < 10 && type; i++) {
        if (type.$$typeof === MEMO) type = type.type;
        else if (type.$$typeof === FORWARD_REF) type = type.render;
        else break;
    }
    return type;
}

// --- ReactUtils.wrapInHooks: call a function component outside React with stand-in hooks, like BetterDiscord does ---

const USE_ERROR = "Muffinshelf: use() of a pending promise";

const standInHooks: Record<string, (...args: any[]) => any> = {
    use(usable: any) {
        if (typeof usable?.then !== "function") return usable?._currentValue;
        let value: any;
        let done = false;
        usable.then((v: any) => {
            value = v;
            done = true;
        });
        if (!done) throw new Error(USE_ERROR);
        return value;
    },
    readContext: (context: any) => context?._currentValue,
    useContext: (context: any) => context?._currentValue,
    useMemo: (factory: () => any) => factory(),
    useState: (initial: any) => [typeof initial === "function" ? initial() : initial, () => { }],
    useReducer: (_reducer: any, initial: any, init?: (a: any) => any) => [init ? init(initial) : initial, () => { }],
    useRef: (value: any = null) => ({ current: value }),
    useCallback: (callback: any) => callback,
    useEffect() { },
    useLayoutEffect() { },
    useInsertionEffect() { },
    useImperativeHandle() { },
    useDebugValue() { },
    useTransition: () => [false, (callback: () => void) => callback()],
    useDeferredValue: (value: any) => value,
    useSyncExternalStore: (_subscribe: any, getSnapshot: () => any) => getSnapshot(),
    useId: () => Math.random().toString(36).slice(2, 11),
    useOptimistic: (passthrough: any) => [passthrough, () => { }],
    useFormState: (_action: any, initial: any) => [initial, () => { }, false],
    useActionState: (_action: any, initial: any) => [initial, () => { }, false],
};

export function wrapInHooks(component: any, customPatches: Record<string, (...args: any[]) => any> = {}) {
    const fc = getType(component);
    return function wrappedComponent(props: any) {
        const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
            ?? (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED?.ReactCurrentDispatcher;
        if (!internals) return fc(props);
        const key = "H" in internals ? "H" : "current";
        const previous = internals[key];
        internals[key] = { ...previous, ...standInHooks, ...customPatches };
        try {
            return fc(props);
        } catch (e) {
            if (e instanceof Error && e.message === USE_ERROR) return null;
            throw e;
        } finally {
            internals[key] = previous;
        }
    };
}

export abstract class Store {
    initialize() { }
    #listeners = new Set<() => void>();
    addChangeListener(callback: () => void) {
        this.#listeners.add(callback);
        return () => this.removeChangeListener(callback);
    }
    removeChangeListener(callback: () => void) {
        this.#listeners.delete(callback);
    }
    emitChange() {
        for (const listener of this.#listeners) listener();
    }
}

type Patch = (props: any, res: ReactNode, instance?: any) => ReactNode;

// Wraps an element's component so a callback can change what it renders. One patcher per job, as in BetterDiscord.
export class NodePatcher {
    #id = Symbol("Muffinshelf.NodePatcher");
    #cache = new WeakMap<object, any>();
    #destroyed = false;

    patch(node: ReactElement<any, any>, callback: Patch) {
        if (this.#destroyed || !node?.type) return;
        const { type } = node as { type: any; };
        const cached = this.#cache.get(type) ?? type[this.#id];
        if (cached) {
            (node as any).type = cached;
            return;
        }
        const isDestroyed = () => this.#destroyed;
        let newType: any;

        if (type.prototype?.isReactComponent) {
            newType = class extends (type as any) {
                render() {
                    const res = super.render();
                    if (isDestroyed()) return res;
                    const ret = callback(this.props, res, this);
                    return ret === undefined ? res : ret;
                }
            };
        } else {
            const fc = getType(type);
            const wrapped = function (...args: any[]) {
                const res = fc(...args);
                if (isDestroyed()) return res;
                const props = args.length === 1 ? args[0] : Object.assign({ ref: args[1] }, args[0]);
                const ret = callback(props, res);
                return ret === undefined ? res : ret;
            };
            newType = wrapped;
            if (typeof type === "object") {
                if (type.type) newType = React.memo(type.type?.render ? React.forwardRef(wrapped as any) : wrapped as any, type.compare);
                else if (type.render) newType = React.forwardRef(wrapped as any);
            }
            for (const prop of ["defaultProps", "displayName", "propTypes"]) {
                const desc = Object.getOwnPropertyDescriptor(type, prop);
                if (desc) Object.defineProperty(newType, prop, desc);
            }
        }

        this.#cache.set(type, newType);
        this.#cache.set(newType, newType);
        newType[this.#id] = newType;
        (node as any).type = newType;
    }

    destroy() {
        this.#destroyed = true;
    }
}

export function useForceUpdate() {
    return useReducer((n: number) => n + 1, 0);
}

type Subscribable = { addChangeListener(cb: () => void): void; removeChangeListener(cb: () => void): void; };

const shallowEqual = (a: any, b: any) => {
    if (Object.is(a, b)) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every(k => Object.is(a[k], b[k]));
};

export function useStateFromStores<T>(stores: Subscribable | Subscribable[], factory: () => T, deps: any[] = [], isEqual: true | ((a: T, b: T) => boolean) = Object.is) {
    const compare = isEqual === true ? shallowEqual : isEqual;
    const [, force] = useForceUpdate();
    const factoryRef = useRef(factory);
    factoryRef.current = factory;
    const state = useRef<T>(undefined as T);
    const lastDeps = useRef<any[] | null>(null);
    if (!lastDeps.current || deps.length !== lastDeps.current.length || deps.some((d, i) => !Object.is(d, lastDeps.current![i]))) {
        state.current = factory();
        lastDeps.current = deps;
    }
    const list = [stores].flat();
    useEffect(() => {
        const onChange = () => {
            const next = factoryRef.current();
            if (compare(state.current, next)) return;
            state.current = next;
            force();
        };
        list.forEach(s => s.addChangeListener(onChange));
        return () => list.forEach(s => s.removeChangeListener(onChange));
    }, list);
    return state.current;
}

// --- Setting inputs with BetterDiscord's prop names ---

interface InputProps<T> {
    value?: T;
    defaultValue?: T;
    onChange?(value: T): void;
    disabled?: boolean;
}

function useValue<T>({ value, defaultValue, onChange }: InputProps<T>): [T | undefined, (v: T) => void] {
    const [state, setState] = useState(value ?? defaultValue);
    useEffect(() => setState(value ?? defaultValue), [value]);
    return [state, v => {
        setState(v);
        onChange?.(v);
    }];
}

const toHex = (n: number) => `#${(n >>> 0).toString(16).padStart(6, "0").slice(-6)}`;
const fromColor = (c: any) => typeof c === "number" ? c : parseInt(String(c ?? "#000000").replace("#", ""), 16) || 0;

export const Inputs = {
    DropdownInput(props: InputProps<any> & { options?: { label: string; value: any; }[]; style?: string; }) {
        const [value, set] = useValue(props);
        return <Select options={props.options ?? []} select={set} isSelected={v => v === value} serialize={String} isDisabled={props.disabled} />;
    },
    RadioInput(props: InputProps<any> & { name?: string; options?: { name?: string; label?: string; value: any; desc?: string; description?: string; }[]; }) {
        const [value, set] = useValue(props);
        return (
            <div className="vc-muffinshelf-radio" role="radiogroup">
                {props.options?.map(o => (
                    <label key={String(o.value)} className="vc-muffinshelf-radio-option">
                        <input type="radio" name={props.name} checked={o.value === value} disabled={props.disabled} onChange={() => set(o.value)} />
                        <Text variant="text-md/normal">{o.name ?? o.label}</Text>
                        {(o.desc ?? o.description) && <Text variant="text-sm/normal">{o.desc ?? o.description}</Text>}
                    </label>
                ))}
            </div>
        );
    },
    NumberInput(props: InputProps<number> & { min?: number; max?: number; step?: number; }) {
        const [value, set] = useValue(props);
        return (
            <TextInput
                type="number"
                value={value == null ? "" : String(value)}
                disabled={props.disabled}
                min={props.min}
                max={props.max}
                step={props.step}
                onChange={(v: string) => {
                    const n = Number(v);
                    if (!Number.isNaN(n)) set(Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, n)));
                }}
            />
        );
    },
    SliderInput(props: InputProps<number> & { min?: number; max?: number; step?: number; markers?: number[]; units?: string; }) {
        const [value, set] = useValue(props);
        return <Slider initialValue={value ?? props.min ?? 0} minValue={props.min ?? 0} maxValue={props.max ?? 100} markers={props.markers} stickToMarkers={!!props.markers} onValueChange={set} disabled={props.disabled} onValueRender={(v: number) => `${Math.round(v * 100) / 100}${props.units ?? ""}`} />;
    },
    ColorInput(props: InputProps<string | number> & { colors?: number[]; }) {
        const [value, set] = useValue(props);
        const asNumber = typeof (props.value ?? props.defaultValue) === "number";
        return <ColorPicker color={fromColor(value)} showEyeDropper onChange={(c: number) => set(asNumber ? c : toHex(c))} />;
    },
    KeybindInput(props: InputProps<string[]> & { clearable?: boolean; }) {
        const [value, set] = useValue(props);
        const [recording, setRecording] = useState(false);
        return (
            <Button
                size="small"
                variant="secondary"
                disabled={props.disabled}
                onClick={() => setRecording(true)}
                onKeyDown={(e: React.KeyboardEvent) => {
                    if (!recording) return;
                    e.preventDefault();
                    const keys = [e.ctrlKey && "Control", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta"].filter(Boolean) as string[];
                    if (!["Control", "Alt", "Shift", "Meta"].includes(e.key)) {
                        set([...keys, e.key.length === 1 ? e.key.toUpperCase() : e.key]);
                        setRecording(false);
                    }
                }}
            >
                {recording ? "Press a key..." : value?.length ? value.join(" + ") : "No keybind"}
            </Button>
        );
    },
    SearchInput(props: InputProps<string> & { placeholder?: string; onKeyDown?(e: any): void; }) {
        const [value, set] = useValue(props);
        return <TextInput value={value ?? ""} placeholder={props.placeholder ?? "Search..."} onChange={set} disabled={props.disabled} onKeyDown={props.onKeyDown} />;
    },
    Checkbox(props: InputProps<boolean> & { label?: ReactNode; }) {
        const [value, set] = useValue(props);
        return <Checkbox value={!!value} disabled={props.disabled} onChange={(_: any, v: boolean) => set(v)}><Text variant="text-sm/normal">{props.label}</Text></Checkbox>;
    },
};

export const Spinner = Object.assign(({ type }: { type?: string; }) => (
    <div className="vc-muffinshelf-spinner" role="status" aria-label="Loading" data-type={type}>
        <span />
    </div>
), {
    Type: Object.freeze({
        WANDERING_CUBES: "wandering-cubes",
        CHASING_DOTS: "chasing-dots",
        PULSING_ELLIPSIS: "pulsing-ellipsis",
        SPINNING_CIRCLE: "spinning-circle",
        SPINNING_CIRCLE_SIMPLE: "spinning-circle-simple",
        LOW_MOTION: "low-motion",
    }),
});

// BetterDiscord's Modal parts, mapped onto Discord's own modal.
const BdModal = Object.assign(
    ({ children, ...props }: Record<string, any>) => <Modal {...props as any} title={props.title ?? ""}>{children}</Modal>,
    {
        Root: ({ children, ...props }: Record<string, any>) => <Modal {...props as any} title="">{children}</Modal>,
        Header: ({ children }: { children?: ReactNode; }) => <div className="vc-muffinshelf-modal-header">{children}</div>,
        Content: ({ children }: { children?: ReactNode; }) => <div className="vc-muffinshelf-modal-content">{children}</div>,
        Footer: ({ children }: { children?: ReactNode; }) => <div className="vc-muffinshelf-modal-footer">{children}</div>,
        CloseButton: ({ onClick }: { onClick?(): void; }) => <Button size="small" variant="secondary" onClick={onClick}>Close</Button>,
        Sizes: { SMALL: "small", MEDIUM: "medium", LARGE: "large", DYNAMIC: "dynamic" },
    }
);
export { BdModal as Modal };

export const showInviteModal = (code: string) => openInviteModal(String(code).replace(/^.*\//, "")).catch(() => null);

// --- UI.showNotification / openFloatingWindow, DOM.animate, Utils.cache ---

let notificationId = 0;
const visibleNotifications = new Set<string>();

export function showBdNotification(options: { id?: string; title?: string; content?: any; type?: string; duration?: number; icon?: any; onClick?(): void; onClose?(): void; actions?: { label: string; onClick?(): void; }[]; }) {
    const id = options.id ?? `muffinshelf-${++notificationId}`;
    const handle = {
        id,
        isVisible: () => visibleNotifications.has(id),
        close: () => void visibleNotifications.delete(id),
    };
    // Like BetterDiscord, showing an id that's already up returns the existing one instead of stacking a copy.
    if (visibleNotifications.has(id)) return handle;
    visibleNotifications.add(id);
    const { content } = options;
    showNotification({
        title: String(options.title ?? ""),
        body: typeof content === "string" ? content : "",
        richBody: typeof content === "string" || content == null ? undefined : content,
        color: { success: "var(--status-positive)", error: "var(--status-danger)", warning: "var(--status-warning)" }[options.type ?? ""] ?? undefined,
        permanent: options.duration === Infinity || options.duration === 0,
        onClick: options.onClick ?? options.actions?.[0]?.onClick,
        onClose: () => {
            visibleNotifications.delete(id);
            options.onClose?.();
        },
        noPersist: true,
    });
    return handle;
}

const floating = new Map<string, string>();

export function openFloatingWindow(win: { id: string; title?: string; content?: any; onClose?(): void; }) {
    if (typeof win.id !== "string") throw new Error("Floating window requires id");
    const key = openModal(props => (
        <Modal {...props as any} title={win.title ?? ""} onClose={() => {
            floating.delete(win.id);
            win.onClose?.();
            props.onClose();
        }}>
            {typeof win.content === "function" ? React.createElement(win.content) : win.content}
        </Modal>
    ));
    floating.set(win.id, key);
    return {
        close() {
            const k = floating.get(win.id);
            if (k) closeModal(k);
            floating.delete(win.id);
        },
        isOpened: () => floating.has(win.id),
    };
}

export function animate(update: (progress: number) => void, duration: number, options: { timing?(t: number): number; } = {}) {
    const timing = options.timing ?? ((t: number) => t);
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        update(timing(t));
        if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
}

export const cache = Object.assign(<T,>(factory: () => T) => {
    let done = false;
    let value: T;
    return () => {
        if (!done) {
            value = factory();
            done = true;
        }
        return value;
    };
}, {
    proxy<T extends object>(factory: () => T) {
        const get = cache(factory);
        return new Proxy({} as T, {
            get: (_, key) => (get() as any)?.[key],
            has: (_, key) => key in Object(get()),
            ownKeys: () => Reflect.ownKeys(Object(get())),
            getOwnPropertyDescriptor: (_, key) => {
                const desc = Reflect.getOwnPropertyDescriptor(Object(get()), key);
                return desc && { ...desc, configurable: true };
            },
        });
    },
});

// --- Commands: BetterDiscord slash commands on top of Equicord's commands API ---

const CommandTypes = { CHAT_INPUT: 1, USER: 2, MESSAGE: 3 };
const InputTypes = { BUILT_IN: 0, TEXT: 1, SEARCH: 2, BOT: 3, PLACEHOLDER: 4 };
const OptionTypes = { SUB_COMMAND: 1, SUB_COMMAND_GROUP: 2, STRING: 3, INTEGER: 4, BOOLEAN: 5, USER: 6, CHANNEL: 7, ROLE: 8, MENTIONABLE: 9, NUMBER: 10, ATTACHMENT: 11 };
const MessageEmbedTypes = { IMAGE: "image", VIDEO: "video", LINK: "link", ARTICLE: "article", TWEET: "tweet", RICH: "rich", GIFV: "gifv" };
const registered = new Map<string, Map<string, any>>();

interface BdCommand {
    id: string;
    name: string;
    description?: string;
    options?: any[];
    inputType?: number;
    execute(options: any[], ctx: { channel: any; guild?: any; }): any;
}

function registerBdCommand(caller: string, command: BdCommand) {
    if (!caller || typeof command !== "object" || !command?.id || !command.name || typeof command.execute !== "function") return undefined;
    const mine = registered.get(caller) ?? new Map();
    if (mine.has(command.id)) throw new Error(`Command with id bd-${caller}-${command.id} is already registered`);
    const builtIn = command.inputType === undefined || command.inputType === InputTypes.BUILT_IN;
    const vcCommand: any = {
        name: command.name,
        description: command.description || command.name,
        options: (command.options ?? []).map(o => ({ ...o, description: o.description || o.name, required: !!o.required })),
        inputType: builtIn ? InputTypes.BUILT_IN : command.inputType,
        execute: async (args: any[], ctx: any) => {
            const result = await command.execute(args, { channel: ctx.channel, guild: ctx.guild });
            if (!builtIn) return result;
            if (result && typeof result === "object" && !Array.isArray(result) && (typeof result.content === "string" || result.embeds)) {
                const embeds = result.embeds ? [result.embeds].flat().map((e: any) => ({ ...e, type: e.type || "rich" })) : undefined;
                sendBotMessage(ctx.channel.id, { content: typeof result.content === "string" ? result.content : undefined, embeds, author: { username: caller } as any });
            }
            return undefined;
        },
    };
    registerCommand(vcCommand, `Muffinshelf (${caller})`);
    mine.set(command.id, vcCommand);
    registered.set(caller, mine);
    return () => unregisterBdCommand(caller, command.id);
}

function unregisterBdCommand(caller: string, id: string) {
    const mine = registered.get(caller);
    const cmd = mine?.get(id);
    if (!cmd) return;
    unregisterCommand(cmd.name);
    mine!.delete(id);
    if (!mine!.size) registered.delete(caller);
}

function unregisterAllBdCommands(caller: string) {
    for (const id of [...registered.get(caller)?.keys() ?? []]) unregisterBdCommand(caller, id);
}

const Types = Object.freeze({ OptionTypes, CommandTypes, InputTypes, MessageEmbedTypes });

export const Commands = {
    Types,
    register: registerBdCommand,
    unregister: unregisterBdCommand,
    unregisterAll: unregisterAllBdCommands,
    getCommandsByCaller: (caller: string) => [...registered.get(caller)?.values() ?? []],
};

export const boundCommands = (caller: string) => ({
    Types,
    register: (command: BdCommand) => registerBdCommand(caller, command),
    unregister: (id: string) => unregisterBdCommand(caller, id),
    unregisterAll: () => unregisterAllBdCommands(caller),
    getCommandsByCaller: () => Commands.getCommandsByCaller(caller),
});

export function clearCommands() {
    for (const caller of [...registered.keys()]) unregisterAllBdCommands(caller);
}

export type { ComponentType };
