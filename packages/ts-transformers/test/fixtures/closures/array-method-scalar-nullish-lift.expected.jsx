function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Row {
    name?: string;
    active?: boolean;
    primary?: string[];
    fallback: number[];
}
const __cfLift_h2797c28b9ee8 = __cfHelpers.lift<{
    r: {
        name?: string | undefined;
    };
}, string>(({ r }) => r.name ?? "default", {
    type: "object",
    properties: {
        r: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            }
        }
    },
    required: ["r"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_h4fd82c3520eb = __cfHelpers.pattern(__cf_pattern_input => {
    const r = __cf_pattern_input.key("element");
    return __cfLift_h2797c28b9ee8({ r: {
            name: r.key("name")
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
                name: {
                    type: "string"
                },
                active: {
                    type: "boolean"
                },
                primary: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                },
                fallback: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                }
            },
            required: ["fallback"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_hd145b9cf9544 = __cfHelpers.lift<{
    r: {
        active?: boolean | undefined;
    };
}, boolean>(({ r }) => r.active ?? true, {
    type: "object",
    properties: {
        r: {
            type: "object",
            properties: {
                active: {
                    anyOf: [{
                            type: "undefined"
                        }, {
                            type: "boolean"
                        }]
                }
            }
        }
    },
    required: ["r"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_h25731035d0cc = __cfHelpers.pattern(__cf_pattern_input => {
    const r = __cf_pattern_input.key("element");
    return __cfLift_hd145b9cf9544({ r: {
            active: r.key("active")
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
                name: {
                    type: "string"
                },
                active: {
                    type: "boolean"
                },
                primary: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                },
                fallback: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                }
            },
            required: ["fallback"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_hf7edaa6532d0 = __cfHelpers.pattern(__cf_pattern_input => {
    const r = __cf_pattern_input.key("element");
    return <i>{r.key("name")}</i>;
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
                name: {
                    type: "string"
                },
                active: {
                    type: "boolean"
                },
                primary: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                },
                fallback: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                }
            },
            required: ["fallback"]
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
const __cfPattern_h6956235d0288 = __cfHelpers.pattern(__cf_pattern_input => {
    const r = __cf_pattern_input.key("element");
    return r.key("primary") ?? r.key("fallback");
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
                name: {
                    type: "string"
                },
                active: {
                    type: "boolean"
                },
                primary: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                },
                fallback: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                }
            },
            required: ["fallback"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    anyOf: [{
            type: "array",
            items: {
                type: "string"
            }
        }, {
            type: "array",
            items: {
                type: "number"
            }
        }]
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: array-method-scalar-nullish-lift
// Verifies (CT-1779): a SCALAR nullish-coalescing `??` with a reactive operand in the
// return / predicate position of a reactive map/filter/flatMap callback is value-lifted,
// so the `?? default` fallback runs on the RESOLVED value. Emitted raw, `v.name ?? "d"`
// collapses to the bare field projection — a Reactive proxy is never null and `??`
// can't be trapped — so the default is silently dropped (type-clean, no error).
//   - scalar string `??`        → mapWithPattern(pattern(... return lift(... r.name ?? "default")))
//   - scalar boolean `??` (pred) → filterWithPattern(pattern(... return lift(... r.active ?? true)))
// A COLLECTION-valued `??` must stay structural so the runtime *WithPattern flattens it.
// CT-1777 keyed the exclusion on operand provenance, which over-excluded scalar `??`;
// CT-1779 keys it on RESULT type. The homogeneous `i.tags ?? []` case is pinned by
// filter-flatmap-fallback-chain; here the heterogeneous `r.primary ?? r.fallback`
// (`string[] | number[]`, a union of array members a bare isArrayType misses) stays
// structural too.
export default pattern((__cf_pattern_input) => {
    const rows = __cf_pattern_input.key("rows");
    return {
        [UI]: (<div>
        {/* scalar string ??: lifted, so "default" is live */}
        <div>{rows.mapWithPattern(__cfPattern_h4fd82c3520eb, {})}</div>
        {/* scalar boolean ?? as a filter predicate: lifted */}
        <div>
          {rows.filterWithPattern(__cfPattern_h25731035d0cc, {}).mapWithPattern(__cfPattern_hf7edaa6532d0, {})}
        </div>
        {/* heterogeneous collection ?? (union of array types): stays structural */}
        <div>{rows.mapWithPattern(__cfPattern_h6956235d0288, {})}</div>
      </div>),
    };
}, {
    type: "object",
    properties: {
        rows: {
            type: "array",
            items: {
                $ref: "#/$defs/Row"
            }
        }
    },
    required: ["rows"],
    $defs: {
        Row: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                active: {
                    type: "boolean"
                },
                primary: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                },
                fallback: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                }
            },
            required: ["fallback"]
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
    __cfLift_h2797c28b9ee8,
    __cfPattern_h4fd82c3520eb,
    __cfLift_hd145b9cf9544,
    __cfPattern_h25731035d0cc,
    __cfPattern_hf7edaa6532d0,
    __cfPattern_h6956235d0288,
    __cfLift_1: __cfLift_h2797c28b9ee8,
    __cfPattern_1: __cfPattern_h4fd82c3520eb,
    __cfLift_2: __cfLift_hd145b9cf9544,
    __cfPattern_2: __cfPattern_h25731035d0cc,
    __cfPattern_3: __cfPattern_hf7edaa6532d0,
    __cfPattern_4: __cfPattern_h6956235d0288
});
