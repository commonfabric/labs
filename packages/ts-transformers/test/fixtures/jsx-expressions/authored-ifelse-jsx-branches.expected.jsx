function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { ifElse, pattern, UI, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Item {
    name: string;
}
const __cfLift_h279203547b20 = __cfHelpers.lift<{
    limit: number;
}, boolean>(({ limit }) => limit > 0, {
    type: "object",
    properties: {
        limit: {
            type: "number"
        }
    },
    required: ["limit"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfPattern_hfe105d59f1b1 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    return <span>{item.key("name")}</span>;
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
                name: {
                    type: "string"
                }
            },
            required: ["name"]
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
const __cfLift_h2903f1fcd2e2 = __cfHelpers.lift<{
    count: __cfHelpers.ReadonlyCell<number>;
}, number>(({ count }) => count.get(), {
    type: "object",
    properties: {
        count: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: authored-ifelse-jsx-branches
// Verifies: authored ifElse in JSX lowers both conditions and reactive branches correctly
//   ifElse(limit > 0, items.map(...), <span>Hidden</span>) → derived condition + pattern-lowered map branch
//   ifElse(show, count.get(), 0) in JSX                     → derived reactive branch, not raw count.get()
export default pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    const limit = __cf_pattern_input.key("limit");
    const count = __cf_pattern_input.key("count");
    const show = __cf_pattern_input.key("show");
    return ({
        [UI]: (<div>
      {ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "array",
            items: {
                $ref: "#/$defs/JSXElement"
            },
            $defs: {
                JSXElement: {
                    anyOf: [{}, {
                            type: "object",
                            properties: {}
                        }]
                }
            }
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "array",
                    items: {
                        $ref: "#/$defs/JSXElement"
                    }
                }],
            $defs: {
                JSXElement: {
                    anyOf: [{}, {
                            type: "object",
                            properties: {}
                        }]
                }
            }
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_h279203547b20({ limit: limit }), items.mapWithPattern(__cfPattern_hfe105d59f1b1, {}), <span>Hidden</span>)}
      <p>{ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, show, __cfLift_h2903f1fcd2e2({ count: count }), 0)}</p>
    </div>),
    });
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        },
        limit: {
            type: "number"
        },
        count: {
            type: "number",
            asCell: ["cell"]
        },
        show: {
            type: "boolean"
        }
    },
    required: ["items", "limit", "count", "show"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
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
    __cfLift_h279203547b20,
    __cfPattern_hfe105d59f1b1,
    __cfLift_h2903f1fcd2e2,
    __cfLift_1: __cfLift_h279203547b20,
    __cfPattern_1: __cfPattern_hfe105d59f1b1,
    __cfLift_2: __cfLift_h2903f1fcd2e2
});
