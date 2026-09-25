function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, pattern, UI, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface TagEvent {
    label: string;
}
interface Item {
    name: string;
    value: number;
}
type State = {
    user: {
        settings: {
            notifications: boolean;
        };
    };
    recentEvents: TagEvent[];
    items: Item[];
};
const __cfLift_hdbf1e9e0ab50 = __cfHelpers.lift<{
    state: {
        items: Item[];
    };
}, Item[]>(({ state }) => [...state.items].sort((a, b) => a.value - b.value), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Item"
                    }
                }
            },
            required: ["items"]
        }
    },
    required: ["state"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                value: {
                    type: "number"
                }
            },
            required: ["name", "value"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        $ref: "#/$defs/Item"
    },
    $defs: {
        Item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                value: {
                    type: "number"
                }
            },
            required: ["name", "value"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_h0fd003a899da = __cfHelpers.lift<{
    state: {
        items: {
            length: number;
        };
    };
}, number>(({ state }) => state.items.length, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
                    type: "object",
                    properties: {
                        length: {
                            type: "number"
                        }
                    },
                    required: ["length"]
                }
            },
            required: ["items"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_h24bcb361f84f = __cfHelpers.lift<{
    state: any;
}, boolean>(({ state }) => state.recentEvents.length === 0, {
    type: "object",
    properties: {
        state: true
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_h0ba44e3e915a = __cfHelpers.pattern(__cf_pattern_input => {
    const event = __cf_pattern_input.key("element");
    const idx = __cf_pattern_input.key("index");
    return (<cf-hstack key={idx} gap="2">
                  <span>{event.key("label")}</span>
                </cf-hstack>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/TagEvent"
        },
        index: {
            type: "number"
        }
    },
    required: ["element"],
    $defs: {
        TagEvent: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                }
            },
            required: ["label"]
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
// FIXTURE: ternary-branch-ownership
// Verifies: ternary branches preserve the right ownership mode for lowered work
//   state.user.settings.notifications ? "enabled" : "disabled"
//     -> ifElse(...) with a boolean predicate schema after key(...) lowering
//   recentEvents.length === 0 ? <span>... : <div>{recentEvents.map(...)}</div>
//     -> single branch lift-applied computation + recentEvents.mapWithPattern(...)
//   showList ? (() => { const itemCount = count + " items"; return <div>{sorted.map(...)}</div>; })() : ...
//     -> whole branch compute-wrapped, so sorted.map(...) stays plain JS
export default pattern((state) => {
    const showList = new Writable(true, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema).for("showList", true);
    const sorted = __cfLift_hdbf1e9e0ab50({ state: {
            items: state.key("items")
        } }).for("sorted", true);
    const count = __cfLift_h0fd003a899da({ state: {
            items: {
                length: state.key("items", "length")
            }
        } }).for("count", true);
    return {
        [UI]: (<div>
        <p>{__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["enabled", "disabled"]
        } as const satisfies __cfHelpers.JSONSchema, state.key("user", "settings", "notifications"), "enabled", "disabled")}</p>
        {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_h24bcb361f84f({ state: state }), <span>No events yet</span>, <div>
              {state.key("recentEvents").mapWithPattern(__cfPattern_h0ba44e3e915a, {})}
            </div>)}
        {__cfHelpers.ifElse({
            type: "boolean",
            asCell: ["cell"]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, showList, (() => {
            const itemCount = count + " items";
            return (<div>
                <span>{itemCount}</span>
                {sorted.map((item: Item) => (<span>{item.name}</span>))}
              </div>);
        })(), <span>Hidden</span>)}
      </div>),
    };
}, {
    type: "object",
    properties: {
        user: {
            type: "object",
            properties: {
                settings: {
                    type: "object",
                    properties: {
                        notifications: {
                            type: "boolean"
                        }
                    },
                    required: ["notifications"]
                }
            },
            required: ["settings"]
        },
        recentEvents: {
            type: "array",
            items: {
                $ref: "#/$defs/TagEvent"
            }
        },
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        }
    },
    required: ["user", "recentEvents", "items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                value: {
                    type: "number"
                }
            },
            required: ["name", "value"]
        },
        TagEvent: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                }
            },
            required: ["label"]
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
    __cfLift_hdbf1e9e0ab50,
    __cfLift_h0fd003a899da,
    __cfLift_h24bcb361f84f,
    __cfPattern_h0ba44e3e915a,
    __cfLift_1: __cfLift_hdbf1e9e0ab50,
    __cfLift_2: __cfLift_h0fd003a899da,
    __cfLift_3: __cfLift_h24bcb361f84f,
    __cfPattern_1: __cfPattern_h0ba44e3e915a
});
