function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
/// <cts-enable />
/**
 * A computed that only hands a capture on to a pattern it instantiates takes the
 * capture as an opaque handle, so a change to the capture does not run it again
 * and nothing about the capture has to be current first. A capture it also reads
 * keeps what the read earns.
 */
import { computed, lift, pattern, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface ChildInput {
    rows: readonly string[];
    count: number;
}
const Child = pattern((__cf_pattern_input) => {
    const count = __cf_pattern_input.key("count");
    return ({ count });
}, {
    type: "object",
    properties: {
        rows: {
            type: "array",
            items: {
                type: "string"
            }
        },
        count: {
            type: "number"
        }
    },
    required: ["rows", "count"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        count: {
            type: "number"
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema);
const makeChild = lift(({ rows, count }) => {
    if (count > 10)
        return undefined;
    return Child({ rows, count });
}, {
    type: "object",
    properties: {
        count: {
            type: "number"
        },
        rows: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: ["opaque"]
        }
    },
    required: ["count", "rows"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_1 = __cfHelpers.lift<{
    items: __cfHelpers.ReadonlyCell<string[]>;
}, string[]>(({ items }) => items.get().map((item) => item.toUpperCase()), {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: ["readonly"]
        }
    },
    required: ["items"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift<{
    items: __cfHelpers.ReadonlyCell<unknown[]>;
}, number>(({ items }) => items.get().length, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "unknown"
            },
            asCell: ["readonly"]
        }
    },
    required: ["items"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_3 = __cfHelpers.lift<{
    count: number;
    rows: __cfHelpers.OpaqueCell<string[]>;
}, { count: number; } | undefined>(({ count, rows }) => count > 10 ? undefined : Child({ rows: rows, count: count }), {
    type: "object",
    properties: {
        count: {
            type: "number"
        },
        rows: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: ["opaque"]
        }
    },
    required: ["count", "rows"]
} as const satisfies __cfHelpers.JSONSchema, {
    anyOf: [{
            type: "undefined"
        }, {
            type: "object",
            properties: {
                count: {
                    type: "number"
                }
            },
            required: ["count"]
        }]
} as const satisfies __cfHelpers.JSONSchema);
export default pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    const rows = __cfLift_1({ items: items }).for("rows", true);
    const count = __cfLift_2({ items: items }).for("count", true);
    const child = __cfLift_3({
        count: count,
        rows: rows
    }).for("child", true);
    const lifted = makeChild({ rows, count }).for("lifted", true);
    return { child, lifted };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: ["cell"]
        }
    },
    required: ["items"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        child: {
            anyOf: [{
                    type: "undefined"
                }, {
                    type: "object",
                    properties: {
                        count: {
                            type: "number"
                        }
                    },
                    required: ["count"]
                }]
        },
        lifted: {
            anyOf: [{
                    type: "undefined"
                }, {
                    type: "object",
                    properties: {
                        count: {
                            type: "number"
                        }
                    },
                    required: ["count"]
                }]
        }
    },
    required: ["child", "lifted"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    Child,
    makeChild,
    __cfLift_1,
    __cfLift_2,
    __cfLift_3
});
