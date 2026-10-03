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
 * TRANSFORM REPRO: helper-owned JSX IIFE with defaulted array input, local
 * initializer chain, and final map callback captures.
 *
 * The final callback array method should lower to mapWithPattern, but the
 * IIFE itself should stay decomposed rather than being blanket-wrapped.
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
    contentType?: string;
}
function findChildren(tree: readonly Entry[], path: readonly string[]): readonly Entry[] {
    let current: readonly Entry[] = tree;
    for (const name of Array.isArray(path) ? path : []) {
        const folder = current.find((entry: Entry) => entry.name === name && entry.type === "folder");
        if (!folder || !folder.children)
            return [];
        current = folder.children;
    }
    return current;
}
__cfHardenFn(findChildren);
interface Input {
    entries: Default<Entry[], [
    ]>;
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
const __cfHandler_hb1fea7adc27a = __cfHelpers.handler({
    type: "object",
    properties: {
        item: {
            $ref: "#/$defs/Entry"
        }
    },
    required: ["item"],
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
                },
                contentType: {
                    type: "string"
                }
            },
            required: ["id", "name", "type"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {}
} as const satisfies __cfHelpers.JSONSchema, ({ item }, __cf_action_params) => {
    void item;
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
const __cfLift_h98ff9fc03d40 = __cfHelpers.lift<{
    unsorted: Entry[];
}, Entry[]>(({ unsorted }) => [...unsorted].sort((a: Entry, b: Entry) => {
    if (a.type === b.type)
        return 0;
    return a.type === "file" ? -1 : 1;
}), {
    type: "object",
    properties: {
        unsorted: {
            $ref: "#/$defs/AnonymousType_1"
        }
    },
    required: ["unsorted"],
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
                },
                contentType: {
                    type: "string"
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
                },
                contentType: {
                    type: "string"
                }
            },
            required: ["id", "name", "type"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfHandler_hb75a3a162723 = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
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
        handleNavigateInto: {
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
    required: ["item", "handleNavigateInto"]
} as const satisfies __cfHelpers.JSONSchema, (_, { handleNavigateInto, item }) => handleNavigateInto.send({
    name: item.name,
}));
const __cfHandler_h1e2796f330fe = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        item: {
            $ref: "#/$defs/Entry"
        },
        handleOpenFile: {
            type: "object",
            properties: {
                item: {
                    $ref: "#/$defs/Entry"
                }
            },
            required: ["item"],
            asCell: ["stream"]
        }
    },
    required: ["item", "handleOpenFile"],
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
                },
                contentType: {
                    type: "string"
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
} as const satisfies __cfHelpers.JSONSchema, (_, { handleOpenFile, item }) => handleOpenFile.send({ item }));
const __cfPattern_h40871c06266f = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    const handleNavigateInto = __cf_pattern_input.key("params", "handleNavigateInto");
    const handleOpenFile = __cf_pattern_input.key("params", "handleOpenFile");
    const isFolder = item.key("type") === "folder";
    const isOpenable = __cfHelpers.when({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, !isFolder &&
        !!item.key("contentType"), item.key("contentType") !== "binary").for("isOpenable", true);
    return (<button type="button" onClick={isFolder
            ? __cfHandler_hb75a3a162723({
                handleNavigateInto: handleNavigateInto,
                item: {
                    name: item.key("name")
                }
            }) : isOpenable
            ? __cfHandler_h1e2796f330fe({
                handleOpenFile: handleOpenFile,
                item: item
            }) : undefined}>
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
                handleNavigateInto: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        }
                    },
                    required: ["name"],
                    asCell: ["stream"]
                },
                handleOpenFile: {
                    type: "object",
                    properties: {
                        item: {
                            $ref: "#/$defs/Entry"
                        }
                    },
                    required: ["item"],
                    asCell: ["stream"]
                }
            },
            required: ["handleNavigateInto", "handleOpenFile"]
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
                },
                contentType: {
                    type: "string"
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
    const handleNavigateInto = __cfHandler_hfc59d3603eb4({
        path: path
    }).for({ stream: "handleNavigateInto" }, true);
    const handleOpenFile = __cfHandler_hb1fea7adc27a({}).for({ stream: "handleOpenFile" }, true);
    return {
        [UI]: (<div>
        {(() => {
                const tree = (__cfHelpers.unless({
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
                                },
                                contentType: {
                                    type: "string"
                                }
                            },
                            required: ["id", "name", "type"]
                        }
                    }
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "array",
                    items: false
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
                                },
                                contentType: {
                                    type: "string"
                                }
                            },
                            required: ["id", "name", "type"]
                        }
                    }
                } as const satisfies __cfHelpers.JSONSchema, entries, [])).for("tree", true) as Entry[];
                const p = (__cfHelpers.unless({
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
                } as const satisfies __cfHelpers.JSONSchema, __cfLift_hfd50a862864e({ path: path }), [])).for("p", true) as string[];
                const unsorted = findChildren(tree, p) as Entry[];
                const items = __cfLift_h98ff9fc03d40({ unsorted: unsorted }).for("items", true);
                return items.mapWithPattern(__cfPattern_h40871c06266f, {
                    handleNavigateInto: handleNavigateInto,
                    handleOpenFile: handleOpenFile
                });
            })()}
      </div>)
    };
}, {
    type: "object",
    properties: {
        entries: {
            $ref: "#/$defs/AnonymousType_1",
            "default": []
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
                },
                contentType: {
                    type: "string"
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
    __cfHandler_hb1fea7adc27a,
    __cfLift_hfd50a862864e,
    __cfLift_h98ff9fc03d40,
    __cfHandler_hb75a3a162723,
    __cfHandler_h1e2796f330fe,
    __cfPattern_h40871c06266f,
    __cfHandler_1: __cfHandler_hfc59d3603eb4,
    __cfHandler_2: __cfHandler_hb1fea7adc27a,
    __cfLift_1: __cfLift_hfd50a862864e,
    __cfLift_2: __cfLift_h98ff9fc03d40,
    __cfHandler_3: __cfHandler_hb75a3a162723,
    __cfHandler_4: __cfHandler_h1e2796f330fe,
    __cfPattern_1: __cfPattern_h40871c06266f
});
