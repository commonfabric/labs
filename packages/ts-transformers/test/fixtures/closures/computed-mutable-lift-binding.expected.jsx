function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, lift, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift<{
    value: number;
}, number>(({ value }) => {
    const double = lift((n: number) => n * 2, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    return double(value);
}, {
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift<{
    value: number;
}, number>(({ value }) => {
    // deno-lint-ignore prefer-const -- the fixture covers a `let` binding
    let double = lift((n: number) => n * 2, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    return double(value);
}, {
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_3 = __cfHelpers.lift<{
    value: number;
}, number>(({ value }) => {
    // deno-lint-ignore no-var -- the fixture covers a `var` binding
    var double = lift((n: number) => n * 2, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    return double(value);
}, {
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: computed-mutable-lift-binding
// Verifies: a call through a `let` or `var` binding of a `lift()` call inside a computed() callback lowers as the `const` spelling does
//   computed(() => { let double = lift(fn); return double(value); }) → lift(schema, schema)({ value }) with the callback body kept as written
// Context: `let` and `var` are ordinary code inside a compute callback; a call through such a binding is not the lift-applied shape, whose callee is the inner lift() call itself
export default pattern((__cf_pattern_input) => {
    const value = __cf_pattern_input.key("value");
    const viaConst = __cfLift_1({ value: value }).for("viaConst", true);
    const viaLet = __cfLift_2({ value: value }).for("viaLet", true);
    const viaVar = __cfLift_3({ value: value }).for("viaVar", true);
    return { viaConst, viaLet, viaVar };
}, {
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        viaConst: {
            type: "number"
        },
        viaLet: {
            type: "number"
        },
        viaVar: {
            type: "number"
        }
    },
    required: ["viaConst", "viaLet", "viaVar"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2,
    __cfLift_3
});
