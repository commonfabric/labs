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
 * Regression test for array.length access inside computed().
 *
 * This mimics the pattern from default-app.tsx where:
 * - pieceRegistry comes from wish<{ pieceRegistry: MentionablePiece[] }>
 * - computed(() => pieceRegistry.length) accesses .length on an array from wish
 *
 * The fix ensures the schema is { type: "array", items: { not: true } }
 * rather than { type: "object", properties: { length: { type: "number" } } }
 */
import { computed, NAME, pattern, resultOf, UI, wish } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Piece {
    id: string;
    name: string;
}
const __cfLift_1 = __cfHelpers.lift<{
    pieceRegistry: {
        length: number;
    };
}, string>(({ pieceRegistry }) => `Pieces (${pieceRegistry.length})`, {
    type: "object",
    properties: {
        pieceRegistry: {
            type: "object",
            properties: {
                length: {
                    type: "number"
                }
            },
            required: ["length"]
        }
    },
    required: ["pieceRegistry"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift<{
    pieceRegistry: {
        length: number;
    };
}, number>(({ pieceRegistry }) => pieceRegistry.length, {
    type: "object",
    properties: {
        pieceRegistry: {
            type: "object",
            properties: {
                length: {
                    type: "number"
                }
            },
            required: ["length"]
        }
    },
    required: ["pieceRegistry"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const piece = __cf_pattern_input.key("element");
    return (<li>{piece.key("name")}</li>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Piece"
        }
    },
    required: ["element"],
    $defs: {
        Piece: {
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
// FIXTURE: computed-array-length
// Verifies: computed(() => expr) with .length access on a Reactive<T[]> is closure-extracted
//   computed(() => pieceRegistry.length) → lift(({ pieceRegistry }) => pieceRegistry.length)({ pieceRegistry: { length: pieceRegistry.length } })
//   pieceRegistry.map(fn) → pieceRegistry.mapWithPattern(pattern(fn, ...schemas), {})
// Context: Regression test ensuring array .length produces the correct schema
//   shape rather than an object schema with a length property.
export default pattern(() => {
    const piecesWish = wish<{
        pieceRegistry: Piece[];
    }>({ query: "/" }, {
        type: "object",
        properties: {
            pieceRegistry: {
                type: "array",
                items: {
                    $ref: "#/$defs/Piece"
                }
            }
        },
        required: ["pieceRegistry"],
        $defs: {
            Piece: {
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
        }
    } as const satisfies __cfHelpers.JSONSchema).for("piecesWish", true);
    const __cf_destructure_1 = resultOf(piecesWish.key("result")), pieceRegistry = __cf_destructure_1.key("pieceRegistry").for("pieceRegistry", true);
    return {
        [NAME]: __cfLift_1({ pieceRegistry: {
                length: pieceRegistry.key("length")
            } }),
        [UI]: (<div>
        <span>Count: {__cfLift_2({ pieceRegistry: {
                length: pieceRegistry.key("length")
            } })}</span>
        <ul>
          {pieceRegistry.mapWithPattern(__cfPattern_1, {})}
        </ul>
      </div>),
    };
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string"
        },
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$NAME", "$UI"],
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
    __cfPattern_1
});
