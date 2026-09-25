import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { readWatermarkSeq } from "../src/executor/watermark.ts";
import { awaitAdmitted, highestAuthoredSeq } from "./support/serving-waits.ts";
import {
  openSustainedInputFixture,
  type SustainedInputFixture,
  sustainedInputSpace,
} from "./support/sustained-input.ts";

describe("SpaceServer", () => {
  let fixture: SustainedInputFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  describe("watermark under sustained input", () => {
    it("covers each input within three cycles of its admission while input keeps arriving", async () => {
      // The deadline leaves room for the cascade's two stages several times
      // over, so a settle can reach an idle probe between barriers even on a
      // loaded machine; what keeps it from quiescing is that each stage
      // outlasts the scheduler's yield slice.

      const opened = await openSustainedInputFixture({ flushDeadlineMs: 300 });
      fixture = opened;
      const { cycles, engine, host, server } = opened;
      const stream = opened.stream();
      await cycles.reached(cycles.entries.length + 8);
      await stream.stop();
      const last = stream.inputs[stream.inputs.length - 1].seq;
      await awaitAdmitted(server, () => readWatermarkSeq(engine) >= last);

      const stats = host.stats();
      const covered = stats.settle.series.filter((row) =>
        stream.inputs.some((input) => input.seq === row.seq)
      );
      // The stream kept settles from quiescing, or this case asserts
      // nothing about an exhausted cycle.
      expect(stats.wavesBudgetExhausted).toBeGreaterThan(0);
      expect(covered.length).toBe(stream.inputs.length);
      expect(Math.max(...covered.map((row) => row.cycles)))
        .toBeLessThanOrEqual(3);
      expect(stats.exhaustedAdvances).toBeGreaterThan(0);
    });

    it("leaves the watermark below an input whose derivations the deadline cut off", async () => {
      // A deadline shorter than one stage of the cascade cuts every settle
      // that has the cascade to run, so the input's first cycles end with
      // `total` not yet derived for it. Each cycle's end is checked, not
      // only the last: an advance that ran ahead of the cascade is visible
      // only at the cycle that made it.

      const opened = await openSustainedInputFixture({ flushDeadlineMs: 10 });
      fixture = opened;
      const { cycles, host } = opened;
      const before = cycles.entries.length;
      const seq = await opened.write(3);
      await cycles.matching((end) => end.watermark >= seq);
      const ends = cycles.entries.slice(before);

      expect(
        ends.some((end) => end.watermark < seq && end.total !== 22),
      ).toBe(true);
      for (const end of ends.filter((end) => end.watermark >= seq)) {
        expect(end.total).toBe(22);
      }
      expect(host.stats().wavesBudgetExhausted).toBeGreaterThan(0);
    });

    it("holds the advance below input the serving replica still shadows while the stream runs", async () => {
      // The floor is stubbed, as the direct-drive clamp case in
      // `executor-space-server.test.ts` stubs it: what the replica shadows
      // is pinned there, and this case pins what an exhausted cycle's
      // advance does with a floor. It is set one above the highest input
      // so far, so every input admitted after it is shadowed. An input below
      // the floor can re-arm a terminal root whose retry the floor defers,
      // which holds the advance lower still, so the held cycles pin only the
      // floor as a ceiling. The stream outlives the floor, and the cycles
      // after it lifts show the exhausted advance resuming.

      const opened = await openSustainedInputFixture({ flushDeadlineMs: 300 });
      fixture = opened;
      const { cycles, engine, host, server } = opened;
      const replica = opened.servingRuntime.storageManager
        .open(sustainedInputSpace).replica as unknown as {
          unappliedForeignSeqFloor?: () => number | undefined;
        };
      let floor: number | undefined;
      replica.unappliedForeignSeqFloor = () => floor;
      const stream = opened.stream();
      await cycles.reached(cycles.entries.length + 3);
      const shadowed = highestAuthoredSeq(engine) + 1;
      floor = shadowed;
      const start = cycles.entries.length;
      await cycles.reached(start + 6);
      const held = cycles.entries.slice(start);
      floor = undefined;
      // The stream runs on until a cycle ends with an exhausted advance past
      // the lift; a loop that never resumed one leaves this wait to the
      // stuck net, which fails the case.
      const exhaustedAdvances = host.stats().exhaustedAdvances;
      await cycles.matching(() =>
        host.stats().exhaustedAdvances > exhaustedAdvances
      );
      await stream.stop();
      const last = stream.inputs[stream.inputs.length - 1].seq;
      await awaitAdmitted(server, () => readWatermarkSeq(engine) >= last);

      expect(stream.inputs.some((input) => input.seq > shadowed)).toBe(true);
      expect(held.filter((end) => end.watermark >= shadowed)).toEqual([]);
    });
  });
});
