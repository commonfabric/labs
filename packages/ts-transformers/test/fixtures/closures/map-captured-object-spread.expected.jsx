function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { handler, pattern, UI, type Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
declare global {
    namespace JSX {
        interface IntrinsicElements {
            "cf-button": any;
        }
    }
}
interface Item {
    id: string;
}
interface State {
    items: Item[];
    log: Writable<string[]>;
    prefix: Writable<string>;
}
const record = handler({
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        log: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: ["writeonly"]
        },
        prefix: {
            type: "string",
            asCell: ["readonly"]
        },
        id: {
            type: "string"
        }
    },
    required: ["log", "prefix", "id"]
} as const satisfies __cfHelpers.JSONSchema, (_, state) => {
    state.log.push(`${state.prefix.get()}:${state.id}`);
});
const moduleStyle = __cfHelpers.__cf_data({ color: "red" });
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    const records = __cf_pattern_input.params.records;
    return (<cf-button style={{ ...moduleStyle }} onClick={record({ log: records.key("log"), prefix: records.key("prefix"), id: item.key("id") })}>
            {item.key("id")}
          </cf-button>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Item"
        },
        params: {
            type: "object",
            properties: {
                records: {
                    type: "object",
                    properties: {
                        log: {
                            type: "array",
                            items: {
                                type: "string"
                            },
                            asCell: ["readonly"]
                        },
                        prefix: {
                            type: "string",
                            asCell: ["readonly"]
                        }
                    },
                    required: ["log", "prefix"]
                }
            },
            required: ["records"]
        }
    },
    required: ["element", "params"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                }
            },
            required: ["id"]
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
// FIXTURE: map-captured-object-spread
// Verifies: a spread of a captured `const` object literal with static keys, in
//   a reactive `.map()` callback, is written out as the properties it copies
//   { ...records, id: item.id } → { log: records.key("log"), prefix: records.key("prefix"), id: ... }
//   { ...moduleStyle }          → unchanged (a module binding is not captured)
// Context: the capture reaches the callback as an opaque reference, which has
//   no keys to spread
export default pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    const log = __cf_pattern_input.key("log");
    const prefix = __cf_pattern_input.key("prefix");
    const records = { log: log.for(["records", "log"], true), prefix: prefix.for(["records", "prefix"], true) };
    return {
        [UI]: (<div>
        {items.mapWithPattern(__cfPattern_1, {
                records: records
            })}
      </div>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        },
        log: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: ["cell"]
        },
        prefix: {
            type: "string",
            asCell: ["cell"]
        }
    },
    required: ["items", "log", "prefix"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                }
            },
            required: ["id"]
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
    record,
    __cfPattern_1
});
