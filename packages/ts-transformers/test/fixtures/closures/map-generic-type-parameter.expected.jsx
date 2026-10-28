function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, Reactive } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Email {
    id: string;
    content: string;
}
interface State {
    emails: Reactive<Email[]>;
    prompt: string;
}
/**
 * Test that generic type parameters (like T) are NOT captured as closed-over
 * variables. Type parameters are compile-time only and don't exist at runtime.
 *
 * The bug was: when a generic function used T inside a .map() callback,
 * the closure transformer would try to capture T as: { T: T, prompt: prompt }
 * This caused "ReferenceError: T is not defined" at runtime.
 */
function processWithType<T>(emails: Reactive<Email[]>, _prompt: string) {
    // T is used here but should NOT be captured - it's a type, not a value
    return emails.map((email: Email) => {
        // The type annotation <T> should not cause T to be captured
        const result = { id: email.id, type: "processed" as T };
        return result;
    });
}
__cfHardenFn(processWithType);
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        emails: Email[];
        prompt: string;
    };
}, { id: string; type: string; }[]>(({ state }) => processWithType<string>(state.emails, state.prompt), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                emails: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: {
                                type: "string"
                            }
                        },
                        required: ["id"]
                    }
                },
                prompt: {
                    type: "string"
                }
            },
            required: ["emails", "prompt"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "object",
        properties: {
            id: {
                type: "string"
            },
            type: {
                type: "string"
            }
        },
        required: ["id", "type"]
    }
} as const satisfies __cfHelpers.JSONSchema);
export default pattern((state) => {
    const results = __cfLift_1({ state: {
            emails: state.key("emails"),
            prompt: state.key("prompt")
        } }).for("results", true);
    return { results };
}, {
    type: "object",
    properties: {
        emails: {
            type: "array",
            items: {
                $ref: "#/$defs/Email"
            }
        },
        prompt: {
            type: "string"
        }
    },
    required: ["emails", "prompt"],
    $defs: {
        Email: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                content: {
                    type: "string"
                }
            },
            required: ["id", "content"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        results: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: {
                        type: "string"
                    },
                    type: {
                        type: "string"
                    }
                },
                required: ["id", "type"]
            }
        }
    },
    required: ["results"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
