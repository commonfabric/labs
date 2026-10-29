function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { cell, ComparableCell, ReadonlyCell, WriteonlyCell } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: cell-like-classes
// Verifies: schema injection works for cell(), new ComparableCell(), new ReadonlyCell(), and new WriteonlyCell()
//   cell(100) → cell(100, { type: "number" })
//   new ComparableCell(200) → new ComparableCell(200, { type: "number" })
//   new ReadonlyCell(300) → new ReadonlyCell(300, { type: "number" })
//   new WriteonlyCell(400) → new WriteonlyCell(400, { type: "number" })
export default function TestCellLikeClasses() {
    // Standalone cell() function
    const _standalone = cell(100, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("_standalone", true);
    // new ComparableCell()
    const _comparable = new ComparableCell(200, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("_comparable", true);
    // new ReadonlyCell()
    const _readonly = new ReadonlyCell(300, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("_readonly", true);
    // new WriteonlyCell()
    const _writeonly = new WriteonlyCell(400, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("_writeonly", true);
    return {
        standalone: _standalone,
        comparable: _comparable,
        readonly: _readonly,
        writeonly: _writeonly,
    };
}
__cfHardenFn(TestCellLikeClasses);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
