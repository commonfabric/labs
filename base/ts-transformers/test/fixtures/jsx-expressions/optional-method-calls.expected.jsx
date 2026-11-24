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
function format(value: string): string {
    return value.toUpperCase();
}
__cfHardenFn(format);
interface State {
    maybeText?: string;
    suffix: string;
    items: Array<string | undefined>;
}
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        maybeText?: string | undefined;
    };
}, string | undefined>(({ state }) => state.maybeText?.trim(), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                maybeText: {
                    type: "string"
                }
            }
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["string", "undefined"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    state: {
        maybeText?: string | undefined;
    };
}, string>(({ state }) => format?.(state.maybeText ?? ""), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                maybeText: {
                    type: "string"
                }
            }
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_3 = __cfHelpers.lift<{
    state: {
        maybeText?: string | undefined;
        suffix: string;
    };
}, string | undefined>(({ state }) => state.maybeText?.replace?.("x", state.suffix), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                maybeText: {
                    type: "string"
                },
                suffix: {
                    type: "string"
                }
            },
            required: ["suffix"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["string", "undefined"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_4 = __cfHelpers.lift<{
    item: string | undefined;
}, string | undefined>(({ item }) => item?.trim?.(), {
    type: "object",
    properties: {
        item: {
            type: "string"
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["string", "undefined"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    return <span>{__cfLift_4({ item: item })}</span>;
}, {
    type: "object",
    properties: {
        element: {
            type: "string"
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
// FIXTURE: optional-method-calls
// Verifies: receiver and invocation optionality lower as whole computations
//   state.maybeText?.trim()                     → lift preserving receiver ?.
//   state.maybeText?.replace?.("x", state.suffix) → lift preserving both ?.
//   item?.trim?.()                              → callback lift preserving both ?.
//   format?.(state.maybeText ?? "")              → lift preserving lazy args
// Context: Optionality modifies an otherwise supported call;
//          the underlying call's provenance and lowering route stay unchanged.
export default pattern((state) => ({
    normalized: __cfLift_1({ state: {
            maybeText: state.key("maybeText")
        } }).for(["__patternResult", "normalized"], true),
    selected: __cfLift_2({ state: {
            maybeText: state.key("maybeText")
        } }).for(["__patternResult", "selected"], true),
    [UI]: (<div>
      <p>{__cfLift_3({ state: {
            maybeText: state.key("maybeText"),
            suffix: state.key("suffix")
        } })}</p>
      {state.key("items").mapWithPattern(__cfPattern_1, {})}
    </div>)
}), {
    type: "object",
    properties: {
        maybeText: {
            type: "string"
        },
        suffix: {
            type: "string"
        },
        items: {
            type: "array",
            items: {
                type: ["string", "undefined"]
            }
        }
    },
    required: ["suffix", "items"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        normalized: {
            type: ["string", "undefined"]
        },
        selected: {
            type: "string"
        },
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["normalized", "selected", "$UI"],
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
    __cfLift_3,
    __cfLift_4,
    __cfPattern_1
});
