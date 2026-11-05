function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
/// <cts-enable />
/**
 * A handler that only hands a state cell on to a pattern it instantiates takes
 * the cell as an opaque handle, whichever cell type the state declares, inside
 * a callback as well. A cell the handler also reads keeps what the read earns.
 */
import { handler, pattern, type ReadonlyCell, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface ChildInput {
    rows: ReadonlyCell<readonly string[]>;
    count: ReadonlyCell<number>;
    label: string;
}
const Child = pattern((__cf_pattern_input) => {
    const label = __cf_pattern_input.key("label");
    return ({ label });
}, {
    type: "object",
    properties: {
        rows: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: ["readonly"]
        },
        count: {
            type: "number",
            asCell: ["readonly"]
        },
        label: {
            type: "string"
        }
    },
    required: ["rows", "count", "label"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        label: {
            type: "string"
        }
    },
    required: ["label"]
} as const satisfies __cfHelpers.JSONSchema);
const withEach = __cfHardenFn(<T,>(make: () => T): T => make());
export const addChild = handler({
    type: "object",
    properties: {
        label: {
            type: "string"
        }
    },
    required: ["label"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        rows: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: ["opaque"]
        },
        count: {
            type: "number",
            asCell: ["readonly"]
        },
        made: {
            type: "array",
            items: {
                type: "unknown"
            },
            asCell: ["writeonly"]
        }
    },
    required: ["rows", "count", "made"]
} as const satisfies __cfHelpers.JSONSchema, ({ label }, { rows, count, made }) => {
    if (count.get() > 10)
        return;
    made.push(withEach(() => Child({ rows, count, label })));
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    Child
});
