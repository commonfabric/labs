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
const __cfLift_hb7301f4eead6 = __cfHelpers.lift<{
    config: __cfHelpers.Cell<{ timeout: number | null; retries: number | undefined; }>;
}, number>(({ config }) => (config.get().timeout ?? 30), {
    type: "object",
    properties: {
        config: {
            type: "object",
            properties: {
                timeout: {
                    anyOf: [{
                            type: "number"
                        }, {
                            type: "null"
                        }]
                }
            },
            required: ["timeout"],
            asCell: ["readonly"]
        }
    },
    required: ["config"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_hf99436a4be1e = __cfHelpers.lift<{
    config: __cfHelpers.Cell<{ timeout: number | null; retries: number | undefined; }>;
}, boolean>(({ config }) => (config.get().retries ?? 3) > 0, {
    type: "object",
    properties: {
        config: {
            type: "object",
            properties: {
                retries: {
                    type: "number"
                }
            },
            asCell: ["readonly"]
        }
    },
    required: ["config"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h612c9c5c807d = __cfHelpers.lift<{
    items: __cfHelpers.Cell<string[]>;
}, string | false>(({ items }) => items.get().length > 0 && (items.get()[0] ?? "empty"), {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: ["readonly"]
        }
    },
    required: ["items"]
} as const satisfies __cfHelpers.JSONSchema, {
    anyOf: [{
            type: "string"
        }, {
            type: "boolean",
            "enum": [false]
        }]
} as const satisfies __cfHelpers.JSONSchema);
// Tests nullish coalescing (??) interaction with && and ||
// ?? should NOT be transformed to when/unless (different semantics)
// FIXTURE: logical-nullish-coalescing
// Verifies: ?? operator combined with && and || is correctly handled in a lift-applied computation
//   (config.get().timeout ?? 30) || "disabled" → lift(...)({ config })
//   (config.get().retries ?? 3) > 0 && "text"  → lift(...)({ config })
// Context: ?? has different semantics from || and must not be transformed to unless
export default pattern((_state) => {
    const config = cell<{
        timeout: number | null;
        retries: number | undefined;
    }>({
        timeout: null,
        retries: undefined,
    }, {
        type: "object",
        properties: {
            timeout: {
                anyOf: [{
                        type: "number"
                    }, {
                        type: "null"
                    }]
            },
            retries: {
                type: ["number", "undefined"]
            }
        },
        required: ["timeout", "retries"]
    } as const satisfies __cfHelpers.JSONSchema).for("config", true);
    const items = cell<string[]>([], {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __cfHelpers.JSONSchema).for("items", true);
    return {
        [UI]: (<div>
        {/* ?? followed by || - different semantics */}
        <span>Timeout: {__cfHelpers.unless({
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: ["number", "string"]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_hb7301f4eead6({ config: config }), "disabled")}</span>

        {/* ?? followed by && */}
        <span>{__cfHelpers.when({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": [false, "Will retry"]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_hf99436a4be1e({ config: config }), "Will retry")}</span>

        {/* Mixed: ?? with && and || */}
        <span>
          {__cfHelpers.unless({
            type: ["boolean", "string"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_h612c9c5c807d({ items: items }), "no items")}
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
    __cfLift_hb7301f4eead6,
    __cfLift_hf99436a4be1e,
    __cfLift_h612c9c5c807d,
    __cfLift_1: __cfLift_hb7301f4eead6,
    __cfLift_2: __cfLift_hf99436a4be1e,
    __cfLift_3: __cfLift_h612c9c5c807d
});
