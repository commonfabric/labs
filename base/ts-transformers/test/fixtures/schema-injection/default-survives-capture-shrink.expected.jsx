function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, type Default, type Default as RenamedDefault, pattern, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: default-survives-capture-shrink
// Verifies: Default<…> annotations on properties survive capture shrinking
// as alias references, so the injected capture schemas keep their
// `"default"` values. When the shrunken type node expands the alias
// structurally (`boolean | (false & { [DEFAULT_MARKER]: false })`), the
// schema generator no longer recognizes the spelling and silently drops
// the default — and literal default values can widen away entirely
// (`Default<string, "">` → `{ [DEFAULT_MARKER]: string }`).
interface Item {
    done: boolean | Default<false>;
    label: Default<string, "">;
    // Renamed import: detection is symbol-verified, not name-gated.
    rank: RenamedDefault<number, 7>;
}
// GENERIC reference: a capture through `Tagged<number>[]` can never be
// projected node-driven (recovering the declared type of a generic by
// symbol would leak unsubstituted type parameters) and no authored-AST
// recovery can serve it. The `"default"` survives because the
// DEFAULT_MARKER brand payload carries V through instantiation and the
// schema generator reads it back from the expanded type.
interface Tagged<T> {
    value: T;
    note: Default<string, "n/a">;
}
interface Input {
    items: Item[];
    boxes: Tagged<number>[];
}
const __cfLift_1 = __cfHelpers.lift<{
    items: {
        done: boolean | Default<false>;
    }[];
}, boolean>(({ items }) => items[0]?.done === true, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    done: {
                        type: "boolean",
                        "default": false
                    }
                },
                required: ["done"]
            }
        }
    },
    required: ["items"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift<{
    items: {
        label: Default<string, "">;
    }[];
}, boolean>(({ items }) => items[0]?.label === "", {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    label: {
                        type: "string",
                        "default": ""
                    }
                },
                required: ["label"]
            }
        }
    },
    required: ["items"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_3 = __cfHelpers.lift<{
    items: {
        rank: number | (number & { readonly [DEFAULT_MARKER]: 7; });
    }[];
}, boolean>(({ items }) => items[0]?.rank === 7, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    rank: {
                        type: "number",
                        "default": 7
                    }
                },
                required: ["rank"]
            }
        }
    },
    required: ["items"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_4 = __cfHelpers.lift<{
    boxes: {
        note: string | (string & { readonly [DEFAULT_MARKER]: "n/a"; });
    }[];
}, boolean>(({ boxes }) => boxes[0]?.note === "n/a", {
    type: "object",
    properties: {
        boxes: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    note: {
                        type: "string",
                        "default": "n/a"
                    }
                },
                required: ["note"]
            }
        }
    },
    required: ["boxes"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
export default pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    const boxes = __cf_pattern_input.key("boxes");
    const firstDone = __cfLift_1({ items: items }).for("firstDone", true);
    const firstLabelEmpty = __cfLift_2({ items: items }).for("firstLabelEmpty", true);
    const firstRank = __cfLift_3({ items: items }).for("firstRank", true);
    const firstBoxNote = __cfLift_4({ boxes: boxes }).for("firstBoxNote", true);
    return { firstDone, firstLabelEmpty, firstRank, firstBoxNote };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        },
        boxes: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    value: {
                        type: "number"
                    },
                    note: {
                        type: "string",
                        "default": "n/a"
                    }
                },
                required: ["value", "note"]
            }
        }
    },
    required: ["items", "boxes"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                done: {
                    type: "boolean",
                    "default": false
                },
                label: {
                    type: "string",
                    "default": ""
                },
                rank: {
                    type: "number",
                    "default": 7
                }
            },
            required: ["done", "label", "rank"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        firstDone: {
            type: "boolean"
        },
        firstLabelEmpty: {
            type: "boolean"
        },
        firstRank: {
            type: "boolean"
        },
        firstBoxNote: {
            type: "boolean"
        }
    },
    required: ["firstDone", "firstLabelEmpty", "firstRank", "firstBoxNote"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2,
    __cfLift_3,
    __cfLift_4
});
