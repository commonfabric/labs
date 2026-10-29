function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { action, NAME, pattern, SELF, UI, type VNode, Writable, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// `navigateTo` is a CommonFabric built-in for SPA navigation; importing
// it ensures it lives at module scope and the action bodies that
// reference it (a) compile and (b) close over a module-level symbol.
declare const navigateTo: (target: any) => any;
interface Item {
    id: number;
    label: string;
    [NAME]: string;
}
interface ListOutput {
    [NAME]: string;
    [UI]: VNode;
    read: any;
    write: any;
}
const Item = pattern((__cf_pattern_input) => {
    const id = __cf_pattern_input.key("id");
    const label = __cf_pattern_input.key("label");
    return ({
        id,
        label,
        [NAME]: label,
    });
}, {
    type: "object",
    properties: {
        id: {
            type: "number"
        },
        label: {
            type: "string"
        }
    },
    required: ["id", "label"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        id: {
            type: "number"
        },
        label: {
            type: "string"
        },
        $NAME: {
            type: "string"
        }
    },
    required: ["id", "label", "$NAME"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfHandler_1 = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            asCell: ["readonly"]
        }
    },
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                label: {
                    type: "string"
                },
                $NAME: {
                    type: "string"
                }
            },
            required: ["id", "label", "$NAME"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, (_, { items }) => {
    const pieces = items.get() ?? [];
    const existing = pieces.find((p) => {
        const n = p?.[NAME];
        return typeof n === "string" && n.startsWith("All ");
    });
    if (existing) {
        return navigateTo(existing);
    }
});
const __cfHandler_2 = __cfHelpers.handler({
    type: "object",
    properties: {
        label: {
            type: "string"
        }
    },
    required: ["label"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        self: {
            $ref: "#/$defs/ListOutput"
        },
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            asCell: ["writeonly"]
        }
    },
    required: ["self", "items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                label: {
                    type: "string"
                },
                $NAME: {
                    type: "string"
                }
            },
            required: ["id", "label", "$NAME"]
        },
        ListOutput: {
            type: "object",
            properties: {
                read: true,
                write: true,
                $NAME: {
                    type: "string"
                },
                $UI: {
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }
            },
            required: ["read", "write", "$NAME", "$UI"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, ({ label }, { self, items }) => {
    const newItem = Item({ id: 0, label, parent: self } as any);
    items.push(newItem as any);
    return newItem;
});
// FIXTURE: hoisted-handler-preserves-capture-schemas (CT-1585 regression)
export default pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    const self = __cf_pattern_input[__cfHelpers.SELF];
    // `read` action: matches the shape of notebook.tsx's
    // `goToAllNotesAction` — reads `items.get()`, filters, conditionally
    // navigates. Triggers `items` to be classified `readonly` in this
    // action's captures schema.
    const read = __cfHandler_1({
        items: items
    }).for({ stream: "read" }, true);
    // `write` action: matches the shape of notebook.tsx's
    // `createNoteStreamAction` — pushes a new item, returns it. Should
    // get a schema with `items` classified `writeonly` (plus `self`).
    const write = __cfHandler_2({
        self: self,
        items: items
    }).for({ stream: "write" }, true);
    return {
        [NAME]: "List",
        [UI]: <button type="button" onClick={write}>Create</button>,
        read: read.for({ stream: ["__patternResult", "read"] }, true),
        write: write.for({ stream: ["__patternResult", "write"] }, true)
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            asCell: ["cell"]
        }
    },
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                label: {
                    type: "string"
                },
                $NAME: {
                    type: "string"
                }
            },
            required: ["id", "label", "$NAME"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        read: true,
        write: true,
        $NAME: {
            type: "string"
        },
        $UI: {
            $ref: "https://commonfabric.org/schemas/vnode.json"
        }
    },
    required: ["read", "write", "$NAME", "$UI"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    Item,
    __cfHandler_1,
    __cfHandler_2
});
