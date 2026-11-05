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
 * TRANSFORM REPRO: helper-owned JSX IIFE final map callback captures reactive state
 * after the local receiver has been rewritten through a synthetic fallback wrapper.
 */
import { pattern, UI, VNode } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Entry {
    name: string;
}
interface Input {
    entries: Entry[];
    prefix: string;
    labelPrefix: string;
}
interface Output {
    [UI]: VNode;
}
const visibleEntries = __cfHardenFn((entries: Entry[], prefix: string) => entries.filter((entry) => entry.name.startsWith(prefix)));
const __cfLift_1 = __cfHelpers.lift<{
    entries: Entry[];
    prefix: string;
}, Entry[]>(({ entries, prefix }) => visibleEntries(entries, prefix), {
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
const __cfPattern_1 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { labelPrefix }) => {
    const entry = __cf_pattern_input.key("element");
    return (<button type="button">
            {labelPrefix}:{entry.key("name")}
          </button>);
}, {
    type: "object",
    properties: {
        labelPrefix: {
            type: "string"
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
    const labelPrefix = __cf_pattern_input.key("labelPrefix");
    return ({
        [UI]: (<div>
      {(() => {
                const visible = __cfHelpers.unless({
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
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "array",
                    items: false
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
                } as const satisfies __cfHelpers.JSONSchema, __cfLift_1({
                    entries: entries,
                    prefix: prefix
                }).for(["visible", 3], true), []).for("visible", true);
                return visible.mapWithPattern(__cfPattern_1.curry({
                    labelPrefix: labelPrefix
                }));
            })()}
    </div>)
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
        },
        labelPrefix: {
            type: "string"
        }
    },
    required: ["entries", "prefix", "labelPrefix"],
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
    __cfPattern_1
});
