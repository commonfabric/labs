function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { lift } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Person {
    name: string;
    age: number;
}
interface PersonWithYear {
    name: string;
    birthYear: number;
}
const currentYear = 2024;
// FIXTURE: schema-generation-lift-inside-jsx
// Verifies: lift() inside a JSX expression still gets schemas injected from inline param types
//   lift((person: Person): PersonWithYear => ...) → lift(inputSchema, outputSchema, fn)
// Context: lift() appears as a JSX child expression; schemas derived from param + return type annotations
export const result = (<div>
    {lift((person: Person): PersonWithYear => ({
        name: person.name,
        birthYear: currentYear - person.age,
    }), {
        type: "object",
        properties: {
            name: {
                type: "string"
            },
            age: {
                type: "number"
            }
        },
        required: ["name", "age"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "object",
        properties: {
            name: {
                type: "string"
            },
            birthYear: {
                type: "number"
            }
        },
        required: ["name", "birthYear"]
    } as const satisfies __cfHelpers.JSONSchema)}
  </div>);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
