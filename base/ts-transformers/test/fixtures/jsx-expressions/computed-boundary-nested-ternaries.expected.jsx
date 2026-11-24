function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, ifElse, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift<{
    bar: boolean;
}, "B" | "C">(({ bar }) => bar ? "B" : "C", {
    type: "object",
    properties: {
        bar: {
            type: "boolean"
        }
    },
    required: ["bar"]
} as const satisfies __cfHelpers.JSONSchema, {
    "enum": ["B", "C"]
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: computed-boundary-nested-ternaries
// Verifies: outer branch lowering does not structurally lower nested ternaries inside computed callbacks
//   show ? computed(() => bar ? "B" : "C") : "D" → outer branch lowers, inner ternary stays authored
//   ifElse(show, computed(() => foo ? "A" : bar ? "B" : "C"), "D") → helper-owned branch lowering still preserves the inner ternaries
export const OuterTernary = pattern((__cf_pattern_input) => {
    const show = __cf_pattern_input.key("show");
    const bar = __cf_pattern_input.key("bar");
    return (<div>{__cfHelpers.ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        "enum": ["B", "C"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        "enum": ["B", "C", "D"]
    } as const satisfies __cfHelpers.JSONSchema, show, __cfLift_1({ bar: bar }), "D")}</div>);
}, {
    type: "object",
    properties: {
        show: {
            type: "boolean"
        },
        bar: {
            type: "boolean"
        }
    },
    required: ["show", "bar"]
} as const satisfies __cfHelpers.JSONSchema, {
    anyOf: [{
            $ref: "https://commonfabric.org/schemas/vnode.json"
        }, {
            $ref: "#/$defs/UIRenderable"
        }, {
            type: "object",
            properties: {}
        }],
    $defs: {
        UIRenderable: {
            type: "object",
            properties: {
                $UI: {
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }
            },
            required: ["$UI"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    foo: boolean;
    bar: boolean;
}, "A" | "B" | "C">(({ foo, bar }) => foo ? "A" : bar ? "B" : "C", {
    type: "object",
    properties: {
        foo: {
            type: "boolean"
        },
        bar: {
            type: "boolean"
        }
    },
    required: ["foo", "bar"]
} as const satisfies __cfHelpers.JSONSchema, {
    "enum": ["A", "B", "C"]
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
export const AuthoredIfElse = pattern((__cf_pattern_input) => {
    const show = __cf_pattern_input.key("show");
    const foo = __cf_pattern_input.key("foo");
    const bar = __cf_pattern_input.key("bar");
    return ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        "enum": ["A", "B", "C"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        "enum": ["A", "B", "C", "D"]
    } as const satisfies __cfHelpers.JSONSchema, show, __cfLift_2({
        foo: foo,
        bar: bar
    }), "D");
}, {
    type: "object",
    properties: {
        show: {
            type: "boolean"
        },
        foo: {
            type: "boolean"
        },
        bar: {
            type: "boolean"
        }
    },
    required: ["show", "foo", "bar"]
} as const satisfies __cfHelpers.JSONSchema, {
    "enum": ["A", "B", "C", "D"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2
});
