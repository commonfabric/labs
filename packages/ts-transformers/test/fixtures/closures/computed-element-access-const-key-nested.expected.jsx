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
const INNER = "j";
const __cfLift_1 = __cfHelpers.lift<{
    n: __cfHelpers.ReadonlyCell<number>;
    catalog: __cfHelpers.ReadonlyCell<Record<string, any>>;
}, boolean>(({ n, catalog }) => n.get() === 1 && catalog.get().offers[KEY][INNER].space === "room", {
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
const __cfLift_2 = __cfHelpers.lift<{
    n: __cfHelpers.ReadonlyCell<number>;
    catalog: __cfHelpers.ReadonlyCell<Record<string, any>>;
}, boolean>(({ n, catalog }) => n.get() === 1 && catalog.get().offers[KEY] !== undefined, {
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
    catalog: __cfHelpers.ReadonlyCell<Record<string, any>>;
    other: __cfHelpers.ReadonlyCell<Record<string, any>>;
}, boolean>(({ catalog, other }) => catalog.get().offers[KEY].space === other.get().offers[KEY].space, {
    type: "object",
    properties: {
        catalog: {
            type: "object",
            properties: {},
            additionalProperties: true,
            asCell: ["readonly"]
        },
        other: {
            type: "object",
            properties: {},
            additionalProperties: true,
            asCell: ["readonly"]
        }
    },
    required: ["catalog", "other"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_4 = __cfHelpers.lift<{
    n: __cfHelpers.ReadonlyCell<number>;
    typed: __cfHelpers.ReadonlyCell<{
        offers: Record<string, { space: string; }>;
    }>;
}, boolean>(({ n, typed }) => n.get() === 1 && typed.get().offers[KEY]?.space === "room", {
    type: "object",
    properties: {
        n: {
            type: "number",
            asCell: ["readonly"]
        },
        typed: {
            type: "object",
            properties: {
                offers: {
                    type: "object",
                    properties: {},
                    additionalProperties: {
                        type: "object",
                        properties: {
                            space: {
                                type: "string"
                            }
                        },
                        required: ["space"]
                    }
                }
            },
            required: ["offers"],
            asCell: ["readonly"]
        }
    },
    required: ["n", "typed"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: computed-element-access-const-key-nested
// Verifies: literal-typed element keys compose into one static path in each position they can take
//   offers[KEY][INNER].space → catalog.offers.k.j.space; offers[KEY] with no member after it → catalog.offers.k
//   two captures each read through offers[KEY] are both kept; a typed capture shrinks to offers, dropping the unread meta
// Context: Every lift has two captures, so a dropped read would shrink one out
export default pattern(() => {
    const catalog = new Writable<Record<string, any>>({ offers: {} }, {
        type: "object",
        properties: {},
        additionalProperties: true
    } as const satisfies __cfHelpers.JSONSchema).for("catalog", true);
    const other = new Writable<Record<string, any>>({ offers: {} }, {
        type: "object",
        properties: {},
        additionalProperties: true
    } as const satisfies __cfHelpers.JSONSchema).for("other", true);
    const typed = new Writable<{
        offers: Record<string, {
            space: string;
        }>;
        meta: {
            x: number;
        };
    }>({ offers: {}, meta: { x: 1 } }, {
        type: "object",
        properties: {
            offers: {
                type: "object",
                properties: {},
                additionalProperties: {
                    type: "object",
                    properties: {
                        space: {
                            type: "string"
                        }
                    },
                    required: ["space"]
                }
            },
            meta: {
                type: "object",
                properties: {
                    x: {
                        type: "number"
                    }
                },
                required: ["x"]
            }
        },
        required: ["offers", "meta"]
    } as const satisfies __cfHelpers.JSONSchema).for("typed", true);
    const n = new Writable<number>(0, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("n", true);
    const nestedKeys = __cfLift_1({
        n: n,
        catalog: catalog
    }).for("nestedKeys", true);
    const noMemberAfterKey = __cfLift_2({
        n: n,
        catalog: catalog
    }).for("noMemberAfterKey", true);
    const twoCapturesSameShape = __cfLift_3({
        catalog: catalog,
        other: other
    }).for("twoCapturesSameShape", true);
    const typedRecord = __cfLift_4({
        n: n,
        typed: typed
    }).for("typedRecord", true);
    return { nestedKeys, noMemberAfterKey, twoCapturesSameShape, typedRecord };
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        nestedKeys: {
            type: "boolean"
        },
        noMemberAfterKey: {
            type: "boolean"
        },
        twoCapturesSameShape: {
            type: "boolean"
        },
        typedRecord: {
            type: "boolean"
        }
    },
    required: ["nestedKeys", "noMemberAfterKey", "twoCapturesSameShape", "typedRecord"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2,
    __cfLift_3,
    __cfLift_4
});
