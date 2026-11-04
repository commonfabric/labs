function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const identity = __cfHardenFn((x: unknown) => x);
interface Item {
    done: boolean;
}
interface State {
    items: Item[];
}
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        items: Item[];
    };
}, Item[]>(({ state }) => state.items, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Item"
                    }
                }
            },
            required: ["items"]
        }
    },
    required: ["state"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                done: {
                    type: "boolean"
                }
            },
            required: ["done"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        $ref: "#/$defs/Item"
    },
    $defs: {
        Item: {
            type: "object",
            properties: {
                done: {
                    type: "boolean"
                }
            },
            required: ["done"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift<{
    row: {
        done: boolean;
    };
}, unknown>(({ row }) => identity(row.done && "Done"), {
    type: "object",
    properties: {
        row: {
            type: "object",
            properties: {
                done: {
                    type: "boolean"
                }
            },
            required: ["done"]
        }
    },
    required: ["row"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const row = __cf_pattern_input.key("element");
    const label = __cfLift_2({ row: {
            done: row.key("done")
        } }).for("label", true);
    return <span>{label}</span>;
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Item"
        }
    },
    required: ["element"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                done: {
                    type: "boolean"
                }
            },
            required: ["done"]
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
// FIXTURE: computed-map-call-arg-logical-and
// Verifies: callback-local ordinary call roots within a computed-array .map()
//   callback whole-wrap as callback-local lift-applied computations rather than
//   lowering only the nested && argument site.
//   const label = identity(row.done && "Done")
//   → const label = lift(({ row }) => identity(row.done && "Done"))(...)
export default pattern((state) => {
    const rows = __cfLift_1({ state: {
            items: state.key("items")
        } }).for("rows", true);
    return {
        [UI]: (<div>
        {rows.mapWithPattern(__cfPattern_1, {})}
      </div>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        }
    },
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                done: {
                    type: "boolean"
                }
            },
            required: ["done"]
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
    __cfLift_1,
    __cfLift_2,
    __cfPattern_1
});
