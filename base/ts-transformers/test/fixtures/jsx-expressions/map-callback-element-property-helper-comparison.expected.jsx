function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
/**
 * TRANSFORM REPRO: mapped element field comparisons inside helper-call roots
 *
 * The mapped element is lowered to a cell input. A non-JSX comparison such as
 * `message.author === senderName(name.get())` must read `message.author`
 * through a reactive field dependency, not as a plain property on the cell.
 */
import { Default, pattern, UI, VNode, Writable, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Message {
    author: string;
    body: string;
}
interface Input {
    name: Writable<Default<string, "">>;
    selectedRoom: Writable<Default<{
        messages: Message[];
    }, {
        messages: [
        ];
    }>>;
}
interface Output {
    [UI]: VNode;
}
const senderName = __cfHardenFn((name?: string) => name?.trim() || "Anonymous");
const __cfLift_1 = __cfHelpers.lift<{
    selectedRoom: __cfHelpers.ReadonlyCell<Default<{
        messages: Message[];
    }, {
        messages: [
        ];
    }>>;
}, Message[]>(({ selectedRoom }) => selectedRoom.get()?.messages, {
    type: "object",
    properties: {
        selectedRoom: {
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
            "default": {
                messages: []
            },
            asCell: ["readonly"]
        }
    },
    required: ["selectedRoom"],
    $defs: {
        Message: {
            type: "object",
            properties: {
                author: {
                    type: "string"
                },
                body: {
                    type: "string"
                }
            },
            required: ["author", "body"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        $ref: "#/$defs/Message"
    },
    $defs: {
        Message: {
            type: "object",
            properties: {
                author: {
                    type: "string"
                },
                body: {
                    type: "string"
                }
            },
            required: ["author", "body"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift<{
    message: {
        author: string;
    };
    name: Writable<Default<string, "">>;
}, boolean>(({ message, name }) => message.author === senderName(name.get()), {
    type: "object",
    properties: {
        message: {
            type: "object",
            properties: {
                author: {
                    type: "string"
                }
            },
            required: ["author"]
        },
        name: {
            type: "string",
            "default": "",
            asCell: ["readonly"]
        }
    },
    required: ["message", "name"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_3 = __cfHelpers.lift<{
    message: {
        author: string;
    };
}, boolean>(({ message }) => message.author === "Alice", {
    type: "object",
    properties: {
        message: {
            type: "object",
            properties: {
                author: {
                    type: "string"
                }
            },
            required: ["author"]
        }
    },
    required: ["message"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const message = __cf_pattern_input.key("element");
    const name = __cf_pattern_input.key("params", "name");
    const isMine = __cfLift_2({
        message: {
            author: message.key("author")
        },
        name: name
    }).for("isMine", true);
    const isKnownAuthor = __cfLift_3({ message: {
            author: message.key("author")
        } }).for("isKnownAuthor", true);
    return (<div data-author-kind={__cfHelpers.ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        "enum": ["known", "other"]
    } as const satisfies __cfHelpers.JSONSchema, isKnownAuthor, "known", "other")} style={{ justifyContent: __cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["flex-end", "flex-start"]
        } as const satisfies __cfHelpers.JSONSchema, isMine, "flex-end", "flex-start") }}>
              {message.key("author")}
              {message.key("body")}
            </div>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Message"
        },
        params: {
            type: "object",
            properties: {
                name: {
                    type: "string",
                    "default": "",
                    asCell: ["readonly"]
                }
            },
            required: ["name"]
        }
    },
    required: ["element", "params"],
    $defs: {
        Message: {
            type: "object",
            properties: {
                author: {
                    type: "string"
                },
                body: {
                    type: "string"
                }
            },
            required: ["author", "body"]
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
export default pattern((__cf_pattern_input) => {
    const name = __cf_pattern_input.key("name");
    const selectedRoom = __cf_pattern_input.key("selectedRoom");
    return {
        [UI]: (<div>
        {__cfLift_1({ selectedRoom: selectedRoom }).mapWithPattern(__cfPattern_1, {
            name: name
        })}
      </div>),
    };
}, {
    type: "object",
    properties: {
        name: {
            type: "string",
            "default": "",
            asCell: ["cell"]
        },
        selectedRoom: {
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
            "default": {
                messages: []
            },
            asCell: ["cell"]
        }
    },
    required: ["name", "selectedRoom"],
    $defs: {
        Message: {
            type: "object",
            properties: {
                author: {
                    type: "string"
                },
                body: {
                    type: "string"
                }
            },
            required: ["author", "body"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "https://commonfabric.org/schemas/vnode.json"
        }
    },
    required: ["$UI"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2,
    __cfLift_3,
    __cfPattern_1
});
