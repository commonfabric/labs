import { lift } from "commonfabric";

type LiftArgs = {
  value: number;
};

type LiftResult = {
  doubled: number;
};

// FIXTURE: schema-generation-lift-no-generics
// Verifies: lift() with no generic type args infers schemas from inline param and return type
//   lift((args: LiftArgs): LiftResult => ...) → lift(inputSchema, outputSchema, fn)
// Context: Types come from function parameter and return type annotations, not generic args
export const doubleValue = lift((args: LiftArgs): LiftResult => ({
  doubled: args.value * 2,
}));
