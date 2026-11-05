function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Writable, computed, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift<{
    n: number;
    multiplier: __cfHelpers.Cell<number>;
}, number>(({ n, multiplier }) => n * multiplier.get(), {
    type: "object",
    properties: {
        n: {
            type: "number"
        },
        multiplier: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["n", "multiplier"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { multiplier }) => {
    const n = __cf_pattern_input.key("element");
    return __cfLift_1({
        n: n,
        multiplier: multiplier
    }).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        multiplier: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["multiplier"]
} as const satisfies __cfHelpers.JSONSchema), {
    type: "object",
    properties: {
        element: {
            type: "number"
        }
    },
    required: ["element"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    numbers: __cfHelpers.ReadonlyCell<number[]>;
    multiplier: __cfHelpers.ReadonlyCell<number>;
}, number[]>(({ numbers, multiplier }) => numbers.mapWithPattern(__cfPattern_1.curry({
    multiplier: multiplier
})), {
    type: "object",
    properties: {
        numbers: {
            type: "array",
            items: {
                type: "number"
            },
            asCell: ["readonly"]
        },
        multiplier: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["numbers", "multiplier"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "number"
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: computed-with-closed-over-cell-map
// Verifies: .map() on a closed-over Cell inside computed() IS transformed to .mapWithPattern()
//   computed(() => numbers.map(n => n * multiplier.get())) → lift(({ numbers, multiplier }) => numbers.mapWithPattern(pattern(fn, ...).curry({ multiplier })))({ numbers, multiplier })
// Context: Unlike Reactive arrays, Cell arrays still need reactive mapping even
//   inside a lift-applied callback. The .map() callback's closed-over `multiplier` cell
//   is bound through the private `.curry(...)` carrier.
export default pattern(() => {
    const numbers = new Writable([1, 2, 3], {
        type: "array",
        items: {
            type: "number"
        }
    } as const satisfies __cfHelpers.JSONSchema).for("numbers", true);
    const multiplier = new Writable(2, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("multiplier", true);
    // Inside computed, we close over numbers (a Cell)
    // The computed gets transformed to the lift-applied form lift(() => numbers.map(...))({})
    // Inside a lift-applied computation, .map on a closed-over Cell should STILL be transformed to mapWithPattern
    // because Cells need the pattern-based mapping even when unwrapped
    const doubled = __cfLift_2({
        numbers: numbers,
        multiplier: multiplier
    }).for("doubled", true);
    return doubled;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "number"
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfPattern_1,
    __cfLift_2
});
