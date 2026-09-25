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
const __cfLift_ha854a0c40711 = __cfHelpers.lift<{
    view: Row[];
}, boolean>(({ view }) => view.length > 0, {
    type: "object",
    properties: {
        view: {
            type: "array",
            items: {
                type: "unknown"
            }
        }
    },
    required: ["view"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_h578460d853bc = __cfHelpers.pattern(__cf_pattern_input => {
    const v = __cf_pattern_input.key("element");
    return v.key("label");
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
    type: "string"
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
const __cfPattern_he8f19eda4470 = __cfHelpers.pattern(__cf_pattern_input => {
    const v = __cf_pattern_input.key("element");
    return <em>{v.key("label")}</em>;
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
// FIXTURE: cell-get-derived-collection-map
// Verifies: a local bound to a cell-read chain (`rows.get().filter(...)`) is a
//   site-lifted reactive collection, and every array-method consumer of it
//   lowers coherently — a JSX map at the expression root, a JSX map nested in
//   a ternary branch, and a value-position map each rewrite to
//   `.mapWithPattern` with no second lift wrapped around the rewritten call
//   and no callback parameter appearing among any lift's inputs.
// Context: the root map lowers through the deferred-JSX route, which reads
//   the closure stage's registry; the nested map lowers through the
//   control-flow rewrite, whose wrap decision recognizes the symbol-less
//   `*WithPattern` spelling structurally; the value-position map keeps its
//   `.for()` naming on the rewritten chain. `hasAny` pins the
//   boolean-consumer lift over the same local.
export default pattern((__cf_pattern_input) => {
    const rows = __cf_pattern_input.key("rows");
    const view = __cfLift_h6e93f541fe6d({ rows: rows }).filterWithPattern(__cfPattern_h370484f37ccb, {}).for("view", true);
    const hasAny = __cfLift_ha854a0c40711({ view: view }).for("hasAny", true);
    const labels = view.mapWithPattern(__cfPattern_h578460d853bc, {}).for("labels", true);
    return {
        [UI]: (<section>
        <ul>
          {view.mapWithPattern(__cfPattern_hfd5c00670ad6, {})}
        </ul>
        {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "null"
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{
                    type: "null"
                }, {}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, hasAny, <div>
              {view.mapWithPattern(__cfPattern_he8f19eda4470, {})}
            </div>, null)}
      </section>),
        labels,
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
        labels: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["$UI", "labels"],
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
    __cfLift_h6e93f541fe6d,
    __cfPattern_h370484f37ccb,
    __cfLift_ha854a0c40711,
    __cfPattern_h578460d853bc,
    __cfPattern_hfd5c00670ad6,
    __cfPattern_he8f19eda4470,
    __cfLift_1: __cfLift_h6e93f541fe6d,
    __cfPattern_1: __cfPattern_h370484f37ccb,
    __cfLift_2: __cfLift_ha854a0c40711,
    __cfPattern_2: __cfPattern_h578460d853bc,
    __cfPattern_3: __cfPattern_hfd5c00670ad6,
    __cfPattern_4: __cfPattern_he8f19eda4470
});
