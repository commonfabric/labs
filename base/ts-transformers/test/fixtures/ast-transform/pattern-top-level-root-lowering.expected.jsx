function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const identity = __cfHardenFn(<T,>(value: T) => value);
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        user: {
            name: string;
        };
    };
}, string>(({ state }) => identity(state.user.name), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                user: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        }
                    },
                    required: ["name"]
                }
            },
            required: ["user"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    state: {
        maybeUser?: { name: string; } | undefined;
    };
}, string | undefined>(({ state }) => identity(state.maybeUser?.name), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                maybeUser: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        }
                    },
                    required: ["name"]
                }
            }
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["string", "undefined"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_3 = __cfHelpers.lift<{
    state: {
        a: number;
        b: number;
    };
}, number>(({ state }) => Math.max(state.a, state.b), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                a: {
                    type: "number"
                },
                b: {
                    type: "number"
                }
            },
            required: ["a", "b"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_4 = __cfHelpers.lift<{
    state: {
        float: string;
    };
}, number>(({ state }) => parseInt(state.float), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                float: {
                    type: "string"
                }
            },
            required: ["float"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_5 = __cfHelpers.lift<{
    state: {
        label?: string | null | undefined;
    };
}, string>(({ state }) => state.label ?? "Pending", {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                label: {
                    type: ["null", "string", "undefined"]
                }
            }
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: pattern-top-level-root-lowering
// Verifies: top-level non-JSX ordinary helper calls with reactive inputs are
//   lifted as whole calls instead of lowering only inner argument expressions.
//   identity(state.user.name)     -> lift-applied local-helper root
//   identity(state.maybeUser?.name) -> lift-applied optional property access
//   Math.max(state.a, state.b)    -> lift-applied free-function root
//   parseInt(state.float)         -> lift-applied free-function root
//   state.label ?? "Pending"      -> lift-applied nullish root
//   state.items?.[0]              -> lowered optional element access
export default pattern((state) => {
    const label = __cfLift_1({ state: {
            user: {
                name: state.key("user", "name")
            }
        } }).for("label", true);
    const maybeLabel = __cfLift_2({ state: {
            maybeUser: state.key("maybeUser")
        } }).for("maybeLabel", true);
    return {
        label,
        maybeLabel,
        maxValue: __cfLift_3({ state: {
                a: state.key("a"),
                b: state.key("b")
            } }).for(["__patternResult", "maxValue"], true),
        parsedValue: __cfLift_4({ state: {
                float: state.key("float")
            } }).for(["__patternResult", "parsedValue"], true),
        fallbackLabel: __cfLift_5({ state: {
                label: state.key("label")
            } }).for(["__patternResult", "fallbackLabel"], true),
        firstItem: state.key("items", "0")
    };
}, {
    type: "object",
    properties: {
        user: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        },
        maybeUser: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        },
        a: {
            type: "number"
        },
        b: {
            type: "number"
        },
        float: {
            type: "string"
        },
        label: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "null"
                }]
        },
        items: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["user", "a", "b", "float"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        label: {
            type: "string"
        },
        maybeLabel: {
            type: ["string", "undefined"]
        },
        maxValue: {
            type: "number"
        },
        parsedValue: {
            type: "number"
        },
        fallbackLabel: {
            type: "string"
        },
        firstItem: {
            type: ["string", "undefined"]
        }
    },
    required: ["label", "maybeLabel", "maxValue", "parsedValue", "fallbackLabel", "firstItem"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2,
    __cfLift_3,
    __cfLift_4,
    __cfLift_5
});
