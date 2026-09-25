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
interface Row {
    sentAt: number;
    body: string;
}
const __cfLift_h6e3cc74f1dd3 = __cfHelpers.lift<{
    rows: __cfHelpers.Writable<Row[]>;
}, number>(({ rows }) => rows.get().length, {
    type: "object",
    properties: {
        rows: {
            type: "array",
            items: {
                type: "unknown"
            },
            asCell: ["readonly"]
        }
    },
    required: ["rows"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h6e93f541fe6d = __cfHelpers.lift<{
    rows: __cfHelpers.Writable<Row[]>;
}, readonly Row[]>(({ rows }) => rows.get(), {
    type: "object",
    properties: {
        rows: {
            type: "array",
            items: {
                $ref: "#/$defs/Row"
            },
            asCell: ["readonly"]
        }
    },
    required: ["rows"],
    $defs: {
        Row: {
            type: "object",
            properties: {
                sentAt: {
                    type: "number"
                },
                body: {
                    type: "string"
                }
            },
            required: ["sentAt", "body"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        $ref: "#/$defs/Row"
    },
    $defs: {
        Row: {
            type: "object",
            properties: {
                sentAt: {
                    type: "number"
                },
                body: {
                    type: "string"
                }
            },
            required: ["sentAt", "body"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_hb4c16d0a1435 = __cfHelpers.lift<{
    rows: __cfHelpers.Writable<Row[]>;
}, Row | undefined>(({ rows }) => rows.get()[0], {
    type: "object",
    properties: {
        rows: {
            type: "array",
            items: {
                $ref: "#/$defs/Row"
            },
            asCell: ["readonly"]
        }
    },
    required: ["rows"],
    $defs: {
        Row: {
            type: "object",
            properties: {
                sentAt: {
                    type: "number"
                },
                body: {
                    type: "string"
                }
            },
            required: ["sentAt", "body"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    anyOf: [{
            type: "undefined"
        }, {
            $ref: "#/$defs/Row"
        }],
    $defs: {
        Row: {
            type: "object",
            properties: {
                sentAt: {
                    type: "number"
                },
                body: {
                    type: "string"
                }
            },
            required: ["sentAt", "body"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h982e956d5205 = __cfHelpers.lift<{
    rows: __cfHelpers.Writable<Row[]>;
}, string>(({ rows }) => rows.get().join(","), {
    type: "object",
    properties: {
        rows: {
            type: "array",
            items: {
                $ref: "#/$defs/Row"
            },
            asCell: ["readonly"]
        }
    },
    required: ["rows"],
    $defs: {
        Row: {
            type: "object",
            properties: {
                sentAt: {
                    type: "number"
                },
                body: {
                    type: "string"
                }
            },
            required: ["sentAt", "body"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h6e93f541fe6d_2 = __cfHelpers.lift<{
    rows: __cfHelpers.Writable<Row[]>;
}, readonly Row[]>(({ rows }) => rows.get(), {
    type: "object",
    properties: {
        rows: {
            type: "array",
            items: {
                $ref: "#/$defs/Row"
            },
            asCell: ["readonly"]
        }
    },
    required: ["rows"],
    $defs: {
        Row: {
            type: "object",
            properties: {
                sentAt: {
                    type: "number"
                },
                body: {
                    type: "string"
                }
            },
            required: ["sentAt", "body"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        $ref: "#/$defs/Row"
    },
    $defs: {
        Row: {
            type: "object",
            properties: {
                sentAt: {
                    type: "number"
                },
                body: {
                    type: "string"
                }
            },
            required: ["sentAt", "body"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h994a3cd6b58c = __cfHelpers.lift<{
    row: {
        sentAt: number;
    };
}, boolean>(({ row }) => row.sentAt > 0, {
    type: "object",
    properties: {
        row: {
            type: "object",
            properties: {
                sentAt: {
                    type: "number"
                }
            },
            required: ["sentAt"]
        }
    },
    required: ["row"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_hcf51934bbcbe = __cfHelpers.pattern(__cf_pattern_input => {
    const row = __cf_pattern_input.key("element");
    return __cfLift_h994a3cd6b58c({ row: {
            sentAt: row.key("sentAt")
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
                sentAt: {
                    type: "number"
                },
                body: {
                    type: "string"
                }
            },
            required: ["sentAt", "body"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_hd457b85824ad = __cfHelpers.lift<{
    label?: __cfHelpers.Writable<string> | undefined;
}, string | undefined>(({ label }) => label?.get(), {
    type: "object",
    properties: {
        label: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "undefined"
                }],
            asCell: ["readonly"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["string", "undefined"]
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: cell-get-terminal-binding-autowrap
// Verifies: a cell read at a variable-initializer binding is auto-wrapped into a
//   lift whether or not a computation sits on top of it — a bare `rows.get()`,
//   an element access, a value-returning method call, and an array method taking
//   a callback all lower the same way. Each lift's input schema shrinks to what
//   its body actually reads: `.length` needs no element shape and gets
//   `items: { type: "unknown" }`, while the reads that hand the elements onward
//   carry the full `Row`.
// Context: `.filter` over the read array lowers through `filterWithPattern`, so
//   the element schema of its own lift shrinks to the `sentAt` the callback
//   reads. `label` pins the optional spelling: optionality rides through the
//   lift rather than blocking the site, so the input schema carries `label` as
//   an unrequired `anyOf` and the result widens to include `undefined`.
export default pattern((__cf_pattern_input) => {
    const rows = __cf_pattern_input.key("rows");
    const label = __cf_pattern_input.key("label");
    const count = __cfLift_h6e3cc74f1dd3({ rows: rows }).for("count", true);
    const all = __cfLift_h6e93f541fe6d({ rows: rows }).for("all", true);
    const first = __cfLift_hb4c16d0a1435({ rows: rows }).for("first", true);
    const joined = __cfLift_h982e956d5205({ rows: rows }).for("joined", true);
    const recent = __cfLift_h6e93f541fe6d_2({ rows: rows }).filterWithPattern(__cfPattern_hcf51934bbcbe, {}).for("recent", true);
    const optional = __cfLift_hd457b85824ad({ label: label }).for("optional", true);
    return { count, all, first, joined, recent, optional };
}, {
    type: "object",
    properties: {
        rows: {
            type: "array",
            items: {
                $ref: "#/$defs/Row"
            },
            asCell: ["cell"]
        },
        label: {
            type: "string",
            asCell: ["cell"]
        }
    },
    required: ["rows"],
    $defs: {
        Row: {
            type: "object",
            properties: {
                sentAt: {
                    type: "number"
                },
                body: {
                    type: "string"
                }
            },
            required: ["sentAt", "body"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        count: {
            type: "number"
        },
        all: {
            type: "array",
            items: {
                $ref: "#/$defs/Row"
            }
        },
        first: {
            anyOf: [{
                    type: "undefined"
                }, {
                    $ref: "#/$defs/Row"
                }]
        },
        joined: {
            type: "string"
        },
        recent: {
            type: "array",
            items: {
                $ref: "#/$defs/Row"
            }
        },
        optional: {
            type: ["string", "undefined"]
        }
    },
    required: ["count", "all", "first", "joined", "recent", "optional"],
    $defs: {
        Row: {
            type: "object",
            properties: {
                sentAt: {
                    type: "number"
                },
                body: {
                    type: "string"
                }
            },
            required: ["sentAt", "body"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_h6e3cc74f1dd3,
    __cfLift_h6e93f541fe6d,
    __cfLift_hb4c16d0a1435,
    __cfLift_h982e956d5205,
    __cfLift_h6e93f541fe6d_2,
    __cfLift_h994a3cd6b58c,
    __cfPattern_hcf51934bbcbe,
    __cfLift_hd457b85824ad,
    __cfLift_1: __cfLift_h6e3cc74f1dd3,
    __cfLift_2: __cfLift_h6e93f541fe6d,
    __cfLift_3: __cfLift_hb4c16d0a1435,
    __cfLift_4: __cfLift_h982e956d5205,
    __cfLift_5: __cfLift_h6e93f541fe6d_2,
    __cfLift_6: __cfLift_h994a3cd6b58c,
    __cfPattern_1: __cfPattern_hcf51934bbcbe,
    __cfLift_7: __cfLift_hd457b85824ad
});
