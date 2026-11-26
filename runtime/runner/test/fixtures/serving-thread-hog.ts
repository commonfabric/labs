/**
 * A serving worker's thread whose heap grows without bound as its module is
 * evaluated, so that it reaches any heap limit (`serving-thread.test.ts`).
 */

const held: number[][] = [];
for (;;) held.push(new Array(1_000_000).fill(Math.random()));
