function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { NAME, pattern, UI, VIEWS, type VNode } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Entry {
    piece: string;
}
interface Input {
    entries: Entry[];
}
interface RowView {
    rendered: string;
}
interface RowOutput {
    [UI]: VNode;
    [NAME]: string;
    [VIEWS]: {
        row: RowView;
    };
}
const EntryRow = pattern((input) => ({
    [UI]: <div />,
    [NAME]: input.key("piece"),
    [VIEWS]: { row: { rendered: input.key("piece") } },
}), {
    type: "object",
    properties: {
        piece: {
            type: "string"
        }
    },
    required: ["piece"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "https://commonfabric.org/schemas/vnode.json"
        },
        $NAME: {
            type: "string"
        },
        $VIEWS: {
            type: "object",
            properties: {
                row: {
                    $ref: "#/$defs/RowView"
                }
            },
            required: ["row"]
        }
    },
    required: ["$UI", "$NAME", "$VIEWS"],
    $defs: {
        RowView: {
            type: "object",
            properties: {
                rendered: {
                    type: "string"
                }
            },
            required: ["rendered"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const entry = __cf_pattern_input.key("element");
    const row = EntryRow({ piece: entry.key("piece") });
    return {
        views: row.key(__cfHelpers.VIEWS),
        inner: row.key(__cfHelpers.VIEWS, "row"),
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
                }
            },
            required: ["piece"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        views: {
            type: "object",
            properties: {
                row: {
                    $ref: "#/$defs/RowView"
                }
            },
            required: ["row"]
        },
        inner: {
            $ref: "#/$defs/RowView"
        },
        n: {
            type: "string"
        }
    },
    required: ["views", "inner", "n"],
    $defs: {
        RowView: {
            type: "object",
            properties: {
                rendered: {
                    type: "string"
                }
            },
            required: ["rendered"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: map-pattern-factory-result-views-access
// Verifies: `row[VIEWS]` on a pattern-factory result inside a JSX-context map
// callback lowers to `row.key(__cfHelpers.VIEWS)`, as `row[NAME]` does, with
// no lift
//   views: row[VIEWS]       → row.key(__cfHelpers.VIEWS)
//   inner: row[VIEWS].row   → row.key(__cfHelpers.VIEWS, "row")
// Context: VIEWS is a well-known key alongside NAME, UI, SELF and FS
export default pattern((__cf_pattern_input) => {
    const entries = __cf_pattern_input.key("entries");
    return ({
        [UI]: (<div>
      {entries.mapWithPattern(__cfPattern_1, {})}
    </div>),
    });
}, {
    type: "object",
    properties: {
        entries: {
            type: "array",
            items: {
                $ref: "#/$defs/Entry"
            }
        }
    },
    required: ["entries"],
    $defs: {
        Entry: {
            type: "object",
            properties: {
                piece: {
                    type: "string"
                }
            },
            required: ["piece"]
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
    __cfPattern_1
});
