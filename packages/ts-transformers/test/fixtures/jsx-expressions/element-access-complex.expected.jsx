function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { ifElse, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    matrix: number[][];
    row: number;
    col: number;
    items: string[];
    arr: number[];
    a: number;
    b: number;
    indices: number[];
    nested: {
        arrays: string[][];
        index: number;
    };
    users: Array<{
        name: string;
        scores: number[];
    }>;
    selectedUser: number;
    selectedScore: number;
}
const __cfLift_h860446cd1638 = __cfHelpers.lift<{
    state: {
        matrix: number[][];
        row: number;
        col: number;
    };
}, number | undefined>(({ state }) => state.matrix[state.row]![state.col], {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                matrix: {
                    type: "array",
                    items: {
                        type: "array",
                        items: {
                            type: "number"
                        }
                    }
                },
                row: {
                    type: "number"
                },
                col: {
                    type: "number"
                }
            },
            required: ["matrix", "row", "col"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["number", "undefined"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h9c7d581e4e10 = __cfHelpers.lift<{
    state: {
        nested: {
            arrays: string[][];
            index: number;
        };
        row: number;
    };
}, string | undefined>(({ state }) => state.nested.arrays[state.nested.index]![state.row], {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                nested: {
                    type: "object",
                    properties: {
                        arrays: {
                            type: "array",
                            items: {
                                type: "array",
                                items: {
                                    type: "string"
                                }
                            }
                        },
                        index: {
                            type: "number"
                        }
                    },
                    required: ["arrays", "index"]
                },
                row: {
                    type: "number"
                }
            },
            required: ["nested", "row"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["string", "undefined"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_he8e8823883f4 = __cfHelpers.lift<{
    state: {
        items: string[];
    };
}, string | undefined>(({ state }) => state.items[state.items.length - 1], {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["items"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["string", "undefined"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h52574bf035a0 = __cfHelpers.lift<{
    state: {
        arr: number[];
    };
}, number>(({ state }) => state.arr[0]! + state.arr[state.arr.length - 1]!, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                arr: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                }
            },
            required: ["arr"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h769ee8901e64 = __cfHelpers.lift<{
    state: {
        arr: number[];
        a: number;
        b: number;
    };
}, number | undefined>(({ state }) => state.arr[state.a + state.b], {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                arr: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                },
                a: {
                    type: "number"
                },
                b: {
                    type: "number"
                }
            },
            required: ["arr", "a", "b"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["number", "undefined"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_hb65ad4a78287 = __cfHelpers.lift<{
    state: {
        items: string[];
        row: number;
    };
}, string | undefined>(({ state }) => state.items[state.row % state.items.length], {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                },
                row: {
                    type: "number"
                }
            },
            required: ["items", "row"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["string", "undefined"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_ha0897c0f9871 = __cfHelpers.lift<{
    state: {
        arr: number[];
        a: number;
    };
}, number | undefined>(({ state }) => state.arr[Math.min(state.a * 2, state.arr.length - 1)], {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                arr: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                },
                a: {
                    type: "number"
                }
            },
            required: ["arr", "a"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["number", "undefined"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h68d29bbf3148 = __cfHelpers.lift<{
    state: {
        users: { name: string; scores: number[]; }[];
        selectedUser: number;
        selectedScore: number;
    };
}, number | undefined>(({ state }) => state.users[state.selectedUser]!.scores[state.selectedScore], {
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
                            name: {
                                type: "string"
                            },
                            scores: {
                                type: "array",
                                items: {
                                    type: "number"
                                }
                            }
                        },
                        required: ["name", "scores"]
                    }
                },
                selectedUser: {
                    type: "number"
                },
                selectedScore: {
                    type: "number"
                }
            },
            required: ["users", "selectedUser", "selectedScore"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["number", "undefined"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_haff7a419013e = __cfHelpers.lift<{
    state: {
        items: string[];
        indices: number[];
    };
}, string | undefined>(({ state }) => state.items[state.indices[0]!], {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                },
                indices: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                }
            },
            required: ["items", "indices"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["string", "undefined"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h48090f780881 = __cfHelpers.lift<{
    state: {
        arr: number[];
    };
}, number | undefined>(({ state }) => state.arr[state.arr[0]!], {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                arr: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                }
            },
            required: ["arr"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["number", "undefined"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h9a449c893c58 = __cfHelpers.lift<{
    state: {
        nested: {
            arrays: string[][];
            index: number;
        };
    };
}, number>(({ state }) => state.nested.arrays[state.nested.index]!.length, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                nested: {
                    type: "object",
                    properties: {
                        arrays: {
                            type: "array",
                            items: {
                                type: "array",
                                items: {
                                    type: "string"
                                }
                            }
                        },
                        index: {
                            type: "number"
                        }
                    },
                    required: ["arrays", "index"]
                }
            },
            required: ["nested"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h26eb61961c4f = __cfHelpers.lift<{
    state: {
        users: { name: string; scores: number[]; }[];
        selectedUser: number;
    };
}, number>(({ state }) => state.users[state.selectedUser]!.name.length, {
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
                            name: {
                                type: "string"
                            },
                            scores: {
                                type: "array",
                                items: {
                                    type: "number"
                                }
                            }
                        },
                        required: ["name", "scores"]
                    }
                },
                selectedUser: {
                    type: "number"
                }
            },
            required: ["users", "selectedUser"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h4df3f753c34a = __cfHelpers.lift<{
    state: {
        arr: number[];
        a: number;
    };
}, boolean>(({ state }) => state.arr[state.a]! > 10, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                arr: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                },
                a: {
                    type: "number"
                }
            },
            required: ["arr", "a"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h4835bfaf53dc = __cfHelpers.lift<{
    state: {
        items: string[];
        b: number;
    };
}, string>(({ state }) => state.items[state.b]!, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                },
                b: {
                    type: "number"
                }
            },
            required: ["items", "b"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h80544c1076c9 = __cfHelpers.lift<{
    state: {
        matrix: number[][];
        row: number;
        col: number;
    };
}, boolean>(({ state }) => state.matrix[state.row]![state.col]! > 0, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                matrix: {
                    type: "array",
                    items: {
                        type: "array",
                        items: {
                            type: "number"
                        }
                    }
                },
                row: {
                    type: "number"
                },
                col: {
                    type: "number"
                }
            },
            required: ["matrix", "row", "col"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_heea236e134c8 = __cfHelpers.lift<{
    state: {
        arr: number[];
        a: number;
        b: number;
    };
}, number>(({ state }) => state.arr[state.a]! * state.arr[state.b]!, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                arr: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                },
                a: {
                    type: "number"
                },
                b: {
                    type: "number"
                }
            },
            required: ["arr", "a", "b"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h23c3da2b9c6a = __cfHelpers.lift<{
    state: {
        items: string[];
        indices: number[];
    };
}, string>(({ state }) => state.items[0]! + " - " + state.items[state.indices[0]!]!, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                },
                indices: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                }
            },
            required: ["items", "indices"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_hc317dc01eb04 = __cfHelpers.lift<{
    state: {
        arr: number[];
    };
}, number>(({ state }) => state.arr[0]! + state.arr[1]! + state.arr[2]!, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                arr: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                }
            },
            required: ["arr"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: element-access-complex
// Verifies: complex element-access patterns (nested, computed, chained, conditional) are wrapped in a lift-applied computation
//   state.matrix[state.row]![state.col]         → lift(...)({ matrix, row, col })
//   state.arr[state.a + state.b]                → lift(...)({ arr, a, b })
//   state.users[state.selectedUser]!.scores[..] → lift(...)({ users, selectedUser, selectedScore })
// Context: Covers nested indexing, computed indices, chained access, conditions, operators
export default pattern((state) => {
    return {
        [UI]: (<div>
        <h3>Nested Element Access</h3>
        {/* Double indexing into matrix */}
        <p>Matrix value: {__cfLift_h860446cd1638({ state: {
                matrix: state.key("matrix"),
                row: state.key("row"),
                col: state.key("col")
            } })}</p>

        {/* Triple nested access */}
        <p>Deep nested: {__cfLift_h9c7d581e4e10({ state: {
                nested: {
                    arrays: state.key("nested", "arrays"),
                    index: state.key("nested", "index")
                },
                row: state.key("row")
            } })}</p>

        <h3>Multiple References to Same Array</h3>
        {/* Same array accessed multiple times with different indices */}
        <p>
          First and last: {state.key("items", "0")} and{" "}
          {__cfLift_he8e8823883f4({ state: {
                items: state.key("items")
            } })}
        </p>

        {/* Array used in computation and access */}
        <p>Sum of ends: {__cfLift_h52574bf035a0({ state: {
                arr: state.key("arr")
            } })}</p>

        <h3>Computed Indices</h3>
        {/* Index from multiple state values */}
        <p>Computed index: {__cfLift_h769ee8901e64({ state: {
                arr: state.key("arr"),
                a: state.key("a"),
                b: state.key("b")
            } })}</p>

        {/* Index from computation involving array */}
        <p>Modulo index: {__cfLift_hb65ad4a78287({ state: {
                items: state.key("items"),
                row: state.key("row")
            } })}</p>

        {/* Complex index expression */}
        <p>Complex: {__cfLift_ha0897c0f9871({ state: {
                arr: state.key("arr"),
                a: state.key("a")
            } })}</p>

        <h3>Chained Element Access</h3>
        {/* Element access returning array, then accessing that */}
        <p>
          User score:{" "}
          {__cfLift_h68d29bbf3148({ state: {
                users: state.key("users"),
                selectedUser: state.key("selectedUser"),
                selectedScore: state.key("selectedScore")
            } })!}
        </p>

        {/* Using one array element as index for another */}
        <p>Indirect: {__cfLift_haff7a419013e({ state: {
                items: state.key("items"),
                indices: state.key("indices")
            } })}</p>

        {/* Array element used as index for same array */}
        <p>Self reference: {__cfLift_h48090f780881({ state: {
                arr: state.key("arr")
            } })}</p>

        <h3>Mixed Property and Element Access</h3>
        {/* Property access followed by element access with computed index */}
        <p>Mixed: {__cfLift_h9a449c893c58({ state: {
                nested: {
                    arrays: state.key("nested", "arrays"),
                    index: state.key("nested", "index")
                }
            } })}</p>

        {/* Element access followed by property access */}
        <p>User name length: {__cfLift_h26eb61961c4f({ state: {
                users: state.key("users"),
                selectedUser: state.key("selectedUser")
            } })}</p>

        <h3>Element Access in Conditions</h3>
        {/* Element access in ternary */}
        <p>
          Conditional:{" "}
          {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_h4df3f753c34a({ state: {
                arr: state.key("arr"),
                a: state.key("a")
            } }), __cfLift_h4835bfaf53dc({ state: {
                items: state.key("items"),
                b: state.key("b")
            } }), state.key("items", "0")!)}
        </p>

        {/* Element access in boolean expression */}
        <p>
          Has value: {ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["positive", "non-positive"]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_h80544c1076c9({ state: {
                matrix: state.key("matrix"),
                row: state.key("row"),
                col: state.key("col")
            } }), "positive", "non-positive")}
        </p>

        <h3>Element Access with Operators</h3>
        {/* Element access with arithmetic */}
        <p>Product: {__cfLift_heea236e134c8({ state: {
                arr: state.key("arr"),
                a: state.key("a"),
                b: state.key("b")
            } })}</p>

        {/* Element access with string concatenation */}
        <p>Concat: {__cfLift_h23c3da2b9c6a({ state: {
                items: state.key("items"),
                indices: state.key("indices")
            } })}</p>

        {/* Multiple element accesses in single expression */}
        <p>Sum: {__cfLift_hc317dc01eb04({ state: {
                arr: state.key("arr")
            } })}</p>
      </div>),
    };
}, {
    type: "object",
    properties: {
        matrix: {
            type: "array",
            items: {
                type: "array",
                items: {
                    type: "number"
                }
            }
        },
        row: {
            type: "number"
        },
        col: {
            type: "number"
        },
        items: {
            type: "array",
            items: {
                type: "string"
            }
        },
        arr: {
            type: "array",
            items: {
                type: "number"
            }
        },
        a: {
            type: "number"
        },
        b: {
            type: "number"
        },
        indices: {
            type: "array",
            items: {
                type: "number"
            }
        },
        nested: {
            type: "object",
            properties: {
                arrays: {
                    type: "array",
                    items: {
                        type: "array",
                        items: {
                            type: "string"
                        }
                    }
                },
                index: {
                    type: "number"
                }
            },
            required: ["arrays", "index"]
        },
        users: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    },
                    scores: {
                        type: "array",
                        items: {
                            type: "number"
                        }
                    }
                },
                required: ["name", "scores"]
            }
        },
        selectedUser: {
            type: "number"
        },
        selectedScore: {
            type: "number"
        }
    },
    required: ["matrix", "row", "col", "items", "arr", "a", "b", "indices", "nested", "users", "selectedUser", "selectedScore"]
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
    __cfLift_h860446cd1638,
    __cfLift_h9c7d581e4e10,
    __cfLift_he8e8823883f4,
    __cfLift_h52574bf035a0,
    __cfLift_h769ee8901e64,
    __cfLift_hb65ad4a78287,
    __cfLift_ha0897c0f9871,
    __cfLift_h68d29bbf3148,
    __cfLift_haff7a419013e,
    __cfLift_h48090f780881,
    __cfLift_h9a449c893c58,
    __cfLift_h26eb61961c4f,
    __cfLift_h4df3f753c34a,
    __cfLift_h4835bfaf53dc,
    __cfLift_h80544c1076c9,
    __cfLift_heea236e134c8,
    __cfLift_h23c3da2b9c6a,
    __cfLift_hc317dc01eb04,
    __cfLift_1: __cfLift_h860446cd1638,
    __cfLift_2: __cfLift_h9c7d581e4e10,
    __cfLift_3: __cfLift_he8e8823883f4,
    __cfLift_4: __cfLift_h52574bf035a0,
    __cfLift_5: __cfLift_h769ee8901e64,
    __cfLift_6: __cfLift_hb65ad4a78287,
    __cfLift_7: __cfLift_ha0897c0f9871,
    __cfLift_8: __cfLift_h68d29bbf3148,
    __cfLift_9: __cfLift_haff7a419013e,
    __cfLift_10: __cfLift_h48090f780881,
    __cfLift_11: __cfLift_h9a449c893c58,
    __cfLift_12: __cfLift_h26eb61961c4f,
    __cfLift_13: __cfLift_h4df3f753c34a,
    __cfLift_14: __cfLift_h4835bfaf53dc,
    __cfLift_15: __cfLift_h80544c1076c9,
    __cfLift_16: __cfLift_heea236e134c8,
    __cfLift_17: __cfLift_h23c3da2b9c6a,
    __cfLift_18: __cfLift_hc317dc01eb04
});
