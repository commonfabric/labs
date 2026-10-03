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
const __cfLift_h25d077160003 = __cfHelpers.lift<{
    value: __cfHelpers.ReadonlyCell<number>;
    config: { multiplier: number; divisor: number; };
    key: string;
}, number>(({ value, config, key }) => value.get() * config[key], {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: ["readonly"]
        },
        config: {
            type: "object",
            properties: {
                multiplier: {
                    type: "number"
                },
                divisor: {
                    type: "number"
                }
            },
            required: ["multiplier", "divisor"]
        },
        key: {
            type: "string"
        }
    },
    required: ["value", "config", "key"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: computed-property-result
// Verifies: computed property access with a dynamic key captures both the object and the key
//   computed(() => expr) → lift(schema, schema)({ value, config, key })
// Context: `config[key]` requires both `config` and `key` to be captured as plain values
export default pattern(() => {
    const value = new Writable(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("value", true);
    const config = { multiplier: 2, divisor: 5 };
    const key = "multiplier";
    const result = __cfLift_h25d077160003({
        value: value,
        config: config,
        key: key
    }).for("result", true);
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_h25d077160003,
    __cfLift_1: __cfLift_h25d077160003
});
