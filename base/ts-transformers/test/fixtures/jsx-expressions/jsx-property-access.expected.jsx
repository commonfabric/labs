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
interface User {
    name: string;
    age: number;
    active: boolean;
    profile: {
        bio: string;
        location: string;
        settings: {
            theme: string;
            notifications: boolean;
        };
    };
}
interface Config {
    theme: {
        primaryColor: string;
        secondaryColor: string;
        fontSize: number;
    };
    features: {
        darkMode: boolean;
        beta: boolean;
    };
}
interface State {
    user: User;
    config: Config;
    items: string[];
    index: number;
    numbers: number[];
}
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        user: {
            age: number;
        };
    };
}, number>(({ state }) => state.user.age + 1, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                user: {
                    type: "object",
                    properties: {
                        age: {
                            type: "number"
                        }
                    },
                    required: ["age"]
                }
            },
            required: ["user"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    state: {
        user: {
            name: string;
        };
    };
}, string>(({ state }) => state.user.name.toUpperCase(), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                user: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        }
                    },
                    required: ["name"]
                }
            },
            required: ["user"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_3 = __cfHelpers.lift<{
    state: {
        user: {
            profile: {
                location: string;
            };
        };
    };
}, boolean>(({ state }) => state.user.profile.location.includes("City"), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                user: {
                    type: "object",
                    properties: {
                        profile: {
                            type: "object",
                            properties: {
                                location: {
                                    type: "string"
                                }
                            },
                            required: ["location"]
                        }
                    },
                    required: ["profile"]
                }
            },
            required: ["user"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_4 = __cfHelpers.lift<{
    state: {
        items: string[];
        index: number;
    };
}, string | undefined>(({ state }) => state.items[state.index], {
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
                index: {
                    type: "number"
                }
            },
            required: ["items", "index"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["string", "undefined"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_5 = __cfHelpers.lift<{
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
const __cfLift_6 = __cfHelpers.lift<{
    state: {
        numbers: number[];
        index: number;
    };
}, number | undefined>(({ state }) => state.numbers[state.index], {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                numbers: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                },
                index: {
                    type: "number"
                }
            },
            required: ["numbers", "index"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["number", "undefined"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_7 = __cfHelpers.lift<{
    state: {
        config: {
            theme: {
                fontSize: number;
            };
        };
    };
}, string>(({ state }) => state.config.theme.fontSize + "px", {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                config: {
                    type: "object",
                    properties: {
                        theme: {
                            type: "object",
                            properties: {
                                fontSize: {
                                    type: "number"
                                }
                            },
                            required: ["fontSize"]
                        }
                    },
                    required: ["theme"]
                }
            },
            required: ["config"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_8 = __cfHelpers.lift<{
    state: {
        user: {
            name: string;
            profile: {
                location: string;
            };
        };
    };
}, string>(({ state }) => state.user.name + " from " + state.user.profile.location, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                user: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        },
                        profile: {
                            type: "object",
                            properties: {
                                location: {
                                    type: "string"
                                }
                            },
                            required: ["location"]
                        }
                    },
                    required: ["name", "profile"]
                }
            },
            required: ["user"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_9 = __cfHelpers.lift<{
    state: {
        config: {
            theme: {
                fontSize: number;
            };
        };
    };
}, number>(({ state }) => state.config.theme.fontSize + 2, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                config: {
                    type: "object",
                    properties: {
                        theme: {
                            type: "object",
                            properties: {
                                fontSize: {
                                    type: "number"
                                }
                            },
                            required: ["fontSize"]
                        }
                    },
                    required: ["theme"]
                }
            },
            required: ["config"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: jsx-property-access
// Verifies: nested property access chains in JSX are converted to .key() or wrapped in a lift-applied computation
//   state.user.name                → state.key("user", "name")  (simple access, no lift)
//   state.user.age + 1             → lift(({state}) => state.user.age + 1)({ age })
//   state.items[state.index]       → lift(...)({ items, index })
// Context: Covers deep nesting, style bindings, array access, method calls on properties
export default pattern((state) => {
    return {
        [UI]: (<div>
        <h3>Basic Property Access</h3>
        <h1>{state.key("user", "name")}</h1>
        <p>Age: {state.key("user", "age")}</p>
        <p>Active: {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["No", "Yes"]
        } as const satisfies __cfHelpers.JSONSchema, state.key("user", "active"), "Yes", "No")}</p>

        <h3>Nested Property Access</h3>
        <p>Bio: {state.key("user", "profile", "bio")}</p>
        <p>Location: {state.key("user", "profile", "location")}</p>
        <p>Theme: {state.key("user", "profile", "settings", "theme")}</p>
        <p>
          Notifications:{" "}
          {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Off", "On"]
        } as const satisfies __cfHelpers.JSONSchema, state.key("user", "profile", "settings", "notifications"), "On", "Off")}
        </p>

        <h3>Property Access with Operations</h3>
        <p>Age + 1: {__cfLift_1({ state: {
                user: {
                    age: state.key("user", "age")
                }
            } })}</p>
        <p>Name length: {state.key("user", "name", "length")}</p>
        <p>Uppercase name: {__cfLift_2({ state: {
                user: {
                    name: state.key("user", "name")
                }
            } })}</p>
        <p>
          Location includes city:{" "}
          {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["No", "Yes"]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_3({ state: {
                user: {
                    profile: {
                        location: state.key("user", "profile", "location")
                    }
                }
            } }), "Yes", "No")}
        </p>

        <h3>Array Element Access</h3>
        <p>Item at index: {__cfLift_4({ state: {
                items: state.key("items"),
                index: state.key("index")
            } })}</p>
        <p>First item: {state.key("items", "0")}</p>
        <p>Last item: {__cfLift_5({ state: {
                items: state.key("items")
            } })}</p>
        <p>Number at index: {__cfLift_6({ state: {
                numbers: state.key("numbers"),
                index: state.key("index")
            } })}</p>

        <h3>Config Access with Styles</h3>
        <p style={{
            color: state.key("config", "theme", "primaryColor"),
            fontSize: __cfLift_7({ state: {
                    config: {
                        theme: {
                            fontSize: state.key("config", "theme", "fontSize")
                        }
                    }
                } }),
        }}>
          Styled text
        </p>
        <div style={{
            backgroundColor: __cfHelpers.ifElse({
                type: "boolean"
            } as const satisfies __cfHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __cfHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __cfHelpers.JSONSchema, {
                "enum": ["#333", "#fff"]
            } as const satisfies __cfHelpers.JSONSchema, state.key("config", "features", "darkMode"), "#333", "#fff"),
            borderColor: state.key("config", "theme", "secondaryColor"),
        }}>
          Theme-aware box
        </div>

        <h3>Complex Property Chains</h3>
        <p>{__cfLift_8({ state: {
                user: {
                    name: state.key("user", "name"),
                    profile: {
                        location: state.key("user", "profile", "location")
                    }
                }
            } })}</p>
        <p>Font size + 2: {__cfLift_9({ state: {
                config: {
                    theme: {
                        fontSize: state.key("config", "theme", "fontSize")
                    }
                }
            } })}px</p>
        <p>
          Has beta and dark mode:{" "}
          {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["No", "Yes"]
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.when({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, state.key("config", "features", "beta"), state.key("config", "features", "darkMode")), "Yes", "No")}
        </p>
      </div>),
    };
}, {
    type: "object",
    properties: {
        user: {
            $ref: "#/$defs/User"
        },
        config: {
            $ref: "#/$defs/Config"
        },
        items: {
            type: "array",
            items: {
                type: "string"
            }
        },
        index: {
            type: "number"
        },
        numbers: {
            type: "array",
            items: {
                type: "number"
            }
        }
    },
    required: ["user", "config", "items", "index", "numbers"],
    $defs: {
        Config: {
            type: "object",
            properties: {
                theme: {
                    type: "object",
                    properties: {
                        primaryColor: {
                            type: "string"
                        },
                        secondaryColor: {
                            type: "string"
                        },
                        fontSize: {
                            type: "number"
                        }
                    },
                    required: ["primaryColor", "secondaryColor", "fontSize"]
                },
                features: {
                    type: "object",
                    properties: {
                        darkMode: {
                            type: "boolean"
                        },
                        beta: {
                            type: "boolean"
                        }
                    },
                    required: ["darkMode", "beta"]
                }
            },
            required: ["theme", "features"]
        },
        User: {
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
                },
                profile: {
                    type: "object",
                    properties: {
                        bio: {
                            type: "string"
                        },
                        location: {
                            type: "string"
                        },
                        settings: {
                            type: "object",
                            properties: {
                                theme: {
                                    type: "string"
                                },
                                notifications: {
                                    type: "boolean"
                                }
                            },
                            required: ["theme", "notifications"]
                        }
                    },
                    required: ["bio", "location", "settings"]
                }
            },
            required: ["name", "age", "active", "profile"]
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
    __cfLift_1,
    __cfLift_2,
    __cfLift_3,
    __cfLift_4,
    __cfLift_5,
    __cfLift_6,
    __cfLift_7,
    __cfLift_8,
    __cfLift_9
});
