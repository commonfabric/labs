function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, pattern, patternTool, type PatternToolResult, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const multiplier = __cfHelpers.__cf_data(new Writable(2, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema).for("multiplier", true));
const prefix = __cfHelpers.__cf_data(new Writable("Result: ", {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema).for("prefix", true));
type Output = {
    tool: PatternToolResult<Record<string, never>>;
};
const __cfLift_1 = __cfHelpers.lift<{
    value: number;
}, string>(({ value }) => {
    return prefix.get() + String(value * multiplier.get());
}, {
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfPattern_1 = pattern((__cf_pattern_input: {
    value: number;
}) => {
    const value = __cf_pattern_input.key("value");
    return __cfLift_1({ value: value }).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: patternTool-multiple-captures
// Verifies: patternTool's first arg is an explicit pattern() (CT-1655) with no
//   explicit extraParams. The free module-scoped reactive captures `prefix` and
//   `multiplier` (read via .get()) are absorbed by the pattern into module-scope
//   lift closures rather than injected into extraParams — auto-capture-into-
//   extraParams was removed when patternTool began requiring an explicit pattern.
//   patternTool(pattern(({ value }) => …prefix.get()…multiplier.get()…))
// Context: Both `prefix` and `multiplier` are module-scoped new Writable() values;
//   `value` is the pattern's only per-call input.
export default pattern(() => {
    const tool = patternTool(__cfPattern_1);
    return { tool };
}, {
    type: "object",
    properties: {},
    additionalProperties: false
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        tool: {
            type: "object",
            properties: {
                pattern: {
                    $ref: "#/$defs/Pattern"
                },
                extraParams: {
                    type: "object",
                    properties: {},
                    additionalProperties: false
                },
                useResultSchemaForObservation: {
                    type: "boolean"
                }
            },
            required: ["pattern", "extraParams"]
        }
    },
    required: ["tool"],
    $defs: {
        Pattern: {
            type: "object",
            properties: {
                argumentSchema: true,
                resultSchema: true,
                defaultScope: {
                    $ref: "#/$defs/CellScope"
                }
            },
            required: ["argumentSchema", "resultSchema"]
        },
        CellScope: {
            "enum": ["space", "user", "session"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfPattern_1
});
