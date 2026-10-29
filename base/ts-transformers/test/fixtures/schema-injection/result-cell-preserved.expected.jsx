function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { type Cell, lift, pattern, type Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Item {
    title: string;
}
interface PassThroughInput {
    cell: Cell<Item[]>;
}
interface Input {
    items: Writable<Item[]>;
}
// FIXTURE: result-cell-preserved
// Pins the boundary principle (see PatternFunction in api/index.ts): factory
// RESULT types are not stripped, so a Cell-branded value forwarded through a
// lift return and a pattern result keeps `asCell: ["cell"]` in the generated
// result schemas. Consumers therefore rehydrate a live Cell (identity + write
// access preserved) instead of receiving a dereferenced copy. Before the
// unstripping, the inferred result schema silently dropped the asCell entry.
const passThrough = lift((input: PassThroughInput) => input.cell, {
    type: "object",
    properties: {
        cell: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            asCell: ["readonly"]
        }
    },
    required: ["cell"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                }
            },
            required: ["title"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        $ref: "#/$defs/Item"
    },
    asCell: ["cell"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                }
            },
            required: ["title"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
export default pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    return {
        items: items.for(["__patternResult", "items"], true),
        forwarded: passThrough({ cell: items }).for(["__patternResult", "forwarded"], true)
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            asCell: ["cell"]
        }
    },
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                }
            },
            required: ["title"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            asCell: ["cell"]
        },
        forwarded: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            asCell: ["cell"]
        }
    },
    required: ["items", "forwarded"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                }
            },
            required: ["title"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    passThrough
});
