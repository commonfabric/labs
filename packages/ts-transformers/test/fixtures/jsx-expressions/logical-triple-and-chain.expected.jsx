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
const __cfLift_hf4e7d1ab5fb4 = __cfHelpers.lift<{
    user: __cfHelpers.Cell<{ active: boolean; verified: boolean; name: string; }>;
}, boolean>(({ user }) => user.get().active && user.get().verified, {
    type: "object",
    properties: {
        user: {
            type: "object",
            properties: {
                active: {
                    type: "boolean"
                },
                verified: {
                    type: "boolean"
                }
            },
            required: ["active", "verified"],
            asCell: ["readonly"]
        }
    },
    required: ["user"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h7c79f9ddc33e = __cfHelpers.lift<{
    user: __cfHelpers.Cell<{ active: boolean; verified: boolean; name: string; }>;
}, string>(({ user }) => user.get().name, {
    type: "object",
    properties: {
        user: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"],
            asCell: ["readonly"]
        }
    },
    required: ["user"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
// Tests triple && chain: a && b && c
// Should produce nested when calls or lower the entire chain to a lift-applied computation
// FIXTURE: logical-triple-and-chain
// Verifies: triple && chain (a && b && <JSX>) is transformed to nested when() or a lift-applied computation
//   user.get().active && user.get().verified && <span> → when(lift(...)({ user }), <span>)
export default pattern((_state) => {
    const user = cell<{
        active: boolean;
        verified: boolean;
        name: string;
    }>({ active: false, verified: false, name: "" }, {
        type: "object",
        properties: {
            active: {
                type: "boolean"
            },
            verified: {
                type: "boolean"
            },
            name: {
                type: "string"
            }
        },
        required: ["active", "verified", "name"]
    } as const satisfies __cfHelpers.JSONSchema).for("user", true);
    return {
        [UI]: (<div>
        {/* Triple && chain with complex conditions */}
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
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_hf4e7d1ab5fb4({ user: user }), <span>Welcome, {__cfLift_h7c79f9ddc33e({ user: user })}!</span>)}
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
    __cfLift_hf4e7d1ab5fb4,
    __cfLift_h7c79f9ddc33e,
    __cfLift_1: __cfLift_hf4e7d1ab5fb4,
    __cfLift_2: __cfLift_h7c79f9ddc33e
});
