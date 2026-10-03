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
    user: {
        name: string;
        age: number;
        email: string;
        profile: {
            bio: string;
            location: string;
            website: string;
        };
        settings: {
            theme: string;
            notifications: boolean;
            privacy: string;
        };
    };
    config: {
        theme: {
            colors: {
                primary: string;
                secondary: string;
                background: string;
            };
            fonts: {
                heading: string;
                body: string;
                mono: string;
            };
            spacing: {
                small: number;
                medium: number;
                large: number;
            };
        };
        features: {
            darkMode: boolean;
            animations: boolean;
            betaFeatures: boolean;
        };
    };
    data: {
        items: Array<{
            id: number;
            name: string;
            value: number;
        }>;
        totals: {
            count: number;
            sum: number;
            average: number;
        };
    };
    deeply: {
        nested: {
            structure: {
                with: {
                    many: {
                        levels: {
                            value: string;
                            count: number;
                        };
                    };
                };
            };
        };
    };
    arrays: {
        first: string[];
        second: number[];
        nested: Array<{
            items: string[];
            count: number;
        }>;
    };
}
const __cfLift_h71e9d701c801 = __cfHelpers.lift<{
    state: {
        user: {
            name: string;
            profile: {
                location: string;
                bio: string;
            };
        };
    };
}, string>(({ state }) => state.user.name + " from " + state.user.profile.location + " - " +
    state.user.profile.bio, {
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
                                },
                                bio: {
                                    type: "string"
                                }
                            },
                            required: ["location", "bio"]
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
const __cfLift_he21c0225beb1 = __cfHelpers.lift<{
    state: {
        user: {
            age: number;
        };
    };
}, number>(({ state }) => state.user.age * 12, {
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
const __cfLift_h9e8d04319c76 = __cfHelpers.lift<{
    state: {
        user: {
            age: number;
        };
    };
}, number>(({ state }) => state.user.age * 365, {
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
const __cfLift_h60141b04cf72 = __cfHelpers.lift<{
    state: {
        user: {
            name: string;
            settings: {
                theme: string;
            };
        };
    };
}, string>(({ state }) => state.user.name + " has notifications on with " +
    state.user.settings.theme + " theme", {
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
                        settings: {
                            type: "object",
                            properties: {
                                theme: {
                                    type: "string"
                                }
                            },
                            required: ["theme"]
                        }
                    },
                    required: ["name", "settings"]
                }
            },
            required: ["user"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h92e2b22acbf8 = __cfHelpers.lift<{
    state: {
        user: {
            name: string;
        };
    };
}, string>(({ state }) => state.user.name + " has notifications off", {
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
const __cfLift_hdcaaec4b17d4 = __cfHelpers.lift<{
    state: {
        config: {
            theme: {
                spacing: {
                    small: number;
                    medium: number;
                    large: number;
                };
            };
        };
    };
}, number>(({ state }) => state.config.theme.spacing.small +
    state.config.theme.spacing.medium +
    state.config.theme.spacing.large, {
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
                                spacing: {
                                    type: "object",
                                    properties: {
                                        small: {
                                            type: "number"
                                        },
                                        medium: {
                                            type: "number"
                                        },
                                        large: {
                                            type: "number"
                                        }
                                    },
                                    required: ["small", "medium", "large"]
                                }
                            },
                            required: ["spacing"]
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
const __cfLift_hb13699ae58ef = __cfHelpers.lift<{
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
const __cfLift_h60316a6a3ad1 = __cfHelpers.lift<{
    state: {
        user: {
            email: string;
        };
    };
}, string>(({ state }) => state.user.email.toLowerCase(), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                user: {
                    type: "object",
                    properties: {
                        email: {
                            type: "string"
                        }
                    },
                    required: ["email"]
                }
            },
            required: ["user"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: parent-suppression-edge
// Verifies: property access suppression -- sibling properties share a captured parent in a lift-applied computation
//   {state.user.name} ... {state.user.age} → individual .key() or shared lift(...)({ user: {...} })
//   {state.config.theme.colors.primary}    → lift-applied computation with deeply nested capture
// Context: Tests that the transformer correctly deduplicates and suppresses parent captures
export default pattern((state) => {
    return {
        [UI]: (<div>
        <h3>Same Base, Different Properties</h3>
        {/* Multiple accesses to same object in one expression */}
        <p>
          User info: {state.key("user", "name")} (age: {state.key("user", "age")}, email:{" "}
          {state.key("user", "email")})
        </p>

        {/* String concatenation with multiple property accesses */}
        <p>
          Full profile:{" "}
          {__cfLift_h71e9d701c801({ state: {
                user: {
                    name: state.key("user", "name"),
                    profile: {
                        location: state.key("user", "profile", "location"),
                        bio: state.key("user", "profile", "bio")
                    }
                }
            } })}
        </p>

        {/* Arithmetic with multiple properties from same base */}
        <p>
          Age calculation: {__cfLift_he21c0225beb1({ state: {
                user: {
                    age: state.key("user", "age")
                }
            } })} months, or{" "}
          {__cfLift_h9e8d04319c76({ state: {
                user: {
                    age: state.key("user", "age")
                }
            } })} days
        </p>

        <h3>Deeply Nested Property Chains</h3>
        {/* Multiple references to deeply nested object */}
        <p>
          Theme: {state.key("config", "theme", "colors", "primary")} /{" "}
          {state.key("config", "theme", "colors", "secondary")} on{" "}
          {state.key("config", "theme", "colors", "background")}
        </p>

        {/* Fonts from same nested structure */}
        <p>
          Typography: Headings in {state.key("config", "theme", "fonts", "heading")}, body in
          {" "}
          {state.key("config", "theme", "fonts", "body")}, code in{" "}
          {state.key("config", "theme", "fonts", "mono")}
        </p>

        {/* Mixed depth accesses */}
        <p>
          Config summary: Dark mode{" "}
          {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["enabled", "disabled"]
        } as const satisfies __cfHelpers.JSONSchema, state.key("config", "features", "darkMode"), "enabled", "disabled")} with{" "}
          {state.key("config", "theme", "colors", "primary")} primary color
        </p>

        <h3>Very Deep Nesting with Multiple References</h3>
        {/* Accessing different properties at same deep level */}
        <p>
          Deep value: {state.key("deeply", "nested", "structure", "with", "many", "levels", "value")}
          {" "}
          (count: {state.key("deeply", "nested", "structure", "with", "many", "levels", "count")})
        </p>

        {/* Mixed depth from same root */}
        <p>
          Mixed depths: {state.key("deeply", "nested", "structure", "with", "many", "levels", "value")}
          {" "}
          in {state.key("deeply", "nested", "structure", "with", "many", "levels", "count")} items
        </p>

        <h3>Arrays with Shared Base</h3>
        {/* Multiple array properties */}
        <p>
          Array info: First has {state.key("arrays", "first", "length")} items, second has
          {" "}
          {state.key("arrays", "second", "length")} items
        </p>

        {/* Nested array access with shared base */}
        <p>
          Nested: {state.key("arrays", "nested", "0")!.items.length} items in first, count is
          {" "}
          {state.key("arrays", "nested", "0")!.count}
        </p>

        {/* Array and property access mixed */}
        <p>
          First item: {state.key("arrays", "first", "0")} (total:{" "}
          {state.key("arrays", "first", "length")})
        </p>

        <h3>Complex Expressions with Shared Bases</h3>
        {/* Conditional with multiple property accesses */}
        <p>
          Status: {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, state.key("user", "settings", "notifications"), __cfLift_h60141b04cf72({ state: {
                user: {
                    name: state.key("user", "name"),
                    settings: {
                        theme: state.key("user", "settings", "theme")
                    }
                }
            } }), __cfLift_h92e2b22acbf8({ state: {
                user: {
                    name: state.key("user", "name")
                }
            } }))}
        </p>

        {/* Computed expression with shared base */}
        <p>
          Spacing calc: {__cfLift_hdcaaec4b17d4({ state: {
                config: {
                    theme: {
                        spacing: {
                            small: state.key("config", "theme", "spacing", "small"),
                            medium: state.key("config", "theme", "spacing", "medium"),
                            large: state.key("config", "theme", "spacing", "large")
                        }
                    }
                }
            } })} total
        </p>

        {/* Boolean expressions with multiple properties */}
        <p>
          Features:{" "}
          {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Full features", "Limited features"]
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.when({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, state.key("config", "features", "darkMode"), state.key("config", "features", "animations")), "Full features", "Limited features")}
        </p>

        <h3>Method Calls on Shared Bases</h3>
        {/* Multiple method calls on properties from same base */}
        <p>
          Formatted: {__cfLift_hb13699ae58ef({ state: {
                user: {
                    name: state.key("user", "name")
                }
            } })} -{" "}
          {__cfLift_h60316a6a3ad1({ state: {
                user: {
                    email: state.key("user", "email")
                }
            } })}
        </p>

        {/* Property access and method calls mixed */}
        <p>
          Profile length: {state.key("user", "profile", "bio", "length")} chars in bio,{" "}
          {state.key("user", "profile", "location", "length")} chars in location
        </p>

        <h3>Edge Cases for Parent Suppression</h3>
        {/* Same intermediate parent used differently */}
        <p>
          User settings: Theme is {state.key("user", "settings", "theme")} with privacy{" "}
          {state.key("user", "settings", "privacy")}
        </p>

        {/* Parent and child both used */}
        <p>
          Data summary: {state.key("data", "items", "length")} items with average{" "}
          {state.key("data", "totals", "average")}
        </p>

        {/* Multiple levels of the same chain */}
        <p>
          Nested refs: {state.key("config", "theme", "colors", "primary")} in{" "}
          {state.key("config", "theme", "fonts", "body")} with{" "}
          {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["animations", "no animations"]
        } as const satisfies __cfHelpers.JSONSchema, state.key("config", "features", "animations"), "animations", "no animations")}
        </p>

        <h3>Extreme Parent Suppression Test</h3>
        {/* Using every level of a deep chain */}
        <p>
          All levels: Root: {__cfHelpers.ifElse({
            type: "object",
            properties: {
                nested: {
                    type: "object",
                    properties: {
                        structure: {
                            type: "object",
                            properties: {
                                "with": {
                                    type: "object",
                                    properties: {
                                        many: {
                                            type: "object",
                                            properties: {
                                                levels: {
                                                    type: "object",
                                                    properties: {
                                                        value: {
                                                            type: "string"
                                                        },
                                                        count: {
                                                            type: "number"
                                                        }
                                                    },
                                                    required: ["value", "count"]
                                                }
                                            },
                                            required: ["levels"]
                                        }
                                    },
                                    required: ["many"]
                                }
                            },
                            required: ["with"]
                        }
                    },
                    required: ["structure"]
                }
            },
            required: ["nested"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["exists", "missing"]
        } as const satisfies __cfHelpers.JSONSchema, state.key("deeply"), "exists", "missing")}, Nested:{" "}
          {__cfHelpers.ifElse({
            type: "object",
            properties: {
                structure: {
                    type: "object",
                    properties: {
                        "with": {
                            type: "object",
                            properties: {
                                many: {
                                    type: "object",
                                    properties: {
                                        levels: {
                                            type: "object",
                                            properties: {
                                                value: {
                                                    type: "string"
                                                },
                                                count: {
                                                    type: "number"
                                                }
                                            },
                                            required: ["value", "count"]
                                        }
                                    },
                                    required: ["levels"]
                                }
                            },
                            required: ["many"]
                        }
                    },
                    required: ["with"]
                }
            },
            required: ["structure"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["exists", "missing"]
        } as const satisfies __cfHelpers.JSONSchema, state.key("deeply", "nested"), "exists", "missing")}, Value:{" "}
          {state.key("deeply", "nested", "structure", "with", "many", "levels", "value")}
        </p>
      </div>),
    };
}, {
    type: "object",
    properties: {
        user: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                age: {
                    type: "number"
                },
                email: {
                    type: "string"
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
                        website: {
                            type: "string"
                        }
                    },
                    required: ["bio", "location", "website"]
                },
                settings: {
                    type: "object",
                    properties: {
                        theme: {
                            type: "string"
                        },
                        notifications: {
                            type: "boolean"
                        },
                        privacy: {
                            type: "string"
                        }
                    },
                    required: ["theme", "notifications", "privacy"]
                }
            },
            required: ["name", "age", "email", "profile", "settings"]
        },
        config: {
            type: "object",
            properties: {
                theme: {
                    type: "object",
                    properties: {
                        colors: {
                            type: "object",
                            properties: {
                                primary: {
                                    type: "string"
                                },
                                secondary: {
                                    type: "string"
                                },
                                background: {
                                    type: "string"
                                }
                            },
                            required: ["primary", "secondary", "background"]
                        },
                        fonts: {
                            type: "object",
                            properties: {
                                heading: {
                                    type: "string"
                                },
                                body: {
                                    type: "string"
                                },
                                mono: {
                                    type: "string"
                                }
                            },
                            required: ["heading", "body", "mono"]
                        },
                        spacing: {
                            type: "object",
                            properties: {
                                small: {
                                    type: "number"
                                },
                                medium: {
                                    type: "number"
                                },
                                large: {
                                    type: "number"
                                }
                            },
                            required: ["small", "medium", "large"]
                        }
                    },
                    required: ["colors", "fonts", "spacing"]
                },
                features: {
                    type: "object",
                    properties: {
                        darkMode: {
                            type: "boolean"
                        },
                        animations: {
                            type: "boolean"
                        },
                        betaFeatures: {
                            type: "boolean"
                        }
                    },
                    required: ["darkMode", "animations", "betaFeatures"]
                }
            },
            required: ["theme", "features"]
        },
        data: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: {
                                type: "number"
                            },
                            name: {
                                type: "string"
                            },
                            value: {
                                type: "number"
                            }
                        },
                        required: ["id", "name", "value"]
                    }
                },
                totals: {
                    type: "object",
                    properties: {
                        count: {
                            type: "number"
                        },
                        sum: {
                            type: "number"
                        },
                        average: {
                            type: "number"
                        }
                    },
                    required: ["count", "sum", "average"]
                }
            },
            required: ["items", "totals"]
        },
        deeply: {
            type: "object",
            properties: {
                nested: {
                    type: "object",
                    properties: {
                        structure: {
                            type: "object",
                            properties: {
                                "with": {
                                    type: "object",
                                    properties: {
                                        many: {
                                            type: "object",
                                            properties: {
                                                levels: {
                                                    type: "object",
                                                    properties: {
                                                        value: {
                                                            type: "string"
                                                        },
                                                        count: {
                                                            type: "number"
                                                        }
                                                    },
                                                    required: ["value", "count"]
                                                }
                                            },
                                            required: ["levels"]
                                        }
                                    },
                                    required: ["many"]
                                }
                            },
                            required: ["with"]
                        }
                    },
                    required: ["structure"]
                }
            },
            required: ["nested"]
        },
        arrays: {
            type: "object",
            properties: {
                first: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                },
                second: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                },
                nested: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            items: {
                                type: "array",
                                items: {
                                    type: "string"
                                }
                            },
                            count: {
                                type: "number"
                            }
                        },
                        required: ["items", "count"]
                    }
                }
            },
            required: ["first", "second", "nested"]
        }
    },
    required: ["user", "config", "data", "deeply", "arrays"]
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
    __cfLift_h71e9d701c801,
    __cfLift_he21c0225beb1,
    __cfLift_h9e8d04319c76,
    __cfLift_h60141b04cf72,
    __cfLift_h92e2b22acbf8,
    __cfLift_hdcaaec4b17d4,
    __cfLift_hb13699ae58ef,
    __cfLift_h60316a6a3ad1,
    __cfLift_1: __cfLift_h71e9d701c801,
    __cfLift_2: __cfLift_he21c0225beb1,
    __cfLift_3: __cfLift_h9e8d04319c76,
    __cfLift_4: __cfLift_h60141b04cf72,
    __cfLift_5: __cfLift_h92e2b22acbf8,
    __cfLift_6: __cfLift_hdcaaec4b17d4,
    __cfLift_7: __cfLift_hb13699ae58ef,
    __cfLift_8: __cfLift_h60316a6a3ad1
});
