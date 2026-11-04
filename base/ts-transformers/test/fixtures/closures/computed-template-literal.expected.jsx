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
    prefix: __cfHelpers.ReadonlyCell<string>;
    value: __cfHelpers.ReadonlyCell<number>;
}, string>(({ prefix, value }) => `${prefix.get()}${value.get()}`, {
    type: "object",
    properties: {
        prefix: {
            type: "string",
            asCell: ["readonly"]
        },
        value: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["prefix", "value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: computed-template-literal
// Verifies: captured cells used inside a template literal expression are extracted
//   computed(() => `${prefix.get()}${value.get()}`) → lift(...)({ value, prefix })
export default pattern(() => {
    const value = new Writable(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("value", true);
    const prefix = new Writable("Value: ", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema).for("prefix", true);
    const result = __cfLift_1({
        prefix: prefix,
        value: value
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
