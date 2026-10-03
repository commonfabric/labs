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
interface Item {
    id: number;
    name: string;
    price: number;
    active: boolean;
}
interface State {
    items: Item[];
    filter: string;
    discount: number;
    taxRate: number;
}
const __cfLift_h2a59c1898c48 = __cfHelpers.lift<{
    state: {
        items: {
            name: string;
        }[];
        filter: string;
    };
}, number>(({ state }) => state.items.filter((i) => i.name.includes(state.filter)).length, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            }
                        },
                        required: ["name"]
                    }
                },
                filter: {
                    type: "string"
                }
            },
            required: ["items", "filter"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_hd75a5a4a2b41 = __cfHelpers.lift<{
    item: {
        price: number;
    };
    state: {
        discount: number;
    };
}, string>(({ item, state }) => (item.price * (1 - state.discount)).toFixed(2), {
    type: "object",
    properties: {
        item: {
            type: "object",
            properties: {
                price: {
                    type: "number"
                }
            },
            required: ["price"]
        },
        state: {
            type: "object",
            properties: {
                discount: {
                    type: "number"
                }
            },
            required: ["discount"]
        }
    },
    required: ["item", "state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_hdd8535926630 = __cfHelpers.lift<{
    item: {
        price: number;
    };
    state: {
        discount: number;
        taxRate: number;
    };
}, string>(({ item, state }) => (item.price * (1 - state.discount) * (1 + state.taxRate))
    .toFixed(2), {
    type: "object",
    properties: {
        item: {
            type: "object",
            properties: {
                price: {
                    type: "number"
                }
            },
            required: ["price"]
        },
        state: {
            type: "object",
            properties: {
                discount: {
                    type: "number"
                },
                taxRate: {
                    type: "number"
                }
            },
            required: ["discount", "taxRate"]
        }
    },
    required: ["item", "state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_h54d847ceb4b0 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    const state = __cf_pattern_input.key("params", "state");
    return (<li key={item.key("id")}>
              <span>{item.key("name")}</span>
              <span>- Original: ${item.key("price")}</span>
              <span>
                - Discounted: ${__cfLift_hd75a5a4a2b41({
        item: {
            price: item.key("price")
        },
        state: {
            discount: state.key("discount")
        }
    })}
              </span>
              <span>
                - With tax:
                ${__cfLift_hdd8535926630({
        item: {
            price: item.key("price")
        },
        state: {
            discount: state.key("discount"),
            taxRate: state.key("taxRate")
        }
    })}
              </span>
            </li>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Item"
        },
        params: {
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        discount: {
                            type: "number"
                        },
                        taxRate: {
                            type: "number"
                        }
                    },
                    required: ["discount", "taxRate"]
                }
            },
            required: ["state"]
        }
    },
    required: ["element", "params"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                name: {
                    type: "string"
                },
                price: {
                    type: "number"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["id", "name", "price", "active"]
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
const __cfLift_h4a3f5c27f005 = __cfHelpers.lift<{
    state: {
        items: Item[];
    };
}, number>(({ state }) => state.items.filter((i) => i.active).length, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
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
            required: ["items"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_hfcbdbf9c0faf = __cfHelpers.lift<{
    state: {
        discount: number;
    };
}, number>(({ state }) => state.discount * 100, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                discount: {
                    type: "number"
                }
            },
            required: ["discount"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h8096a0efba94 = __cfHelpers.lift<{
    state: {
        taxRate: number;
    };
}, number>(({ state }) => state.taxRate * 100, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                taxRate: {
                    type: "number"
                }
            },
            required: ["taxRate"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_hbae4b7d842de = __cfHelpers.lift<{
    state: {
        items: Item[];
    };
}, boolean>(({ state }) => state.items.every((i) => i.active), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
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
            required: ["items"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h4d6d1265abb7 = __cfHelpers.lift<{
    state: {
        items: Item[];
    };
}, boolean>(({ state }) => state.items.some((i) => i.active), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
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
            required: ["items"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h6ad1d5ba034c = __cfHelpers.lift<{
    state: {
        items: Item[];
    };
}, boolean>(({ state }) => state.items.some((i) => i.price > 100), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            price: {
                                type: "number"
                            }
                        },
                        required: ["price"]
                    }
                }
            },
            required: ["items"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h34931f5c6931 = __cfHelpers.lift<{
    state: {
        filter: {
            length: number;
        };
    };
}, boolean>(({ state }) => state.filter.length > 0, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                filter: {
                    type: "object",
                    properties: {
                        length: {
                            type: "number"
                        }
                    },
                    required: ["length"]
                }
            },
            required: ["filter"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: jsx-complex-mixed
// Verifies: mixed transforms -- map, filter, arithmetic, ternary/ifElse, attribute bindings in one pattern
//   .filter(fn)              → .filterWithPattern(pattern(...), {captures})
//   .map(fn)                 → .mapWithPattern(pattern(...), {captures})
//   ternary cond ? a : b     → ifElse(lift(...)(cond), a, b)
//   {state.discount * 100}   → lift(...)({ discount })
// Context: Comprehensive fixture combining array methods, conditionals, lift-applied computations, and attributes
export default pattern((state) => {
    return {
        [UI]: (<div>
        <h3>Array Operations</h3>
        <p>Total items: {state.key("items", "length")}</p>
        <p>
          Filtered count:{" "}
          {__cfLift_h2a59c1898c48({ state: {
                items: state.key("items"),
                filter: state.key("filter")
            } })}
        </p>

        <h3>Array with Complex Expressions</h3>
        <ul>
          {state.key("items").mapWithPattern(__cfPattern_h54d847ceb4b0, {
                state: {
                    discount: state.key("discount"),
                    taxRate: state.key("taxRate")
                }
            })}
        </ul>

        <h3>Array Methods</h3>
        <p>Item count: {state.key("items", "length")}</p>
        <p>Active items: {__cfLift_h4a3f5c27f005({ state: {
                items: state.key("items")
            } })}</p>

        <h3>Simple Operations</h3>
        <p>Discount percent: {__cfLift_hfcbdbf9c0faf({ state: {
                discount: state.key("discount")
            } })}%</p>
        <p>Tax percent: {__cfLift_h8096a0efba94({ state: {
                taxRate: state.key("taxRate")
            } })}%</p>

        <h3>Array Predicates</h3>
        <p>All active: {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Yes", "No"]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_hbae4b7d842de({ state: {
                items: state.key("items")
            } }), "Yes", "No")}</p>
        <p>Any active: {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Yes", "No"]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_h4d6d1265abb7({ state: {
                items: state.key("items")
            } }), "Yes", "No")}</p>
        <p>
          Has expensive (gt 100):{" "}
          {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Yes", "No"]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_h6ad1d5ba034c({ state: {
                items: state.key("items")
            } }), "Yes", "No")}
        </p>

        <h3>Object Operations</h3>
        <div data-item-count={state.key("items", "length")} data-has-filter={__cfLift_h34931f5c6931({ state: {
                filter: {
                    length: state.key("filter", "length")
                }
            } })} data-discount={state.key("discount")}>
          Object attributes
        </div>
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
        },
        filter: {
            type: "string"
        },
        discount: {
            type: "number"
        },
        taxRate: {
            type: "number"
        }
    },
    required: ["items", "filter", "discount", "taxRate"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                name: {
                    type: "string"
                },
                price: {
                    type: "number"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["id", "name", "price", "active"]
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
    __cfLift_h2a59c1898c48,
    __cfLift_hd75a5a4a2b41,
    __cfLift_hdd8535926630,
    __cfPattern_h54d847ceb4b0,
    __cfLift_h4a3f5c27f005,
    __cfLift_hfcbdbf9c0faf,
    __cfLift_h8096a0efba94,
    __cfLift_hbae4b7d842de,
    __cfLift_h4d6d1265abb7,
    __cfLift_h6ad1d5ba034c,
    __cfLift_h34931f5c6931,
    __cfLift_1: __cfLift_h2a59c1898c48,
    __cfLift_2: __cfLift_hd75a5a4a2b41,
    __cfLift_3: __cfLift_hdd8535926630,
    __cfPattern_1: __cfPattern_h54d847ceb4b0,
    __cfLift_4: __cfLift_h4a3f5c27f005,
    __cfLift_5: __cfLift_hfcbdbf9c0faf,
    __cfLift_6: __cfLift_h8096a0efba94,
    __cfLift_7: __cfLift_hbae4b7d842de,
    __cfLift_8: __cfLift_h4d6d1265abb7,
    __cfLift_9: __cfLift_h6ad1d5ba034c,
    __cfLift_10: __cfLift_h34931f5c6931
});
