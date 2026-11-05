function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
/**
 * Regression: .map() on a property access of a computed result inside
 * another computed() should NOT be transformed to .mapWithPattern().
 *
 * Inside a lift-applied callback, Reactive values are unwrapped to plain JS,
 * so `result.tasks` is a plain array.
 */
import { computed, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Item {
    name: string;
    done: boolean;
}
const __cfLift_1 = __cfHelpers.lift<{
    items: {
        done: boolean;
    }[];
}, { tasks: Item[]; view: string; }>(({ items }) => ({
    tasks: items.filter((i) => !i.done),
    view: "inbox",
}), {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    done: {
                        type: "boolean"
                    }
                },
                required: ["done"]
            }
        }
    },
    required: ["items"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        tasks: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        },
        view: {
            type: "string"
        }
    },
    required: ["tasks", "view"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                done: {
                    type: "boolean"
                }
            },
            required: ["name", "done"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift<{
    result: {
        tasks: {
            name: string;
        }[];
    };
}, __cfHelpers.JSXElement[]>(({ result }) => {
    return result.tasks.map((task) => <li>{task.name}</li>);
}, {
    type: "object",
    properties: {
        result: {
            type: "object",
            properties: {
                tasks: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            }
                        },
                        required: ["name"]
                    }
                }
            },
            required: ["tasks"]
        }
    },
    required: ["result"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        $ref: "#/$defs/JSXElement"
    },
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
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: computed-property-access-map
// Verifies: .map() on a property access of a computed result inside another computed() is NOT transformed to .mapWithPattern()
//   computed(() => result.tasks.map(fn)) → lift(({ result }) => result.tasks.map(fn))({ result: { tasks: result.key("tasks") } })
// Context: Inside a lift-applied callback, Reactive values are unwrapped to plain JS,
//   so `result.tasks` is a plain array. The .map() must remain untransformed.
//   This is a negative test for reactive .map() detection on property access paths.
//   Note the captures use result.key("tasks") to extract the needed sub-property.
export default pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    const result = __cfLift_1({ items: items }).for("result", true);
    return {
        [UI]: (<div>
        {__cfLift_2({ result: {
                    tasks: result.key("tasks")
                } })}
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
                name: {
                    type: "string"
                },
                done: {
                    type: "boolean"
                }
            },
            required: ["name", "done"]
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
    __cfLift_2
});
