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
 * The compartment confines names. What the executor hands the code is an
 * object of the executor: `$rt`, the host of a call (`$h`), and the handles
 * and references a function body is given. A handle and a host keep the
 * instance in private fields, and the classes of what a body is given are
 * frozen here. A body that names `$rt` or `$h` still calls every method of
 * them, each of which reads and writes the instance the code belongs to
 * and no other; the crate's check refuses a source that names either.
 */
import {
  HANDED_CLASSES,
  type ModuleEvaluator,
} from "../../../../base/pattern-compiler/exec/executor.ts";
import {
  ComputedOutput,
  MissingKey,
  Ref,
  StreamMarker,
  StreamRef,
} from "../../../../base/pattern-compiler/exec/store.ts";
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

/**
 * Freezes the classes whose instances value code is handed, makes through
 * `$rt` or catches: a handle, the host of a call, a deferred value, a
 * reference, and the errors the executor throws into a body. A body then
 * replaces no method that the executor or another piece calls.
 */
const freezeHandedClasses = (): void => {
  for (
    const handed of [
      ...HANDED_CLASSES,
      Ref,
      StreamRef,
      StreamMarker,
      MissingKey,
      ComputedOutput,
    ] as { prototype?: object }[]
  ) {
    if (handed.prototype !== undefined) Object.freeze(handed.prototype);
    Object.freeze(handed);
  }
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
  freezeHandedClasses();
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
