function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { handler, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Panel {
    name: string;
}
function holdsName(list: readonly Writable<Panel>[], name: string): boolean {
    return list.some((panel) => panel.get().name === name);
}
__cfHardenFn(holdsName);
const addPanel = handler({
    type: "object",
    properties: {
        panel: {
            $ref: "#/$defs/Panel",
            asCell: ["readonly"]
        },
        name: {
            type: "string"
        }
    },
    required: ["panel", "name"],
    $defs: {
        Panel: {
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
        panels: {
            type: "array",
            items: {
                $ref: "#/$defs/Panel",
                asCell: ["cell"]
            },
            asCell: ["cell"]
        }
    },
    required: ["panels"],
    $defs: {
        Panel: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, ({ panel, name }, { panels }) => {
    const list = panels.get();
    if (list.some((existing) => existing.equals(panel)))
        return;
    if (holdsName(list, name))
        return;
    panels.set([...list, panel]);
});
// FIXTURE: identity-element-escaped-to-helper
// Verifies: elements compared with `equals` keep their full schema when the
// list also leaves whole for a helper with no summary, which may read them;
// they are not narrowed to comparable cells as elements only compared are.
export { addPanel };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
