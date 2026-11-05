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
 * TRANSFORM REPRO: helper-owned JSX IIFE final filter callback captures reactive state.
 */
import { Default, pattern, UI, VNode, Writable, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Entry {
    name: string;
}
interface Input {
    entries: Writable<Default<Entry[], [
    ]>>;
}
interface Output {
    [UI]: VNode;
}
function visibleEntries(entries: Writable<Default<Entry[], [
]>>, prefix: string): Entry[] {
    const list = entries.get();
    return list.filter((entry) => prefix.length === 0 || entry.name.startsWith(prefix));
}
__cfHardenFn(visibleEntries);
const __cfLift_1 = __cfHelpers.lift<{
    path: __cfHelpers.Cell<string[]>;
}, readonly string[]>(({ path }) => path.get(), {
    type: "object",
    properties: {
        path: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: ["readonly"]
        }
    },
    required: ["path"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    entries: Writable<Default<Entry[], [
    ]>>;
    p: readonly string[];
}, Entry[]>(({ entries, p }) => visibleEntries(entries, p[0] || ""), {
    type: "object",
    properties: {
        entries: {
            type: "array",
            items: {
                $ref: "#/$defs/Entry"
            },
            "default": [],
            asCell: ["readonly"]
        },
        p: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["entries", "p"],
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
    type: "array",
    items: {
        $ref: "#/$defs/Entry"
    },
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
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_3 = __cfHelpers.lift<{
    entry: {
        name: string;
    };
    labelPrefix: __cfHelpers.Cell<string>;
}, boolean>(({ entry, labelPrefix }) => entry.name.startsWith(`${labelPrefix}`), {
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
        labelPrefix: {
            type: "string",
            asCell: ["readonly"]
        }
    },
    required: ["entry", "labelPrefix"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { labelPrefix }) => {
    const entry = __cf_pattern_input.key("element");
    return __cfLift_3({
        entry: {
            name: entry.key("name")
        },
        labelPrefix: labelPrefix
    }).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        labelPrefix: {
            type: "string",
            asCell: ["cell"]
        }
    },
    required: ["labelPrefix"]
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
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_2 = __cfHelpers.pattern(__cf_pattern_input => {
    const entry = __cf_pattern_input.key("element");
    return <button type="button">{entry.key("name")}</button>;
}, {
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
    const path = new Writable<string[]>([], {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __cfHelpers.JSONSchema).for("path", true);
    const labelPrefix = new Writable("a", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema).for("labelPrefix", true);
    return {
        [UI]: (<div>
        {(() => {
                const p = __cfHelpers.unless({
                    type: "array",
                    items: {
                        type: "string"
                    }
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "array",
                    items: false
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "array",
                    items: {
                        type: "string"
                    }
                } as const satisfies __cfHelpers.JSONSchema, __cfLift_1({ path: path }).for(["p", 3], true), []).for("p", true);
                const visible = __cfLift_2({
                    entries: entries,
                    p: p
                }).for("visible", true);
                const filtered = visible.filterWithPattern(__cfPattern_1.curry({
                    labelPrefix: labelPrefix
                })).for("filtered", true);
                return filtered.mapWithPattern(__cfPattern_2);
            })()}
      </div>)
    };
}, {
    type: "object",
    properties: {
        entries: {
            type: "array",
            items: {
                $ref: "#/$defs/Entry"
            },
            "default": [],
            asCell: ["cell"]
        }
    },
    required: ["entries"],
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
    __cfPattern_1,
    __cfPattern_2
});
