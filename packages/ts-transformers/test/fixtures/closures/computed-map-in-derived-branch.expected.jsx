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
// FIXTURE: computed-map-in-derived-branch
// Verifies: moving a reactive computation out of a JSX slot forces the whole
//   branch into derive(), so nested maps run in compute context and stay plain
//   const peopleCount = count + " people" inside an IIFE branch → branch derive()
//   adminData.map((entry) => <li>...) → stays plain .map() inside the derive callback
// Context: opposite of computed-map-in-ternary-branch; no JSX-local rewrite is
//   available for the hoisted `peopleCount` initializer.
export default pattern((__cf_pattern_input) => {
    const people = __cf_pattern_input.key("people");
    const showAdmin = new Writable(false, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema).for("showAdmin", true);
    const adminData = __cfLift_h316fa572d593({ people: people }).for("adminData", true);
    const count = __cfLift_h3a9c50d3f4cf({ people: people }).for("count", true);
    return {
        [UI]: (<div>
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
        } as const satisfies __cfHelpers.JSONSchema, showAdmin, (() => {
            const peopleCount = count + " people";
            return (<div>
                <span>{peopleCount}</span>
                <ul>
                  {adminData.map((entry) => (<li>
                      {entry.isFirst ? "★ " : ""}
                      {entry.name}
                    </li>))}
                </ul>
              </div>);
        })(), null)}
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
    __cfLift_1: __cfLift_h316fa572d593,
    __cfLift_2: __cfLift_h3a9c50d3f4cf
});
