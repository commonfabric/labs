// Ambient types for the clock preload (`clock-preload.ts`). `deno check` sees
// this because it type-checks the package directory as one program; test files
// reference `clock` with no import.
declare const clock: {
  // Drain reactive (zero-delay) work to a fixpoint without moving the clock.
  settle(): Promise<void>;
  // Advance logical time by `ms`, firing positive-delay timers in lockstep with
  // Date.now and performance.now.
  tick(ms: number): Promise<void>;
  // Return logical time to zero and drop every pending timer. Call from
  // `beforeEach` in a suite whose cases each start from a known instant.
  reset(): void;
};
