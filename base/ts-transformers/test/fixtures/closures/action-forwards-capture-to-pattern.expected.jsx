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
 * A verb that only hands a capture on to a pattern it instantiates takes the
 * capture as an opaque handle, so nothing about it has to be current before the
 * verb runs. A capture the verb also reads keeps what the read earns.
 */
import { action, computed, pattern, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface ChildInput {
    rows: readonly string[];
    count: number;
    label: string;
}
const Child = pattern((__cf_pattern_input) => {
    const label = __cf_pattern_input.key("label");
    return ({ label });
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
        },
        label: {
            type: "string"
        }
    },
    required: ["rows", "count", "label"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        label: {
            type: "string"
        }
    },
    required: ["label"]
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
const __cfHandler_1 = __cfHelpers.handler({
    type: "object",
    properties: {
        label: {
            type: "string"
        }
    },
    required: ["label"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        count: {
            type: "number"
        },
        made: {
            type: "array",
            items: {
                type: "unknown"
            },
            asCell: ["writeonly"]
        },
        rows: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: ["opaque"]
        }
    },
    required: ["count", "made", "rows"]
} as const satisfies __cfHelpers.JSONSchema, ({ label }, { count, made, rows }) => {
    if (count > 10)
        return;
    made.push(Child({ rows, count, label }));
});
export default pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    const rows = __cfLift_1({ items: items }).for("rows", true);
    const count = __cfLift_2({ items: items }).for("count", true);
    const made = new Writable<unknown[]>([], {
        type: "array",
        items: {
            type: "unknown"
        }
    } as const satisfies __cfHelpers.JSONSchema).for("made", true);
    const addChild = __cfHandler_1({
        count: count,
        made: made,
        rows: rows
    }).for({ stream: "addChild" }, true);
    return { addChild: addChild.for({ stream: ["__patternResult", "addChild"] }, true), rows, count };
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
        addChild: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                }
            },
            required: ["label"],
            asCell: ["stream"]
        },
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
    required: ["addChild", "rows", "count"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    Child,
    __cfLift_1,
    __cfLift_2,
    __cfHandler_1
});
