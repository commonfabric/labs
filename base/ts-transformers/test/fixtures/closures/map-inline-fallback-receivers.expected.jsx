function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Reaction {
    emoji: string;
    userNames: string[];
}
interface Message {
    id: string;
    reactions?: Reaction[];
}
interface Input {
    messages: Message[];
}
const __cfPattern_1 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { msg }) => {
    const reaction = __cf_pattern_input.key("element");
    return (<button type="button" data-msg-id={msg.id}>
                {reaction.key("emoji")}
              </button>);
}, {
    type: "object",
    properties: {
        msg: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                }
            },
            required: ["id"]
        }
    },
    required: ["msg"]
} as const satisfies __cfHelpers.JSONSchema), {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Reaction"
        }
    },
    required: ["element"],
    $defs: {
        Reaction: {
            type: "object",
            properties: {
                emoji: {
                    type: "string"
                },
                userNames: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["emoji", "userNames"]
        }
    }
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
const __cfPattern_2 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { msg }) => {
    const reaction = __cf_pattern_input.key("element");
    return (<span>
                {msg.id}:{reaction.key("userNames", "length")}
              </span>);
}, {
    type: "object",
    properties: {
        msg: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                }
            },
            required: ["id"]
        }
    },
    required: ["msg"]
} as const satisfies __cfHelpers.JSONSchema), {
    type: "object",
    properties: {
        element: {
            type: "object",
            properties: {
                userNames: {
                    type: "array",
                    items: {
                        type: "unknown"
                    }
                }
            },
            required: ["userNames"]
        }
    },
    required: ["element"]
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
const __cfPattern_3 = __cfHelpers.pattern(__cf_pattern_input => {
    const msg = __cf_pattern_input.key("element");
    return (<section>
            {(msg.key("reactions") ?? []).mapWithPattern(__cfPattern_1.curry({
            msg: {
                id: msg.key("id")
            }
        }))}
            {(msg.key("reactions") || []).mapWithPattern(__cfPattern_2.curry({
            msg: {
                id: msg.key("id")
            }
        }))}
          </section>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Message"
        }
    },
    required: ["element"],
    $defs: {
        Message: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                reactions: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Reaction"
                    }
                }
            },
            required: ["id"]
        },
        Reaction: {
            type: "object",
            properties: {
                emoji: {
                    type: "string"
                },
                userNames: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["emoji", "userNames"]
        }
    }
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
// FIXTURE: map-inline-fallback-receivers
// Verifies: inline fallback array-method receivers are transformed structurally
//   (msg.reactions ?? []).map(fn) → lift(...)(...).mapWithPattern(pattern(...).curry({ msg: { id: ... } }))
//   (msg.reactions || []).map(fn) → lift(...)(...).mapWithPattern(pattern(...).curry({ msg: { id: ... } }))
// Context: Nested map — outer maps messages, inner fallback receivers capture msg.id and message-local reaction data
export default pattern((__cf_pattern_input) => {
    const messages = __cf_pattern_input.key("messages");
    return {
        [UI]: (<div>
        {messages.mapWithPattern(__cfPattern_3)}
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
                id: {
                    type: "string"
                },
                reactions: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Reaction"
                    }
                }
            },
            required: ["id"]
        },
        Reaction: {
            type: "object",
            properties: {
                emoji: {
                    type: "string"
                },
                userNames: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["emoji", "userNames"]
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
    __cfPattern_1,
    __cfPattern_2,
    __cfPattern_3
});
