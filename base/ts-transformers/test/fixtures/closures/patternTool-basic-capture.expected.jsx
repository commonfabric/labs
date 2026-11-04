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
const content = __cfHelpers.__cf_data(cell("Hello world\nGoodbye world", {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema).for("content", true));
type Output = {
    grepTool: PatternToolResult<{
        content: string;
    }>;
};
const __cfLift_1 = __cfHelpers.lift<{
    query: string;
    content: string;
}, string[]>(({ content, query }) => {
    return content.split("\n").filter((c: string) => c.includes(query));
}, {
    type: "object",
    properties: {
        query: {
            type: "string"
        },
        content: {
            type: "string"
        }
    },
    required: ["query", "content"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfPattern_1 = pattern((__cf_pattern_input: {
    query: string;
    content: string;
}) => {
    const query = __cf_pattern_input.key("query");
    const content = __cf_pattern_input.key("content");
    return __cfLift_1({
        content: content,
        query: query
    }).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        query: {
            type: "string"
        },
        content: {
            type: "string"
        }
    },
    required: ["query", "content"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: patternTool-basic-capture
// Verifies: patternTool's first arg is a pattern() (CT-1655); `content` is a
//   genuine pattern input supplied via extraParams.
//   patternTool(pattern(({ query, content }) => …), { content })
// Context: `content` appears in the pattern callback's destructured input and is
//   pre-filled through extraParams.
export default pattern(() => {
    const grepTool = patternTool(__cfPattern_1, { content: content.for(["grepTool", 1, "content"], true) });
    return { grepTool };
}, {
    type: "object",
    properties: {},
    additionalProperties: false
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        grepTool: {
            type: "object",
            properties: {
                pattern: {
                    $ref: "#/$defs/Pattern"
                },
                extraParams: {
                    type: "object",
                    properties: {
                        content: {
                            type: "string"
                        }
                    },
                    required: ["content"]
                },
                useResultSchemaForObservation: {
                    type: "boolean"
                }
            },
            required: ["pattern", "extraParams"]
        }
    },
    required: ["grepTool"],
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
