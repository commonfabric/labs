import { lift } from "commonfabric";

// FIXTURE: schema-generation-lift-typed-param
// Verifies: lift() with a primitive typed parameter generates scalar input and output schemas
//   lift((value: number) => value * 2) → lift({ type: "number" }, { type: "number" }, fn)
// Context: Single primitive param; output type inferred from expression body
// Lift requires explicit type annotation for proper schema generation
export const doubleValue = lift((value: number) => value * 2);
