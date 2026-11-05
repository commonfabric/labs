function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Vote {
    optionId: string;
    voterName: string;
}
const __cfLift_1 = __cfHelpers.lift<{
    v: {
        optionId: string;
    };
    oid: string;
}, boolean>(({ v, oid }) => v.optionId === oid, {
    type: "object",
    properties: {
        v: {
            type: "object",
            properties: {
                optionId: {
                    type: "string"
                }
            },
            required: ["optionId"]
        },
        oid: {
            type: "string"
        }
    },
    required: ["v", "oid"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { oid }) => {
    const v = __cf_pattern_input.key("element");
    return __cfLift_1({
        v: {
            optionId: v.key("optionId")
        },
        oid: oid
    }).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        oid: {
            type: "string"
        }
    },
    required: ["oid"]
} as const satisfies __cfHelpers.JSONSchema), {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Vote"
        }
    },
    required: ["element"],
    $defs: {
        Vote: {
            type: "object",
            properties: {
                optionId: {
                    type: "string"
                },
                voterName: {
                    type: "string"
                }
            },
            required: ["optionId", "voterName"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_2 = __cfHelpers.pattern(__cf_pattern_input => {
    const v = __cf_pattern_input.key("element");
    return <i>{v.key("voterName")}</i>;
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Vote"
        }
    },
    required: ["element"],
    $defs: {
        Vote: {
            type: "object",
            properties: {
                optionId: {
                    type: "string"
                },
                voterName: {
                    type: "string"
                }
            },
            required: ["optionId", "voterName"]
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
const __cfLift_2 = __cfHelpers.lift<{
    v: {
        optionId: string;
    };
    oid: string;
}, boolean>(({ v, oid }) => v.optionId === oid, {
    type: "object",
    properties: {
        v: {
            type: "object",
            properties: {
                optionId: {
                    type: "string"
                }
            },
            required: ["optionId"]
        },
        oid: {
            type: "string"
        }
    },
    required: ["v", "oid"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_3 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { oid }) => {
    const v = __cf_pattern_input.key("element");
    return __cfLift_2({
        v: {
            optionId: v.key("optionId")
        },
        oid: oid
    }).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        oid: {
            type: "string"
        }
    },
    required: ["oid"]
} as const satisfies __cfHelpers.JSONSchema), {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Vote"
        }
    },
    required: ["element"],
    $defs: {
        Vote: {
            type: "object",
            properties: {
                optionId: {
                    type: "string"
                },
                voterName: {
                    type: "string"
                }
            },
            required: ["optionId", "voterName"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_3 = __cfHelpers.lift<{
    v: {
        optionId: string;
    };
    oid: string;
}, boolean>(({ v, oid }) => v.optionId === oid, {
    type: "object",
    properties: {
        v: {
            type: "object",
            properties: {
                optionId: {
                    type: "string"
                }
            },
            required: ["optionId"]
        },
        oid: {
            type: "string"
        }
    },
    required: ["v", "oid"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_4 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { oid }) => {
    const v = __cf_pattern_input.key("element");
    return [__cfLift_3({
            v: {
                optionId: v.key("optionId")
            },
            oid: oid
        }).for(["__patternResult", 0], true)];
}, {
    type: "object",
    properties: {
        oid: {
            type: "string"
        }
    },
    required: ["oid"]
} as const satisfies __cfHelpers.JSONSchema), {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Vote"
        }
    },
    required: ["element"],
    $defs: {
        Vote: {
            type: "object",
            properties: {
                optionId: {
                    type: "string"
                },
                voterName: {
                    type: "string"
                }
            },
            required: ["optionId", "voterName"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "boolean"
    }
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: array-method-value-lift
// Verifies (CT-1777): a bare reactive VALUE-expression in the return position of a
// reactive map/filter/flatMap callback is lifted to a value-level lift, so it runs on
// resolved values instead of being emitted raw on Reactive proxies. Before CT-1777 a
// filter predicate `v.optionId === oid` compiled to a proxy-vs-proxy `===` — reference
// equality, i.e. a constant `false` — so the filter matched nothing (silent, type-clean).
//   - filter predicate comparison      → filterWithPattern(pattern(... return lift(...)(...)))
//   - map -> non-JSX comparison        → mapWithPattern(pattern(... return lift(...)(...)))
//   - flatMap -> array-element compare → flatMapWithPattern(pattern(... return [lift(...)(...)]))
// Collection-valued `??` fallbacks and logical `&&`/`||` stay structural / control-flow
// lowered; see filter-flatmap-fallback-chain for the structural-collection counterpart.
export default pattern((__cf_pattern_input) => {
    const votes = __cf_pattern_input.key("votes");
    const oid = __cf_pattern_input.key("oid");
    return {
        [UI]: (<div>
        {/* filter predicate: the comparison must be lifted to value level */}
        <div>
          {votes.filterWithPattern(__cfPattern_1.curry({
                oid: oid
            })).mapWithPattern(__cfPattern_2)}
        </div>
        {/* map to a bare non-JSX boolean: the comparison must be lifted */}
        <div>{votes.mapWithPattern(__cfPattern_3.curry({
            oid: oid
        }))}</div>
        {/* flatMap returning an array whose element is a comparison: must be lifted */}
        <div>{votes.flatMapWithPattern(__cfPattern_4.curry({
            oid: oid
        }))}</div>
      </div>),
    };
}, {
    type: "object",
    properties: {
        votes: {
            type: "array",
            items: {
                $ref: "#/$defs/Vote"
            }
        },
        oid: {
            type: "string"
        }
    },
    required: ["votes", "oid"],
    $defs: {
        Vote: {
            type: "object",
            properties: {
                optionId: {
                    type: "string"
                },
                voterName: {
                    type: "string"
                }
            },
            required: ["optionId", "voterName"]
        }
    }
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
    __cfLift_1,
    __cfPattern_1,
    __cfPattern_2,
    __cfLift_2,
    __cfPattern_3,
    __cfLift_3,
    __cfPattern_4
});
