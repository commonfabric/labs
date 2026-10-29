function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: index-signature-extras-optional
// Verifies: a capture path that resolves through a string index signature
// (an "extras" key like `priority` below) shrinks to an OPTIONAL property.
// Index signatures never guarantee a key exists, so the shrunken capture
// schema must not list the key in `required` — otherwise elements without
// the extra fail schema validation and the whole capture reads undefined
// (regression: editable-list assert_extra_passthrough after #4017).
interface TaggedItem {
    id: string;
    label: string;
    // deno-lint-ignore no-explicit-any
    [extra: string]: any;
}
interface Input {
    items: TaggedItem[];
}
const __cfLift_1 = __cfHelpers.lift<{
    items: {
        priority?: any;
    }[];
}, boolean>(({ items }) => items[2]?.priority === 9, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    priority: true
                }
            }
        }
    },
    required: ["items"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift<{
    items: {
        label: string;
    }[];
}, boolean>(({ items }) => items[2]?.label === "Gamma", {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    label: {
                        type: "string"
                    }
                },
                required: ["label"]
            }
        }
    },
    required: ["items"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
export default pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    // Extras key: only exists on some elements; must shrink to `priority?`.
    const extraIsNine = __cfLift_1({ items: items }).for("extraIsNine", true);
    // Declared key for contrast: stays required as before.
    const labelIsGamma = __cfLift_2({ items: items }).for("labelIsGamma", true);
    return { extraIsNine, labelIsGamma };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/TaggedItem"
            }
        }
    },
    required: ["items"],
    $defs: {
        TaggedItem: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                label: {
                    type: "string"
                }
            },
            additionalProperties: true,
            required: ["id", "label"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        extraIsNine: {
            type: "boolean"
        },
        labelIsGamma: {
            type: "boolean"
        }
    },
    required: ["extraIsNine", "labelIsGamma"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2
});
