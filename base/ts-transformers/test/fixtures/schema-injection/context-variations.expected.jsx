function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { cell, pattern, handler } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// 1. Top-level
const _topLevel = __cfHelpers.__cf_data(cell(10, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema).for("_topLevel", true));
// 2. Inside function
function regularFunction() {
    const _inFunction = cell(20, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("_inFunction", true);
    return _inFunction;
}
__cfHardenFn(regularFunction);
// 3. Inside arrow function
const arrowFunction = __cfHardenFn(() => {
    const _inArrow = cell(30, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("_inArrow", true);
    return _inArrow;
});
// 4. Inside class method
class TestClass {
    method() {
        const _inMethod = cell(40, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema).for("_inMethod", true);
        return _inMethod;
    }
}
// 5. Inside pattern
const testPattern = pattern(() => {
    const _inPattern = cell(50, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("_inPattern", true);
    return _inPattern;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number",
    asCell: ["cell"]
} as const satisfies __cfHelpers.JSONSchema);
// 6. Inside handler
const testHandler = handler(false as const satisfies __cfHelpers.JSONSchema, false as const satisfies __cfHelpers.JSONSchema, () => {
    const _inHandler = cell(60, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("_inHandler", true);
    return _inHandler;
});
// FIXTURE: context-variations
// Verifies: schema injection works in all code contexts and pattern/handler get their own schemas
//   cell(N) → cell(N, { type: "number" }) in top-level, function, arrow, class method, pattern, handler
//   pattern(() => ...) → pattern(() => ..., inputSchema, outputSchema)
//   handler(() => ...) → handler(inputSchema, outputSchema, () => ...)
export default function TestContextVariations() {
    return {
        topLevel: _topLevel,
        regularFunction,
        arrowFunction,
        TestClass,
        testPattern,
        testHandler,
    };
}
__cfHardenFn(TestContextVariations);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    testPattern,
    testHandler
});
