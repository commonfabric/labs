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
 * Edge case: a computed whose body maps over a captured cell's array value
 * (NO outer captures beyond the cell itself) and reads `.length`.
 *
 * This tests the scenario where:
 * 1. The captured `items` cell is unwrapped via .get() inside the computed body
 * 2. The inner .map() runs on the plain array, so it is NOT rewritten to .mapWithPattern()
 * 3. SchemaInjectionTransformer infers the result type from the computed body
 */
import { Cell, computed, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Item {
    id: number;
    value: string;
}
const __cfLift_1 = __cfHelpers.lift<{
    items: __cfHelpers.ReadonlyCell<Item[]>;
}, number>(({ items }) => items.get().map((item) => item.value).length, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            asCell: ["readonly"]
        }
    },
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                value: {
                    type: "string"
                }
            },
            required: ["id", "value"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: computed-map-input-no-captures
// Verifies: a computed over a captured cell array uses a plain .map() (not .mapWithPattern)
//   computed(() => items.get().map(...).length) → lift(...)({ items })
// Context: tests schema injection for a computed whose result derives from a captured cell's array
export default pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    // items is a captured cell; .get() yields a plain array, so .map() stays plain.
    const count = __cfLift_1({ items: items }).for("count", true);
    return { count };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            asCell: ["cell"]
        }
    },
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                value: {
                    type: "string"
                }
            },
            required: ["id", "value"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        count: {
            type: "number"
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
