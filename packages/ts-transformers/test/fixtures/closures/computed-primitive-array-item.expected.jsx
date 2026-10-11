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
const __cfLift_1 = __cfHelpers.lift(() => ["ABCDEFGHIJ"], false, undefined, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift((): {
    text?: string;
    size: "s" | "md";
}[] => [
    { text: "Hello", size: "md" },
], false, undefined, { completeSchedulerScopeSummary: true });
const __cfLift_3 = __cfHelpers.lift(() => [[1, 2, 3]], false, undefined, { completeSchedulerScopeSummary: true });
const __cfLift_4 = __cfHelpers.lift<{
    words: string[];
}, number | undefined>(({ words }) => words[0]?.length, {
    type: "object",
    properties: {
        words: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["words"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["number", "undefined"]
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_5 = __cfHelpers.lift<{
    words: string[];
}, string | undefined>(({ words }) => words[0]?.[0], {
    type: "object",
    properties: {
        words: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["words"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["string", "undefined"]
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_6 = __cfHelpers.lift<{
    labels: {
        text?: string | undefined;
    }[];
}, number | undefined>(({ labels }) => labels[0]?.text?.length, {
    type: "object",
    properties: {
        labels: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    text: {
                        type: "string"
                    }
                }
            }
        }
    },
    required: ["labels"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["number", "undefined"]
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_7 = __cfHelpers.lift<{
    labels: {
        size: "s" | "md";
    }[];
}, number | undefined>(({ labels }) => labels[0]?.size.length, {
    type: "object",
    properties: {
        labels: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    size: {
                        "enum": ["s", "md"]
                    }
                },
                required: ["size"]
            }
        }
    },
    required: ["labels"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["number", "undefined"]
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_8 = __cfHelpers.lift<{
    grid: unknown[][];
}, number | undefined>(({ grid }) => grid[0]?.length, {
    type: "object",
    properties: {
        grid: {
            type: "array",
            items: {
                type: "array",
                items: {
                    type: "unknown"
                }
            }
        }
    },
    required: ["grid"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["number", "undefined"]
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: computed-primitive-array-item
// Verifies: an array item that is a primitive keeps its type when a computed
//   reads through it, for arrays whose type is inferred
//   words[0]?.length        → words: string[]   (not unknown[][])
//   words[0]?.[0]           → words: string[]   (not string[][])
//   labels[0]?.text?.length → text?: string | undefined (not unknown[])
//   labels[0]?.size.length  → size: "s" | "md"  (not unknown[])
// Context: a string has a numeric index and `length` through its apparent
//   type, and is still not an array. `grid[0]?.length` is the control: an item
//   that is an array shrinks to `unknown[]`.
export default pattern(() => {
    const words = __cfLift_1().for("words", true);
    const labels = __cfLift_2().for("labels", true);
    const grid = __cfLift_3().for("grid", true);
    const firstLength = __cfLift_4({ words: words }).for("firstLength", true);
    const firstLetter = __cfLift_5({ words: words }).for("firstLetter", true);
    const textLength = __cfLift_6({ labels: labels }).for("textLength", true);
    const sizeLength = __cfLift_7({ labels: labels }).for("sizeLength", true);
    const rowLength = __cfLift_8({ grid: grid }).for("rowLength", true);
    return { firstLength, firstLetter, textLength, sizeLength, rowLength };
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        firstLength: {
            type: ["number", "undefined"]
        },
        firstLetter: {
            type: ["string", "undefined"]
        },
        textLength: {
            type: ["number", "undefined"]
        },
        sizeLength: {
            type: ["number", "undefined"]
        },
        rowLength: {
            type: ["number", "undefined"]
        }
    },
    required: ["firstLength", "firstLetter", "textLength", "sizeLength", "rowLength"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2,
    __cfLift_3,
    __cfLift_4,
    __cfLift_5,
    __cfLift_6,
    __cfLift_7,
    __cfLift_8
});
