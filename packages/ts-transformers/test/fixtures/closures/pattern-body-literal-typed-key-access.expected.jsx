function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, UI, type VNode } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface RowInput {
    piece: string;
}
interface RowOutput {
    rendered: string;
    extra: string;
}
interface Input extends RowInput {
    field: "rendered";
    entries: RowInput[];
}
interface Output {
    direct: string;
    chosen: string;
    rows: {
        direct: string;
    }[];
    [UI]: VNode;
}
const Row = pattern((input) => ({
    rendered: input.key("piece"),
    extra: input.key("piece"),
}), {
    type: "object",
    properties: {
        piece: {
            type: "string"
        }
    },
    required: ["piece"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        rendered: {
            type: "string"
        },
        extra: {
            type: "string"
        }
    },
    required: ["rendered", "extra"]
} as const satisfies __cfHelpers.JSONSchema);
const KEY = "rendered";
const __cfLift_1 = __cfHelpers.lift<{
    row: RowOutput;
    field: string;
}, string>(({ row, field }) => row[field], {
    type: "object",
    properties: {
        row: {
            $ref: "#/$defs/RowOutput"
        },
        field: {
            type: "string"
        }
    },
    required: ["row", "field"],
    $defs: {
        RowOutput: {
            type: "object",
            properties: {
                rendered: {
                    type: "string"
                },
                extra: {
                    type: "string"
                }
            },
            required: ["rendered", "extra"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const entry = __cf_pattern_input.key("element");
    const inner = Row({ piece: entry.key("piece") });
    return { direct: inner.key(KEY) };
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/RowInput"
        }
    },
    required: ["element"],
    $defs: {
        RowInput: {
            type: "object",
            properties: {
                piece: {
                    type: "string"
                }
            },
            required: ["piece"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        direct: {
            type: "string"
        }
    },
    required: ["direct"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_2 = __cfHelpers.pattern(__cf_pattern_input => {
    const entry = __cf_pattern_input.key("element");
    const inner = Row({ piece: entry.key("piece") });
    return <span>{inner.key(KEY)}</span>;
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/RowInput"
        }
    },
    required: ["element"],
    $defs: {
        RowInput: {
            type: "object",
            properties: {
                piece: {
                    type: "string"
                }
            },
            required: ["piece"]
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
// FIXTURE: pattern-body-literal-typed-key-access
// Verifies: `row[KEY]`, where KEY is a `const` of a single literal type,
// lowers to `row.key(KEY)` in the pattern body, in JSX, and in a collection
// callback alike, the key evaluated where the read is
//   direct: row[KEY]      → row.key(KEY)
//   <div>{row[KEY]}</div> → <div>{row.key(KEY)}</div>
// Context: a key read from a reactive value is not fixed by its type, so
// `row[field]` stays a lift over `row` and `field`
export default pattern((__cf_pattern_input) => {
    const piece = __cf_pattern_input.key("piece");
    const field = __cf_pattern_input.key("field");
    const entries = __cf_pattern_input.key("entries");
    const row = Row({ piece });
    return {
        direct: row.key(KEY),
        chosen: __cfLift_1({
            row: row,
            field: field
        }).for(["__patternResult", "chosen"], true),
        rows: entries.mapWithPattern(__cfPattern_1, {}).for(["__patternResult", "rows"], true),
        [UI]: (<div>
        {row.key(KEY)}
        {entries.mapWithPattern(__cfPattern_2, {})}
      </div>)
    };
}, {
    type: "object",
    properties: {
        field: {
            type: "string",
            "enum": ["rendered"]
        },
        entries: {
            type: "array",
            items: {
                $ref: "#/$defs/RowInput"
            }
        },
        piece: {
            type: "string"
        }
    },
    required: ["field", "entries", "piece"],
    $defs: {
        RowInput: {
            type: "object",
            properties: {
                piece: {
                    type: "string"
                }
            },
            required: ["piece"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        direct: {
            type: "string"
        },
        chosen: {
            type: "string"
        },
        rows: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    direct: {
                        type: "string"
                    }
                },
                required: ["direct"]
            }
        },
        $UI: {
            $ref: "https://commonfabric.org/schemas/vnode.json"
        }
    },
    required: ["direct", "chosen", "rows", "$UI"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    Row,
    __cfLift_1,
    __cfPattern_1,
    __cfPattern_2
});
