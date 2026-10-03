function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { NAME, pattern, UI, type VNode } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Entry {
    piece: string;
    name: string;
    backlinks: string[];
}
interface Input {
    filtered: Entry[];
}
interface RowInput {
    piece: string;
    name: string;
    backlinks: string[];
}
interface RowOutput {
    rendered: string;
    [UI]: VNode;
    [NAME]: string;
}
const EntryRow = pattern((input) => ({
    rendered: input.key("piece"),
    [UI]: <div />,
    [NAME]: input.key("name"),
}), {
    type: "object",
    properties: {
        piece: {
            type: "string"
        },
        name: {
            type: "string"
        },
        backlinks: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["piece", "name", "backlinks"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        rendered: {
            type: "string"
        },
        $UI: {
            $ref: "https://commonfabric.org/schemas/vnode.json"
        },
        $NAME: {
            type: "string"
        }
    },
    required: ["rendered", "$UI", "$NAME"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_h78b7b76105ac = __cfHelpers.pattern(__cf_pattern_input => {
    const entry = __cf_pattern_input.key("element");
    const row = EntryRow({
        piece: entry.key("piece"),
        name: entry.key("name"),
        backlinks: entry.key("backlinks"),
    });
    return {
        ui: row.key(__cfHelpers.UI),
        n: row.key(__cfHelpers.NAME),
    };
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Entry"
        }
    },
    required: ["element"],
    $defs: {
        Entry: {
            type: "object",
            properties: {
                piece: {
                    type: "string"
                },
                name: {
                    type: "string"
                },
                backlinks: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["piece", "name", "backlinks"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        ui: {
            $ref: "https://commonfabric.org/schemas/vnode.json"
        },
        n: {
            type: "string"
        }
    },
    required: ["ui", "n"]
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: map-pattern-factory-result-key-access (CT-1586)
// Verifies: `row[K]` where K is a well-known CF computed key (UI or NAME)
// and row is a pattern-factory result inside a JSX-context map callback
// lowers to `row.key(__cfHelpers.K)` — not a lift-applied wrapper.
// Context: `EntryRow(...)` is recognized as an opaque-origin call via
// structural pattern-factory detection, so `row` is tracked as a local
// opaque binding. The reordered visitor in pattern-body-reactive-root-
// lowering lets tracked-opaque static-key access take precedence over the
// JSX dynamic-wrap heuristic. Covers both UI and NAME on the same row to
// exercise the common well-known-key cases through the same fix path.
export default pattern((__cf_pattern_input) => {
    const filtered = __cf_pattern_input.key("filtered");
    return ({
        [UI]: (<div>
      {filtered.mapWithPattern(__cfPattern_h78b7b76105ac, {})}
    </div>),
    });
}, {
    type: "object",
    properties: {
        filtered: {
            type: "array",
            items: {
                $ref: "#/$defs/Entry"
            }
        }
    },
    required: ["filtered"],
    $defs: {
        Entry: {
            type: "object",
            properties: {
                piece: {
                    type: "string"
                },
                name: {
                    type: "string"
                },
                backlinks: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["piece", "name", "backlinks"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$UI"],
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    $ref: "#/$defs/UIRenderable"
                }, {
                    type: "object",
                    properties: {}
                }]
        },
        UIRenderable: {
            type: "object",
            properties: {
                $UI: {
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }
            },
            required: ["$UI"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    EntryRow,
    __cfPattern_h78b7b76105ac,
    __cfPattern_1: __cfPattern_h78b7b76105ac
});
