function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
/**
 * Regression test: action() referenced inside explicit computed() in JSX
 *
 * Variation where the pattern author uses computed() explicitly inside JSX
 * (not encouraged, but should still work). The action is referenced INSIDE
 * the computed expression, so it must be captured in the lift-applied wrapper.
 */
import { action, Cell, computed, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Card {
    title: string;
    description: string;
}
interface Input {
    card: Card;
}
const __cfHandler_h51b930355b0f = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        isEditing: {
            type: "boolean",
            asCell: ["writeonly"]
        }
    },
    required: ["isEditing"]
} as const satisfies __cfHelpers.JSONSchema, (_, { isEditing }) => {
    isEditing.set(true);
});
const __cfLift_h8e88377ecb13 = __cfHelpers.lift<{
    card: {
        description: string;
    };
    startEditing: __cfHelpers.Stream<void>;
}, __cfHelpers.JSXElement>(({ card, startEditing }) => (<div>
                <span>{card.description}</span>
                <cf-button onClick={startEditing}>Edit</cf-button>
              </div>), {
    type: "object",
    properties: {
        card: {
            type: "object",
            properties: {
                description: {
                    type: "string"
                }
            },
            required: ["description"]
        },
        startEditing: {
            asCell: ["stream", "opaque"]
        }
    },
    required: ["card", "startEditing"]
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
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: action-in-ternary-with-explicit-computed
// Verifies: action() referenced inside an explicit computed() in JSX is captured in the lift-applied wrapper
//   action(() => ...) → handler(...)({ isEditing })
//   computed(() => JSX with action ref) → lift(fn)({ card, startEditing })
// Context: Action referenced inside computed expression must appear in the lift-applied capture object
export default pattern((__cf_pattern_input) => {
    const card = __cf_pattern_input.key("card");
    const isEditing = new Cell(false, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema).for("isEditing", true);
    const startEditing = __cfHandler_h51b930355b0f({
        isEditing: isEditing
    }).for({ stream: "startEditing" }, true);
    return {
        [UI]: (<cf-card>
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
        } as const satisfies __cfHelpers.JSONSchema, isEditing, <div>Editing</div>, <div>
            <span>{card.key("title")}</span>
            {/* Explicit computed() wrapping JSX that references the action */}
            {/* The action must be captured in the lift-applied computation created for this computed */}
            {__cfLift_h8e88377ecb13({
                card: {
                    description: card.key("description")
                },
                startEditing: startEditing
            })}
          </div>)}
      </cf-card>),
        card,
    };
}, {
    type: "object",
    properties: {
        card: {
            $ref: "#/$defs/Card"
        }
    },
    required: ["card"],
    $defs: {
        Card: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                },
                description: {
                    type: "string"
                }
            },
            required: ["title", "description"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        },
        card: {
            $ref: "#/$defs/Card"
        }
    },
    required: ["$UI", "card"],
    $defs: {
        Card: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                },
                description: {
                    type: "string"
                }
            },
            required: ["title", "description"]
        },
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
    __cfHandler_h51b930355b0f,
    __cfLift_h8e88377ecb13,
    __cfHandler_1: __cfHandler_h51b930355b0f,
    __cfLift_1: __cfLift_h8e88377ecb13
});
