function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Writable, computed, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const KEY = "k";
const ANY_KEY: string = "k";
const __cfLift_1 = __cfHelpers.lift<{
    n: __cfHelpers.ReadonlyCell<number>;
    catalog: __cfHelpers.ReadonlyCell<Record<string, any>>;
    key: __cfHelpers.ReadonlyCell<string>;
}, boolean>(({ n, catalog, key }) => n.get() === 1 && catalog.get().offers[key.get()].space === "room", {
    type: "object",
    properties: {
        n: {
            type: "number",
            asCell: ["readonly"]
        },
        catalog: {
            type: "object",
            properties: {},
            additionalProperties: true,
            asCell: ["readonly"]
        },
        key: {
            type: "string",
            asCell: ["readonly"]
        }
    },
    required: ["n", "catalog", "key"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift<{
    n: __cfHelpers.ReadonlyCell<number>;
    catalog: __cfHelpers.ReadonlyCell<Record<string, any>>;
}, boolean>(({ n, catalog }) => n.get() === 1 && catalog.get().offers[ANY_KEY].space === "room", {
    type: "object",
    properties: {
        n: {
            type: "number",
            asCell: ["readonly"]
        },
        catalog: {
            type: "object",
            properties: {},
            additionalProperties: true,
            asCell: ["readonly"]
        }
    },
    required: ["n", "catalog"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_3 = __cfHelpers.lift<{
    n: __cfHelpers.ReadonlyCell<number>;
    catalog: __cfHelpers.ReadonlyCell<Record<string, any>>;
}, boolean>(({ n, catalog }) => n.get() === 1 && catalog.get().offers[String(KEY)].space === "room", {
    type: "object",
    properties: {
        n: {
            type: "number",
            asCell: ["readonly"]
        },
        catalog: {
            type: "object",
            properties: {},
            additionalProperties: true,
            asCell: ["readonly"]
        }
    },
    required: ["n", "catalog"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_4 = __cfHelpers.lift<{
    keys: __cfHelpers.ReadonlyCell<string[]>;
    n: __cfHelpers.ReadonlyCell<number>;
    catalog: __cfHelpers.ReadonlyCell<Record<string, any>>;
}, any[]>(({ keys, n, catalog }) => keys.get().map((k) => n.get() === 1 && catalog.get().offers[k].space), {
    type: "object",
    properties: {
        keys: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: ["readonly"]
        },
        n: {
            type: "number",
            asCell: ["readonly"]
        },
        catalog: {
            type: "object",
            properties: {},
            additionalProperties: true,
            asCell: ["readonly"]
        }
    },
    required: ["keys", "n", "catalog"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: true
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_5 = __cfHelpers.lift<{
    n: __cfHelpers.ReadonlyCell<number>;
    items: __cfHelpers.ReadonlyCell<number[]>;
    idx: __cfHelpers.ReadonlyCell<number>;
}, number>(({ n, items, idx }) => n.get() + items.get()[idx.get()]!, {
    type: "object",
    properties: {
        n: {
            type: "number",
            asCell: ["readonly"]
        },
        items: {
            type: "array",
            items: {
                type: "number"
            },
            asCell: ["readonly"]
        },
        idx: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["n", "items", "idx"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: computed-element-access-dynamic-key
// Verifies: an element access whose key can name any member leaves its `.get()` chain unresolved, so the receiver is read in full
//   catalog.get().offers[key.get()].space, offers[ANY_KEY], offers[String(KEY)], and offers[k] in a map callback each record a full read of catalog
//   items.get()[idx.get()] directly on the `.get()` result reads items in full the same way
// Context: Every lift has at least two captures, so a dropped read would shrink one out
export default pattern(() => {
    const catalog = new Writable<Record<string, any>>({ offers: {} }, {
        type: "object",
        properties: {},
        additionalProperties: true
    } as const satisfies __cfHelpers.JSONSchema).for("catalog", true);
    const n = new Writable<number>(0, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("n", true);
    const key = new Writable<string>("k", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema).for("key", true);
    const items = new Writable<number[]>([], {
        type: "array",
        items: {
            type: "number"
        }
    } as const satisfies __cfHelpers.JSONSchema).for("items", true);
    const idx = new Writable<number>(0, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("idx", true);
    const keys = new Writable<string[]>(["k"], {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __cfHelpers.JSONSchema).for("keys", true);
    const captureKey = __cfLift_1({
        n: n,
        catalog: catalog,
        key: key
    }).for("captureKey", true);
    const stringTypedKey = __cfLift_2({
        n: n,
        catalog: catalog
    }).for("stringTypedKey", true);
    const callKey = __cfLift_3({
        n: n,
        catalog: catalog
    }).for("callKey", true);
    const callbackParameterKey = __cfLift_4({
        keys: keys,
        n: n,
        catalog: catalog
    }).for("callbackParameterKey", true);
    const indexOnGetResult = __cfLift_5({
        n: n,
        items: items,
        idx: idx
    }).for("indexOnGetResult", true);
    return { captureKey, stringTypedKey, callKey, callbackParameterKey, indexOnGetResult };
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        captureKey: {
            type: "boolean"
        },
        stringTypedKey: {
            type: "boolean"
        },
        callKey: {
            type: "boolean"
        },
        callbackParameterKey: {
            type: "array",
            items: true
        },
        indexOnGetResult: {
            type: "number"
        }
    },
    required: ["captureKey", "stringTypedKey", "callKey", "callbackParameterKey", "indexOnGetResult"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2,
    __cfLift_3,
    __cfLift_4,
    __cfLift_5
});
