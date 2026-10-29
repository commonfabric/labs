function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { cell, computed, pattern, patternTool, type PatternToolResult } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const multiplier = __cfHelpers.__cf_data(cell(2, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema).for("multiplier", true));
const offset = __cfHelpers.__cf_data(cell(10, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema).for("offset", true));
type Output = {
    tool: PatternToolResult<{
        offset: number;
    }>;
};
const __cfLift_1 = __cfHelpers.lift<{
    value: number;
    offset: number;
}, number>(({ value, offset }) => {
    return value * multiplier.get() + offset;
}, {
    type: "object",
    properties: {
        value: {
            type: "number"
        },
        offset: {
            type: "number"
        }
    },
    required: ["value", "offset"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfPattern_1 = pattern((__cf_pattern_input: {
    value: number;
    offset: number;
}) => {
    const value = __cf_pattern_input.key("value");
    const offset = __cf_pattern_input.key("offset");
    return __cfLift_1({
        value: value,
        offset: offset
    }).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        value: {
            type: "number"
        },
        offset: {
            type: "number"
        }
    },
    required: ["value", "offset"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: patternTool-with-existing-params
// Verifies: patternTool's first arg is an explicit pattern() (CT-1655). The
//   author supplies `offset` via extraParams (a genuine per-call input); the
//   free module-scoped capture `multiplier` (read via .get()) is absorbed by the
//   pattern into a module-scope lift closure rather than injected into
//   extraParams — auto-capture-into-extraParams was removed when patternTool
//   began requiring an explicit pattern.
//   patternTool(pattern(({ value, offset }) => …multiplier.get()…), { offset })
export default pattern(() => {
    const tool = patternTool(__cfPattern_1, { offset: offset.for(["tool", 1, "offset"], true) });
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
                    properties: {
                        offset: {
                            type: "number"
                        }
                    },
                    required: ["offset"]
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
