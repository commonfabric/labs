function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface ContentPart {
    type: "text" | "image";
    text?: string;
    image?: string;
}
interface Message {
    role: "user" | "assistant";
    content: string | ContentPart[];
}
interface State {
    messages: Message[];
}
const __cfLift_h6cdcb512d0c4 = __cfHelpers.lift<{
    state: {
        messages: Message[];
    };
}, string | null>(({ state }) => {
    const messages = state.messages;
    if (!messages || messages.length === 0)
        return null;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]!;
        if (msg.role === "assistant") {
            // This map call inside the computed callback was the key issue
            const content = typeof msg.content === "string"
                ? msg.content
                : msg.content.map((part) => {
                    if (part.type === "text")
                        return part.text || "";
                    return "";
                }).join("");
            return content;
        }
    }
    return null;
}, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                messages: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Message"
                    }
                }
            },
            required: ["messages"]
        }
    },
    required: ["state"],
    $defs: {
        Message: {
            type: "object",
            properties: {
                role: {
                    "enum": ["user", "assistant"]
                },
                content: {
                    anyOf: [{
                            type: "string"
                        }, {
                            type: "array",
                            items: {
                                $ref: "#/$defs/ContentPart"
                            }
                        }]
                }
            },
            required: ["role", "content"]
        },
        ContentPart: {
            type: "object",
            properties: {
                type: {
                    "enum": ["text", "image"]
                },
                text: {
                    type: "string"
                },
                image: {
                    type: "string"
                }
            },
            required: ["type"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    anyOf: [{
            type: "string"
        }, {
            type: "null"
        }]
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: computed-map-union-return
// Verifies: a computed returning a union type (string | null) with a nested .map() infers the correct output schema
//   computed(() => { ...; return content }) → lift(schema, anyOf[string, null])({ messages })
//   inner .map() inside the computed callback → NOT transformed (plain array after unwrap)
// Context: previously caused schema to fall back to `true` when the callback became synthetic
export default pattern((state) => {
    // This computed callback contains a nested map and returns string | null.
    // The callback becomes synthetic during transformation, which previously
    // caused type inference to fail, resulting in a 'true' schema instead of
    // the correct union type schema.
    const latestMessage = __cfLift_h6cdcb512d0c4({ state: {
            messages: state.key("messages")
        } }).for("latestMessage", true);
    return {
        [UI]: (<div>
        <div>Latest: {latestMessage}</div>
      </div>),
    };
}, {
    type: "object",
    properties: {
        messages: {
            type: "array",
            items: {
                $ref: "#/$defs/Message"
            }
        }
    },
    required: ["messages"],
    $defs: {
        Message: {
            type: "object",
            properties: {
                role: {
                    "enum": ["user", "assistant"]
                },
                content: {
                    anyOf: [{
                            type: "string"
                        }, {
                            type: "array",
                            items: {
                                $ref: "#/$defs/ContentPart"
                            }
                        }]
                }
            },
            required: ["role", "content"]
        },
        ContentPart: {
            type: "object",
            properties: {
                type: {
                    "enum": ["text", "image"]
                },
                text: {
                    type: "string"
                },
                image: {
                    type: "string"
                }
            },
            required: ["type"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$UI"],
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    $ref: "#/$defs/UIRenderable"
                }, {
                    type: "object",
                    properties: {}
                }]
        },
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
    __cfLift_h6cdcb512d0c4,
    __cfLift_1: __cfLift_h6cdcb512d0c4
});
