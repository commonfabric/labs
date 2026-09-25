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
    isActive: boolean;
    count: number;
    userType: string;
    score: number;
    hasPermission: boolean;
    isPremium: boolean;
}
const __cfLift_h89148dfed5bb = __cfHelpers.lift<{
    state: {
        count: number;
    };
}, boolean>(({ state }) => state.count > 10, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                count: {
                    type: "number"
                }
            },
            required: ["count"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h80b473952880 = __cfHelpers.lift<{
    state: {
        score: number;
    };
}, boolean>(({ state }) => state.score >= 90, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                score: {
                    type: "number"
                }
            },
            required: ["score"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h87a39eab30b0 = __cfHelpers.lift<{
    state: {
        score: number;
    };
}, boolean>(({ state }) => state.score >= 80, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                score: {
                    type: "number"
                }
            },
            required: ["score"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_hf81d88ebaf5e = __cfHelpers.lift<{
    state: {
        count: number;
    };
}, boolean>(({ state }) => state.count === 0, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                count: {
                    type: "number"
                }
            },
            required: ["count"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_hfd1cf776e918 = __cfHelpers.lift<{
    state: {
        count: number;
    };
}, boolean>(({ state }) => state.count === 1, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                count: {
                    type: "number"
                }
            },
            required: ["count"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h8b2cca337f2b = __cfHelpers.lift<{
    state: {
        userType: string;
    };
}, boolean>(({ state }) => state.userType === "admin", {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                userType: {
                    type: "string"
                }
            },
            required: ["userType"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h1b1c89380d86 = __cfHelpers.lift<{
    state: {
        userType: string;
    };
}, boolean>(({ state }) => state.userType === "user", {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                userType: {
                    type: "string"
                }
            },
            required: ["userType"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_hbb9e3a8118a5 = __cfHelpers.lift<{
    state: {
        count: number;
    };
}, boolean>(({ state }) => state.count > 0, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                count: {
                    type: "number"
                }
            },
            required: ["count"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_hf41cec7a3d28 = __cfHelpers.lift<{
    state: {
        count: number;
    };
}, boolean>(({ state }) => state.count < 10, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                count: {
                    type: "number"
                }
            },
            required: ["count"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h1ceb9e35cb2e = __cfHelpers.lift<{
    state: {
        score: number;
    };
}, boolean>(({ state }) => state.score > 100, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                score: {
                    type: "number"
                }
            },
            required: ["score"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h9abe7ff5580a = __cfHelpers.lift<{
    state: {
        count: number;
    };
}, boolean>(({ state }) => state.count > 5, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                count: {
                    type: "number"
                }
            },
            required: ["count"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: jsx-conditional-rendering-no-name
// Verifies: same conditional rendering transforms work when pattern has no NAME export
//   cond ? a : b             → ifElse(schema..., cond, a, b)
//   ifElse(cond, <jsx>, <jsx>) → ifElse(schema..., cond, <jsx>, <jsx>)
// Context: Variant of jsx-conditional-rendering without [NAME], testing schema inference without name
export default pattern((state) => {
    return {
        [UI]: (<div>
        <h3>Basic Ternary</h3>
        <span>{__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Active", "Inactive"]
        } as const satisfies __cfHelpers.JSONSchema, state.key("isActive"), "Active", "Inactive")}</span>
        <span>{__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Authorized", "Denied"]
        } as const satisfies __cfHelpers.JSONSchema, state.key("hasPermission"), "Authorized", "Denied")}</span>

        <h3>Ternary with Comparisons</h3>
        <span>{__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["High", "Low"]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_h89148dfed5bb({ state: {
                count: state.key("count")
            } }), "High", "Low")}</span>
        <span>{__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["B", "C"]
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["B", "C", "A"]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_h80b473952880({ state: {
                score: state.key("score")
            } }), "A", __cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["B", "C"]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_h87a39eab30b0({ state: {
                score: state.key("score")
            } }), "B", "C"))}</span>
        <span>
          {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Single", "Multiple"]
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Single", "Multiple", "Empty"]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_hf81d88ebaf5e({ state: {
                count: state.key("count")
            } }), "Empty", __cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Single", "Multiple"]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_hfd1cf776e918({ state: {
                count: state.key("count")
            } }), "Single", "Multiple"))}
        </span>

        <h3>Nested Ternary</h3>
        <span>
          {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Premium Active", "Regular Active"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Inactive", "Premium Active", "Regular Active"]
        } as const satisfies __cfHelpers.JSONSchema, state.key("isActive"), __cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Premium Active", "Regular Active"]
        } as const satisfies __cfHelpers.JSONSchema, state.key("isPremium"), "Premium Active", "Regular Active"), "Inactive")}
        </span>
        <span>
          {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["User", "Guest"]
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["User", "Guest", "Admin"]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_h8b2cca337f2b({ state: {
                userType: state.key("userType")
            } }), "Admin", __cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["User", "Guest"]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_h1b1c89380d86({ state: {
                userType: state.key("userType")
            } }), "User", "Guest"))}
        </span>

        <h3>Complex Conditions</h3>
        <span>
          {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Full Access", "Limited Access"]
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.when({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, state.key("isActive"), state.key("hasPermission")), "Full Access", "Limited Access")}
        </span>
        <span>
          {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["In Range", "Out of Range"]
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.when({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_hbb9e3a8118a5({ state: {
                count: state.key("count")
            } }), __cfLift_hf41cec7a3d28({ state: {
                count: state.key("count")
            } })), "In Range", "Out of Range")}
        </span>
        <span>
          {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Premium Features", "Basic Features"]
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.unless({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, state.key("isPremium"), __cfLift_h1ceb9e35cb2e({ state: {
                score: state.key("score")
            } })), "Premium Features", "Basic Features")}
        </span>

        <h3>IfElse Component</h3>
        {ifElse({
                type: "boolean"
            } as const satisfies __cfHelpers.JSONSchema, {
                anyOf: [{}, {
                        type: "object",
                        properties: {}
                    }]
            } as const satisfies __cfHelpers.JSONSchema, {
                anyOf: [{}, {
                        type: "object",
                        properties: {}
                    }]
            } as const satisfies __cfHelpers.JSONSchema, {} as const satisfies __cfHelpers.JSONSchema, state.key("isActive"), <div>User is active with {state.key("count")} items</div>, <div>User is inactive</div>)}

        {ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {} as const satisfies __cfHelpers.JSONSchema, __cfLift_h9abe7ff5580a({ state: {
                count: state.key("count")
            } }), <ul>
            <li>Many items: {state.key("count")}</li>
          </ul>, <p>Few items: {state.key("count")}</p>)}
      </div>),
    };
}, {
    type: "object",
    properties: {
        isActive: {
            type: "boolean"
        },
        count: {
            type: "number"
        },
        userType: {
            type: "string"
        },
        score: {
            type: "number"
        },
        hasPermission: {
            type: "boolean"
        },
        isPremium: {
            type: "boolean"
        }
    },
    required: ["isActive", "count", "userType", "score", "hasPermission", "isPremium"]
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
    __cfLift_h89148dfed5bb,
    __cfLift_h80b473952880,
    __cfLift_h87a39eab30b0,
    __cfLift_hf81d88ebaf5e,
    __cfLift_hfd1cf776e918,
    __cfLift_h8b2cca337f2b,
    __cfLift_h1b1c89380d86,
    __cfLift_hbb9e3a8118a5,
    __cfLift_hf41cec7a3d28,
    __cfLift_h1ceb9e35cb2e,
    __cfLift_h9abe7ff5580a,
    __cfLift_1: __cfLift_h89148dfed5bb,
    __cfLift_2: __cfLift_h80b473952880,
    __cfLift_3: __cfLift_h87a39eab30b0,
    __cfLift_4: __cfLift_hf81d88ebaf5e,
    __cfLift_5: __cfLift_hfd1cf776e918,
    __cfLift_6: __cfLift_h8b2cca337f2b,
    __cfLift_7: __cfLift_h1b1c89380d86,
    __cfLift_8: __cfLift_hbb9e3a8118a5,
    __cfLift_9: __cfLift_hf41cec7a3d28,
    __cfLift_10: __cfLift_h1ceb9e35cb2e,
    __cfLift_11: __cfLift_h9abe7ff5580a
});
