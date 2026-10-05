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
interface Spot {
    active: boolean;
    spotNumber: string;
    label?: string;
}
interface Person {
    name: string;
    email: string;
    commuteMode: string;
    priorityRank: number;
    defaultSpot?: string;
    spotPreferences: string[];
    isFirst: boolean;
    isLast: boolean;
}
interface State {
    people: Person[];
    editingPersonName: string | null;
    removePersonConfirmTarget: string | null;
    spots: Spot[];
}
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        editingPersonName: string | null;
    };
    personName: string;
}, boolean>(({ state, personName }) => state.editingPersonName === personName, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                editingPersonName: {
                    anyOf: [{
                            type: "string"
                        }, {
                            type: "null"
                        }]
                }
            },
            required: ["editingPersonName"]
        },
        personName: {
            type: "string"
        }
    },
    required: ["state", "personName"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift<{
    state: {
        removePersonConfirmTarget: string | null;
    };
    personName: string;
}, boolean>(({ state, personName }) => state.removePersonConfirmTarget === personName, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                removePersonConfirmTarget: {
                    anyOf: [{
                            type: "string"
                        }, {
                            type: "null"
                        }]
                }
            },
            required: ["removePersonConfirmTarget"]
        },
        personName: {
            type: "string"
        }
    },
    required: ["state", "personName"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_3 = __cfHelpers.lift<{
    state: {
        spots: {
            spotNumber: string;
            label?: string | undefined;
            active: boolean;
        }[];
    };
}, { label: string; value: string; }[]>(({ state }) => state.spots
    .filter((s) => s.active)
    .map((s) => ({
    label: "#" + s.spotNumber + (s.label ? " - " + s.label : ""),
    value: s.spotNumber,
})), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                spots: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            spotNumber: {
                                type: "string"
                            },
                            label: {
                                type: "string"
                            },
                            active: {
                                type: "boolean"
                            }
                        },
                        required: ["spotNumber", "active"]
                    }
                }
            },
            required: ["spots"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "object",
        properties: {
            label: {
                type: "string"
            },
            value: {
                type: "string"
            }
        },
        required: ["label", "value"]
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_4 = __cfHelpers.lift<{
    activeSpotOpts: {
        length: number;
    };
}, boolean>(({ activeSpotOpts }) => activeSpotOpts.length > 0, {
    type: "object",
    properties: {
        activeSpotOpts: {
            type: "object",
            properties: {
                length: {
                    type: "number"
                }
            },
            required: ["length"]
        }
    },
    required: ["activeSpotOpts"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_5 = __cfHelpers.lift<{
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
const __cfLift_6 = __cfHelpers.lift<{
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
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const person = __cf_pattern_input.key("element");
    const state = __cf_pattern_input.key("params", "state");
    const personName = person.key("name"), email = person.key("email"), commuteMode = person.key("commuteMode"), priorityRank = person.key("priorityRank"), defaultSpot = person.key("defaultSpot"), spotPreferences = person.key("spotPreferences"), isFirst = person.key("isFirst"), isLast = person.key("isLast");
    const isEditing = __cfLift_1({
        state: {
            editingPersonName: state.key("editingPersonName")
        },
        personName: personName
    }).for("isEditing", true);
    const isRemoveConfirm = __cfLift_2({
        state: {
            removePersonConfirmTarget: state.key("removePersonConfirmTarget")
        },
        personName: personName
    }).for("isRemoveConfirm", true);
    const activeSpotOpts = __cfLift_3({ state: {
            spots: state.key("spots")
        } }).for("activeSpotOpts", true);
    return (<section>
              <span>{personName}</span>
              <span>{email}</span>
              <span>{commuteMode}</span>
              <span>{priorityRank}</span>
              {__cfHelpers.ifElse({
        type: ["string", "undefined"]
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
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "null"
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{
                type: "null"
            }, {
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
    } as const satisfies __cfHelpers.JSONSchema, defaultSpot, <span>{defaultSpot}</span>, null)}
              {__cfHelpers.ifElse({
        type: "boolean"
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
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "null"
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{
                type: "null"
            }, {
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
    } as const satisfies __cfHelpers.JSONSchema, isFirst, <span>first</span>, null)}
              {__cfHelpers.ifElse({
        type: "boolean"
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
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "null"
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{
                type: "null"
            }, {
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
    } as const satisfies __cfHelpers.JSONSchema, isLast, <span>last</span>, null)}
              {__cfHelpers.ifElse({
        type: "boolean"
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
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "null"
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{
                type: "null"
            }, {
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
    } as const satisfies __cfHelpers.JSONSchema, isEditing, <span>editing</span>, null)}
              {__cfHelpers.ifElse({
        type: "boolean"
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
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "null"
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{
                type: "null"
            }, {
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
    } as const satisfies __cfHelpers.JSONSchema, isRemoveConfirm, <span>removing</span>, null)}
              {__cfHelpers.ifElse({
        type: "boolean"
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
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "null"
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{
                type: "null"
            }, {
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
    } as const satisfies __cfHelpers.JSONSchema, __cfLift_4({ activeSpotOpts: {
            length: activeSpotOpts.key("length")
        } }), <span>spots</span>, null)}
              {__cfHelpers.ifElse({
        type: "boolean"
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
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "null"
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{
                type: "null"
            }, {
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
    } as const satisfies __cfHelpers.JSONSchema, __cfLift_5({ spotPreferences: spotPreferences }), <span>
                    Prefers: {__cfLift_6({ spotPreferences: spotPreferences })}
                  </span>, null)}
            </section>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Person"
        },
        params: {
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        editingPersonName: {
                            anyOf: [{
                                    type: "string"
                                }, {
                                    type: "null"
                                }]
                        },
                        removePersonConfirmTarget: {
                            anyOf: [{
                                    type: "string"
                                }, {
                                    type: "null"
                                }]
                        },
                        spots: {
                            type: "array",
                            items: {
                                $ref: "#/$defs/Spot"
                            }
                        }
                    },
                    required: ["editingPersonName", "removePersonConfirmTarget", "spots"]
                }
            },
            required: ["state"]
        }
    },
    required: ["element", "params"],
    $defs: {
        Spot: {
            type: "object",
            properties: {
                active: {
                    type: "boolean"
                },
                spotNumber: {
                    type: "string"
                },
                label: {
                    type: "string"
                }
            },
            required: ["active", "spotNumber"]
        },
        Person: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                email: {
                    type: "string"
                },
                commuteMode: {
                    type: "string"
                },
                priorityRank: {
                    type: "number"
                },
                defaultSpot: {
                    type: "string"
                },
                spotPreferences: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                },
                isFirst: {
                    type: "boolean"
                },
                isLast: {
                    type: "boolean"
                }
            },
            required: ["name", "email", "commuteMode", "priorityRank", "spotPreferences", "isFirst", "isLast"]
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
// FIXTURE: map-parking-style-join
// Verifies: nested plain-array joins inside a reactive map callback stay plain in complex branches
//   state.people.map(fn)                    -> state.key("people").mapWithPattern(pattern(...), ...)
//   state.spots.filter(...).map(... )       -> lift(...)(...).filter(...).map(...) stays plain inside computed()
//   spotPreferences.map((n) => "#" + n)     -> nested plain-array callback stays plain and does not capture n
// Context: Realistic callback body mixing computed aliases, destructuring, conditional JSX, and joined plain-array labels
export default pattern((state) => {
    return {
        [UI]: (<div>
        {state.key("people").mapWithPattern(__cfPattern_1, {
                state: {
                    editingPersonName: state.key("editingPersonName"),
                    removePersonConfirmTarget: state.key("removePersonConfirmTarget"),
                    spots: state.key("spots")
                }
            })}
      </div>),
    };
}, {
    type: "object",
    properties: {
        people: {
            type: "array",
            items: {
                $ref: "#/$defs/Person"
            }
        },
        editingPersonName: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "null"
                }]
        },
        removePersonConfirmTarget: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "null"
                }]
        },
        spots: {
            type: "array",
            items: {
                $ref: "#/$defs/Spot"
            }
        }
    },
    required: ["people", "editingPersonName", "removePersonConfirmTarget", "spots"],
    $defs: {
        Spot: {
            type: "object",
            properties: {
                active: {
                    type: "boolean"
                },
                spotNumber: {
                    type: "string"
                },
                label: {
                    type: "string"
                }
            },
            required: ["active", "spotNumber"]
        },
        Person: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                email: {
                    type: "string"
                },
                commuteMode: {
                    type: "string"
                },
                priorityRank: {
                    type: "number"
                },
                defaultSpot: {
                    type: "string"
                },
                spotPreferences: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                },
                isFirst: {
                    type: "boolean"
                },
                isLast: {
                    type: "boolean"
                }
            },
            required: ["name", "email", "commuteMode", "priorityRank", "spotPreferences", "isFirst", "isLast"]
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
    __cfPattern_1
});
