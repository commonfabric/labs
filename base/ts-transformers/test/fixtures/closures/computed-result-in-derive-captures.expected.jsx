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
 * computed() result used as a lift-applied capture should use .key("count"),
 * not plain property access. The computed() return value is an
 * Reactive, so rewritePatternBody correctly treats it as opaque.
 */
import { computed, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    items: Array<{
        name: string;
        done: boolean;
    }>;
}
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        items: {
            done: boolean;
        }[];
    };
}, { count: number; total: number; }>(({ state }) => ({
    count: state.items.filter((i) => i.done).length,
    total: state.items.length,
}), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            done: {
                                type: "boolean"
                            }
                        },
                        required: ["done"]
                    }
                }
            },
            required: ["items"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        count: {
            type: "number"
        },
        total: {
            type: "number"
        }
    },
    required: ["count", "total"]
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift<{
    stats: {
        count: number;
        total: number;
    };
}, string>(({ stats }) => `${stats.count} of ${stats.total} done`, {
    type: "object",
    properties: {
        stats: {
            type: "object",
            properties: {
                count: {
                    type: "number"
                },
                total: {
                    type: "number"
                }
            },
            required: ["count", "total"]
        }
    },
    required: ["stats"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: computed-result-in-derive-captures
// Verifies: computed() result properties captured in a subsequent lift-applied computation use .key() access
//   computed(() => `${stats.count} of ${stats.total} done`) → lift(({ stats }) => ...)({ stats: { count: stats.key("count"), total: stats.key("total") } })
// Context: The first computed() returns a Reactive with { count, total }.
//   When the second computed() captures stats.count and stats.total, the
//   transform rewrites them to stats.key("count") and stats.key("total") in
//   the captures object because stats is a Reactive.
export default pattern((state) => {
    const stats = __cfLift_1({ state: {
            items: state.key("items")
        } }).for("stats", true);
    return {
        [UI]: (<div>
        {__cfLift_2({ stats: {
                count: stats.key("count"),
                total: stats.key("total")
            } })}
      </div>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    },
                    done: {
                        type: "boolean"
                    }
                },
                required: ["name", "done"]
            }
        }
    },
    required: ["items"]
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
    __cfLift_2
});
