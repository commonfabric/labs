function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { cell, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_hc6f7d7e5f267 = __cfHelpers.lift<{
    people: __cfHelpers.Cell<{ id: string; name: string; }[]>;
}, boolean>(({ people }) => people.get().length > 0, {
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
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_hfc461082958c = __cfHelpers.pattern(__cf_pattern_input => {
    const person = __cf_pattern_input.key("element");
    const index = __cf_pattern_input.key("index");
    return (<li key={index}>{person.key("name")}</li>);
}, {
    type: "object",
    properties: {
        element: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        },
        index: {
            type: "number"
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
// FIXTURE: map-single-capture-no-name
// Verifies: same map + length guard transforms work with _state: any parameter
//   people.get().length > 0 && <ul>{people.map(...)}</ul> → when(..., <ul>{mapWithPattern(...)}</ul>)
// Context: Variant of map-single-capture with _state: any
export default pattern((_state: any) => {
    const people = cell([
        { id: "1", name: "Alice" },
        { id: "2", name: "Bob" },
    ], {
        type: "array",
        items: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                name: {
                    type: "string"
                }
            },
            required: ["id", "name"]
        }
    } as const satisfies __cfHelpers.JSONSchema).for("people", true);
    return {
        [UI]: (<div>
        {__cfHelpers.when({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{
                    type: "boolean"
                }, {}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_hc6f7d7e5f267({ people: people }), <ul>
            {people.mapWithPattern(__cfPattern_hfc461082958c, {})}
          </ul>)}
      </div>),
    };
}, false as const satisfies __cfHelpers.JSONSchema, {
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
    __cfLift_hc6f7d7e5f267,
    __cfPattern_hfc461082958c,
    __cfLift_1: __cfLift_hc6f7d7e5f267,
    __cfPattern_1: __cfPattern_hfc461082958c
});
