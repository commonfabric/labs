/**
 * Evaluates the value code of a compiled pattern in an SES compartment
 * (milestone 5 of `docs/plans/compiled-pattern-language-integration.md`).
 *
 * The text of a module of value code is the crate's own emit: statements
 * that read the two names `$rt` and `$exports` and the globals. The
 * evaluator makes one function of each text in a compartment, so the free
 * names of the text are the parameters and the globals of the compartment
 * and nothing else, and the intrinsics the code reaches are frozen.
 *
 * The compartment confines names. It does not confine what the executor
 * hands the code: `$rt`, the host of a call and each handle are objects of
 * the executor, and the code reads whatever member they have.
 */
import type { ModuleEvaluator } from "../../../../base/pattern-compiler/exec/executor.ts";
import { createModuleCompartmentGlobals } from "../sandbox/compartment-globals.ts";
import {
  createLockedCompartment,
  ensureSESLockdown,
} from "../sandbox/ses-runtime.ts";

/**
 * The globals of a compartment of value code beside the shared intrinsics:
 * those a module of today's compiled bundles has, without the registrar of
 * hoisted builder artifacts, which value code does not call. `Date` and
 * `Math` are the gated ones: the clock and a random draw are given under a
 * frame of a handler and refused elsewhere (`sandboxDateNow`).
 */
const valueCodeGlobals = (): Record<string, unknown> => {
  const { __cfReg: _registrar, ...globals } = createModuleCompartmentGlobals();
  return globals;
};

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Returns an evaluator that makes each function in one compartment of its
 * own. The global object of the compartment is frozen and a module's text
 * is the body of a function, so one module leaves nothing in the
 * compartment that another finds. Locks the realm down.
 */
export const compartmentEvaluator = (): ModuleEvaluator => {
  // The gated `Date` is made from the `Date` a locked-down realm has.
  ensureSESLockdown();
  const compartment = createLockedCompartment(valueCodeGlobals());
  return ({ path, source }, parameters) => {
    for (const name of parameters) {
      if (!IDENTIFIER.test(name)) {
        throw new Error(`Not a parameter name of value code: ${name}`);
      }
    }
    const made = compartment.evaluate(
      `(function (${
        parameters.join(", ")
      }) {"use strict";\n${source}\n})\n//# sourceURL=compiled:${path}`,
    );
    if (typeof made !== "function") {
      throw new Error(`The value code of ${path} is not one function body.`);
    }
    return made as (...given: unknown[]) => void;
  };
};
