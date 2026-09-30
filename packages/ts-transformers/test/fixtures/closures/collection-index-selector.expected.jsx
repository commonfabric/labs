function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, pattern, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: collection-index-selector
// Verifies: groupBy/keyBy preserve Cell identity and evaluate conditional keys
//   inside one computation before tagging their primitive or Cell key kind.
// Context: A block selector omits empty labels; identity keys share their text.
interface Row {
    label: string;
    owner: Cell<string>;
    useOwner: boolean;
}
const __cfLift_1 = __cfHelpers.lift<{
    row: {
        useOwner: boolean;
        owner: __cfHelpers.Cell<string>;
        label: string;
    };
}, {
    isCell: boolean;
    value: string | __cfHelpers.Cell<string>;
}>(({ row }) => __cfHelpers.tagCollectionKey(row.useOwner ? row.owner : row.label), {
    type: "object",
    properties: {
        row: {
            type: "object",
            properties: {
                useOwner: {
                    type: "boolean"
                },
                owner: {
                    type: "string",
                    asCell: ["readonly"]
                },
                label: {
                    type: "string"
                }
            },
            required: ["useOwner", "owner", "label"]
        }
    },
    required: ["row"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        isCell: {
            type: "boolean"
        },
        value: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "string",
                    asCell: ["cell"]
                }]
        }
    },
    required: ["isCell", "value"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const row = __cf_pattern_input.key("element");
    return __cfLift_1({ row: {
            useOwner: row.key("useOwner"),
            owner: row.key("owner"),
            label: row.key("label")
        } }).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Row"
        }
    },
    required: ["element"],
    $defs: {
        Row: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                },
                owner: {
                    type: "string",
                    asCell: ["cell"]
                },
                useOwner: {
                    type: "boolean"
                }
            },
            required: ["label", "owner", "useOwner"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        isCell: {
            type: "boolean"
        },
        value: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "string",
                    asCell: ["cell"]
                }]
        }
    },
    required: ["isCell", "value"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    row: {
        label: string;
    };
}, {
    isCell: boolean;
    value: string | undefined;
}>(({ row }) => __cfHelpers.tagCollectionKey(row.label !== "" ? row.label : undefined), {
    type: "object",
    properties: {
        row: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                }
            },
            required: ["label"]
        }
    },
    required: ["row"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        isCell: {
            type: "boolean"
        },
        value: {
            type: ["string", "undefined"]
        }
    },
    required: ["isCell", "value"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_2 = __cfHelpers.pattern(__cf_pattern_input => {
    const row = __cf_pattern_input.key("element");
    return __cfLift_2({ row: {
            label: row.key("label")
        } }).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Row"
        }
    },
    required: ["element"],
    $defs: {
        Row: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                },
                owner: {
                    type: "string",
                    asCell: ["cell"]
                },
                useOwner: {
                    type: "boolean"
                }
            },
            required: ["label", "owner", "useOwner"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        isCell: {
            type: "boolean"
        },
        value: {
            type: ["string", "undefined"]
        }
    },
    required: ["isCell", "value"]
} as const satisfies __cfHelpers.JSONSchema);
export default pattern((__cf_pattern_input) => {
    const rows = __cf_pattern_input.key("rows");
    const groups = rows.groupByWithPattern(__cfPattern_1, {}).for("groups", true);
    const unique = rows.keyByWithPattern(__cfPattern_2, {}).for("unique", true);
    return { groups: groups.for(["__patternResult", "groups"], true), unique: unique.for(["__patternResult", "unique"], true) };
}, {
    type: "object",
    properties: {
        rows: {
            type: "array",
            items: {
                $ref: "#/$defs/Row"
            },
            asCell: ["cell"]
        }
    },
    required: ["rows"],
    $defs: {
        Row: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                },
                owner: {
                    type: "string",
                    asCell: ["cell"]
                },
                useOwner: {
                    type: "boolean"
                }
            },
            required: ["label", "owner", "useOwner"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        groups: {
            type: "object",
            properties: {
                kind: {
                    type: "string",
                    "enum": ["collection-index"]
                },
                mode: {
                    type: "string",
                    "enum": ["group"]
                },
                keys: {
                    type: "array",
                    items: {
                        anyOf: [{
                                type: "string"
                            }, {
                                type: "string",
                                asCell: ["cell"]
                            }]
                    }
                },
                keyEntries: {
                    type: "array",
                    items: {
                        anyOf: [{
                                type: "object",
                                properties: {
                                    kind: {
                                        type: "string",
                                        "enum": ["value"]
                                    },
                                    value: {
                                        type: "string"
                                    }
                                },
                                required: ["kind", "value"]
                            }, {
                                type: "object",
                                properties: {
                                    kind: {
                                        type: "string",
                                        "enum": ["cell"]
                                    },
                                    cell: {
                                        type: "string",
                                        asCell: ["cell"]
                                    }
                                },
                                required: ["kind", "cell"]
                            }]
                    }
                },
                buckets: {
                    type: "object",
                    properties: {},
                    additionalProperties: {
                        type: "array",
                        items: {
                            $ref: "#/$defs/Row"
                        }
                    }
                }
            },
            required: ["kind", "mode", "keys", "keyEntries", "buckets"],
            asCell: ["readonly"]
        },
        unique: {
            type: "object",
            properties: {
                kind: {
                    type: "string",
                    "enum": ["collection-index"]
                },
                mode: {
                    type: "string",
                    "enum": ["key"]
                },
                keys: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                },
                keyEntries: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            kind: {
                                type: "string",
                                "enum": ["value"]
                            },
                            value: {
                                type: "string"
                            }
                        },
                        required: ["kind", "value"]
                    }
                },
                buckets: {
                    type: "object",
                    properties: {},
                    additionalProperties: {
                        anyOf: [{
                                type: "undefined"
                            }, {
                                $ref: "#/$defs/Row"
                            }]
                    }
                }
            },
            required: ["kind", "mode", "keys", "keyEntries", "buckets"],
            asCell: ["readonly"]
        }
    },
    required: ["groups", "unique"],
    $defs: {
        Row: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                },
                owner: {
                    type: "string",
                    asCell: ["cell"]
                },
                useOwner: {
                    type: "boolean"
                }
            },
            required: ["label", "owner", "useOwner"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfPattern_1,
    __cfLift_2,
    __cfPattern_2
});
