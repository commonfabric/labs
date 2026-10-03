function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Default, handler, pattern, UI, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const join = handler({
    type: "object",
    properties: {
        name: {
            type: "string"
        }
    },
    required: ["name"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        myName: {
            type: "string",
            asCell: ["writeonly"]
        }
    },
    required: ["myName"]
} as const satisfies __cfHelpers.JSONSchema, (event, { myName }) => {
    myName.set(event.name);
});
interface CardState {
    myName: Default<string, "">;
    users: Default<string[], [
    ]>;
}
const __cfLift_h1eef49fc3d16 = __cfHelpers.lift<{
    users: {
        length: number;
    };
}, boolean>(({ users }) => users.length > 0, {
    type: "object",
    properties: {
        users: {
            type: "object",
            properties: {
                length: {
                    type: "number"
                }
            },
            required: ["length"]
        }
    },
    required: ["users"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfHandler_h98aa865b6fae = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        boundJoin: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"],
            asCell: ["stream"]
        }
    },
    required: ["boundJoin"]
} as const satisfies __cfHelpers.JSONSchema, (__cf_handler_event, { boundJoin }) => boundJoin.send({ name: "guest" }));
// FIXTURE: builder-arg-ternary-label
// Verifies: a ternary over a reactive comparison written inline in a
//   bound-handler's builder args lowers via the conditional emitter's ifElse
//   path (predicate lifted, literal branches preserved) rather than tripping
//   the compute-wrap guard:
//   label: users.length > 0 ? "join the others" : "be first"
//     -> ifElse(<schemas>, __cfLift_1({users}), "join the others", "be first")
// Context: contrast with the BINARY comparison form (`users.length === 0`)
//   at the same position, which is rejected with the
//   `reactive:call-argument-computation` hoist diagnostic — pinned in
//   test/builder-argument-computation-diagnostic.test.ts.
export default pattern((__cf_pattern_input) => {
    const myName = __cf_pattern_input.key("myName");
    const users = __cf_pattern_input.key("users");
    const boundJoin = join({
        myName,
        label: __cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["join the others", "be first"]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_h1eef49fc3d16({ users: {
                length: users.key("length")
            } }), "join the others", "be first").for(["boundJoin", "label"], true)
    }).for({ stream: "boundJoin" }, true);
    return {
        [UI]: (<div>
        <cf-button onClick={__cfHandler_h98aa865b6fae({
            boundJoin: boundJoin
        })}>
          Join
        </cf-button>
      </div>),
    };
}, {
    type: "object",
    properties: {
        myName: {
            type: "string",
            "default": ""
        },
        users: {
            type: "array",
            items: {
                type: "string"
            },
            "default": []
        }
    },
    required: ["myName", "users"]
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
    join,
    __cfLift_h1eef49fc3d16,
    __cfHandler_h98aa865b6fae,
    __cfLift_1: __cfLift_h1eef49fc3d16,
    __cfHandler_1: __cfHandler_h98aa865b6fae
});
