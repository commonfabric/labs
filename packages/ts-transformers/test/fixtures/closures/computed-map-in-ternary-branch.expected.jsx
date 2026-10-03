function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, computed, Default, pattern, UI, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Person {
    name: string;
    rank: number;
}
interface PatternInput {
    people?: Cell<Default<Person[], [
    ]>>;
}
const __cfLift_h316fa572d593 = __cfHelpers.lift<{
    people: __cfHelpers.ReadonlyCell<Person[]>;
}, { name: string; rank: number; isFirst: boolean; }[]>(({ people }) => [...people.get()]
    .sort((a, b) => a.rank - b.rank)
    .map((p) => ({ name: p.name, rank: p.rank, isFirst: p.rank === 1 })), {
    type: "object",
    properties: {
        people: {
            type: "array",
            items: {
                $ref: "#/$defs/Person"
            },
            asCell: ["readonly"]
        }
    },
    required: ["people"],
    $defs: {
        Person: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                rank: {
                    type: "number"
                }
            },
            required: ["name", "rank"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "object",
        properties: {
            name: {
                type: "string"
            },
            rank: {
                type: "number"
            },
            isFirst: {
                type: "boolean"
            }
        },
        required: ["name", "rank", "isFirst"]
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_h3a9c50d3f4cf = __cfHelpers.lift<{
    people: __cfHelpers.ReadonlyCell<unknown[]>;
}, number>(({ people }) => people.get().length, {
    type: "object",
    properties: {
        people: {
            type: "array",
            items: {
                type: "unknown"
            },
            asCell: ["readonly"]
        }
    },
    required: ["people"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfPattern_h9d910eebd9d0 = __cfHelpers.pattern(__cf_pattern_input => {
    const person = __cf_pattern_input.key("element");
    return (<span>{person.key("name")}</span>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Person"
        }
    },
    required: ["element"],
    $defs: {
        Person: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                rank: {
                    type: "number"
                }
            },
            required: ["name", "rank"]
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
const __cfLift_h18f03ff428f4 = __cfHelpers.lift<{
    count: number;
}, string>(({ count }) => count + " people", {
    type: "object",
    properties: {
        count: {
            type: "number"
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_h278aca9fcc08 = __cfHelpers.pattern(__cf_pattern_input => {
    const entry = __cf_pattern_input.key("element");
    return (<li>
                    {__cfHelpers.ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        "enum": ["", "\u2605 "]
    } as const satisfies __cfHelpers.JSONSchema, entry.key("isFirst"), "★ ", "")}
                    {entry.key("name")}
                  </li>);
}, {
    type: "object",
    properties: {
        element: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                rank: {
                    type: "number"
                },
                isFirst: {
                    type: "boolean"
                }
            },
            required: ["name", "rank", "isFirst"]
        }
    },
    required: ["element"]
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
// FIXTURE: computed-map-in-ternary-branch
// Verifies: a computed array used inside a ternary JSX branch stays pattern-lowered
//   const adminData = computed(() => [...people.get()].sort(...).map(...))
//   adminData.map((entry) => <li>...) → adminData.mapWithPattern(pattern(...), {})
//   showAdmin ? <div>...</div> : null → ifElse(showAdmin, <div>...</div>, null)
// Context: The outer `people.map(...)` is over a pattern input cell, while the
//   inner `adminData.map(...)` is over compute-owned data but still lowered in
//   pattern context when rendered from the ternary branch.
export default pattern((__cf_pattern_input) => {
    const people = __cf_pattern_input.key("people");
    const showAdmin = new Writable(false, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema).for("showAdmin", true);
    const adminData = __cfLift_h316fa572d593({ people: people }).for("adminData", true);
    const count = __cfLift_h3a9c50d3f4cf({ people: people }).for("count", true);
    return {
        [UI]: (<div>
        {people.mapWithPattern(__cfPattern_h9d910eebd9d0, {})}
        {__cfHelpers.ifElse({
            type: "boolean",
            asCell: ["cell"]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "null"
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{
                    type: "null"
                }, {}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, showAdmin, <div>
              <span>{__cfLift_h18f03ff428f4({ count: count })}</span>
              <ul>
                {adminData.mapWithPattern(__cfPattern_h278aca9fcc08, {})}
              </ul>
            </div>, null)}
      </div>),
    };
}, {
    type: "object",
    properties: {
        people: {
            type: "array",
            items: {
                $ref: "#/$defs/Person"
            },
            "default": [],
            asCell: ["cell"]
        }
    },
    $defs: {
        Person: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                rank: {
                    type: "number"
                }
            },
            required: ["name", "rank"]
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
    __cfLift_h316fa572d593,
    __cfLift_h3a9c50d3f4cf,
    __cfPattern_h9d910eebd9d0,
    __cfLift_h18f03ff428f4,
    __cfPattern_h278aca9fcc08,
    __cfLift_1: __cfLift_h316fa572d593,
    __cfLift_2: __cfLift_h3a9c50d3f4cf,
    __cfPattern_1: __cfPattern_h9d910eebd9d0,
    __cfLift_3: __cfLift_h18f03ff428f4,
    __cfPattern_2: __cfPattern_h278aca9fcc08
});
