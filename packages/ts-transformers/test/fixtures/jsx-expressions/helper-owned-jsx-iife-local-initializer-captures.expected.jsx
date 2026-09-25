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
 * TRANSFORM REPRO: helper-owned JSX IIFE must account for local initializer dependencies
 *
 * The wrapper around this authored IIFE should capture the reactive roots that
 * feed local aliases declared inside the IIFE body. Capturing the inner locals
 * themselves (`tree`, `p`, `unsorted`, `items`) is wrong because they are not
 * in scope at the synthetic lift-applied call site.
 */
import { action, Default, pattern, UI, VNode, Writable, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Entry {
    id: string;
    name: string;
    type: "file" | "folder";
    children?: Entry[];
}
function findChildren(tree: Writable<Entry[]>, path: readonly string[]): readonly Entry[] {
    let current = tree.get();
    for (const name of path) {
        const folder = current.find((entry: Entry) => entry.name === name && entry.type === "folder");
        if (!folder || !folder.children)
            return [];
        current = folder.children;
    }
    return current;
}
__cfHardenFn(findChildren);
interface Input {
    entries: Writable<Default<Entry[], [
    ]>>;
}
interface Output {
    [UI]: VNode;
}
const __cfHandler_hfc59d3603eb4 = __cfHelpers.handler({
    type: "object",
    properties: {
        name: {
            type: "string"
        }
    },
    required: ["name"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        path: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: ["writeonly"]
        }
    },
    required: ["path"]
} as const satisfies __cfHelpers.JSONSchema, ({ name }, { path }) => {
    path.push(name);
});
const __cfLift_hfd50a862864e = __cfHelpers.lift<{
    path: __cfHelpers.Cell<string[]>;
}, readonly string[]>(({ path }) => path.get(), {
    type: "object",
    properties: {
        path: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: ["readonly"]
        }
    },
    required: ["path"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_he3cf86ab1f0d = __cfHelpers.lift<{
    tree: __cfHelpers.Cell<Entry[]>;
    p: readonly string[];
}, readonly Entry[]>(({ tree, p }) => findChildren(tree, p), {
    type: "object",
    properties: {
        tree: {
            type: "array",
            items: {
                $ref: "#/$defs/Entry"
            },
            asCell: ["readonly"]
        },
        p: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["tree", "p"],
    $defs: {
        Entry: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                name: {
                    type: "string"
                },
                type: {
                    "enum": ["file", "folder"]
                },
                children: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Entry"
                    }
                }
            },
            required: ["id", "name", "type"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        $ref: "#/$defs/Entry"
    },
    $defs: {
        Entry: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                name: {
                    type: "string"
                },
                type: {
                    "enum": ["file", "folder"]
                },
                children: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Entry"
                    }
                }
            },
            required: ["id", "name", "type"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h5e6bc47ef34d = __cfHelpers.lift<{
    unsorted: readonly Entry[];
}, Entry[]>(({ unsorted }) => [...unsorted].sort((a: Entry, b: Entry) => a.name.localeCompare(b.name)), {
    type: "object",
    properties: {
        unsorted: {
            type: "array",
            items: {
                $ref: "#/$defs/Entry"
            }
        }
    },
    required: ["unsorted"],
    $defs: {
        Entry: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                name: {
                    type: "string"
                },
                type: {
                    "enum": ["file", "folder"]
                },
                children: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Entry"
                    }
                }
            },
            required: ["id", "name", "type"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    $ref: "#/$defs/AnonymousType_1",
    $defs: {
        AnonymousType_1: {
            type: "array",
            items: {
                $ref: "#/$defs/Entry"
            }
        },
        Entry: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                name: {
                    type: "string"
                },
                type: {
                    "enum": ["file", "folder"]
                },
                children: {
                    $ref: "#/$defs/AnonymousType_1"
                }
            },
            required: ["id", "name", "type"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfHandler_h5e44d572cb85 = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        },
        pushPath: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"],
            asCell: ["stream"]
        }
    },
    required: ["item", "pushPath"]
} as const satisfies __cfHelpers.JSONSchema, (_, { pushPath, item }) => pushPath.send({ name: item.name }));
const __cfPattern_h181d19baff88 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    const pushPath = __cf_pattern_input.key("params", "pushPath");
    return (<button type="button" onClick={__cfHandler_h5e44d572cb85({
        pushPath: pushPath,
        item: {
            name: item.key("name")
        }
    })}>
                {item.key("name")}
              </button>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Entry"
        },
        params: {
            type: "object",
            properties: {
                pushPath: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        }
                    },
                    required: ["name"],
                    asCell: ["stream"]
                }
            },
            required: ["pushPath"]
        }
    },
    required: ["element", "params"],
    $defs: {
        Entry: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                name: {
                    type: "string"
                },
                type: {
                    "enum": ["file", "folder"]
                },
                children: {
                    $ref: "#/$defs/AnonymousType_1"
                }
            },
            required: ["id", "name", "type"]
        },
        AnonymousType_1: {
            type: "array",
            items: {
                $ref: "#/$defs/Entry"
            }
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
    const entries = __cf_pattern_input.key("entries");
    const path = new Writable<string[]>([], {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __cfHelpers.JSONSchema).for("path", true);
    const pushPath = __cfHandler_hfc59d3603eb4({
        path: path
    }).for({ stream: "pushPath" }, true);
    return {
        [UI]: (<div>
        {(() => {
                const tree = entries;
                const p = __cfHelpers.unless({
                    type: "array",
                    items: {
                        type: "string"
                    }
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "array",
                    items: false
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "array",
                    items: {
                        type: "string"
                    }
                } as const satisfies __cfHelpers.JSONSchema, __cfLift_hfd50a862864e({ path: path }).for(["p", 3], true), []).for("p", true);
                const unsorted = __cfLift_he3cf86ab1f0d({
                    tree: tree,
                    p: p
                }).for("unsorted", true);
                const items = __cfLift_h5e6bc47ef34d({ unsorted: unsorted }).for("items", true);
                return items.mapWithPattern(__cfPattern_h181d19baff88, {
                    pushPath: pushPath
                });
            })()}
      </div>)
    };
}, {
    type: "object",
    properties: {
        entries: {
            $ref: "#/$defs/AnonymousType_1",
            "default": [],
            asCell: ["cell"]
        }
    },
    required: ["entries"],
    $defs: {
        AnonymousType_1: {
            type: "array",
            items: {
                $ref: "#/$defs/Entry"
            }
        },
        Entry: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                name: {
                    type: "string"
                },
                type: {
                    "enum": ["file", "folder"]
                },
                children: {
                    $ref: "#/$defs/AnonymousType_1"
                }
            },
            required: ["id", "name", "type"]
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
    __cfHandler_hfc59d3603eb4,
    __cfLift_hfd50a862864e,
    __cfLift_he3cf86ab1f0d,
    __cfLift_h5e6bc47ef34d,
    __cfHandler_h5e44d572cb85,
    __cfPattern_h181d19baff88,
    __cfHandler_1: __cfHandler_hfc59d3603eb4,
    __cfLift_1: __cfLift_hfd50a862864e,
    __cfLift_2: __cfLift_he3cf86ab1f0d,
    __cfLift_3: __cfLift_h5e6bc47ef34d,
    __cfHandler_2: __cfHandler_h5e44d572cb85,
    __cfPattern_1: __cfPattern_h181d19baff88
});
