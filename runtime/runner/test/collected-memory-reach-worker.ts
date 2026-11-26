/**
 * A worker for `collected-memory.test.ts`, started after the collector is
 * exposed, as a serving worker is: it posts whether its own realm, and code a
 * locked-down SES compartment evaluates, as a pattern's code is, can see
 * `gc()`.
 */

import {
  ensureSESLockdown,
  evaluateFunctionSourceInSES,
} from "../src/sandbox/ses-runtime.ts";
import { createCallbackCompartmentGlobals } from "../src/sandbox/compartment-globals.ts";

ensureSESLockdown();
const inCompartment = evaluateFunctionSourceInSES(
  `() => [
    typeof gc,
    typeof globalThis.gc,
    (() => {
      try {
        return typeof Function("return gc")();
      } catch (error) {
        return "throws " + error.name;
      }
    })(),
  ]`,
  { lockdown: true, globals: createCallbackCompartmentGlobals({}) },
);
if (typeof inCompartment !== "function") {
  throw new Error("the compartment evaluated no function");
}
self.postMessage({
  realm: typeof Reflect.get(globalThis, "gc"),
  compartment: inCompartment(),
});
