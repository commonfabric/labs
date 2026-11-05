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
interface Reaction {
    emoji: string;
}
interface Message {
    id: string;
    reactions?: Reaction[];
}
interface Input {
    messages: Message[];
}
const __cfLift_1 = __cfHelpers.lift<{
    msg: {
        reactions?: Reaction[] | undefined;
    };
}, Reaction[]>(({ msg }) => (msg.reactions ?? []) as Reaction[], {
    type: "object",
    properties: {
        msg: {
            type: "object",
            properties: {
                reactions: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Reaction"
                    }
                }
            }
        }
    },
    required: ["msg"],
    $defs: {
        Reaction: {
            type: "object",
            properties: {
                emoji: {
                    type: "string"
                }
            },
            required: ["emoji"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        $ref: "#/$defs/Reaction"
    },
    $defs: {
        Reaction: {
            type: "object",
            properties: {
                emoji: {
                    type: "string"
                }
            },
            required: ["emoji"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
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
                }
            },
            required: ["emoji"]
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
const __cfPattern_2 = __cfHelpers.pattern(__cf_pattern_input => {
    const msg = __cf_pattern_input.key("element");
    const messageReactions = __cfLift_1({ msg: {
            reactions: msg.key("reactions")
        } }).for("messageReactions", true);
    return (<div>
              {messageReactions.mapWithPattern(__cfPattern_1.curry({
            msg: {
                id: msg.key("id")
            }
        }))}
            </div>);
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
                }
            },
            required: ["emoji"]
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
// FIXTURE: map-computed-fallback-alias
// Verifies: computed() inside a map callback creates a lift-applied computation and nested map is also transformed
//   computed(() => (msg.reactions ?? [])) → lift(...)(...) with msg.reactions as input
//   messageReactions.map(fn) → nested .mapWithPattern(pattern(...).curry({ msg: { id: msg.key("id") } }))
// Context: Nested map — outer maps messages, inner maps computed reactions; inner captures msg.id
export default pattern((__cf_pattern_input) => {
    const messages = __cf_pattern_input.key("messages");
    return {
        [UI]: (<div>
        {messages.mapWithPattern(__cfPattern_2)}
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
                }
            },
            required: ["emoji"]
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
    __cfLift_1,
    __cfPattern_1,
    __cfPattern_2
});
