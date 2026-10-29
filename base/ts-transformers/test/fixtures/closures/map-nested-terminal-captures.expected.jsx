function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const terms = __cfHardenFn((value: string): string[] => value.split(" "));
const __cfLift_1 = __cfHelpers.lift<{
    group: string;
}, string[]>(({ group }) => terms(group), {
    type: "object",
    properties: {
        group: {
            type: "string"
        }
    },
    required: ["group"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    rows: string[];
    tokens: string[];
}, number[]>(({ rows, tokens }) => rows.map((row) => {
    const hits = tokens.filter((token) => row.includes(token));
    return hits.length;
}).slice(0, 1), {
    type: "object",
    properties: {
        rows: {
            type: "array",
            items: {
                type: "string"
            }
        },
        tokens: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["rows", "tokens"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "number"
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_3 = __cfHelpers.lift<{
    rows: string[];
    tokens: string[];
}, number[]>(({ rows, tokens }) => __cfLift_2({
    rows: rows,
    tokens: tokens
}), {
    type: "object",
    properties: {
        rows: {
            type: "array",
            items: {
                type: "string"
            }
        },
        tokens: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["rows", "tokens"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "number"
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const count = __cf_pattern_input.key("element");
    return count;
}, {
    type: "object",
    properties: {
        element: {
            type: "number"
        }
    },
    required: ["element"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_2 = __cfHelpers.pattern(__cf_pattern_input => {
    const group = __cf_pattern_input.key("element");
    const rows = __cf_pattern_input.key("params", "rows");
    const tokens = __cfLift_1({ group: group }).for("tokens", true);
    return __cfLift_3({
        rows: rows,
        tokens: tokens
    }).mapWithPattern(__cfPattern_1, {}).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        element: {
            type: "string"
        },
        params: {
            type: "object",
            properties: {
                rows: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["rows"]
        }
    },
    required: ["element", "params"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "number"
    }
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: map-nested-terminal-captures
// Verifies: a terminal chain captures an enclosing local through nested callbacks,
// keeps the callbacks inside its lift as plain JavaScript, and excludes their locals.
// Context: the chain is inside a reactive map callback and feeds another reactive map.
export default pattern((__cf_pattern_input) => {
    const groups = __cf_pattern_input.key("groups");
    const rows = __cf_pattern_input.key("rows");
    return ({
        matches: groups.mapWithPattern(__cfPattern_2, {
            rows: rows
        }).for(["__patternResult", "matches"], true)
    });
}, {
    type: "object",
    properties: {
        groups: {
            type: "array",
            items: {
                type: "string"
            }
        },
        rows: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["groups", "rows"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        matches: {
            type: "array",
            items: {
                type: "array",
                items: {
                    type: "number"
                }
            }
        }
    },
    required: ["matches"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2,
    __cfLift_3,
    __cfPattern_1,
    __cfPattern_2
});
