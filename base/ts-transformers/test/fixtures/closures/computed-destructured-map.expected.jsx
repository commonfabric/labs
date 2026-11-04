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
 * Regression: .map() on a destructured property from a computed result
 * inside another computed() should NOT be transformed to .mapWithPattern().
 *
 * Inside a lift-applied callback, Reactive values are unwrapped to plain JS,
 * so destructured `tasks` is a plain array.
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
    result: { tasks: Item[]; view: string; };
}, __cfHelpers.JSXElement[]>(({ result }) => {
    const { tasks } = result;
    return tasks.map((task) => <li>{task.name}</li>);
}, {
    type: "object",
    properties: {
        result: {
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
            required: ["tasks", "view"]
        }
    },
    required: ["result"],
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
// FIXTURE: computed-destructured-map
// Verifies: .map() on a destructured property of a computed result inside another computed() is NOT transformed to .mapWithPattern()
//   computed(() => { const { tasks } = result; return tasks.map(fn) }) → lift(({ result }) => { const { tasks } = result; return tasks.map(fn) })(...)
// Context: Inside a lift-applied callback, Reactive values are unwrapped to plain JS,
//   so destructured `tasks` is a plain array. The .map() must remain untransformed.
//   This is a negative test for reactive .map() detection on derived values.
export default pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    const result = __cfLift_1({ items: items }).for("result", true);
    return {
        [UI]: (<div>
        {__cfLift_2({ result: result })}
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
