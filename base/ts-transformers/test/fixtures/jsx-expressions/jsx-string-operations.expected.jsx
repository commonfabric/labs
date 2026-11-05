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
    firstName: string;
    lastName: string;
    title: string;
    message: string;
    count: number;
}
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        title: string;
        firstName: string;
        lastName: string;
    };
}, string>(({ state }) => state.title + ": " + state.firstName + " " + state.lastName, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                },
                firstName: {
                    type: "string"
                },
                lastName: {
                    type: "string"
                }
            },
            required: ["title", "firstName", "lastName"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    state: {
        firstName: string;
        lastName: string;
    };
}, string>(({ state }) => state.firstName + state.lastName, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                firstName: {
                    type: "string"
                },
                lastName: {
                    type: "string"
                }
            },
            required: ["firstName", "lastName"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_3 = __cfHelpers.lift<{
    state: {
        firstName: string;
    };
}, string>(({ state }) => "Hello, " + state.firstName + "!", {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                firstName: {
                    type: "string"
                }
            },
            required: ["firstName"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_4 = __cfHelpers.lift<{
    state: {
        firstName: string;
    };
}, string>(({ state }) => `Welcome, ${state.firstName}!`, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                firstName: {
                    type: "string"
                }
            },
            required: ["firstName"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_5 = __cfHelpers.lift<{
    state: {
        firstName: string;
        lastName: string;
    };
}, string>(({ state }) => `Full name: ${state.firstName} ${state.lastName}`, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                firstName: {
                    type: "string"
                },
                lastName: {
                    type: "string"
                }
            },
            required: ["firstName", "lastName"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_6 = __cfHelpers.lift<{
    state: {
        title: string;
        firstName: string;
        lastName: string;
    };
}, string>(({ state }) => `${state.title}: ${state.firstName} ${state.lastName}`, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                },
                firstName: {
                    type: "string"
                },
                lastName: {
                    type: "string"
                }
            },
            required: ["title", "firstName", "lastName"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_7 = __cfHelpers.lift<{
    state: {
        firstName: string;
    };
}, string>(({ state }) => state.firstName.toUpperCase(), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                firstName: {
                    type: "string"
                }
            },
            required: ["firstName"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_8 = __cfHelpers.lift<{
    state: {
        title: string;
    };
}, string>(({ state }) => state.title.toLowerCase(), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                }
            },
            required: ["title"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_9 = __cfHelpers.lift<{
    state: {
        message: string;
    };
}, string>(({ state }) => state.message.substring(0, 5), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                message: {
                    type: "string"
                }
            },
            required: ["message"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_10 = __cfHelpers.lift<{
    state: {
        firstName: string;
        count: number;
    };
}, string>(({ state }) => state.firstName + " has " + state.count + " items", {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                firstName: {
                    type: "string"
                },
                count: {
                    type: "number"
                }
            },
            required: ["firstName", "count"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_11 = __cfHelpers.lift<{
    state: {
        firstName: string;
        count: number;
    };
}, string>(({ state }) => `${state.firstName} has ${state.count} items`, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                firstName: {
                    type: "string"
                },
                count: {
                    type: "number"
                }
            },
            required: ["firstName", "count"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_12 = __cfHelpers.lift<{
    state: {
        count: number;
    };
}, string>(({ state }) => "Count: " + state.count, {
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
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: jsx-string-operations
// Verifies: string concatenation, template literals, and string methods in JSX are wrapped in a lift-applied computation
//   state.title + ": " + state.firstName → lift(...)({ title, firstName })
//   `Welcome, ${state.firstName}!`       → lift(...)({ firstName })
//   state.firstName.toUpperCase()        → lift(...)({ firstName })
export default pattern((state) => {
    return {
        [UI]: (<div>
        <h3>String Concatenation</h3>
        <h1>{__cfLift_1({ state: {
                title: state.key("title"),
                firstName: state.key("firstName"),
                lastName: state.key("lastName")
            } })}</h1>
        <p>{__cfLift_2({ state: {
                firstName: state.key("firstName"),
                lastName: state.key("lastName")
            } })}</p>
        <p>{__cfLift_3({ state: {
                firstName: state.key("firstName")
            } })}</p>

        <h3>Template Literals</h3>
        <p>{__cfLift_4({ state: {
                firstName: state.key("firstName")
            } })}</p>
        <p>{__cfLift_5({ state: {
                firstName: state.key("firstName"),
                lastName: state.key("lastName")
            } })}</p>
        <p>{__cfLift_6({ state: {
                title: state.key("title"),
                firstName: state.key("firstName"),
                lastName: state.key("lastName")
            } })}</p>

        <h3>String Methods</h3>
        <p>Uppercase: {__cfLift_7({ state: {
                firstName: state.key("firstName")
            } })}</p>
        <p>Lowercase: {__cfLift_8({ state: {
                title: state.key("title")
            } })}</p>
        <p>Length: {state.key("message", "length")}</p>
        <p>Substring: {__cfLift_9({ state: {
                message: state.key("message")
            } })}</p>

        <h3>Mixed String and Number</h3>
        <p>{__cfLift_10({ state: {
                firstName: state.key("firstName"),
                count: state.key("count")
            } })}</p>
        <p>{__cfLift_11({ state: {
                firstName: state.key("firstName"),
                count: state.key("count")
            } })}</p>
        <p>Count as string: {__cfLift_12({ state: {
                count: state.key("count")
            } })}</p>
      </div>),
    };
}, {
    type: "object",
    properties: {
        firstName: {
            type: "string"
        },
        lastName: {
            type: "string"
        },
        title: {
            type: "string"
        },
        message: {
            type: "string"
        },
        count: {
            type: "number"
        }
    },
    required: ["firstName", "lastName", "title", "message", "count"]
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
    __cfLift_12
});
