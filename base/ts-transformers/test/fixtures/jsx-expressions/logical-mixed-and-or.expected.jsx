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
}, string | false>(({ user }) => (user.get().name.length > 0 && user.get().name), {
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
    anyOf: [{
            type: "string"
        }, {
            type: "boolean",
            "enum": [false]
        }]
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    defaultMessage: __cfHelpers.Cell<string>;
}, string>(({ defaultMessage }) => defaultMessage.get(), {
    type: "object",
    properties: {
        defaultMessage: {
            type: "string",
            asCell: ["readonly"]
        }
    },
    required: ["defaultMessage"]
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
const __cfLift_5 = __cfHelpers.lift<{
    user: __cfHelpers.Cell<{ name: string; age: number; }>;
}, string | false>(({ user }) => (user.get().name.length > 0 && `Hello ${user.get().name}`) ||
    (user.get().age > 0 && `Age: ${user.get().age}`), {
    type: "object",
    properties: {
        user: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                age: {
                    type: "number"
                }
            },
            required: ["name", "age"],
            asCell: ["readonly"]
        }
    },
    required: ["user"]
} as const satisfies __cfHelpers.JSONSchema, {
    anyOf: [{
            type: "string"
        }, {
            type: "boolean",
            "enum": [false]
        }]
} as const satisfies __cfHelpers.JSONSchema);
// Tests mixed && and || operators: (a && b) || c
// The && should use when, the || should use unless
// FIXTURE: logical-mixed-and-or
// Verifies: mixed && and || patterns are correctly decomposed into when/unless/lift-applied
//   (cond && value) || fallback → lift-applied computation or nested when/unless
//   cond && (value || fallback) → nested logical transforms
//   (a && b) || (c && d) || e   → chained lift-applied expressions
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
    const defaultMessage = cell("Guest", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema).for("defaultMessage", true);
    return {
        [UI]: (<div>
        {/* (condition && value) || fallback pattern */}
        <span>{__cfHelpers.unless({
            type: ["boolean", "string"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_1({ user: user }), __cfLift_2({ defaultMessage: defaultMessage }))}</span>

        {/* condition && (value || fallback) pattern */}
        <span>{__cfHelpers.when({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: ["boolean", "string"]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_3({ user: user }), __cfHelpers.unless({
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_4({ user: user }), "Anonymous Adult"))}</span>

        {/* Complex: (a && b) || (c && d) */}
        <span>
          {__cfHelpers.unless({
            type: ["boolean", "string"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_5({ user: user }), "Unknown user")}
        </span>
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
    __cfLift_4,
    __cfLift_5
});
