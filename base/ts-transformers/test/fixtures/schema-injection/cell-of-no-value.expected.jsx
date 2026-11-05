function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, cell, ComparableCell } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: cell-of-no-value
// Verifies: new Cell/cell with type arg but no value injects undefined as first arg plus schema
//   new Cell<string>() → new Cell<string>(undefined, { type: "string" })
//   cell<string>() → cell<string>(undefined, { type: "string" })
//   new ComparableCell<{ name: string }>() → new ComparableCell<...>(undefined, { type: "object", ... })
//   new Cell<string>("hello") → new Cell<string>("hello", { type: "string" })
export default function TestCellOfNoValue() {
    // new Cell with type argument but no value - should become new Cell(undefined, schema)
    const _c1 = new Cell<string>(undefined, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema).for("_c1", true);
    const _c2 = new Cell<number>(undefined, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("_c2", true);
    const _c3 = new Cell<boolean>(undefined, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema).for("_c3", true);
    // cell() with type argument but no value - should become cell(undefined, schema)
    const _c4 = cell<string>(undefined, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema).for("_c4", true);
    // new ComparableCell with type argument but no value
    const _c5 = new ComparableCell<{
        name: string;
    }>(undefined, {
        type: "object",
        properties: {
            name: {
                type: "string"
            }
        },
        required: ["name"]
    } as const satisfies __cfHelpers.JSONSchema).for("_c5", true);
    // Mixed - some with value, some without
    const _c6 = new Cell<string>("hello", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema).for("_c6", true); // has value
    const _c7 = new Cell<number>(undefined, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("_c7", true); // no value
    return null;
}
__cfHardenFn(TestCellOfNoValue);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
