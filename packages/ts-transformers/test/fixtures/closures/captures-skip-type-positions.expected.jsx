function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { action, computed, pattern, UI, VNode, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface View {
    value: unknown;
    label: string;
}
interface Item {
    name: string;
    value: Record<string, unknown> | null;
}
interface State {
    view: View;
    items: Item[];
    log: Writable<string>;
}
function propOf(view: View): unknown {
    return view.value;
}
__cfHardenFn(propOf);
const __cfHandler_1 = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        view: {
            $ref: "#/$defs/View"
        },
        log: {
            type: "string",
            asCell: ["writeonly"]
        }
    },
    required: ["view", "log"],
    $defs: {
        View: {
            type: "object",
            properties: {
                value: {
                    type: "unknown"
                },
                label: {
                    type: "string"
                }
            },
            required: ["value", "label"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, (_, { view, log }) => {
    const value = propOf(view);
    if (typeof value === "object" && value !== null && "set" in value) {
        (value as {
            set: (next: string) => void;
        }).set("x");
    }
    log.set(view.label);
});
const __cfLift_1 = __cfHelpers.lift<{
    view: View;
}, string>(({ view }) => {
    const copy: typeof view = view;
    const value = copy.value;
    return typeof value === "object" && value !== null && "send" in value
        ? String((value as {
            send: (event: Record<string, never>) => void;
        }))
        : copy.label;
}, {
    type: "object",
    properties: {
        view: {
            $ref: "#/$defs/View"
        }
    },
    required: ["view"],
    $defs: {
        View: {
            type: "object",
            properties: {
                value: {
                    type: "unknown"
                },
                label: {
                    type: "string"
                }
            },
            required: ["value", "label"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift<{
    item: {
        value: Record<string, unknown> | null;
    };
}, boolean>(({ item }) => typeof item.value === "object", {
    type: "object",
    properties: {
        item: {
            type: "object",
            properties: {
                value: {
                    anyOf: [{
                            type: "object",
                            properties: {},
                            additionalProperties: {
                                type: "unknown"
                            }
                        }, {
                            type: "null"
                        }]
                }
            },
            required: ["value"]
        }
    },
    required: ["item"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_3 = __cfHelpers.lift<{
    item: {
        value: Record<string, unknown> | null;
    };
}, boolean>(({ item }) => item.value !== null, {
    type: "object",
    properties: {
        item: {
            type: "object",
            properties: {
                value: {
                    anyOf: [{
                            type: "object",
                            properties: {},
                            additionalProperties: {
                                type: "unknown"
                            }
                        }, {
                            type: "null"
                        }]
                }
            },
            required: ["value"]
        }
    },
    required: ["item"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_4 = __cfHelpers.lift<{
    item: {
        value: Record<string, unknown>;
    };
    get: (key: string) => unknown;
}, string>(({ item, get }) => String((item.value as {
    get: (key: string) => unknown;
})), {
    type: "object",
    properties: {
        item: {
            type: "object",
            properties: {
                value: {
                    type: "object",
                    properties: {},
                    additionalProperties: {
                        type: "unknown"
                    }
                }
            },
            required: ["value"]
        }
    },
    required: ["item"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    return (<span>
            {__cfHelpers.ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.when({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, __cfLift_2({ item: {
            value: item.key("value")
        } }), __cfLift_3({ item: {
            value: item.key("value")
        } })), __cfLift_4({
        item: {
            value: item.key("value")
        },
        get: get
    }), item.key("name"))}
          </span>);
}, {
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
                name: {
                    type: "string"
                },
                value: {
                    anyOf: [{
                            type: "object",
                            properties: {},
                            additionalProperties: {
                                type: "unknown"
                            }
                        }, {
                            type: "null"
                        }]
                }
            },
            required: ["name", "value"]
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
// FIXTURE: captures-skip-type-positions
// Verifies: a name that appears only inside a type is not captured
//   (value as { set: (next: string) => void })  → no `next` capture
//   (stream as { send: (event: …) => void })    → no `event` capture
//   const copy: typeof view = view              → `view` captured for the
//                                                 value, not for the type
// Context: the same capture collector serves actions, computeds and array
//   callbacks, and none of them may bind a type's parameter names as inputs:
//   with no such binding in scope, an unshrunk state would require them and
//   the callback would never run.
export default pattern((__cf_pattern_input) => {
    const view = __cf_pattern_input.key("view");
    const items = __cf_pattern_input.key("items");
    const log = __cf_pattern_input.key("log");
    const setIt = __cfHandler_1({
        view: view,
        log: log
    }).for({ stream: "setIt" }, true);
    const summary = __cfLift_1({ view: view }).for("summary", true);
    return {
        [UI]: (<div>
        <button type="button" onClick={setIt}>{summary}</button>
        {items.mapWithPattern(__cfPattern_1, {})}
      </div>),
    };
}, {
    type: "object",
    properties: {
        view: {
            $ref: "#/$defs/View"
        },
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        },
        log: {
            type: "string",
            asCell: ["cell"]
        }
    },
    required: ["view", "items", "log"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                value: {
                    anyOf: [{
                            type: "object",
                            properties: {},
                            additionalProperties: {
                                type: "unknown"
                            }
                        }, {
                            type: "null"
                        }]
                }
            },
            required: ["name", "value"]
        },
        View: {
            type: "object",
            properties: {
                value: {
                    type: "unknown"
                },
                label: {
                    type: "string"
                }
            },
            required: ["value", "label"]
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
    __cfHandler_1,
    __cfLift_1,
    __cfLift_2,
    __cfLift_3,
    __cfLift_4,
    __cfPattern_1
});
