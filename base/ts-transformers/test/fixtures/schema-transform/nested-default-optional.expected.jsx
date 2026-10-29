function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { type Cell, Default, handler, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface OptionalBranch {
    counter?: number;
    label?: string;
}
interface OptionalNested {
    branch?: OptionalBranch;
}
interface NestedOptionalState {
    nested?: OptionalNested;
}
interface NestedOptionalArgs {
    // deno-lint-ignore ban-types
    state: Default<NestedOptionalState, {}>;
}
const increment = handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        state: {
            $ref: "#/$defs/NestedOptionalState",
            asCell: ["cell"]
        }
    },
    required: ["state"],
    $defs: {
        NestedOptionalState: {
            type: "object",
            properties: {
                nested: {
                    $ref: "#/$defs/OptionalNested"
                }
            }
        },
        OptionalNested: {
            type: "object",
            properties: {
                branch: {
                    $ref: "#/$defs/OptionalBranch"
                }
            }
        },
        OptionalBranch: {
            type: "object",
            properties: {
                counter: {
                    type: "number"
                },
                label: {
                    type: "string"
                }
            }
        }
    }
} as const satisfies __cfHelpers.JSONSchema, (_, context: {
    state: Cell<NestedOptionalState>;
}) => {
    const current = context.state.get() ?? {};
    const branch = current.nested?.branch ?? {};
    const counter = (branch.counter ?? 0) + 1;
    context.state.set({ nested: { branch: { counter } } });
});
// FIXTURE: nested-default-optional
// Verifies: nested optional interfaces with Default<> generate schemas with $ref/$defs and "default" values
//   Default<NestedOptionalState, {}> → schema property with "default": {}
//   Optional nested fields → $ref without "required" entries
//   handler() → injects event/context schemas with asCell annotations
//   pattern<Args>() → generates input schema, output schema (with asOpaque/asStream)
// Context: deeply nested optional types (OptionalBranch inside OptionalNested inside NestedOptionalState)
export default pattern((__cf_pattern_input) => {
    const state = __cf_pattern_input.key("state");
    return {
        state,
        increment: increment({ state }).for({ stream: ["__patternResult", "increment"] }, true)
    };
}, {
    type: "object",
    properties: {
        state: {
            $ref: "#/$defs/NestedOptionalState",
            "default": {}
        }
    },
    required: ["state"],
    $defs: {
        NestedOptionalState: {
            type: "object",
            properties: {
                nested: {
                    $ref: "#/$defs/OptionalNested"
                }
            }
        },
        OptionalNested: {
            type: "object",
            properties: {
                branch: {
                    $ref: "#/$defs/OptionalBranch"
                }
            }
        },
        OptionalBranch: {
            type: "object",
            properties: {
                counter: {
                    type: "number"
                },
                label: {
                    type: "string"
                }
            }
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        state: {
            $ref: "#/$defs/NestedOptionalState",
            "default": {}
        },
        increment: {
            type: "unknown",
            asCell: ["stream"]
        }
    },
    required: ["state", "increment"],
    $defs: {
        NestedOptionalState: {
            type: "object",
            properties: {
                nested: {
                    $ref: "#/$defs/OptionalNested"
                }
            }
        },
        OptionalNested: {
            type: "object",
            properties: {
                branch: {
                    $ref: "#/$defs/OptionalBranch"
                }
            }
        },
        OptionalBranch: {
            type: "object",
            properties: {
                counter: {
                    type: "number"
                },
                label: {
                    type: "string"
                }
            }
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    increment
});
