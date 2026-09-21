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
 * Test case for nested map transformation inside ternary.
 *
 * The key scenario: `item.tags.map(...)` where `item` is from an outer
 * `mapWithPattern` callback, and the whole thing is inside a ternary
 * that gets wrapped in `ifElse` → lift-applied computation.
 *
 * The inner map on `item.tags` should still be transformed to
 * `mapWithPattern` because `item` comes from a mapWithPattern element,
 * NOT from the lift-applied computation's captures.
 */
import { Cell, computed, Default, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Tag {
    name: string;
}
interface Item {
    label: string;
    tags: Tag[];
    selectedIndex: number;
}
interface PatternInput {
    items?: Cell<Default<Item[], [
    ]>>;
}
const __cfLift_1 = __cfHelpers.lift<{
    items: __cfHelpers.ReadonlyCell<Default<Item[], [
    ]>>;
}, boolean>(({ items }) => items.get().length > 0, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            "default": [],
            asCell: ["readonly"]
        }
    },
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                },
                tags: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Tag"
                    }
                },
                selectedIndex: {
                    type: "number"
                }
            },
            required: ["label", "tags", "selectedIndex"]
        },
        Tag: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift<{
    i: number;
    item: {
        selectedIndex: number;
    };
}, boolean>(({ i, item }) => i === item.selectedIndex, {
    type: "object",
    properties: {
        i: {
            type: "number"
        },
        item: {
            type: "object",
            properties: {
                selectedIndex: {
                    type: "number"
                }
            },
            required: ["selectedIndex"]
        }
    },
    required: ["i", "item"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const tag = __cf_pattern_input.key("element");
    const i = __cf_pattern_input.key("index");
    const item = __cf_pattern_input.key("params", "item");
    return (<li>
                    {__cfHelpers.ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        "enum": ["", "* "]
    } as const satisfies __cfHelpers.JSONSchema, __cfLift_2({
        i: i,
        item: {
            selectedIndex: item.key("selectedIndex")
        }
    }), "* ", "")}
                    {tag.key("name")}
                  </li>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Tag"
        },
        index: {
            type: "number"
        },
        params: {
            type: "object",
            properties: {
                item: {
                    type: "object",
                    properties: {
                        selectedIndex: {
                            type: "number"
                        }
                    },
                    required: ["selectedIndex"]
                }
            },
            required: ["item"]
        }
    },
    required: ["element", "params"],
    $defs: {
        Tag: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
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
    const item = __cf_pattern_input.key("element");
    return (<div>
              <strong>{item.key("label")}</strong>
              <ul>
                {item.key("tags").mapWithPattern(__cfPattern_1, {
            item: {
                selectedIndex: item.key("selectedIndex")
            }
        })}
              </ul>
            </div>);
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
                label: {
                    type: "string"
                },
                tags: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Tag"
                    }
                },
                selectedIndex: {
                    type: "number"
                }
            },
            required: ["label", "tags", "selectedIndex"]
        },
        Tag: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
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
// FIXTURE: pattern-nested-jsx-map
// Verifies: nested .map() calls in JSX both become mapWithPattern, including inside ifElse
//   items.map((item) => ...) → items.mapWithPattern(pattern(...))
//   item.tags.map((tag, i) => ...) → item.key("tags").mapWithPattern(pattern(...), { item: ... })
//   hasItems ? items.map(...) : <p>No items</p> → ifElse(hasItems, items.mapWithPattern(...), <p>No items</p>)
//   i === item.selectedIndex ? "* " : "" → ifElse(lift(...)(...), "* ", "")
// Context: Inner map on item.tags captures `item.selectedIndex` from the outer
//   mapWithPattern, so it must be passed as a param. Ternaries become ifElse at
//   both the outer and inner levels.
export default pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    const hasItems = __cfLift_1({ items: items }).for("hasItems", true);
    return {
        [UI]: (<div>
        {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "array",
            items: {}
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }, {
                    type: "array",
                    items: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, hasItems, items.mapWithPattern(__cfPattern_2, {}), <p>No items</p>)}
      </div>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            "default": [],
            asCell: ["cell"]
        }
    },
    $defs: {
        Item: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                },
                tags: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Tag"
                    }
                },
                selectedIndex: {
                    type: "number"
                }
            },
            required: ["label", "tags", "selectedIndex"]
        },
        Tag: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
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
    __cfLift_2,
    __cfPattern_1,
    __cfPattern_2
});
