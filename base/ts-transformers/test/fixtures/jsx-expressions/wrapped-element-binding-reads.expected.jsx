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
 * TRANSFORM REPRO: wrapped element-binding reads keep partial-key inputs
 *
 * Wrappers around the element identifier (parens, non-null assertion, `as`
 * type assertion) should not block the analyzer or the capture-tree parser
 * from recognizing `entry.name` as a fine-grained reactive dependency. The
 * lift-applied computation's inputs should use the nested partial-key shape
 *   { entry: { name: entry.key("name") } }
 * not a flat fallback like `_entry__name: entry.key("name")` (which is
 * what the parser produced before `parseCaptureExpression` started
 * unwrapping wrappers — the dependency was still captured, but in a less
 * structured shape that downstream readers don't expect).
 */
import { pattern, UI, type VNode } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
type Entry = {
    name: string;
};
interface Input {
    entries: Entry[];
    prefix: string;
}
interface Output {
    [UI]: VNode;
}
const __cfLift_1 = __cfHelpers.lift<{
    entry: {
        name: string;
    };
    prefix: string;
}, boolean>(({ entry, prefix }) => (entry).name === prefix, {
    type: "object",
    properties: {
        entry: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        },
        prefix: {
            type: "string"
        }
    },
    required: ["entry", "prefix"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    entry: {
        name: string;
    };
    prefix: string;
}, boolean>(({ entry, prefix }) => entry!.name === prefix, {
    type: "object",
    properties: {
        entry: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        },
        prefix: {
            type: "string"
        }
    },
    required: ["entry", "prefix"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_3 = __cfHelpers.lift<{
    entry: {
        name: string;
    };
    prefix: string;
}, boolean>(({ entry, prefix }) => (entry as Entry).name === prefix, {
    type: "object",
    properties: {
        entry: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        },
        prefix: {
            type: "string"
        }
    },
    required: ["entry", "prefix"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { prefix }) => {
    const entry = __cf_pattern_input.key("element");
    // Parenthesized: (entry).name
    const a = __cfLift_1({
        entry: {
            name: entry.key("name")
        },
        prefix: prefix
    }).for("a", true);
    // Non-null asserted: entry!.name
    const b = __cfLift_2({
        entry: {
            name: entry.key("name")
        },
        prefix: prefix
    }).for("b", true);
    // 'as' asserted: (entry as Entry).name
    const c = __cfLift_3({
        entry: {
            name: entry.key("name")
        },
        prefix: prefix
    }).for("c", true);
    return (<span data-a={a} data-b={b} data-c={c}>{entry.key("name")}</span>);
}, {
    type: "object",
    properties: {
        prefix: {
            type: "string"
        }
    },
    required: ["prefix"]
} as const satisfies __cfHelpers.JSONSchema), {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Entry"
        }
    },
    required: ["element"],
    $defs: {
        Entry: {
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
export default pattern((__cf_pattern_input) => {
    const entries = __cf_pattern_input.key("entries");
    const prefix = __cf_pattern_input.key("prefix");
    return ({
        [UI]: (<div>
      {entries.mapWithPattern(__cfPattern_1.curry({
                prefix: prefix
            }))}
    </div>),
    });
}, {
    type: "object",
    properties: {
        entries: {
            type: "array",
            items: {
                $ref: "#/$defs/Entry"
            }
        },
        prefix: {
            type: "string"
        }
    },
    required: ["entries", "prefix"],
    $defs: {
        Entry: {
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
            $ref: "https://commonfabric.org/schemas/vnode.json"
        }
    },
    required: ["$UI"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2,
    __cfLift_3,
    __cfPattern_1
});
