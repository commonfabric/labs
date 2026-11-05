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
interface SubItem {
    id: number;
    name: string;
    active: boolean;
}
interface Item {
    id: number;
    title: string;
    subItems: SubItem[];
}
interface State {
    items: Item[];
}
const __cfLift_1 = __cfHelpers.lift<{
    item: {
        subItems: SubItem[];
    };
}, string>(({ item }) => item.subItems
    .filter((s) => s.active)
    .map((s) => s.name)
    .join(", "), {
    type: "object",
    properties: {
        item: {
            type: "object",
            properties: {
                subItems: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/SubItem"
                    }
                }
            },
            required: ["subItems"]
        }
    },
    required: ["item"],
    $defs: {
        SubItem: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                name: {
                    type: "string"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["id", "name", "active"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    return (<div>
            <h2>{item.key("title")}</h2>
            <p>
              Active items:{" "}
              {__cfLift_1({ item: {
                subItems: item.key("subItems")
            } })}
            </p>
          </div>);
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
                id: {
                    type: "number"
                },
                title: {
                    type: "string"
                },
                subItems: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/SubItem"
                    }
                }
            },
            required: ["id", "title", "subItems"]
        },
        SubItem: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                name: {
                    type: "string"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["id", "name", "active"]
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
// FIXTURE: computed-inside-map-with-method-chain
// Verifies: a computed nested inside .map() correctly transforms outer .map() but leaves inner chains alone
//   state.items.map(fn) → state.items.mapWithPattern(pattern(...))
//   inner .filter().map() inside the computed callback → NOT transformed (plain array)
// Context: computed is used inline in JSX within a mapWithPattern callback
export default pattern((state) => {
    return {
        [UI]: (<div>
        {/* Edge case: explicit computed inside mapWithPattern with method chain.
                The inner .filter().map() should NOT be transformed because:
                - inside the computed, item.subItems unwraps to a plain JS array
                - .filter() returns a plain JS array
                - Plain arrays don't have .mapWithPattern() */}
        {state.key("items").mapWithPattern(__cfPattern_1)}
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
                id: {
                    type: "number"
                },
                title: {
                    type: "string"
                },
                subItems: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/SubItem"
                    }
                }
            },
            required: ["id", "title", "subItems"]
        },
        SubItem: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                name: {
                    type: "string"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["id", "name", "active"]
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
    __cfPattern_1
});
