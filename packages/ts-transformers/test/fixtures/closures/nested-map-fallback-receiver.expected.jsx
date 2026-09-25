function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { action, Default, pattern, UI, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Person {
    name: string;
}
interface State {
    rows: Default<Array<{
        id: string;
        label: string;
    }>, [
    ]>;
}
const __cfHandler_hb20549a97e67 = __cfHelpers.handler({
    type: "object",
    properties: {
        name: {
            type: "string"
        }
    },
    required: ["name"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        assignName: {
            type: "string",
            asCell: [{
                    kind: "cell",
                    scope: "space"
                }]
        }
    },
    required: ["assignName"]
} as const satisfies __cfHelpers.JSONSchema, (p, { assignName }) => assignName.set(p.name));
const __cfLift_hec8401e03c4b = __cfHelpers.lift<{
    people: __cfHelpers.PerSpace<__cfHelpers.Cell<Person[]>>;
}, readonly Person[]>(({ people }) => people.get(), {
    type: "object",
    properties: {
        people: {
            type: "array",
            items: {
                $ref: "#/$defs/Person"
            },
            asCell: [{
                    kind: "cell",
                    scope: "space"
                }]
        }
    },
    required: ["people"],
    $defs: {
        Person: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        $ref: "#/$defs/Person"
    },
    $defs: {
        Person: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfHandler_h2a93a514867f = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        p: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        },
        setAssign: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"],
            asCell: ["stream"]
        }
    },
    required: ["p", "setAssign"]
} as const satisfies __cfHelpers.JSONSchema, (__cf_handler_event, { setAssign, p }) => setAssign.send({ name: p.name }));
const __cfPattern_h82f00529d775 = __cfHelpers.pattern(__cf_pattern_input => {
    const p = __cf_pattern_input.key("element");
    const setAssign = __cf_pattern_input.key("params", "setAssign");
    return (<button type="button" onClick={__cfHandler_h2a93a514867f({
        setAssign: setAssign,
        p: {
            name: p.key("name")
        }
    })}>
                {p.key("name")}
              </button>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Person"
        },
        params: {
            type: "object",
            properties: {
                setAssign: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        }
                    },
                    required: ["name"],
                    asCell: ["stream"]
                }
            },
            required: ["setAssign"]
        }
    },
    required: ["element", "params"],
    $defs: {
        Person: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
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
const __cfPattern_h425affd75001 = __cfHelpers.pattern(__cf_pattern_input => {
    const row = __cf_pattern_input.key("element");
    const people = __cf_pattern_input.key("params", "people");
    const setAssign = __cf_pattern_input.key("params", "setAssign");
    return (<div>
            <span>{row.key("label")}</span>
            {(__cfLift_hec8401e03c4b({ people: people }) ?? []).mapWithPattern(__cfPattern_h82f00529d775, {
            setAssign: setAssign
        })}
          </div>);
}, {
    type: "object",
    properties: {
        element: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                label: {
                    type: "string"
                }
            },
            required: ["id", "label"]
        },
        params: {
            type: "object",
            properties: {
                people: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Person"
                    },
                    asCell: [{
                            kind: "cell",
                            scope: "space"
                        }]
                },
                setAssign: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        }
                    },
                    required: ["name"],
                    asCell: ["stream"]
                }
            },
            required: ["people", "setAssign"]
        }
    },
    required: ["element", "params"],
    $defs: {
        Person: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
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
// FIXTURE: nested-map-fallback-receiver
// Verifies: a fallback-receiver array method — (reactiveCall() ?? []).map(...) —
//   nested INSIDE another .map() callback is lowered to mapWithPattern, so its
//   inner closure (which captures a sibling pattern cell) is threaded through
//   params instead of being illegally accessed across frames.
//     rows.map((row) => (people.get() ?? []).map((p) => ... setAssign ...))
//       → rows.mapWithPattern(pattern(... (lift(...)(...) ?? []).mapWithPattern(...) ...))
// Context: This is CT-1626. Before the fix, the inner `(people.get() ?? [])`
//   receiver — a `??` binary whose LHS is a reactive (lift-applied) call —
//   was classified as a plain `T[]` receiver, so the inner `.map` stayed a raw
//   CellImpl.map and threw at construction ("Reactive reference from outer
//   scope cannot be accessed via closure"). The `?? []` guard (correct for the
//   scoped-cell-undefined-before-sync race) is exactly what hid the reactive
//   receiver from the transformer.
export default pattern((__cf_pattern_input) => {
    const rows = __cf_pattern_input.key("rows");
    const people = Writable.perSpace.of<Person[]>([], {
        type: "array",
        items: {
            $ref: "#/$defs/Person"
        },
        $defs: {
            Person: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    }
                },
                required: ["name"]
            }
        },
        scope: "space"
    } as const satisfies __cfHelpers.JSONSchema).for("people", true);
    const assignName = Writable.perSpace.of<string>("", {
        type: "string",
        scope: "space"
    } as const satisfies __cfHelpers.JSONSchema).for("assignName", true);
    const setAssign = __cfHandler_hb20549a97e67({
        assignName: assignName
    }).for({ stream: "setAssign" }, true);
    return {
        [UI]: (<div>
        {rows.mapWithPattern(__cfPattern_h425affd75001, {
                people: people,
                setAssign: setAssign
            })}
      </div>),
    };
}, {
    type: "object",
    properties: {
        rows: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: {
                        type: "string"
                    },
                    label: {
                        type: "string"
                    }
                },
                required: ["id", "label"]
            },
            "default": []
        }
    },
    required: ["rows"]
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
    __cfHandler_hb20549a97e67,
    __cfLift_hec8401e03c4b,
    __cfHandler_h2a93a514867f,
    __cfPattern_h82f00529d775,
    __cfPattern_h425affd75001,
    __cfHandler_1: __cfHandler_hb20549a97e67,
    __cfLift_1: __cfLift_hec8401e03c4b,
    __cfHandler_2: __cfHandler_h2a93a514867f,
    __cfPattern_1: __cfPattern_h82f00529d775,
    __cfPattern_2: __cfPattern_h425affd75001
});
