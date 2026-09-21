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
 * Test case for ternary transformation inside nested Cell.map callbacks.
 *
 * The key scenario: A ternary inside a nested .map() callback should be
 * transformed to ifElse, because the callback body of a Cell.map is
 * back in "pattern mode" where ternaries need transformation.
 *
 * This structure mirrors pattern-nested-jsx-map: outer ternary wraps items.map,
 * causing ifElse → lift-applied, then inner ternary is inside nested .map callback.
 */
import { Cell, computed, Default, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Tag {
    name: string;
    active: boolean;
}
interface Item {
    label: string;
    tags: Tag[];
}
interface PatternInput {
    items?: Cell<Default<Item[], [
    ]>>;
    showInactive?: Default<boolean, false>;
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
                }
            },
            required: ["label", "tags"]
        },
        Tag: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["name", "active"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift<{
    item: {
        tags: {
            length: number;
        };
    };
}, boolean>(({ item }) => item.tags.length > 0, {
    type: "object",
    properties: {
        item: {
            type: "object",
            properties: {
                tags: {
                    type: "object",
                    properties: {
                        length: {
                            type: "number"
                        }
                    },
                    required: ["length"]
                }
            },
            required: ["tags"]
        }
    },
    required: ["item"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const tag = __cf_pattern_input.key("element");
    const showInactive = __cf_pattern_input.key("params", "showInactive");
    return (<li>
                    {/* This ternary should be transformed to ifElse */}
                    {__cfHelpers.ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, tag.key("active"), tag.key("name"), __cfHelpers.ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, showInactive, `(${tag.key("name")})`, ""))}
                  </li>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Tag"
        },
        params: {
            type: "object",
            properties: {
                showInactive: {
                    type: "boolean",
                    "default": false
                }
            },
            required: ["showInactive"]
        }
    },
    required: ["element", "params"],
    $defs: {
        Tag: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["name", "active"]
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
    const showInactive = __cf_pattern_input.key("params", "showInactive");
    return (<div>
              {/* Ternary in outer map, outside inner map - should also be ifElse */}
              <strong>{__cfHelpers.ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, __cfLift_2({ item: {
            tags: {
                length: item.key("tags", "length")
            }
        } }), item.key("label"), "No tags")}</strong>
              <ul>
                {item.key("tags").mapWithPattern(__cfPattern_1, {
            showInactive: showInactive
        })}
              </ul>
            </div>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Item"
        },
        params: {
            type: "object",
            properties: {
                showInactive: {
                    type: "boolean",
                    "default": false
                }
            },
            required: ["showInactive"]
        }
    },
    required: ["element", "params"],
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
                }
            },
            required: ["label", "tags"]
        },
        Tag: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["name", "active"]
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
// FIXTURE: map-ternary-inside-nested-map
// Verifies: ternaries inside nested .map() callbacks are transformed to ifElse
//   outer ternary → ifElse(hasItems, items.mapWithPattern(...), <p>No items</p>)
//   outer .map(fn) → .mapWithPattern(pattern(...), {showInactive})
//   inner .map(fn) → .mapWithPattern(pattern(...), {showInactive})
//   inner ternary → ifElse(tag.active, tag.name, ifElse(showInactive, `(${tag.name})`, ""))
// Context: Nested maps with ternaries at both levels; captures showInactive through both map layers
export default pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    const showInactive = __cf_pattern_input.key("showInactive");
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
        } as const satisfies __cfHelpers.JSONSchema, hasItems, items.mapWithPattern(__cfPattern_2, {
            showInactive: showInactive
        }), <p>No items</p>)}
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
        },
        showInactive: {
            type: "boolean",
            "default": false
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
                }
            },
            required: ["label", "tags"]
        },
        Tag: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["name", "active"]
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
