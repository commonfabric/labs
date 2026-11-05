function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Item {
    title: string;
}
export interface SubOutput {
    label: string;
    store: Writable<Item>;
}
// FIXTURE: map-result-cell-preserved
// The .map() lowering injects a pattern whose RESULT schema is inferred from
// the element callback's return type. When the callback returns a sub-pattern
// result whose Output carries a Writable<>, the injected pattern's result
// schema (and the outer pattern's result schema) must keep `asCell: ["cell"]`
// on that field — consumers rehydrate the live per-element cell. Before
// factory result types stopped being StripCell'd, the brand was silently
// dropped here (the declared Sub schema kept it, but the inferred map-pattern
// result schema lost it).
const Sub = pattern((__cf_pattern_input) => {
    const item = __cf_pattern_input.key("item");
    const store = new Writable<Item>({ title: "" }, {
        type: "object",
        properties: {
            title: {
                type: "string"
            }
        },
        required: ["title"]
    } as const satisfies __cfHelpers.JSONSchema).for("store", true);
    return { label: item.key("title"), store };
}, {
    type: "object",
    properties: {
        item: {
            $ref: "#/$defs/Item"
        }
    },
    required: ["item"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                }
            },
            required: ["title"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        label: {
            type: "string"
        },
        store: {
            $ref: "#/$defs/Item",
            asCell: ["cell"]
        }
    },
    required: ["label", "store"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                }
            },
            required: ["title"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
export interface Input {
    items: Item[];
}
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    return Sub({ item });
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Item"
        }
    },
    required: ["element"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                }
            },
            required: ["title"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        label: {
            type: "string"
        },
        store: {
            $ref: "#/$defs/Item",
            asCell: ["cell"]
        }
    },
    required: ["label", "store"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                }
            },
            required: ["title"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
export default pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    const subs = items.mapWithPattern(__cfPattern_1).for("subs", true);
    return { subs };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        }
    },
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                }
            },
            required: ["title"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        subs: {
            type: "array",
            items: {
                $ref: "#/$defs/SubOutput"
            }
        }
    },
    required: ["subs"],
    $defs: {
        SubOutput: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                },
                store: {
                    $ref: "#/$defs/Item",
                    asCell: ["cell"]
                }
            },
            required: ["label", "store"]
        },
        Item: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                }
            },
            required: ["title"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    Sub,
    __cfPattern_1
});
