function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Item {
    id: number;
    name: string;
}
interface User {
    firstName: string;
    lastName: string;
}
interface State {
    items: Item[];
    currentUser: User;
}
const __cfPattern_1 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { state }) => {
    const item = __cf_pattern_input.key("element");
    return (<div>
            {item.key("name")} - edited by {state.currentUser.firstName} {state.currentUser.lastName}
          </div>);
}, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                currentUser: {
                    type: "object",
                    properties: {
                        firstName: {
                            type: "string"
                        },
                        lastName: {
                            type: "string"
                        }
                    },
                    required: ["firstName", "lastName"]
                }
            },
            required: ["currentUser"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema), {
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
                name: {
                    type: "string"
                }
            },
            required: ["id", "name"]
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
// FIXTURE: map-nested-property
// Verifies: .map() on reactive array captures nested property access on state
//   .map(fn) → .mapWithPattern(pattern(...).curry({state: {currentUser: {firstName, lastName}}}))
// Context: Captures state.currentUser.firstName and state.currentUser.lastName as nested property paths
export default pattern((state) => {
    return {
        [UI]: (<div>
        {state.key("items").mapWithPattern(__cfPattern_1.curry({
                state: {
                    currentUser: {
                        firstName: state.key("currentUser", "firstName"),
                        lastName: state.key("currentUser", "lastName")
                    }
                }
            }))}
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
        },
        currentUser: {
            $ref: "#/$defs/User"
        }
    },
    required: ["items", "currentUser"],
    $defs: {
        User: {
            type: "object",
            properties: {
                firstName: {
                    type: "string"
                },
                lastName: {
                    type: "string"
                }
            },
            required: ["firstName", "lastName"]
        },
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                name: {
                    type: "string"
                }
            },
            required: ["id", "name"]
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
    __cfPattern_1
});
