function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Default, computed, lift, pattern, wish } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const passthrough = lift((items: string[]) => items, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h25c7969c79e7 = __cfHelpers.lift<{
    state: {
        items: string[];
    };
}, string[]>(({ state }) => state.items, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["items"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_h46fcdf4bd295 = __cfHelpers.lift<{
    inner: string[];
}, string[]>(({ inner }) => inner, {
    type: "object",
    properties: {
        inner: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["inner"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_haacab7ab55c2 = __cfHelpers.lift<{
    item: string;
}, string>(({ item }) => item + "!", {
    type: "object",
    properties: {
        item: {
            type: "string"
        }
    },
    required: ["item"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_hbedea5792321 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    return __cfLift_haacab7ab55c2({ item: item }).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        element: {
            type: "string"
        }
    },
    required: ["element"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h3a10d74f22a6 = __cfHelpers.lift<{
    inner: string[];
}, string[]>(({ inner }) => {
    const foo = __cfLift_h46fcdf4bd295({ inner: inner }).for("foo", true);
    return foo.mapWithPattern(__cfPattern_hbedea5792321, {});
}, {
    type: "object",
    properties: {
        inner: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["inner"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_haacab7ab55c2_2 = __cfHelpers.lift<{
    item: string;
}, string>(({ item }) => item + "!", {
    type: "object",
    properties: {
        item: {
            type: "string"
        }
    },
    required: ["item"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_h3a7d86a214aa = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    return __cfLift_haacab7ab55c2_2({ item: item }).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        element: {
            type: "string"
        }
    },
    required: ["element"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_hb60fff46237a = __cfHelpers.lift<{
    inner: string[];
}, string[]>(({ inner }) => {
    const foo = passthrough(inner).for("foo", true);
    return foo.mapWithPattern(__cfPattern_h3a7d86a214aa, {});
}, {
    type: "object",
    properties: {
        inner: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["inner"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_haacab7ab55c2_3 = __cfHelpers.lift<{
    item: string;
}, string>(({ item }) => item + "!", {
    type: "object",
    properties: {
        item: {
            type: "string"
        }
    },
    required: ["item"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_hc0add00504ab = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    return __cfLift_haacab7ab55c2_3({ item: item }).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        element: {
            type: "string"
        }
    },
    required: ["element"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h7059495abfc1 = __cfHelpers.lift(() => {
    const foo = wish<Default<string[], [
    ]>>({ query: "#items" }, {
        type: "array",
        items: {
            type: "string"
        },
        "default": []
    } as const satisfies __cfHelpers.JSONSchema).result!;
    return foo.mapWithPattern(__cfPattern_hc0add00504ab, {});
}, false, undefined, { completeSchedulerScopeSummary: true });
const __cfLift_h46fcdf4bd295_2 = __cfHelpers.lift<{
    inner: string[];
}, string[]>(({ inner }) => inner, {
    type: "object",
    properties: {
        inner: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["inner"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_hd0cb62492362 = __cfHelpers.lift<{
    item: {
        length: number;
    };
}, boolean>(({ item }) => item.length > 1, {
    type: "object",
    properties: {
        item: {
            type: "object",
            properties: {
                length: {
                    type: "number"
                }
            },
            required: ["length"]
        }
    },
    required: ["item"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_h349f704fe887 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    return __cfLift_hd0cb62492362({ item: {
            length: item.key("length")
        } }).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        element: {
            type: "string"
        }
    },
    required: ["element"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_haacab7ab55c2_4 = __cfHelpers.lift<{
    item: string;
}, string>(({ item }) => item + "!", {
    type: "object",
    properties: {
        item: {
            type: "string"
        }
    },
    required: ["item"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_ha964652d3e0d = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    return __cfLift_haacab7ab55c2_4({ item: item }).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        element: {
            type: "string"
        }
    },
    required: ["element"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h663d123103e9 = __cfHelpers.lift<{
    inner: string[];
}, string[]>(({ inner }) => {
    const foo = __cfLift_h46fcdf4bd295_2({ inner: inner }).for("foo", true);
    const filtered = foo.filterWithPattern(__cfPattern_h349f704fe887, {}).for("filtered", true);
    return filtered.mapWithPattern(__cfPattern_ha964652d3e0d, {});
}, {
    type: "object",
    properties: {
        inner: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["inner"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_h46fcdf4bd295_3 = __cfHelpers.lift<{
    inner: string[];
}, string[]>(({ inner }) => inner, {
    type: "object",
    properties: {
        inner: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["inner"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_hd0cb62492362_2 = __cfHelpers.lift<{
    item: {
        length: number;
    };
}, boolean>(({ item }) => item.length > 1, {
    type: "object",
    properties: {
        item: {
            type: "object",
            properties: {
                length: {
                    type: "number"
                }
            },
            required: ["length"]
        }
    },
    required: ["item"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_h75d29e59268b = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    return __cfLift_hd0cb62492362_2({ item: {
            length: item.key("length")
        } }).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        element: {
            type: "string"
        }
    },
    required: ["element"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h8ee1135a2ccf = __cfHelpers.lift<{
    item: string;
}, string>(({ item }) => item.toUpperCase(), {
    type: "object",
    properties: {
        item: {
            type: "string"
        }
    },
    required: ["item"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_hf23ac404a1de = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    return __cfLift_h8ee1135a2ccf({ item: item }).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        element: {
            type: "string"
        }
    },
    required: ["element"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h5e1e356213e2 = __cfHelpers.lift<{
    inner: string[];
}, string[]>(({ inner }) => {
    const foo = __cfLift_h46fcdf4bd295_3({ inner: inner }).for("foo", true);
    const filtered = foo.filterWithPattern(__cfPattern_h75d29e59268b, {}).for("filtered", true);
    return filtered.mapWithPattern(__cfPattern_hf23ac404a1de, {});
}, {
    type: "object",
    properties: {
        inner: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["inner"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: map-regains-reactive-aliases
// Verifies: compute-owned aliases that still resolve to reactive array roots
// are rewritten back to mapWithPattern/filterWithPattern when used in pattern
// lowering sites
//   const foo = computed(() => inner); foo.map(fn)        -> foo.mapWithPattern(...)
//   const foo = passthrough(inner); foo.map(fn)           -> foo.mapWithPattern(...)
//   const foo = wish<Default<T[], []>>(...).result!; map  -> foo.mapWithPattern(...)
//   const filtered = foo.filter(fn); filtered.map(fn)     -> filterWithPattern(...).mapWithPattern(...)
//   const filtered = foo.filter(fn); filtered.map(item => item.toUpperCase())
//                                                   -> receiver-method body still lowers to a lift-applied computation
// Context: contrasts with the existing plain-array compute fixtures where the
// callback receiver really is compute-owned plain JS data.
export default pattern((state) => {
    const inner = __cfLift_h25c7969c79e7({ state: {
            items: state.key("items")
        } }).for("inner", true);
    const fromComputed = __cfLift_h3a10d74f22a6({ inner: inner }).for("fromComputed", true);
    const fromLift = __cfLift_hb60fff46237a({ inner: inner }).for("fromLift", true);
    const fromWish = __cfLift_h7059495abfc1().for("fromWish", true);
    const fromFiltered = __cfLift_h663d123103e9({ inner: inner }).for("fromFiltered", true);
    const fromFilteredReceiverMethod = __cfLift_h5e1e356213e2({ inner: inner }).for("fromFilteredReceiverMethod", true);
    return {
        fromComputed,
        fromLift,
        fromWish,
        fromFiltered,
        fromFilteredReceiverMethod,
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["items"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        fromComputed: {
            type: "array",
            items: {
                type: "string"
            }
        },
        fromLift: {
            type: "array",
            items: {
                type: "string"
            }
        },
        fromWish: {
            type: "array",
            items: {
                type: "string"
            }
        },
        fromFiltered: {
            type: "array",
            items: {
                type: "string"
            }
        },
        fromFilteredReceiverMethod: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["fromComputed", "fromLift", "fromWish", "fromFiltered", "fromFilteredReceiverMethod"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    passthrough,
    __cfLift_h25c7969c79e7,
    __cfLift_h46fcdf4bd295,
    __cfLift_haacab7ab55c2,
    __cfPattern_hbedea5792321,
    __cfLift_h3a10d74f22a6,
    __cfLift_haacab7ab55c2_2,
    __cfPattern_h3a7d86a214aa,
    __cfLift_hb60fff46237a,
    __cfLift_haacab7ab55c2_3,
    __cfPattern_hc0add00504ab,
    __cfLift_h7059495abfc1,
    __cfLift_h46fcdf4bd295_2,
    __cfLift_hd0cb62492362,
    __cfPattern_h349f704fe887,
    __cfLift_haacab7ab55c2_4,
    __cfPattern_ha964652d3e0d,
    __cfLift_h663d123103e9,
    __cfLift_h46fcdf4bd295_3,
    __cfLift_hd0cb62492362_2,
    __cfPattern_h75d29e59268b,
    __cfLift_h8ee1135a2ccf,
    __cfPattern_hf23ac404a1de,
    __cfLift_h5e1e356213e2,
    __cfLift_1: __cfLift_h25c7969c79e7,
    __cfLift_2: __cfLift_h46fcdf4bd295,
    __cfLift_3: __cfLift_haacab7ab55c2,
    __cfPattern_1: __cfPattern_hbedea5792321,
    __cfLift_4: __cfLift_h3a10d74f22a6,
    __cfLift_5: __cfLift_haacab7ab55c2_2,
    __cfPattern_2: __cfPattern_h3a7d86a214aa,
    __cfLift_6: __cfLift_hb60fff46237a,
    __cfLift_7: __cfLift_haacab7ab55c2_3,
    __cfPattern_3: __cfPattern_hc0add00504ab,
    __cfLift_8: __cfLift_h7059495abfc1,
    __cfLift_9: __cfLift_h46fcdf4bd295_2,
    __cfLift_10: __cfLift_hd0cb62492362,
    __cfPattern_4: __cfPattern_h349f704fe887,
    __cfLift_11: __cfLift_haacab7ab55c2_4,
    __cfPattern_5: __cfPattern_ha964652d3e0d,
    __cfLift_12: __cfLift_h663d123103e9,
    __cfLift_13: __cfLift_h46fcdf4bd295_3,
    __cfLift_14: __cfLift_hd0cb62492362_2,
    __cfPattern_6: __cfPattern_h75d29e59268b,
    __cfLift_15: __cfLift_h8ee1135a2ccf,
    __cfPattern_7: __cfPattern_hf23ac404a1de,
    __cfLift_16: __cfLift_h5e1e356213e2
});
