function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, UI, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Row {
    label: string;
    keep: boolean;
}
const __cfLift_h6e93f541fe6d = __cfHelpers.lift<{
    rows: __cfHelpers.Writable<Row[]>;
}, readonly Row[]>(({ rows }) => rows.get(), {
    type: "object",
    properties: {
        rows: {
            type: "array",
            items: {
                $ref: "#/$defs/Row"
            },
            asCell: ["readonly"]
        }
    },
    required: ["rows"],
    $defs: {
        Row: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                },
                keep: {
                    type: "boolean"
                }
            },
            required: ["label", "keep"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        $ref: "#/$defs/Row"
    },
    $defs: {
        Row: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                },
                keep: {
                    type: "boolean"
                }
            },
            required: ["label", "keep"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_h370484f37ccb = __cfHelpers.pattern(__cf_pattern_input => {
    const r = __cf_pattern_input.key("element");
    return r.key("keep");
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Row"
        }
    },
    required: ["element"],
    $defs: {
        Row: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                },
                keep: {
                    type: "boolean"
                }
            },
            required: ["label", "keep"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_hfd5c00670ad6 = __cfHelpers.pattern(__cf_pattern_input => {
    const v = __cf_pattern_input.key("element");
    return <li>{v.key("label")}</li>;
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Row"
        }
    },
    required: ["element"],
    $defs: {
        Row: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                },
                keep: {
                    type: "boolean"
                }
            },
            required: ["label", "keep"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    anyOf: [{
            $ref: "https://commonfabric.org/schemas/vnode.json"
        }, {
            $ref: "#/$defs/UIRenderable"
        }, {
            type: "object",
            properties: {}
        }],
    $defs: {
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
// FIXTURE: cell-get-derived-collection-map-paren-builder
// Verifies: parentheses around the pattern builder callback do not change the
//   site-lifted-collection admission — the derived local still registers, and
//   a JSX map over it still lowers to `.mapWithPattern`, exactly as in the
//   unparenthesized spelling (cell-get-derived-collection-map).
// Context: the admission locates the builder call through
//   getCallArgumentPosition, which reads argument positions through
//   transparent parens (§5.7 paren-invariance).
export default pattern((__cf_pattern_input) => {
    const rows = __cf_pattern_input.key("rows");
    const view = __cfLift_h6e93f541fe6d({ rows: rows }).filterWithPattern(__cfPattern_h370484f37ccb, {}).for("view", true);
    return {
        [UI]: (<ul>
        {view.mapWithPattern(__cfPattern_hfd5c00670ad6, {})}
      </ul>),
        view,
    };
}, {
    type: "object",
    properties: {
        rows: {
            type: "array",
            items: {
                $ref: "#/$defs/Row"
            },
            asCell: ["cell"]
        }
    },
    required: ["rows"],
    $defs: {
        Row: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                },
                keep: {
                    type: "boolean"
                }
            },
            required: ["label", "keep"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        },
        view: {
            type: "array",
            items: {
                $ref: "#/$defs/Row"
            }
        }
    },
    required: ["$UI", "view"],
    $defs: {
        Row: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                },
                keep: {
                    type: "boolean"
                }
            },
            required: ["label", "keep"]
        },
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
    __cfLift_h6e93f541fe6d,
    __cfPattern_h370484f37ccb,
    __cfPattern_hfd5c00670ad6,
    __cfLift_1: __cfLift_h6e93f541fe6d,
    __cfPattern_1: __cfPattern_h370484f37ccb,
    __cfPattern_2: __cfPattern_hfd5c00670ad6
});
