function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, computed, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Item {
    name: string;
    done: Cell<boolean>;
}
interface Assignment {
    aisle: string;
    item: Item;
}
const __cfLift_1 = __cfHelpers.lift<{
    items: Item[];
}, { aisle: string; item: Item; }[]>(({ items }) => items.map((item, idx) => ({
    aisle: `Aisle ${(idx % 3) + 1}`,
    item: item,
})), {
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
                name: {
                    type: "string"
                },
                done: {
                    type: "boolean",
                    asCell: ["cell"]
                }
            },
            required: ["name", "done"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "object",
        properties: {
            aisle: {
                type: "string"
            },
            item: {
                $ref: "#/$defs/Item"
            }
        },
        required: ["aisle", "item"]
    },
    $defs: {
        Item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                done: {
                    type: "boolean",
                    asCell: ["cell"]
                }
            },
            required: ["name", "done"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift<{
    itemsWithAisles: { aisle: string; item: Item; }[];
}, Record<string, Assignment[]>>(({ itemsWithAisles }) => {
    const groups: Record<string, Assignment[]> = {};
    for (const assignment of itemsWithAisles) {
        if (!groups[assignment.aisle]) {
            groups[assignment.aisle] = [];
        }
        groups[assignment.aisle]!.push(assignment);
    }
    return groups;
}, {
    type: "object",
    properties: {
        itemsWithAisles: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    aisle: {
                        type: "string"
                    },
                    item: {
                        $ref: "#/$defs/Item"
                    }
                },
                required: ["aisle", "item"]
            }
        }
    },
    required: ["itemsWithAisles"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                done: {
                    type: "boolean",
                    asCell: ["cell"]
                }
            },
            required: ["name", "done"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {},
    additionalProperties: {
        type: "array",
        items: {
            $ref: "#/$defs/Assignment"
        }
    },
    $defs: {
        Assignment: {
            type: "object",
            properties: {
                aisle: {
                    type: "string"
                },
                item: {
                    $ref: "#/$defs/Item"
                }
            },
            required: ["aisle", "item"]
        },
        Item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                done: {
                    type: "boolean",
                    asCell: ["cell"]
                }
            },
            required: ["name", "done"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_3 = __cfHelpers.lift<{
    groupedByAisle: Record<string, Assignment[]>;
}, string[]>(({ groupedByAisle }) => Object.keys(groupedByAisle).sort(), {
    type: "object",
    properties: {
        groupedByAisle: {
            type: "object",
            properties: {},
            additionalProperties: {
                type: "array",
                items: {
                    $ref: "#/$defs/Assignment"
                }
            }
        }
    },
    required: ["groupedByAisle"],
    $defs: {
        Assignment: {
            type: "object",
            properties: {
                aisle: {
                    type: "string"
                },
                item: {
                    $ref: "#/$defs/Item"
                }
            },
            required: ["aisle", "item"]
        },
        Item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                done: {
                    type: "boolean",
                    asCell: ["cell"]
                }
            },
            required: ["name", "done"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_4 = __cfHelpers.lift<{
    groupedByAisle: Record<string, Assignment[]>;
    aisleName: string;
}, Assignment[] | undefined>(({ groupedByAisle, aisleName }) => groupedByAisle[aisleName], {
    type: "object",
    properties: {
        groupedByAisle: {
            type: "object",
            properties: {},
            additionalProperties: {
                type: "array",
                items: {
                    $ref: "#/$defs/Assignment"
                }
            }
        },
        aisleName: {
            type: "string"
        }
    },
    required: ["groupedByAisle", "aisleName"],
    $defs: {
        Assignment: {
            type: "object",
            properties: {
                aisle: {
                    type: "string"
                },
                item: {
                    $ref: "#/$defs/Item"
                }
            },
            required: ["aisle", "item"]
        },
        Item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                done: {
                    type: "boolean",
                    asCell: ["cell"]
                }
            },
            required: ["name", "done"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    anyOf: [{
            type: "undefined"
        }, {
            type: "array",
            items: {
                $ref: "#/$defs/Assignment"
            }
        }],
    $defs: {
        Assignment: {
            type: "object",
            properties: {
                aisle: {
                    type: "string"
                },
                item: {
                    $ref: "#/$defs/Item"
                }
            },
            required: ["aisle", "item"]
        },
        Item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                done: {
                    type: "boolean",
                    asCell: ["cell"]
                }
            },
            required: ["name", "done"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const assignment = __cf_pattern_input.key("element");
    return (<div>
                  <span>{assignment.key("item", "name")}</span>
                  <cf-checkbox $checked={assignment.key("item", "done")}/>
                </div>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Assignment"
        }
    },
    required: ["element"],
    $defs: {
        Assignment: {
            type: "object",
            properties: {
                aisle: {
                    type: "string"
                },
                item: {
                    $ref: "#/$defs/Item"
                }
            },
            required: ["aisle", "item"]
        },
        Item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                done: {
                    type: "boolean",
                    asCell: ["cell"]
                }
            },
            required: ["name", "done"]
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
    const aisleName = __cf_pattern_input.key("element");
    const groupedByAisle = __cf_pattern_input.key("params", "groupedByAisle");
    return (<div>
              <h3>{aisleName}</h3>
              {__cfLift_4({
            groupedByAisle: groupedByAisle,
            aisleName: aisleName
        })!.mapWithPattern(__cfPattern_1, {})}
            </div>);
}, {
    type: "object",
    properties: {
        element: {
            type: "string"
        },
        params: {
            type: "object",
            properties: {
                groupedByAisle: {
                    type: "object",
                    properties: {},
                    additionalProperties: {
                        type: "array",
                        items: {
                            $ref: "#/$defs/Assignment"
                        }
                    }
                }
            },
            required: ["groupedByAisle"]
        }
    },
    required: ["element", "params"],
    $defs: {
        Assignment: {
            type: "object",
            properties: {
                aisle: {
                    type: "string"
                },
                item: {
                    $ref: "#/$defs/Item"
                }
            },
            required: ["aisle", "item"]
        },
        Item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                done: {
                    type: "boolean",
                    asCell: ["cell"]
                }
            },
            required: ["name", "done"]
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
// CT-1036: Property access on derived grouped objects with derived keys
// This pattern groups items by a property, then maps over the group keys
// and accesses the grouped object with each key.
// FIXTURE: derived-property-access-with-derived-key
// Verifies: .map() chains with derived keys and element access are fully transformed
//   aisleNames.map(...)            → aisleNames.mapWithPattern(pattern(...), {captures})
//   groupedByAisle[aisleName].map  → lift over {groupedByAisle, aisleName} then .mapWithPattern(...)
// Context: CT-1036 -- nested map with derived object indexed by derived key, two levels deep
export default pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    // Create assignments with aisle data (whole-array map kept inside computed)
    const itemsWithAisles = __cfLift_1({ items: items }).for("itemsWithAisles", true);
    // Group by aisle - returns Record<string, Assignment[]>
    const groupedByAisle = __cfLift_2({ itemsWithAisles: itemsWithAisles }).for("groupedByAisle", true);
    // Derive sorted aisle names from grouped object
    const aisleNames = __cfLift_3({ groupedByAisle: groupedByAisle }).for("aisleNames", true);
    // The pattern from CT-1036:
    // - Map over derived keys (aisleNames)
    // - Access derived object with derived key (groupedByAisle[aisleName])
    // - Map over the result
    return {
        [UI]: (<div>
          {aisleNames.mapWithPattern(__cfPattern_2, {
                groupedByAisle: groupedByAisle
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
        }
    },
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                done: {
                    type: "boolean",
                    asCell: ["cell"]
                }
            },
            required: ["name", "done"]
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
    __cfLift_3,
    __cfLift_4,
    __cfPattern_1,
    __cfPattern_2
});
