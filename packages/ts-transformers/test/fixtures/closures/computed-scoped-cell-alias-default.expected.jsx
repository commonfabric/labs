function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, Default, pattern, type PerSession, type PerUser, Writable, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Counters {
    nextSeq: number;
    expiredThrough: number;
}
const ANNOTATED: Counters = __cfHelpers.__cf_data({ nextSeq: 1, expiredThrough: 0 });
const SATISFYING = __cfHelpers.__cf_data({ nextSeq: 1, expiredThrough: 0 } satisfies Counters);
type AnnotatedCell = Writable<Counters | Default<typeof ANNOTATED>>;
type SatisfyingCell = Writable<Counters | Default<typeof SATISFYING>>;
interface Input {
    annotated: PerSession<AnnotatedCell>;
    satisfying: PerUser<SatisfyingCell>;
}
const __cfLift_1 = __cfHelpers.lift<{
    annotated: __cfHelpers.PerSession<__cfHelpers.ReadonlyCell<{
        nextSeq: number;
    } | Default<typeof ANNOTATED>>>;
}, number>(({ annotated }) => annotated.get().nextSeq, {
    type: "object",
    properties: {
        annotated: {
            anyOf: [{
                    type: "object",
                    properties: {
                        nextSeq: {
                            type: "number"
                        }
                    },
                    required: ["nextSeq"]
                }, {
                    $ref: "#/$defs/Counters",
                    "default": {
                        nextSeq: 1,
                        expiredThrough: 0
                    }
                }],
            asCell: [{
                    kind: "readonly",
                    scope: "session"
                }]
        }
    },
    required: ["annotated"],
    $defs: {
        Counters: {
            type: "object",
            properties: {
                nextSeq: {
                    type: "number"
                },
                expiredThrough: {
                    type: "number"
                }
            },
            required: ["nextSeq", "expiredThrough"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift<{
    satisfying: __cfHelpers.PerUser<__cfHelpers.ReadonlyCell<{
        expiredThrough: number;
    } | Default<typeof SATISFYING>>>;
}, number>(({ satisfying }) => satisfying.get().expiredThrough, {
    type: "object",
    properties: {
        satisfying: {
            anyOf: [{
                    type: "object",
                    properties: {
                        expiredThrough: {
                            type: "number"
                        }
                    },
                    required: ["expiredThrough"]
                }, {
                    type: "object",
                    properties: {
                        nextSeq: {
                            type: "number"
                        },
                        expiredThrough: {
                            type: "number"
                        }
                    },
                    required: ["nextSeq", "expiredThrough"],
                    "default": {
                        nextSeq: 1,
                        expiredThrough: 0
                    }
                }],
            asCell: [{
                    kind: "readonly",
                    scope: "user"
                }]
        }
    },
    required: ["satisfying"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: computed-scoped-cell-alias-default
// Verifies: a destructured input declared as a scope wrapper around an alias of
//   a cell, `PerSession<AnnotatedCell>` with
//   `type AnnotatedCell = Writable<Counters | Default<typeof ANNOTATED>>`, keeps
//   the authored `Default<typeof ANNOTATED>` in the capture type of a computed
//   that reads it, and so keeps the default in the lift's argument schema.
//   The alias inside the scope wrapper is read through, as it is inside
//   `Writable`.
// Context: `ANNOTATED` is annotated with an interface and `SATISFYING` is
//   checked with `satisfies`, so neither const's type is literal: a capture type
//   printed from the checker's type holds `Counters` or a widened object type
//   where the default was, with no value to recover.
export default pattern((__cf_pattern_input) => {
    const annotated = __cf_pattern_input.key("annotated");
    const satisfying = __cf_pattern_input.key("satisfying");
    const next = __cfLift_1({ annotated: annotated }).for("next", true);
    const expired = __cfLift_2({ satisfying: satisfying }).for("expired", true);
    return { next, expired };
}, {
    type: "object",
    properties: {
        annotated: {
            $ref: "#/$defs/Counters",
            "default": {
                nextSeq: 1,
                expiredThrough: 0
            },
            asCell: [{
                    kind: "cell",
                    scope: "session"
                }]
        },
        satisfying: {
            $ref: "#/$defs/Counters",
            "default": {
                nextSeq: 1,
                expiredThrough: 0
            },
            asCell: [{
                    kind: "cell",
                    scope: "user"
                }]
        }
    },
    required: ["annotated", "satisfying"],
    $defs: {
        Counters: {
            type: "object",
            properties: {
                nextSeq: {
                    type: "number"
                },
                expiredThrough: {
                    type: "number"
                }
            },
            required: ["nextSeq", "expiredThrough"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        next: {
            type: "number"
        },
        expired: {
            type: "number"
        }
    },
    required: ["next", "expired"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2
});
