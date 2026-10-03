function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Writable, computed, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Habit {
    name: string;
}
interface HabitLog {
    habitName: string;
    date: string;
    completed: boolean;
}
interface Input {
    habits: Habit[];
    logs: Writable<HabitLog[]>;
    todayDate: string;
}
const __cfLift_h093ae1e435d0 = __cfHelpers.lift<{
    logs: __cfHelpers.ReadonlyCell<HabitLog[]>;
    habit: {
        name: string;
    };
    todayDate: string;
}, boolean>(({ logs, habit, todayDate }) => logs.get().some((log) => log.habitName === habit.name &&
    log.date === todayDate &&
    log.completed), {
    type: "object",
    properties: {
        logs: {
            type: "array",
            items: {
                $ref: "#/$defs/HabitLog"
            },
            asCell: ["readonly"]
        },
        habit: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        },
        todayDate: {
            type: "string"
        }
    },
    required: ["logs", "habit", "todayDate"],
    $defs: {
        HabitLog: {
            type: "object",
            properties: {
                habitName: {
                    type: "string"
                },
                date: {
                    type: "string"
                },
                completed: {
                    type: "boolean"
                }
            },
            required: ["habitName", "date", "completed"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfPattern_h7539fce3615a = __cfHelpers.pattern(__cf_pattern_input => {
    const habit = __cf_pattern_input.key("element");
    const logs = __cf_pattern_input.key("params", "logs");
    const todayDate = __cf_pattern_input.key("params", "todayDate");
    const doneToday = __cfLift_h093ae1e435d0({
        logs: logs,
        habit: {
            name: habit.key("name")
        },
        todayDate: todayDate
    }).for("doneToday", true);
    return <span>{__cfHelpers.ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        "enum": ["yes", "no"]
    } as const satisfies __cfHelpers.JSONSchema, doneToday, "yes", "no")}</span>;
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Habit"
        },
        params: {
            type: "object",
            properties: {
                logs: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/HabitLog"
                    },
                    asCell: ["readonly"]
                },
                todayDate: {
                    type: "string"
                }
            },
            required: ["logs", "todayDate"]
        }
    },
    required: ["element", "params"],
    $defs: {
        HabitLog: {
            type: "object",
            properties: {
                habitName: {
                    type: "string"
                },
                date: {
                    type: "string"
                },
                completed: {
                    type: "boolean"
                }
            },
            required: ["habitName", "date", "completed"]
        },
        Habit: {
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
// FIXTURE: map-plain-array-some-in-computed
// Verifies: plain-array callbacks nested inside computed() remain plain even inside a reactive outer map callback
//   habits.map(fn) -> habits.mapWithPattern(...)
//   computed(() => logs.get().some(fn)) -> lift(...)(...) whose inner some(fn) stays plain JS
// Context: The outer callback is pattern-owned, but the inner some() callback runs on the unwrapped logs array inside computed()
export default pattern((__cf_pattern_input) => {
    const habits = __cf_pattern_input.key("habits");
    const logs = __cf_pattern_input.key("logs");
    const todayDate = __cf_pattern_input.key("todayDate");
    return {
        [UI]: <div>{habits.mapWithPattern(__cfPattern_h7539fce3615a, {
                logs: logs,
                todayDate: todayDate
            })}</div>,
    };
}, {
    type: "object",
    properties: {
        habits: {
            type: "array",
            items: {
                $ref: "#/$defs/Habit"
            }
        },
        logs: {
            type: "array",
            items: {
                $ref: "#/$defs/HabitLog"
            },
            asCell: ["cell"]
        },
        todayDate: {
            type: "string"
        }
    },
    required: ["habits", "logs", "todayDate"],
    $defs: {
        HabitLog: {
            type: "object",
            properties: {
                habitName: {
                    type: "string"
                },
                date: {
                    type: "string"
                },
                completed: {
                    type: "boolean"
                }
            },
            required: ["habitName", "date", "completed"]
        },
        Habit: {
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
    __cfLift_h093ae1e435d0,
    __cfPattern_h7539fce3615a,
    __cfLift_1: __cfLift_h093ae1e435d0,
    __cfPattern_1: __cfPattern_h7539fce3615a
});
