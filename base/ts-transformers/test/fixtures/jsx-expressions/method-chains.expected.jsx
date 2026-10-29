function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    text: string;
    searchTerm: string;
    items: number[];
    start: number;
    end: number;
    threshold: number;
    factor: number;
    names: string[];
    prefix: string;
    prices: number[];
    discount: number;
    taxRate: number;
    users: Array<{
        name: string;
        age: number;
        active: boolean;
    }>;
    minAge: number;
    words: string[];
    separator: string;
}
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        text: string;
    };
}, string>(({ state }) => state.text.trim().toLowerCase(), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                text: {
                    type: "string"
                }
            },
            required: ["text"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    state: {
        text: string;
        searchTerm: string;
    };
}, boolean>(({ state }) => state.text.toLowerCase().includes(state.searchTerm.toLowerCase()), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                text: {
                    type: "string"
                },
                searchTerm: {
                    type: "string"
                }
            },
            required: ["text", "searchTerm"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_3 = __cfHelpers.lift<{
    state: {
        text: string;
    };
}, string>(({ state }) => state.text.trim().toLowerCase().replace("old", "new").toUpperCase(), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                text: {
                    type: "string"
                }
            },
            required: ["text"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_4 = __cfHelpers.lift<{
    state: {
        items: number[];
        threshold: number;
    };
}, number>(({ state }) => state.items.filter((x) => x > state.threshold).length, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                },
                threshold: {
                    type: "number"
                }
            },
            required: ["items", "threshold"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_5 = __cfHelpers.lift<{
    x: number;
    state: {
        threshold: number;
    };
}, boolean>(({ x, state }) => x > state.threshold, {
    type: "object",
    properties: {
        x: {
            type: "number"
        },
        state: {
            type: "object",
            properties: {
                threshold: {
                    type: "number"
                }
            },
            required: ["threshold"]
        }
    },
    required: ["x", "state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const x = __cf_pattern_input.key("element");
    const state = __cf_pattern_input.key("params", "state");
    return __cfLift_5({
        x: x,
        state: {
            threshold: state.key("threshold")
        }
    }).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        element: {
            type: "number"
        },
        params: {
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        threshold: {
                            type: "number"
                        }
                    },
                    required: ["threshold"]
                }
            },
            required: ["state"]
        }
    },
    required: ["element", "params"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_6 = __cfHelpers.lift<{
    x: number;
    state: {
        factor: number;
    };
}, number>(({ x, state }) => x * state.factor, {
    type: "object",
    properties: {
        x: {
            type: "number"
        },
        state: {
            type: "object",
            properties: {
                factor: {
                    type: "number"
                }
            },
            required: ["factor"]
        }
    },
    required: ["x", "state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_2 = __cfHelpers.pattern(__cf_pattern_input => {
    const x = __cf_pattern_input.key("element");
    const state = __cf_pattern_input.key("params", "state");
    return (<li>Value: {__cfLift_6({
        x: x,
        state: {
            factor: state.key("factor")
        }
    })}</li>);
}, {
    type: "object",
    properties: {
        element: {
            type: "number"
        },
        params: {
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        factor: {
                            type: "number"
                        }
                    },
                    required: ["factor"]
                }
            },
            required: ["state"]
        }
    },
    required: ["element", "params"]
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
const __cfLift_7 = __cfHelpers.lift<{
    state: {
        items: number[];
        start: number;
        end: number;
    };
}, number>(({ state }) => state.items.filter((x) => x > state.start).filter((x) => x < state.end).length, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                },
                end: {
                    type: "number"
                },
                start: {
                    type: "number"
                }
            },
            required: ["items", "end", "start"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_8 = __cfHelpers.lift<{
    state: {
        items: number[];
        start: number;
        end: number;
    };
}, string>(({ state }) => state.items.slice(state.start, state.end).join(", "), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                },
                start: {
                    type: "number"
                },
                end: {
                    type: "number"
                }
            },
            required: ["items", "start", "end"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_9 = __cfHelpers.lift<{
    state: {
        names: string[];
        prefix: string;
    };
}, string>(({ state }) => state.names.filter((n) => n.startsWith(state.prefix)).join(", "), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                names: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                },
                prefix: {
                    type: "string"
                }
            },
            required: ["names", "prefix"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_10 = __cfHelpers.lift<{
    state: {
        names: string[];
        searchTerm: string;
    };
}, string | undefined>(({ state }) => state.names.find((n) => n.includes(state.searchTerm)), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                names: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                },
                searchTerm: {
                    type: "string"
                }
            },
            required: ["names", "searchTerm"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["string", "undefined"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_11 = __cfHelpers.lift<{
    name: string;
}, string>(({ name }) => name.trim().toLowerCase().replace(" ", "-"), {
    type: "object",
    properties: {
        name: {
            type: "string"
        }
    },
    required: ["name"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_3 = __cfHelpers.pattern(__cf_pattern_input => {
    const name = __cf_pattern_input.key("element");
    return (<li>{__cfLift_11({ name: name })}</li>);
}, {
    type: "object",
    properties: {
        element: {
            type: "string"
        }
    },
    required: ["element"]
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
const __cfLift_12 = __cfHelpers.lift<{
    state: {
        prices: number[];
        discount: number;
    };
}, number>(({ state }) => state.prices.reduce((sum, price) => sum + price * (1 - state.discount), 0), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                prices: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                },
                discount: {
                    type: "number"
                }
            },
            required: ["prices", "discount"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_13 = __cfHelpers.lift<{
    state: {
        items: number[];
        factor: number;
    };
}, number>(({ state }) => (state.items.reduce((a, b) => a + b, 0) / state.items.length) *
    state.factor, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                },
                factor: {
                    type: "number"
                }
            },
            required: ["items", "factor"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_14 = __cfHelpers.lift<{
    state: {
        prices: number[];
        discount: number;
    };
}, string>(({ state }) => (state.prices[0]! * (1 - state.discount)).toFixed(2), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                prices: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                },
                discount: {
                    type: "number"
                }
            },
            required: ["prices", "discount"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_15 = __cfHelpers.lift<{
    state: {
        text: string;
        prefix: string;
    };
}, string>(({ state }) => (state.text.length > 10 ? state.text : state.prefix).trim(), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                text: {
                    type: "string"
                },
                prefix: {
                    type: "string"
                }
            },
            required: ["text", "prefix"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_16 = __cfHelpers.lift<{
    state: {
        text: string;
        prefix: string;
    };
}, string>(({ state }) => (state.text + " " + state.prefix).trim().toLowerCase().split(" ")
    .join("-"), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                text: {
                    type: "string"
                },
                prefix: {
                    type: "string"
                }
            },
            required: ["text", "prefix"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_17 = __cfHelpers.lift<{
    state: {
        users: { name: string; age: number; active: boolean; }[];
        minAge: number;
    };
}, number>(({ state }) => state.users.filter((u) => u.age >= state.minAge && u.active).length, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                users: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            age: {
                                type: "number"
                            },
                            active: {
                                type: "boolean"
                            }
                        },
                        required: ["age", "active"]
                    }
                },
                minAge: {
                    type: "number"
                }
            },
            required: ["users", "minAge"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_18 = __cfHelpers.lift<{
    u: {
        name: string;
    };
}, string>(({ u }) => u.name.toUpperCase(), {
    type: "object",
    properties: {
        u: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    },
    required: ["u"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_19 = __cfHelpers.lift<{
    u: {
        name: string;
    };
}, string>(({ u }) => u.name.toLowerCase(), {
    type: "object",
    properties: {
        u: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    },
    required: ["u"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_4 = __cfHelpers.pattern(__cf_pattern_input => {
    const u = __cf_pattern_input.key("element");
    return (<li>{__cfHelpers.ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, u.key("active"), __cfLift_18({ u: {
            name: u.key("name")
        } }), __cfLift_19({ u: {
            name: u.key("name")
        } }))}</li>);
}, {
    type: "object",
    properties: {
        element: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                age: {
                    type: "number"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["name", "age", "active"]
        }
    },
    required: ["element"]
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
const __cfLift_20 = __cfHelpers.lift<{
    state: {
        users: { name: string; age: number; active: boolean; }[];
        minAge: number;
    };
}, boolean>(({ state }) => state.users.some((u) => u.age >= state.minAge), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                users: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            age: {
                                type: "number"
                            }
                        },
                        required: ["age"]
                    }
                },
                minAge: {
                    type: "number"
                }
            },
            required: ["users", "minAge"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_21 = __cfHelpers.lift<{
    state: {
        users: { name: string; age: number; active: boolean; }[];
    };
}, boolean>(({ state }) => state.users.every((u) => u.active), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                users: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            active: {
                                type: "boolean"
                            }
                        },
                        required: ["active"]
                    }
                }
            },
            required: ["users"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_22 = __cfHelpers.lift<{
    state: {
        text: string;
        prefix: string;
    };
}, number>(({ state }) => state.text.trim().length + state.prefix.trim().length, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                text: {
                    type: "string"
                },
                prefix: {
                    type: "string"
                }
            },
            required: ["text", "prefix"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_23 = __cfHelpers.lift<{
    state: {
        text: string;
        threshold: number;
    };
}, boolean>(({ state }) => state.text.trim().length > state.threshold, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                text: {
                    type: "string"
                },
                threshold: {
                    type: "number"
                }
            },
            required: ["text", "threshold"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_24 = __cfHelpers.lift<{
    state: {
        words: string[];
        separator: string;
    };
}, string>(({ state }) => state.words.join(state.separator).toUpperCase(), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                words: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                },
                separator: {
                    type: "string"
                }
            },
            required: ["words", "separator"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: method-chains
// Verifies: chained method calls and array method chains in JSX are wrapped in a lift-applied computation
//   state.text.trim().toLowerCase()          → lift(...)({ text })
//   state.items.filter(fn).map(fn)           → .filterWithPattern(...).mapWithPattern(...)
//   state.prices.reduce(fn, 0)               → lift(...)({ prices, discount })
// Context: Covers string chains, filter/map chains, reactive args, computed values, complex predicates
export default pattern((state) => {
    return {
        [UI]: (<div>
        <h3>Chained String Methods</h3>
        {/* Simple chain */}
        <p>Trimmed lower: {__cfLift_1({ state: {
                text: state.key("text")
            } })}</p>

        {/* Chain with reactive argument */}
        <p>
          Contains search:{" "}
          {__cfLift_2({ state: {
                text: state.key("text"),
                searchTerm: state.key("searchTerm")
            } })}
        </p>

        {/* Longer chain */}
        <p>
          Processed:{" "}
          {__cfLift_3({ state: {
                text: state.key("text")
            } })}
        </p>

        <h3>Array Method Chains</h3>
        {/* Filter then length */}
        <p>
          Count above threshold:{" "}
          {__cfLift_4({ state: {
                items: state.key("items"),
                threshold: state.key("threshold")
            } })}
        </p>

        {/* Filter then map */}
        <ul>
          {state.key("items").filterWithPattern(__cfPattern_1, {
                state: {
                    threshold: state.key("threshold")
                }
            }).mapWithPattern(__cfPattern_2, {
                state: {
                    factor: state.key("factor")
                }
            })}
        </ul>

        {/* Multiple filters */}
        <p>
          Double filter count:{" "}
          {__cfLift_7({ state: {
                items: state.key("items"),
                start: state.key("start"),
                end: state.key("end")
            } })}
        </p>

        <h3>Methods with Reactive Arguments</h3>
        {/* Slice with reactive indices */}
        <p>
          Sliced items: {__cfLift_8({ state: {
                items: state.key("items"),
                start: state.key("start"),
                end: state.key("end")
            } })}
        </p>

        {/* String methods with reactive args */}
        <p>
          Starts with:{" "}
          {__cfLift_9({ state: {
                names: state.key("names"),
                prefix: state.key("prefix")
            } })}
        </p>

        {/* Array find with reactive predicate */}
        <p>
          First match: {__cfLift_10({ state: {
                names: state.key("names"),
                searchTerm: state.key("searchTerm")
            } })}
        </p>

        <h3>Complex Method Combinations</h3>
        {/* Map with chained operations inside */}
        <ul>
          {state.key("names").mapWithPattern(__cfPattern_3, {})}
        </ul>

        {/* Reduce with reactive accumulator */}
        <p>
          Total with discount: {__cfLift_12({ state: {
                prices: state.key("prices"),
                discount: state.key("discount")
            } })}
        </p>

        {/* Method result used in computation */}
        <p>
          Average * factor:{" "}
          {__cfLift_13({ state: {
                items: state.key("items"),
                factor: state.key("factor")
            } })}
        </p>

        <h3>Methods on Computed Values</h3>
        {/* Method on binary expression result */}
        <p>
          Formatted price: {__cfLift_14({ state: {
                prices: state.key("prices"),
                discount: state.key("discount")
            } })}
        </p>

        {/* Method on conditional result */}
        <p>
          Conditional trim:{" "}
          {__cfLift_15({ state: {
                text: state.key("text"),
                prefix: state.key("prefix")
            } })}
        </p>

        {/* Method chain on computed value */}
        <p>
          Complex:{" "}
          {__cfLift_16({ state: {
                text: state.key("text"),
                prefix: state.key("prefix")
            } })}
        </p>

        <h3>Array Methods with Complex Predicates</h3>
        {/* Filter with multiple conditions */}
        <p>
          Active adults:{" "}
          {__cfLift_17({ state: {
                users: state.key("users"),
                minAge: state.key("minAge")
            } })}
        </p>

        {/* Map with conditional logic */}
        <ul>
          {state.key("users").mapWithPattern(__cfPattern_4, {})}
        </ul>

        {/* Some/every with reactive predicates */}
        <p>
          Has adults:{" "}
          {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["No", "Yes"]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_20({ state: {
                users: state.key("users"),
                minAge: state.key("minAge")
            } }), "Yes", "No")}
        </p>
        <p>All active: {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["No", "Yes"]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_21({ state: {
                users: state.key("users")
            } }), "Yes", "No")}</p>

        <h3>Method Calls in Expressions</h3>
        {/* Method result in arithmetic */}
        <p>
          Length sum: {__cfLift_22({ state: {
                text: state.key("text"),
                prefix: state.key("prefix")
            } })}
        </p>

        {/* Method result in comparison */}
        <p>
          Is long: {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["No", "Yes"]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_23({ state: {
                text: state.key("text"),
                threshold: state.key("threshold")
            } }), "Yes", "No")}
        </p>

        {/* Multiple method results combined */}
        <p>Joined: {__cfLift_24({ state: {
                words: state.key("words"),
                separator: state.key("separator")
            } })}</p>
      </div>),
    };
}, {
    type: "object",
    properties: {
        text: {
            type: "string"
        },
        searchTerm: {
            type: "string"
        },
        items: {
            type: "array",
            items: {
                type: "number"
            }
        },
        start: {
            type: "number"
        },
        end: {
            type: "number"
        },
        threshold: {
            type: "number"
        },
        factor: {
            type: "number"
        },
        names: {
            type: "array",
            items: {
                type: "string"
            }
        },
        prefix: {
            type: "string"
        },
        prices: {
            type: "array",
            items: {
                type: "number"
            }
        },
        discount: {
            type: "number"
        },
        taxRate: {
            type: "number"
        },
        users: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    },
                    age: {
                        type: "number"
                    },
                    active: {
                        type: "boolean"
                    }
                },
                required: ["name", "age", "active"]
            }
        },
        minAge: {
            type: "number"
        },
        words: {
            type: "array",
            items: {
                type: "string"
            }
        },
        separator: {
            type: "string"
        }
    },
    required: ["text", "searchTerm", "items", "start", "end", "threshold", "factor", "names", "prefix", "prices", "discount", "taxRate", "users", "minAge", "words", "separator"]
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
    __cfLift_5,
    __cfPattern_1,
    __cfLift_6,
    __cfPattern_2,
    __cfLift_7,
    __cfLift_8,
    __cfLift_9,
    __cfLift_10,
    __cfLift_11,
    __cfPattern_3,
    __cfLift_12,
    __cfLift_13,
    __cfLift_14,
    __cfLift_15,
    __cfLift_16,
    __cfLift_17,
    __cfLift_18,
    __cfLift_19,
    __cfPattern_4,
    __cfLift_20,
    __cfLift_21,
    __cfLift_22,
    __cfLift_23,
    __cfLift_24
});
