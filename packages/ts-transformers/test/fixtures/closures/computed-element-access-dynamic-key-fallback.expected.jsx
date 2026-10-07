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
const ANY_KEY: string = "k";
const __cfLift_1 = __cfHelpers.lift<{
    a: __cfHelpers.ReadonlyCell<{
        p: string;
    }>;
    catalog: __cfHelpers.ReadonlyCell<Record<string, any>>;
    n: __cfHelpers.ReadonlyCell<number>;
}, boolean>(({ a, catalog, n }) => {
    const v = a.get().p || catalog.get().offers[ANY_KEY].space;
    return n.get() === 1 && v === "room";
}, {
    type: "object",
    properties: {
        a: {
            type: "object",
            properties: {
                p: {
                    type: "string"
                }
            },
            required: ["p"],
            asCell: ["readonly"]
        },
        catalog: {
            type: "object",
            properties: {},
            additionalProperties: true,
            asCell: ["readonly"]
        },
        n: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["a", "catalog", "n"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift<{
    a: __cfHelpers.ReadonlyCell<{
        p: string;
    }>;
    catalog: __cfHelpers.ReadonlyCell<Record<string, any>>;
    n: __cfHelpers.ReadonlyCell<number>;
}, boolean>(({ a, catalog, n }) => {
    const v = a.get().p ?? catalog.get().offers[ANY_KEY].space;
    return n.get() === 1 && v === "room";
}, {
    type: "object",
    properties: {
        a: {
            type: "object",
            properties: {
                p: {
                    type: "string"
                }
            },
            required: ["p"],
            asCell: ["readonly"]
        },
        catalog: {
            type: "object",
            properties: {},
            additionalProperties: true,
            asCell: ["readonly"]
        },
        n: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["a", "catalog", "n"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_3 = __cfHelpers.lift<{
    catalog: __cfHelpers.ReadonlyCell<Record<string, any>>;
    a: __cfHelpers.ReadonlyCell<{
        p: string;
    }>;
    n: __cfHelpers.ReadonlyCell<number>;
}, boolean>(({ catalog, a, n }) => {
    const v = catalog.get().offers[ANY_KEY].space || a.get().p;
    return n.get() === 1 && v === "room";
}, {
    type: "object",
    properties: {
        catalog: {
            type: "object",
            properties: {},
            additionalProperties: true,
            asCell: ["readonly"]
        },
        a: {
            type: "object",
            properties: {
                p: {
                    type: "string"
                }
            },
            required: ["p"],
            asCell: ["readonly"]
        },
        n: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["catalog", "a", "n"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_4 = __cfHelpers.lift<{
    n: __cfHelpers.ReadonlyCell<number>;
    a: __cfHelpers.ReadonlyCell<{ p: string; }>;
    catalog: __cfHelpers.ReadonlyCell<Record<string, any>>;
}, boolean>(({ n, a, catalog }) => n.get() === 1 && (a.get() ?? catalog.get().offers[ANY_KEY]).p === "room", {
    type: "object",
    properties: {
        n: {
            type: "number",
            asCell: ["readonly"]
        },
        a: {
            type: "object",
            properties: {
                p: {
                    type: "string"
                }
            },
            required: ["p"],
            asCell: ["readonly"]
        },
        catalog: {
            type: "object",
            properties: {},
            additionalProperties: true,
            asCell: ["readonly"]
        }
    },
    required: ["n", "a", "catalog"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_5 = __cfHelpers.lift<{
    a: __cfHelpers.ReadonlyCell<{
        p: string;
    }>;
    catalog: __cfHelpers.ReadonlyCell<Record<string, any>>;
    n: __cfHelpers.ReadonlyCell<number>;
}, boolean>(({ a, catalog, n }) => {
    const v = a.get().p || catalog.get().offers.k.space;
    return n.get() === 1 && v === "room";
}, {
    type: "object",
    properties: {
        a: {
            type: "object",
            properties: {
                p: {
                    type: "string"
                }
            },
            required: ["p"],
            asCell: ["readonly"]
        },
        catalog: {
            type: "object",
            properties: {},
            additionalProperties: true,
            asCell: ["readonly"]
        },
        n: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["a", "catalog", "n"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: computed-element-access-dynamic-key-fallback
// Verifies: a dynamic-key chain inside a `||` or `??` keeps its capture even when the fallback as a whole resolves by its other operand
//   const v = a.get().p || catalog.get().offers[ANY_KEY].space, and the `??` form, keep catalog in the lift's input
//   the dynamic chain on the left of `||`, and (a.get() ?? catalog.get().offers[ANY_KEY]).p, keep catalog the same way
//   a fallback whose right operand is a static chain, a.get().p || catalog.get().offers.k.space, is the control
// Context: Every lift has three captures, so a dropped read would shrink one out
export default pattern(() => {
    const a = new Writable<{
        p: string;
    }>({ p: "" }, {
        type: "object",
        properties: {
            p: {
                type: "string"
            }
        },
        required: ["p"]
    } as const satisfies __cfHelpers.JSONSchema).for("a", true);
    const catalog = new Writable<Record<string, any>>({ offers: {} }, {
        type: "object",
        properties: {},
        additionalProperties: true
    } as const satisfies __cfHelpers.JSONSchema).for("catalog", true);
    const n = new Writable<number>(0, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("n", true);
    const orRight = __cfLift_1({
        a: a,
        catalog: catalog,
        n: n
    }).for("orRight", true);
    const nullishRight = __cfLift_2({
        a: a,
        catalog: catalog,
        n: n
    }).for("nullishRight", true);
    const orLeft = __cfLift_3({
        catalog: catalog,
        a: a,
        n: n
    }).for("orLeft", true);
    const memberAfterNullish = __cfLift_4({
        n: n,
        a: a,
        catalog: catalog
    }).for("memberAfterNullish", true);
    const staticRight = __cfLift_5({
        a: a,
        catalog: catalog,
        n: n
    }).for("staticRight", true);
    return { orRight, nullishRight, orLeft, memberAfterNullish, staticRight };
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        orRight: {
            type: "boolean"
        },
        nullishRight: {
            type: "boolean"
        },
        orLeft: {
            type: "boolean"
        },
        memberAfterNullish: {
            type: "boolean"
        },
        staticRight: {
            type: "boolean"
        }
    },
    required: ["orRight", "nullishRight", "orLeft", "memberAfterNullish", "staticRight"]
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
