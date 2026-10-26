/*
 * cordmuffin
 * Copyright (c) 2026 cordmuffin contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";

const logger = new Logger("Muffinshelf");

type PatchType = "before" | "instead" | "after";
type AnyFn = (...args: any[]) => any;

interface ChildPatch {
    caller: string;
    type: PatchType;
    id: number;
    callback: AnyFn;
    unpatch: () => void;
}

interface Patch {
    module: any;
    functionName: PropertyKey;
    original: AnyFn;
    proxy: AnyFn;
    descriptor: PropertyDescriptor | undefined;
    counter: number;
    children: ChildPatch[];
}

const patches: Patch[] = [];

function runChildren(patch: Patch, thisArg: any, args: any[]) {
    const { children, original } = patch;
    for (const child of children) {
        if (child.type !== "before") continue;
        try {
            child.callback(thisArg, args);
        } catch (e) {
            logger.error(`${child.caller} before patch on ${String(patch.functionName)} threw`, e);
        }
    }

    const insteads = children.filter(c => c.type === "instead");
    let result: any;
    if (!insteads.length) {
        result = original.apply(thisArg, args);
    } else {
        for (const child of insteads) {
            try {
                const ret = child.callback(thisArg, args, original.bind(thisArg));
                if (ret !== undefined) result = ret;
            } catch (e) {
                logger.error(`${child.caller} instead patch on ${String(patch.functionName)} threw`, e);
            }
        }
    }

    for (const child of children) {
        if (child.type !== "after") continue;
        try {
            const ret = child.callback(thisArg, args, result);
            if (ret !== undefined) result = ret;
        } catch (e) {
            logger.error(`${child.caller} after patch on ${String(patch.functionName)} threw`, e);
        }
    }
    return result;
}

function setProperty(module: any, key: PropertyKey, value: AnyFn) {
    try {
        module[key] = value;
        if (module[key] === value) return;
    } catch { }
    Object.defineProperty(module, key, { value, writable: true, configurable: true, enumerable: true });
}

function makePatch(module: any, functionName: PropertyKey): Patch {
    const original: AnyFn = module[functionName];
    const descriptor = Object.getOwnPropertyDescriptor(module, functionName);
    const patch = { module, functionName, original, descriptor, counter: 0, children: [] } as unknown as Patch;

    patch.proxy = function (this: any, ...args: any[]) {
        if (new.target) return Reflect.construct(original, args, new.target);
        return runChildren(patch, this, args);
    };
    Object.assign(patch.proxy, original);
    Object.defineProperties(patch.proxy, {
        toString: { value: () => original.toString(), configurable: true, writable: true },
        __originalFunction: { value: original, configurable: true, writable: true },
    });
    if (original.prototype) patch.proxy.prototype = original.prototype;

    setProperty(module, functionName, patch.proxy);
    patches.push(patch);
    return patch;
}

function revert(patch: Patch) {
    if (patch.module[patch.functionName] === patch.proxy) {
        // Assign first so a setter (mapped objects, writable webpack exports) puts the original back underneath too.
        setProperty(patch.module, patch.functionName, patch.original);
        if (patch.descriptor?.configurable) {
            try {
                Object.defineProperty(patch.module, patch.functionName, patch.descriptor);
            } catch { }
        }
    }
    patches.splice(patches.indexOf(patch), 1);
}

export function pushPatch(caller: string, module: any, functionName: PropertyKey, callback: AnyFn, type: PatchType) {
    if (!module || typeof callback !== "function") return () => { };
    if (typeof module[functionName] !== "function") {
        logger.warn(`${caller} tried to patch ${String(functionName)}, which isn't a function`);
        return () => { };
    }

    const patch = patches.find(p => p.module === module && p.functionName === functionName) ?? makePatch(module, functionName);
    const child: ChildPatch = {
        caller,
        type,
        id: patch.counter++,
        callback,
        unpatch: () => {
            const i = patch.children.indexOf(child);
            if (i !== -1) patch.children.splice(i, 1);
            if (!patch.children.length) revert(patch);
        }
    };
    patch.children.push(child);
    return child.unpatch;
}

export function unpatchAll(caller: string) {
    for (const patch of [...patches]) {
        for (const child of [...patch.children]) {
            if (child.caller === caller) child.unpatch();
        }
    }
}

export function getPatchesByCaller(caller: string) {
    return patches.flatMap(p => p.children.filter(c => c.caller === caller));
}

export function makePatcher(boundCaller?: string) {
    const make = (type: PatchType) => (...args: any[]) => {
        const [caller, module, name, callback] = boundCaller ? [boundCaller, ...args] : args;
        return pushPatch(caller, module, name, callback, type);
    };
    return {
        before: make("before"),
        instead: make("instead"),
        after: make("after"),
        unpatchAll: (caller?: string) => unpatchAll(boundCaller ?? caller ?? ""),
        getPatchesByCaller: (caller?: string) => getPatchesByCaller(boundCaller ?? caller ?? ""),
    };
}
