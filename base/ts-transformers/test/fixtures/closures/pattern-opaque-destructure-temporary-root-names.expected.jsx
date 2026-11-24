function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, generateObject, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift<{
    messages: string[];
}, string>(({ messages }) => messages[0] ?? "", {
    type: "object",
    properties: {
        messages: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["messages"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift<{
    result?: any;
}, any>(({ result }) => result?.title ?? "Untitled", {
    type: "object",
    properties: {
        result: true
    }
} as const satisfies __cfHelpers.JSONSchema, true as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: pattern-opaque-destructure-temporary-root-names
// Verifies: destructured opaque temporaries preserve generated root suffixes
//   const { result } = generateObject(...) uses the synthesized __cf_destructure_* binding consistently
// NOTE (CT-1800): generateObject's `result` is declared optional, so the captured
//   `result` is emitted optional (absent from `required`). The lift therefore
//   fires while pending, keeping the `?? "Untitled"` fallback live.
export default pattern((__cf_pattern_input) => {
    const messages = __cf_pattern_input.key("messages");
    const preview = __cfLift_1({ messages: messages }).for("preview", true);
    const __cf_destructure_1 = generateObject({
        prompt: preview,
        schema: {
            type: "object",
            properties: {
                title: { type: "string" },
            },
            required: ["title"],
        },
    }), result = __cf_destructure_1.key("result").for("result", true);
    return <div>{__cfLift_2({ result: result })}</div>;
}, {
    type: "object",
    properties: {
        messages: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["messages"]
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
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2
});
