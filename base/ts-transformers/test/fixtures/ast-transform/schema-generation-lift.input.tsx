import { lift } from "commonfabric";

type LiftArgs = {
  value: number;
};

type LiftResult = {
  doubled: number;
};

// FIXTURE: schema-generation-lift
// Verifies: lift() with generic type args generates input and output schemas
//   lift<LiftArgs, LiftResult>(fn) → lift(inputSchema, outputSchema, fn)
export const doubleValue = lift<LiftArgs, LiftResult>(({ value }) => ({
  doubled: value * 2,
}));
