import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { EveryFieldOf } from "@/shared/security-context.ts";

// The assertions in this file are made when it is type-checked, not when it
// runs. `EveryFieldOf<T>` is what holds a hand-written literal to naming every
// field of the type it builds, so what each case below pins is which literals
// the type admits and which it refuses; an `@ts-expect-error` marks one it must
// refuse, and a refusal that stops happening leaves the directive unused, which
// fails the type check.
type Posture = {
  id: string;
  mode?: "allow" | "deny";
  ceiling?: readonly string[];
};

declare const absent: Posture["mode"];

function everyFieldOfChecks() {
  // Every field named, each carrying a value of its own type.
  const named: EveryFieldOf<Posture> = {
    id: "runtime",
    mode: "deny",
    ceiling: ["secret"],
  };

  // A field the type declares optional may be named and absent. This is what
  // separates `EveryFieldOf<T>` from `Required<T>`, which admits neither.
  const absentValue: EveryFieldOf<Posture> = {
    id: "runtime",
    mode: absent,
    ceiling: undefined,
  };

  // @ts-expect-error a field left out reads as absent on whatever is built
  const dropped: EveryFieldOf<Posture> = { id: "runtime", mode: "deny" };

  const undeclared: EveryFieldOf<Posture> = {
    id: "runtime",
    mode: "deny",
    ceiling: undefined,
    // @ts-expect-error a key the type never declared reaches nothing
    typo: true,
  };

  const wrongValue: EveryFieldOf<Posture> = {
    id: "runtime",
    // @ts-expect-error a value off the declared union is caught here, rather
    // than wherever the literal is finally assigned
    mode: "allowed",
    ceiling: undefined,
  };

  return { named, absentValue, dropped, undeclared, wrongValue };
}

describe("EveryFieldOf", () => {
  it("holds a literal to naming every field of the type it builds", () => {
    // Which literals are admitted and refused is settled by the type-checker
    // above; at run time only the carrier holding those checks is observable.
    expect(typeof everyFieldOfChecks).toBe("function");
  });
});
