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
    value: __cfHelpers.ReadonlyCell<number>;
    numLiteral: number;
    floatLiteral: number;
    boolLiteral: boolean;
    strLiteral: string;
}, string>(({ value, numLiteral, floatLiteral, boolLiteral, strLiteral }) => {
    // Use all captured literals to ensure they're all widened
    const combined = value.get() + numLiteral + floatLiteral;
    return boolLiteral ? strLiteral + combined : "";
}, {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: ["readonly"]
        },
        numLiteral: {
            type: "number"
        },
        floatLiteral: {
            type: "number"
        },
        boolLiteral: {
            type: "boolean"
        },
        strLiteral: {
            type: "string"
        }
    },
    required: ["value", "numLiteral", "floatLiteral", "boolLiteral", "strLiteral"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// Test that all literal types are widened in closure captures
// FIXTURE: computed-all-literal-types
// Verifies: literal values (number, string, boolean, float) are captured and their types widened in schemas
//   computed(() => expr) → lift(schema, schema)({ value, numLiteral, floatLiteral, boolLiteral, strLiteral }) with widened types
// Context: each literal type maps to its widened JSON schema type (e.g., 42 → "number", "hello" → "string")
export default pattern(() => {
    const value = new Writable(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("value", true);
    // All literal types that should be widened
    const numLiteral = 42;
    const strLiteral = "hello";
    const boolLiteral = true;
    const floatLiteral = 3.14;
    const result = __cfLift_1({
        value: value,
        numLiteral: numLiteral,
        floatLiteral: floatLiteral,
        boolLiteral: boolLiteral,
        strLiteral: strLiteral
    }).for("result", true);
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
