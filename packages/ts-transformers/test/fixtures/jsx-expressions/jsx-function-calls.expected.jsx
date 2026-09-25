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
interface State {
    a: number;
    b: number;
    price: number;
    text: string;
    values: number[];
    name: string;
    float: string;
}
const __cfLift_hc153d1b5c82c = __cfHelpers.lift<{
    state: {
        a: number;
        b: number;
    };
}, number>(({ state }) => Math.max(state.a, state.b), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                a: {
                    type: "number"
                },
                b: {
                    type: "number"
                }
            },
            required: ["a", "b"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_hffd39797350c = __cfHelpers.lift<{
    state: {
        a: number;
    };
}, number>(({ state }) => Math.min(state.a, 10), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                a: {
                    type: "number"
                }
            },
            required: ["a"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h57086f1770fe = __cfHelpers.lift<{
    state: {
        a: number;
        b: number;
    };
}, number>(({ state }) => Math.abs(state.a - state.b), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                a: {
                    type: "number"
                },
                b: {
                    type: "number"
                }
            },
            required: ["a", "b"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_he75194969f73 = __cfHelpers.lift<{
    state: {
        price: number;
    };
}, number>(({ state }) => Math.round(state.price), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                price: {
                    type: "number"
                }
            },
            required: ["price"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h6c3d6e4ebc7e = __cfHelpers.lift<{
    state: {
        price: number;
    };
}, number>(({ state }) => Math.floor(state.price), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                price: {
                    type: "number"
                }
            },
            required: ["price"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h01327696368c = __cfHelpers.lift<{
    state: {
        price: number;
    };
}, number>(({ state }) => Math.ceil(state.price), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                price: {
                    type: "number"
                }
            },
            required: ["price"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_ha1812ca90e20 = __cfHelpers.lift<{
    state: {
        a: number;
    };
}, number>(({ state }) => Math.sqrt(state.a), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                a: {
                    type: "number"
                }
            },
            required: ["a"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_hd70a6d2393b8 = __cfHelpers.lift<{
    state: {
        name: string;
    };
}, string>(({ state }) => state.name.toUpperCase(), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h06a586055757 = __cfHelpers.lift<{
    state: {
        name: string;
    };
}, string>(({ state }) => state.name.toLowerCase(), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_hbce3f5caa499 = __cfHelpers.lift<{
    state: {
        text: string;
    };
}, string>(({ state }) => state.text.substring(0, 5), {
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
const __cfLift_h20a0fe9c716a = __cfHelpers.lift<{
    state: {
        text: string;
    };
}, string>(({ state }) => state.text.replace("old", "new"), {
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
const __cfLift_hd27e59eaabe9 = __cfHelpers.lift<{
    state: {
        text: string;
    };
}, boolean>(({ state }) => state.text.includes("test"), {
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
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_hbe3db5019722 = __cfHelpers.lift<{
    state: {
        name: string;
    };
}, boolean>(({ state }) => state.name.startsWith("A"), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_hb8f89b907c39 = __cfHelpers.lift<{
    state: {
        price: number;
    };
}, string>(({ state }) => state.price.toFixed(2), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                price: {
                    type: "number"
                }
            },
            required: ["price"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_hb821b83dfb5b = __cfHelpers.lift<{
    state: {
        price: number;
    };
}, string>(({ state }) => state.price.toPrecision(4), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                price: {
                    type: "number"
                }
            },
            required: ["price"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h1f431b9b430a = __cfHelpers.lift<{
    state: {
        float: string;
    };
}, number>(({ state }) => parseInt(state.float), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                float: {
                    type: "string"
                }
            },
            required: ["float"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_hb332029fac5d = __cfHelpers.lift<{
    state: {
        float: string;
    };
}, number>(({ state }) => parseFloat(state.float), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                float: {
                    type: "string"
                }
            },
            required: ["float"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_hf4dc1251e63c = __cfHelpers.lift<{
    state: {
        values: number[];
    };
}, number>(({ state }) => state.values.reduce((a, b) => a + b, 0), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                values: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                }
            },
            required: ["values"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h81c31b3c6346 = __cfHelpers.lift<{
    state: {
        values: number[];
    };
}, number>(({ state }) => Math.max(...state.values), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                values: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                }
            },
            required: ["values"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_hf6f49a1f9e90 = __cfHelpers.lift<{
    state: {
        values: number[];
    };
}, string>(({ state }) => state.values.join(", "), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                values: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                }
            },
            required: ["values"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h4bea4b458ea1 = __cfHelpers.lift<{
    state: {
        a: number;
    };
}, number>(({ state }) => Math.pow(state.a, 2), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                a: {
                    type: "number"
                }
            },
            required: ["a"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h2d17bf278df3 = __cfHelpers.lift<{
    state: {
        a: number;
    };
}, number>(({ state }) => Math.round(Math.sqrt(state.a)), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                a: {
                    type: "number"
                }
            },
            required: ["a"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h5dac3358f7b4 = __cfHelpers.lift<{
    state: {
        name: string;
    };
}, string>(({ state }) => state.name.trim().toUpperCase(), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h6c2a5c2bed73 = __cfHelpers.lift<{
    state: {
        a: number;
        b: number;
    };
}, number>(({ state }) => Math.max(state.a + 1, state.b * 2), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                a: {
                    type: "number"
                },
                b: {
                    type: "number"
                }
            },
            required: ["a", "b"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: jsx-function-calls
// Verifies: function/method calls with reactive args in JSX are wrapped in a lift-applied computation
//   Math.max(state.a, state.b)     → lift(({state}) => Math.max(state.a, state.b))({ a, b })
//   state.name.toUpperCase()       → lift(...)({ name })
//   parseInt(state.float)          → lift(...)({ float })
export default pattern((state) => {
    return {
        [UI]: (<div>
        <h3>Math Functions</h3>
        <p>Max: {__cfLift_hc153d1b5c82c({ state: {
                a: state.key("a"),
                b: state.key("b")
            } })}</p>
        <p>Min: {__cfLift_hffd39797350c({ state: {
                a: state.key("a")
            } })}</p>
        <p>Abs: {__cfLift_h57086f1770fe({ state: {
                a: state.key("a"),
                b: state.key("b")
            } })}</p>
        <p>Round: {__cfLift_he75194969f73({ state: {
                price: state.key("price")
            } })}</p>
        <p>Floor: {__cfLift_h6c3d6e4ebc7e({ state: {
                price: state.key("price")
            } })}</p>
        <p>Ceiling: {__cfLift_h01327696368c({ state: {
                price: state.key("price")
            } })}</p>
        <p>Square root: {__cfLift_ha1812ca90e20({ state: {
                a: state.key("a")
            } })}</p>

        <h3>String Methods as Function Calls</h3>
        <p>Uppercase: {__cfLift_hd70a6d2393b8({ state: {
                name: state.key("name")
            } })}</p>
        <p>Lowercase: {__cfLift_h06a586055757({ state: {
                name: state.key("name")
            } })}</p>
        <p>Substring: {__cfLift_hbce3f5caa499({ state: {
                text: state.key("text")
            } })}</p>
        <p>Replace: {__cfLift_h20a0fe9c716a({ state: {
                text: state.key("text")
            } })}</p>
        <p>Includes: {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Yes", "No"]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_hd27e59eaabe9({ state: {
                text: state.key("text")
            } }), "Yes", "No")}</p>
        <p>Starts with: {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Yes", "No"]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_hbe3db5019722({ state: {
                name: state.key("name")
            } }), "Yes", "No")}</p>

        <h3>Number Methods</h3>
        <p>To Fixed: {__cfLift_hb8f89b907c39({ state: {
                price: state.key("price")
            } })}</p>
        <p>To Precision: {__cfLift_hb821b83dfb5b({ state: {
                price: state.key("price")
            } })}</p>

        <h3>Parse Functions</h3>
        <p>Parse Int: {__cfLift_h1f431b9b430a({ state: {
                float: state.key("float")
            } })}</p>
        <p>Parse Float: {__cfLift_hb332029fac5d({ state: {
                float: state.key("float")
            } })}</p>

        <h3>Array Method Calls</h3>
        <p>Sum: {__cfLift_hf4dc1251e63c({ state: {
                values: state.key("values")
            } })}</p>
        <p>Max value: {__cfLift_h81c31b3c6346({ state: {
                values: state.key("values")
            } })}</p>
        <p>Joined: {__cfLift_hf6f49a1f9e90({ state: {
                values: state.key("values")
            } })}</p>

        <h3>Complex Function Calls</h3>
        <p>Multiple args: {__cfLift_h4bea4b458ea1({ state: {
                a: state.key("a")
            } })}</p>
        <p>Nested calls: {__cfLift_h2d17bf278df3({ state: {
                a: state.key("a")
            } })}</p>
        <p>Chained calls: {__cfLift_h5dac3358f7b4({ state: {
                name: state.key("name")
            } })}</p>
        <p>With expressions: {__cfLift_h6c2a5c2bed73({ state: {
                a: state.key("a"),
                b: state.key("b")
            } })}</p>
      </div>),
    };
}, {
    type: "object",
    properties: {
        a: {
            type: "number"
        },
        b: {
            type: "number"
        },
        price: {
            type: "number"
        },
        text: {
            type: "string"
        },
        values: {
            type: "array",
            items: {
                type: "number"
            }
        },
        name: {
            type: "string"
        },
        float: {
            type: "string"
        }
    },
    required: ["a", "b", "price", "text", "values", "name", "float"]
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
    __cfLift_hc153d1b5c82c,
    __cfLift_hffd39797350c,
    __cfLift_h57086f1770fe,
    __cfLift_he75194969f73,
    __cfLift_h6c3d6e4ebc7e,
    __cfLift_h01327696368c,
    __cfLift_ha1812ca90e20,
    __cfLift_hd70a6d2393b8,
    __cfLift_h06a586055757,
    __cfLift_hbce3f5caa499,
    __cfLift_h20a0fe9c716a,
    __cfLift_hd27e59eaabe9,
    __cfLift_hbe3db5019722,
    __cfLift_hb8f89b907c39,
    __cfLift_hb821b83dfb5b,
    __cfLift_h1f431b9b430a,
    __cfLift_hb332029fac5d,
    __cfLift_hf4dc1251e63c,
    __cfLift_h81c31b3c6346,
    __cfLift_hf6f49a1f9e90,
    __cfLift_h4bea4b458ea1,
    __cfLift_h2d17bf278df3,
    __cfLift_h5dac3358f7b4,
    __cfLift_h6c2a5c2bed73,
    __cfLift_1: __cfLift_hc153d1b5c82c,
    __cfLift_2: __cfLift_hffd39797350c,
    __cfLift_3: __cfLift_h57086f1770fe,
    __cfLift_4: __cfLift_he75194969f73,
    __cfLift_5: __cfLift_h6c3d6e4ebc7e,
    __cfLift_6: __cfLift_h01327696368c,
    __cfLift_7: __cfLift_ha1812ca90e20,
    __cfLift_8: __cfLift_hd70a6d2393b8,
    __cfLift_9: __cfLift_h06a586055757,
    __cfLift_10: __cfLift_hbce3f5caa499,
    __cfLift_11: __cfLift_h20a0fe9c716a,
    __cfLift_12: __cfLift_hd27e59eaabe9,
    __cfLift_13: __cfLift_hbe3db5019722,
    __cfLift_14: __cfLift_hb8f89b907c39,
    __cfLift_15: __cfLift_hb821b83dfb5b,
    __cfLift_16: __cfLift_h1f431b9b430a,
    __cfLift_17: __cfLift_hb332029fac5d,
    __cfLift_18: __cfLift_hf4dc1251e63c,
    __cfLift_19: __cfLift_h81c31b3c6346,
    __cfLift_20: __cfLift_hf6f49a1f9e90,
    __cfLift_21: __cfLift_h4bea4b458ea1,
    __cfLift_22: __cfLift_h2d17bf278df3,
    __cfLift_23: __cfLift_h5dac3358f7b4,
    __cfLift_24: __cfLift_h6c2a5c2bed73
});
