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
const __cfLift_1 = __cfHelpers.lift<{
    user: __cfHelpers.Cell<{ name: string; age: number; }>;
}, boolean>(({ user }) => user.get().name.length > 0, {
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
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    user: __cfHelpers.Cell<{ name: string; age: number; }>;
}, string>(({ user }) => `Hello, ${user.get().name}!`, {
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
const __cfLift_3 = __cfHelpers.lift<{
    user: __cfHelpers.Cell<{ name: string; age: number; }>;
}, boolean>(({ user }) => user.get().age > 18, {
    type: "object",
    properties: {
        user: {
            type: "object",
            properties: {
                age: {
                    type: "number"
                }
            },
            required: ["age"],
            asCell: ["readonly"]
        }
    },
    required: ["user"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_4 = __cfHelpers.lift<{
    user: __cfHelpers.Cell<{ name: string; age: number; }>;
}, number>(({ user }) => user.get().age, {
    type: "object",
    properties: {
        user: {
            type: "object",
            properties: {
                age: {
                    type: "number"
                }
            },
            required: ["age"],
            asCell: ["readonly"]
        }
    },
    required: ["user"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: logical-and-non-jsx
// Verifies: && with non-JSX right side still lowers through when(), with predicate/value derived separately
//   user.get().name.length > 0 && `Hello...` → when(lift(...)(predicate), lift(...)(template))
//   user.get().age > 18 && user.get().age    → when(lift(...)(predicate), lift(...)(number))
// Context: JSX-local control flow still uses when(); non-JSX right-hand values become derived branch values
export default pattern((_state) => {
    const user = cell<{
        name: string;
        age: number;
    }>({ name: "", age: 0 }, {
        type: "object",
        properties: {
            name: {
                type: "string"
            },
            age: {
                type: "number"
            }
        },
        required: ["name", "age"]
    } as const satisfies __cfHelpers.JSONSchema).for("user", true);
    return {
        [UI]: (<div>
        {/* Non-JSX right side: string template with complex expression */}
        <p>{__cfHelpers.when({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: ["boolean", "string"]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_1({ user: user }), __cfLift_2({ user: user }))}</p>

        {/* Non-JSX right side: number expression */}
        <p>Age: {__cfHelpers.when({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: ["boolean", "number"]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_3({ user: user }), __cfLift_4({ user: user }))}</p>
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
    __cfLift_1,
    __cfLift_2,
    __cfLift_3,
    __cfLift_4
});
