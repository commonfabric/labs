function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { type Default, pattern, type Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift<{
    mentioned: Writable<unknown[] | Default<[
    ]>>;
}, readonly unknown[]>(({ mentioned }) => mentioned.get(), {
    type: "object",
    properties: {
        mentioned: {
            type: "array",
            items: {
                type: "unknown"
            },
            "default": [],
            asCell: ["readonly"]
        }
    },
    required: ["mentioned"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "unknown"
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    mentionedView: readonly unknown[];
}, boolean>(({ mentionedView }) => mentionedView.length > 0, {
    type: "object",
    properties: {
        mentionedView: {
            type: "array",
            items: {
                type: "unknown"
            }
        }
    },
    required: ["mentionedView"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_3 = __cfHelpers.lift<{
    nums: Writable<number[] | Default<[
    ]>>;
}, readonly number[]>(({ nums }) => nums.get(), {
    type: "object",
    properties: {
        nums: {
            type: "array",
            items: {
                type: "number"
            },
            "default": [],
            asCell: ["readonly"]
        }
    },
    required: ["nums"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "number"
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_4 = __cfHelpers.lift<{
    numsView: readonly number[];
}, number>(({ numsView }) => numsView.length, {
    type: "object",
    properties: {
        numsView: {
            type: "array",
            items: {
                type: "unknown"
            }
        }
    },
    required: ["numsView"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: cell-get-readonly-array-result
// Verifies: a pattern-scope `.get()` of an array cell lowers to a lift whose
// RESULT schema keeps the array's shape. The read types as `readonly T[]`,
// which the checker prints as a `readonly` type-operator node; the generator
// analyzes through it rather than falling back to `true`. For `unknown[]` —
// the reference-only declaration — that fallback turned "compare, don't read
// through" into a schema that walks everything reachable.
export default pattern((__cf_pattern_input) => {
    const mentioned = __cf_pattern_input.key("mentioned");
    const nums = __cf_pattern_input.key("nums");
    const mentionedView = __cfLift_1({ mentioned: mentioned }).for("mentionedView", true);
    const hasMentioned = __cfLift_2({ mentionedView: mentionedView }).for("hasMentioned", true);
    const numsView = __cfLift_3({ nums: nums }).for("numsView", true);
    const count = __cfLift_4({ numsView: numsView }).for("count", true);
    return { hasMentioned, count };
}, {
    type: "object",
    properties: {
        mentioned: {
            type: "array",
            items: {
                type: "unknown"
            },
            "default": [],
            asCell: ["cell"]
        },
        nums: {
            type: "array",
            items: {
                type: "number"
            },
            "default": [],
            asCell: ["cell"]
        }
    },
    required: ["mentioned", "nums"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        hasMentioned: {
            type: "boolean"
        },
        count: {
            type: "number"
        }
    },
    required: ["hasMentioned", "count"]
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
