// Run by `../worker-exit-coverage.test.ts` in a `deno test` of its own, with a
// coverage directory of its own. Named without `.test.ts` so that the lane does
// not also run it directly.
import { afterAll, describe, it } from "@std/testing/bdd";
import { WorkerExitBarrier } from "../worker-exit-barrier.ts";

/** How many workers to start, which the outer test names. */
const WORKER_COUNT = Number(Deno.env.get("WORKER_COUNT"));
if (!(WORKER_COUNT > 0)) throw new Error("WORKER_COUNT must name a count");

const barrier = await WorkerExitBarrier.create();

describe("runtime workers under coverage", () => {
  afterAll(() => barrier.settle());

  // The workers are disposed of together at the end, so that all of them are
  // writing their profiles when the file ends: the arrangement in which a
  // process that does not wait for them loses them.
  it("starts runtime workers and disposes of them", async () => {
    const transports = [];
    for (let i = 0; i < WORKER_COUNT; i++) {
      transports.push(await barrier.connect());
    }
    for (const transport of transports) await transport.dispose();
  });
});
