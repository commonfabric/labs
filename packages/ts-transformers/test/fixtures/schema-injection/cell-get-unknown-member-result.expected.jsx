function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { type Default, pattern, type Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift<{
    entry: Writable<{
        topic: unknown;
        title: string;
    } | Default<{
        topic: null;
        title: "";
    }>>;
}, Readonly<{ topic: unknown; title: string; }>>(({ entry }) => entry.get(), {
    type: "object",
    properties: {
        entry: {
            type: "object",
            properties: {
                topic: {
                    type: "unknown"
                },
                title: {
                    type: "string"
                }
            },
            required: ["topic", "title"],
            "default": {
                topic: null,
                title: ""
            },
            asCell: ["readonly"]
        }
    },
    required: ["entry"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        topic: {
            type: "unknown"
        },
        title: {
            type: "string"
        }
    },
    required: ["topic", "title"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    entryView: Readonly<{ topic: unknown; title: string; }>;
}, number>(({ entryView }) => entryView.title.length, {
    type: "object",
    properties: {
        entryView: {
            type: "object",
            properties: {
                topic: {
                    type: "unknown"
                },
                title: {
                    type: "string"
                }
            },
            required: ["topic", "title"]
        }
    },
    required: ["entryView"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_3 = __cfHelpers.lift<{
    lookup: __cfHelpers.Writable<Record<string, unknown>>;
}, Readonly<Record<string, unknown>>>(({ lookup }) => lookup.get(), {
    type: "object",
    properties: {
        lookup: {
            type: "object",
            properties: {},
            additionalProperties: {
                type: "unknown"
            },
            asCell: ["readonly"]
        }
    },
    required: ["lookup"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {},
    additionalProperties: {
        type: "unknown"
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_4 = __cfHelpers.lift<{
    lookupView: Readonly<Record<string, unknown>>;
}, number>(({ lookupView }) => Object.keys(lookupView).length, {
    type: "object",
    properties: {
        lookupView: {
            type: "object",
            properties: {},
            additionalProperties: {
                type: "unknown"
            }
        }
    },
    required: ["lookupView"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_5 = __cfHelpers.lift<{
    pair: Writable<[
        unknown,
        string
    ] | Default<[
        null,
        ""
    ]>>;
}, readonly [unknown, string]>(({ pair }) => pair.get(), {
    type: "object",
    properties: {
        pair: {
            type: "array",
            items: {
                type: "unknown"
            },
            "default": [null, ""],
            asCell: ["readonly"]
        }
    },
    required: ["pair"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        anyOf: [{
                type: "unknown"
            }, {
                type: "string"
            }]
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_6 = __cfHelpers.lift<{
    pairView: readonly [unknown, string];
}, 2>(({ pairView }) => pairView.length, {
    type: "object",
    properties: {
        pairView: {
            type: "array",
            items: {
                type: "unknown"
            }
        }
    },
    required: ["pairView"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number",
    "enum": [2]
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: cell-get-unknown-member-result
// Verifies: a pattern-scope `.get()` of a cell whose type CONTAINS `unknown`
// keeps its reliable Type for the lowered lift's RESULT schema. The read
// types as `Readonly<{…}>` (printed as an alias reference) or as a tuple,
// and the node-based analyzer can instantiate neither: it used to emit an
// empty object for the alias form and `true` for the tuple. `unknown` is a
// deliberate, schemaable declaration, so a node that merely contains one is
// analyzed from its Type like any other.
export default pattern((__cf_pattern_input) => {
    const entry = __cf_pattern_input.key("entry");
    const lookup = __cf_pattern_input.key("lookup");
    const pair = __cf_pattern_input.key("pair");
    const entryView = __cfLift_1({ entry: entry }).for("entryView", true);
    const titleLength = __cfLift_2({ entryView: entryView }).for("titleLength", true);
    const lookupView = __cfLift_3({ lookup: lookup }).for("lookupView", true);
    const keyCount = __cfLift_4({ lookupView: lookupView }).for("keyCount", true);
    const pairView = __cfLift_5({ pair: pair }).for("pairView", true);
    const pairLength = __cfLift_6({ pairView: pairView }).for("pairLength", true);
    return { titleLength, keyCount, pairLength };
}, {
    type: "object",
    properties: {
        entry: {
            type: "object",
            properties: {
                topic: {
                    type: "unknown"
                },
                title: {
                    type: "string"
                }
            },
            required: ["topic", "title"],
            "default": {
                topic: null,
                title: ""
            },
            asCell: ["cell"]
        },
        lookup: {
            type: "object",
            properties: {},
            additionalProperties: {
                type: "unknown"
            },
            asCell: ["cell"]
        },
        pair: {
            type: "array",
            items: {
                type: "unknown"
            },
            "default": [null, ""],
            asCell: ["cell"]
        }
    },
    required: ["entry", "lookup", "pair"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        titleLength: {
            type: "number"
        },
        keyCount: {
            type: "number"
        },
        pairLength: {
            type: "number"
        }
    },
    required: ["titleLength", "keyCount", "pairLength"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2,
    __cfLift_3,
    __cfLift_4,
    __cfLift_5,
    __cfLift_6
});
