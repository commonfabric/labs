// Ambient types for the clock preload (`clock-preload.ts`). `deno check` sees
// this because it type-checks the package directory as one program; test files
// reference `t.settle()` with no import.
declare namespace Deno {
  interface TestContext {
    // Resolve once every zero-delay timer and microtask has run to a fixpoint.
    settle(): Promise<void>;
  }
}
