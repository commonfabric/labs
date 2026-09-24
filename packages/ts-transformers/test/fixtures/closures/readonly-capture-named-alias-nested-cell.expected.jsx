function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, computed, Default, pattern, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// `Entry[] | Default<[]>` aliased as EntriesValue; Entry contains a nested Cell.
// Creating the cell with `Writable.of<EntriesValue>(...)` gives it the BARE
// `Cell<EntriesValue>` type (not a user alias), so the chokepoint normalizes the
// capture node to `__cfHelpers.Cell<EntriesValue>`. That makes it visible to the
// capability re-wrap, which narrows the read-only capture to `ReadonlyCell`.
interface Entry {
    readonly profile: Cell<{
        name: string;
    }>;
}
type EntriesValue = Entry[] | Default<[
]>;
// Reads the cell only (passed by reference, never written) — makes the capture
// read-only and triggers the Cell -> ReadonlyCell narrowing.
const firstName = __cfHardenFn((entries: Cell<EntriesValue>): string => (entries.get() ?? [])[0]?.profile.get().name ?? "");
const __cfLift_1 = __cfHelpers.lift<{
    entries: __cfHelpers.ReadonlyCell<EntriesValue>;
}, string>(({ entries }) => firstName(entries), {
    type: "object",
    properties: {
        entries: {
            $ref: "#/$defs/EntriesValue",
            asCell: ["readonly"]
        }
    },
    required: ["entries"],
    $defs: {
        EntriesValue: {
            type: "array",
            items: {
                $ref: "#/$defs/Entry"
            },
            "default": []
        },
        Entry: {
            type: "object",
            properties: {
                profile: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        }
                    },
                    required: ["name"],
                    asCell: ["cell"]
                }
            },
            required: ["profile"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: readonly-capture-named-alias-nested-cell
// Verifies (BEHAVIOR LOCK): a by-reference, read-only-used capture of a bare
//   `Cell<EntriesValue>` (EntriesValue = Entry[] | Default<[]>, Entry has a
//   nested `Cell`) is branded `__cfHelpers.ReadonlyCell<EntriesValue>` with
//   schema `{ $ref: "#/$defs/EntriesValue", asCell: ["readonly"] }`. The Cell ->
//   ReadonlyCell capability narrowing must PRESERVE the inner `$ref` (and thus
//   the nested `profile` Cell materialized in $defs), NOT collapse the capture to
//   a bare `{ asCell: ["readonly"] }`.
//
// NOTE: this is a behavior lock, not a standalone regression repro. The schema-gen
//   `$ref`-drop bug this guards against only manifests when the inner type comes
//   from a CROSS-FILE import (so a synthetic reference to it degrades to `any` in
//   the schema generator's checker context). The fixture harness type-checks each
//   fixture as a single file, so the inner resolves here regardless of the fix.
//   The genuine fail-without/pass-with regression guard is the pattern test
//   packages/patterns/cfc-group-chat-demo/main.test.tsx (the `profiles` capture).
//   This fixture pins the intended single-file output with a legible diff so a
//   future change to the readonly-rewrap path is obvious here too.
export default pattern(() => {
    const entries = Writable.of<EntriesValue>([] as EntriesValue, {
        type: "array",
        items: {
            $ref: "#/$defs/Entry"
        },
        "default": [],
        $defs: {
            Entry: {
                type: "object",
                properties: {
                    profile: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            }
                        },
                        required: ["name"],
                        asCell: ["cell"]
                    }
                },
                required: ["profile"]
            }
        }
    } as const satisfies __cfHelpers.JSONSchema).for("entries", true);
    return __cfLift_1({ entries: entries }).for("__patternResult", true);
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
