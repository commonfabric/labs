function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, Default, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Entry {
    name: string;
    url: string;
}
interface LinksState {
    links: Default<Entry[], [
    ]>;
    myName: Default<string, "">;
}
const __cfLift_h578766f76305 = __cfHelpers.lift<{
    myName: Default<string, "">;
}, string>(({ myName }) => myName.trim(), {
    type: "object",
    properties: {
        myName: {
            type: "string",
            "default": ""
        }
    },
    required: ["myName"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_h44217494a20f = __cfHelpers.lift<{
    entry: {
        name: string;
    };
    me: string;
}, boolean>(({ entry, me }) => entry.name === me, {
    type: "object",
    properties: {
        entry: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        },
        me: {
            type: "string"
        }
    },
    required: ["entry", "me"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_h693560d5b14a = __cfHelpers.pattern(__cf_pattern_input => {
    const entry = __cf_pattern_input.key("element");
    const me = __cf_pattern_input.key("params", "me");
    return (__cfHelpers.ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{}, {
                type: "object",
                properties: {}
            }]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "null"
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{
                type: "null"
            }, {}, {
                type: "object",
                properties: {}
            }]
    } as const satisfies __cfHelpers.JSONSchema, __cfLift_h44217494a20f({
        entry: {
            name: entry.key("name")
        },
        me: me
    }), <span>{entry.key("url")}</span>, null)).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Entry"
        },
        params: {
            type: "object",
            properties: {
                me: {
                    type: "string"
                }
            },
            required: ["me"]
        }
    },
    required: ["element", "params"],
    $defs: {
        Entry: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                url: {
                    type: "string"
                }
            },
            required: ["name", "url"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    anyOf: [{
            type: "null"
        }, {
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
// FIXTURE: map-row-ternary-computed-capture
// Verifies: a binary comparison inside a JSX map-row ternary, comparing the
//   element binding against a computed captured from the enclosing pattern
//   body, lowers without crashing the compute-wrap invariant (lunch-poll
//   PR #4928 shape 2):
//   {links.map((entry) => entry.name === me ? <span/> : null)}
//     -> mapWithPattern row with an ifElse over a lifted comparison
// Context: regression companion to the builder-argument computation
//   diagnostic — this shape is supported and must keep lowering cleanly.
export default pattern((__cf_pattern_input) => {
    const links = __cf_pattern_input.key("links");
    const myName = __cf_pattern_input.key("myName");
    const me = __cfLift_h578766f76305({ myName: myName }).for("me", true);
    return {
        [UI]: (<div>
        {links.mapWithPattern(__cfPattern_h693560d5b14a, {
                me: me
            })}
      </div>),
    };
}, {
    type: "object",
    properties: {
        links: {
            type: "array",
            items: {
                $ref: "#/$defs/Entry"
            },
            "default": []
        },
        myName: {
            type: "string",
            "default": ""
        }
    },
    required: ["links", "myName"],
    $defs: {
        Entry: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                url: {
                    type: "string"
                }
            },
            required: ["name", "url"]
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
    __cfLift_h578766f76305,
    __cfLift_h44217494a20f,
    __cfPattern_h693560d5b14a,
    __cfLift_1: __cfLift_h578766f76305,
    __cfLift_2: __cfLift_h44217494a20f,
    __cfPattern_1: __cfPattern_h693560d5b14a
});
