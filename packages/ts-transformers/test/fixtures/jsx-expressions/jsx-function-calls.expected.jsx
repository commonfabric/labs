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
const __cfLift_1 = __cfHelpers.lift<{
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
const __cfLift_2 = __cfHelpers.lift<{
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
const __cfLift_3 = __cfHelpers.lift<{
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
const __cfLift_4 = __cfHelpers.lift<{
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
const __cfLift_5 = __cfHelpers.lift<{
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
const __cfLift_6 = __cfHelpers.lift<{
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
const __cfLift_7 = __cfHelpers.lift<{
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
const __cfLift_8 = __cfHelpers.lift<{
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
const __cfLift_9 = __cfHelpers.lift<{
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
const __cfLift_10 = __cfHelpers.lift<{
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
const __cfLift_11 = __cfHelpers.lift<{
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
const __cfLift_12 = __cfHelpers.lift<{
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
const __cfLift_13 = __cfHelpers.lift<{
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
const __cfLift_14 = __cfHelpers.lift<{
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
const __cfLift_15 = __cfHelpers.lift<{
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
const __cfLift_16 = __cfHelpers.lift<{
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
const __cfLift_17 = __cfHelpers.lift<{
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
const __cfLift_18 = __cfHelpers.lift<{
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
const __cfLift_19 = __cfHelpers.lift<{
    state: {
        values: number[];
    };
}, number>(({ state }) => 
// deno-lint-ignore cf-spread/no-spread-arguments -- the fixture covers a spread argument
Math.max(...state.values), {
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
const __cfLift_20 = __cfHelpers.lift<{
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
const __cfLift_21 = __cfHelpers.lift<{
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
const __cfLift_22 = __cfHelpers.lift<{
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
const __cfLift_23 = __cfHelpers.lift<{
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
const __cfLift_24 = __cfHelpers.lift<{
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
        <p>Max: {__cfLift_1({ state: {
                a: state.key("a"),
                b: state.key("b")
            } })}</p>
        <p>Min: {__cfLift_2({ state: {
                a: state.key("a")
            } })}</p>
        <p>Abs: {__cfLift_3({ state: {
                a: state.key("a"),
                b: state.key("b")
            } })}</p>
        <p>Round: {__cfLift_4({ state: {
                price: state.key("price")
            } })}</p>
        <p>Floor: {__cfLift_5({ state: {
                price: state.key("price")
            } })}</p>
        <p>Ceiling: {__cfLift_6({ state: {
                price: state.key("price")
            } })}</p>
        <p>Square root: {__cfLift_7({ state: {
                a: state.key("a")
            } })}</p>

        <h3>String Methods as Function Calls</h3>
        <p>Uppercase: {__cfLift_8({ state: {
                name: state.key("name")
            } })}</p>
        <p>Lowercase: {__cfLift_9({ state: {
                name: state.key("name")
            } })}</p>
        <p>Substring: {__cfLift_10({ state: {
                text: state.key("text")
            } })}</p>
        <p>Replace: {__cfLift_11({ state: {
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
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_12({ state: {
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
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_13({ state: {
                name: state.key("name")
            } }), "Yes", "No")}</p>

        <h3>Number Methods</h3>
        <p>To Fixed: {__cfLift_14({ state: {
                price: state.key("price")
            } })}</p>
        <p>To Precision: {__cfLift_15({ state: {
                price: state.key("price")
            } })}</p>

        <h3>Parse Functions</h3>
        <p>Parse Int: {__cfLift_16({ state: {
                float: state.key("float")
            } })}</p>
        <p>Parse Float: {__cfLift_17({ state: {
                float: state.key("float")
            } })}</p>

        <h3>Array Method Calls</h3>
        <p>Sum: {__cfLift_18({ state: {
                values: state.key("values")
            } })}</p>
        <p>Max value: {__cfLift_19({ state: {
                values: state.key("values")
            } })}</p>
        <p>Joined: {__cfLift_20({ state: {
                values: state.key("values")
            } })}</p>

        <h3>Complex Function Calls</h3>
        <p>Multiple args: {__cfLift_21({ state: {
                a: state.key("a")
            } })}</p>
        <p>Nested calls: {__cfLift_22({ state: {
                a: state.key("a")
            } })}</p>
        <p>Chained calls: {__cfLift_23({ state: {
                name: state.key("name")
            } })}</p>
        <p>With expressions: {__cfLift_24({ state: {
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
    __cfLift_1,
    __cfLift_2,
    __cfLift_3,
    __cfLift_4,
    __cfLift_5,
    __cfLift_6,
    __cfLift_7,
    __cfLift_8,
    __cfLift_9,
    __cfLift_10,
    __cfLift_11,
    __cfLift_12,
    __cfLift_13,
    __cfLift_14,
    __cfLift_15,
    __cfLift_16,
    __cfLift_17,
    __cfLift_18,
    __cfLift_19,
    __cfLift_20,
    __cfLift_21,
    __cfLift_22,
    __cfLift_23,
    __cfLift_24
});
