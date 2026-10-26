function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, pattern, UI, NAME } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// Represents a question that may or may not exist
type Question = {
    question: string;
    category: string;
    priority: number;
};
const __cfLift_1 = __cfHelpers.lift((): Question | null => {
    // In real code this would filter and return first match, or null
    return null;
}, false, undefined, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift<{
    topQuestion: {
        question: string;
    } | null;
}, string>(({ topQuestion }) => topQuestion?.question || "", {
    type: "object",
    properties: {
        topQuestion: {
            anyOf: [{
                    type: "object",
                    properties: {
                        question: {
                            type: "string"
                        }
                    },
                    required: ["question"]
                }, {
                    type: "null"
                }]
        }
    },
    required: ["topQuestion"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_3 = __cfHelpers.lift<{
    topQuestion: Question | null;
}, string>(({ topQuestion }) => topQuestion === null ? "" : topQuestion.question, {
    type: "object",
    properties: {
        topQuestion: {
            anyOf: [{
                    $ref: "#/$defs/Question"
                }, {
                    type: "null"
                }]
        }
    },
    required: ["topQuestion"],
    $defs: {
        Question: {
            type: "object",
            properties: {
                question: {
                    type: "string"
                },
                category: {
                    type: "string"
                },
                priority: {
                    type: "number"
                }
            },
            required: ["question", "category", "priority"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_4 = __cfHelpers.lift<{
    topQuestion: {
        category: string;
    } | null;
}, string>(({ topQuestion }) => topQuestion?.category || "", {
    type: "object",
    properties: {
        topQuestion: {
            anyOf: [{
                    type: "object",
                    properties: {
                        category: {
                            type: "string"
                        }
                    },
                    required: ["category"]
                }, {
                    type: "null"
                }]
        }
    },
    required: ["topQuestion"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_5 = __cfHelpers.lift<{
    topQuestion: Question | null;
}, string>(({ topQuestion }) => topQuestion === null ? "" : topQuestion.category, {
    type: "object",
    properties: {
        topQuestion: {
            anyOf: [{
                    $ref: "#/$defs/Question"
                }, {
                    type: "null"
                }]
        }
    },
    required: ["topQuestion"],
    $defs: {
        Question: {
            type: "object",
            properties: {
                question: {
                    type: "string"
                },
                category: {
                    type: "string"
                },
                priority: {
                    type: "number"
                }
            },
            required: ["question", "category", "priority"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: computed-nullable-optional-chain
// Verifies: computed() capturing a nullable computed result preserves anyOf [type, null] in schema
//   computed(() => topQuestion?.question || "") → lift(({ topQuestion }) => topQuestion?.question || "")({ topQuestion })
//   computed(() => topQuestion === null ? "" : topQuestion.question) → lift(({ topQuestion }) => ...)({ topQuestion })
// Context: Tests both optional chaining (?.) and explicit null-check patterns on
//   a nullable Reactive. The capture schema correctly uses anyOf [Question, null]
//   with asOpaque: true for the topQuestion capture.
export default pattern((_) => {
    // This computed can return null - simulates finding a question from a list
    const topQuestion = __cfLift_1().for("topQuestion", true);
    return {
        [NAME]: "Computed Nullable Optional Chain",
        [UI]: (<div>
        {/* BUG CASE: Optional chaining loses nullability in schema inference */}
        {/* The input schema should have topQuestion as anyOf [Question, null] */}
        {/* but instead infers topQuestion as object with required "question" */}
        <p>Optional chaining: {__cfLift_2({ topQuestion: topQuestion })}</p>

        {/* WORKAROUND: Explicit null check preserves nullability */}
        {/* This correctly generates anyOf [Question, null] in the schema */}
        <p>Explicit check: {__cfLift_3({ topQuestion: topQuestion })}</p>

        {/* Same issue with category field */}
        <span>Category (buggy): {__cfLift_4({ topQuestion: topQuestion })}</span>
        <span>Category (works): {__cfLift_5({ topQuestion: topQuestion })}</span>
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
    __cfLift_3,
    __cfLift_4,
    __cfLift_5
});
