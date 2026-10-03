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
interface Spot {
    spotNumber: string;
}
interface Person {
    name: string;
    spotPreferences: string[];
}
interface State {
    spots: Spot[];
    people: Person[];
}
const __cfPattern_haef5fc049b98 = __cfHelpers.pattern(__cf_pattern_input => {
    const spot = __cf_pattern_input.key("element");
    const sn = spot.key("spotNumber");
    return <li>{sn}</li>;
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Spot"
        }
    },
    required: ["element"],
    $defs: {
        Spot: {
            type: "object",
            properties: {
                spotNumber: {
                    type: "string"
                }
            },
            required: ["spotNumber"]
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
const __cfLift_h08a94ce500b2 = __cfHelpers.lift<{
    spotPreferences: string[];
}, boolean>(({ spotPreferences }) => spotPreferences.length > 0, {
    type: "object",
    properties: {
        spotPreferences: {
            type: "array",
            items: {
                type: "unknown"
            }
        }
    },
    required: ["spotPreferences"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h7c1de21101a8 = __cfHelpers.lift<{
    spotPreferences: string[];
}, string>(({ spotPreferences }) => spotPreferences.map((n) => "#" + n).join(", "), {
    type: "object",
    properties: {
        spotPreferences: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["spotPreferences"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_hce187d7e99a4 = __cfHelpers.pattern(__cf_pattern_input => {
    const person = __cf_pattern_input.key("element");
    const name = person.key("name"), spotPreferences = person.key("spotPreferences");
    return (<li>
                <span>{name}</span>
                {__cfHelpers.ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{}, {
                type: "object",
                properties: {}
            }]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "null"
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{
                type: "null"
            }, {}, {
                type: "object",
                properties: {}
            }]
    } as const satisfies __cfHelpers.JSONSchema, __cfLift_h08a94ce500b2({ spotPreferences: spotPreferences }), <span>{__cfLift_h7c1de21101a8({ spotPreferences: spotPreferences })}</span>, null)}
              </li>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Person"
        }
    },
    required: ["element"],
    $defs: {
        Person: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                spotPreferences: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["name", "spotPreferences"]
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
// FIXTURE: map-body-destructure-cases
// Verifies: body-local destructuring inside reactive .map() callbacks lowers to key() access
//   const { spotNumber: sn } = spot        -> sn bound from spot.key("spotNumber")
//   const { name, spotPreferences } = ...  -> both aliases lowered from person.key(...)
//   spotPreferences.length                 -> spotPreferences.key("length")
//   spotPreferences.map(...).join(", ")    -> nested plain-array callback stays plain
// Context: Covers destructuring aliases declared inside the callback body, not only in the parameter list
export default pattern((state) => {
    return {
        [UI]: (<section>
        <ul>
          {state.key("spots").mapWithPattern(__cfPattern_haef5fc049b98, {})}
        </ul>

        <ul>
          {state.key("people").mapWithPattern(__cfPattern_hce187d7e99a4, {})}
        </ul>
      </section>),
    };
}, {
    type: "object",
    properties: {
        spots: {
            type: "array",
            items: {
                $ref: "#/$defs/Spot"
            }
        },
        people: {
            type: "array",
            items: {
                $ref: "#/$defs/Person"
            }
        }
    },
    required: ["spots", "people"],
    $defs: {
        Person: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                spotPreferences: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["name", "spotPreferences"]
        },
        Spot: {
            type: "object",
            properties: {
                spotNumber: {
                    type: "string"
                }
            },
            required: ["spotNumber"]
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
    __cfPattern_haef5fc049b98,
    __cfLift_h08a94ce500b2,
    __cfLift_h7c1de21101a8,
    __cfPattern_hce187d7e99a4,
    __cfPattern_1: __cfPattern_haef5fc049b98,
    __cfLift_1: __cfLift_h08a94ce500b2,
    __cfLift_2: __cfLift_h7c1de21101a8,
    __cfPattern_2: __cfPattern_hce187d7e99a4
});
