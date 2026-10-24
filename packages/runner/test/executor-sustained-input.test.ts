import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import * as Engine from "@commonfabric/memory/v2/engine";
import { maxOf } from "@commonfabric/utils/math";
import { readWatermarkSeq } from "../src/executor/watermark.ts";
import { awaitAdmitted, awaitEach } from "./support/serving-waits.ts";
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
    it("advances the watermark over the stream's inputs on exhausted cycles while input keeps arriving", async () => {
      // The deadline leaves an idle machine room for the cascade's two
      // stages several times over, and each stage outlasts the scheduler's
      // yield slice, so a settle finds the scheduler busy at its exit
      // probes and ends at the deadline. How many cycles an input then
      // waits for coverage is elapsed time counted in deadlines, which a
      // slower machine stretches without limit, so this case bounds no such
      // count; the next case does, by driving the deadline's clock itself.
      // The stream runs until three exhausted cycles have each carried W
      // over one of its inputs. A loop that covers input only once it
      // pauses ends no such cycle, and leaves this wait to the stuck net,
      // which fails the case.

      const opened = await openSustainedInputFixture({ flushDeadlineMs: 300 });
      fixture = opened;
      const { cycles, engine, host, server } = opened;
      const stream = opened.stream();
      const exhaustedCoverages = (): number =>
        cycles.entries.filter((end, index) => {
          const before = cycles.entries[index - 1];
          return before !== undefined &&
            end.exhaustedAdvances > before.exhaustedAdvances &&
            stream.inputs.some((input) =>
              before.watermark < input.seq && input.seq <= end.watermark
            );
        }).length;
      await awaitEach(cycles, () => exhaustedCoverages() >= 3);
      await stream.stop();
      const last = stream.inputs[stream.inputs.length - 1].seq;
      await awaitAdmitted(server, () => readWatermarkSeq(engine) >= last);

      const covered = host.stats().settle.series.filter((row) =>
        stream.inputs.some((input) => input.seq === row.seq)
      );
      expect(covered.length).toBe(stream.inputs.length);
    });

    it("covers each input within two cycles of its admission when every frame barrier completes after the flush deadline", async () => {
      // The fixture drives the deadline's clock and moves it past the
      // deadline as each barrier's frames land, so every settle the stream
      // feeds ends exhausted at its first barrier, with that barrier
      // complete, on a machine of any speed. A client writes the inputs, so
      // each one re-arms the argument's terminal root. The cycle after an
      // input's admission drains it, applies its frames at that barrier,
      // and starts the root's retry there. The cycle after that awaits the
      // retry, finds the scheduler idle, and proves the head that barrier
      // applied, whatever later input has re-armed the root by then. With
      // the clock driven, those two cycles are steps of the loop and not a
      // measure of elapsed time. A loop that leaves the retry for a barrier
      // ahead of the deadline, or that proves nothing while a re-armed root
      // is pending, covers the stream's first input only once the stream
      // stops.

      const opened = await openSustainedInputFixture({
        flushDeadlineMs: 600_000,
        lateBarriers: true,
      });
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
      expect(covered.length).toBe(stream.inputs.length);
      expect(maxOf(covered.map((row) => row.cycles)))
        .toBeLessThanOrEqual(2);
      expect(stats.exhaustedAdvances).toBeGreaterThan(0);
    });

    it("leaves the watermark below an input whose derivations the deadline cut off", async () => {
      // A deadline shorter than one stage of the cascade cuts every settle
      // that has the cascade to run, so the input's first cycles end with
      // `total` not yet derived for it. The stages are lengthened well past
      // the deadline, so that a fast machine cannot run the whole cascade
      // inside one settle. Each cycle's end is checked, not only the last:
      // an advance that ran ahead of the cascade is visible only at the
      // cycle that made it.

      const opened = await openSustainedInputFixture({
        flushDeadlineMs: 10,
        stageSpins: 20_000_000,
      });
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
      // advance does with a floor. It is set one above the space's head, so
      // every input admitted after it is shadowed. The inputs are direct
      // writes: a client writing the argument would demand it, and each of
      // its writes would re-arm a terminal root whose retry the floor
      // defers, holding W below the floor whatever the floor clamp did.
      // The held cycles still advance, to just below the floor. The stream
      // outlives the floor, and the cycles after it lifts show the
      // exhausted advance resuming.

      const opened = await openSustainedInputFixture({
        flushDeadlineMs: 300,
        directInputs: true,
      });
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
      const shadowed = Engine.serverSeq(engine) + 1;
      floor = shadowed;
      const start = cycles.entries.length;
      await cycles.matching((end) =>
        cycles.entries.indexOf(end) >= start && end.watermark === shadowed - 1
      );
      await cycles.reached(cycles.entries.length + 2);
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

    it("holds an exhausted advance below input the replica shadowed when the settle proved coverage, though the shadow lifts before the cycle ends", async () => {
      // The floor is stubbed as in the case above, and lifts at the flush
      // deadline's cut: the scheduler's leftover purge runs in the same
      // synchronous stretch as the cycle's own floor read, so that read
      // finds no floor. The novelty that lifts has not been derived yet,
      // so a proof taken while it was shadowed may not claim it; only the
      // floor read with the proof holds the advance below it. The lift
      // waits for a cut settle that took such a proof: the proof reads the
      // floor while the scheduler is idle, and only a settle the deadline
      // cuts purges, so a cut with no proof behind it leaves the lift to a
      // later one. The inputs are direct writes, so that no terminal root's
      // deferred retry holds W lower than the floor does and hides which
      // clamp held it.

      const opened = await openSustainedInputFixture({
        flushDeadlineMs: 300,
        directInputs: true,
      });
      fixture = opened;
      const { cycles, engine, server } = opened;
      const scheduler = opened.servingRuntime.scheduler;
      const replica = opened.servingRuntime.storageManager
        .open(sustainedInputSpace).replica as unknown as {
          unappliedForeignSeqFloor?: () => number | undefined;
        };
      let floor: number | undefined;
      // The cycle in which the floor was last read over an idle scheduler.
      // A cycle's advance reads the floor after its cut, and the cycle log
      // records the cycle after that, so a read logged under the index a
      // cut sees came from that settle's proof, before the cut.
      let provedCycle: number | undefined;
      replica.unappliedForeignSeqFloor = () => {
        if (floor !== undefined && scheduler.isIdle()) {
          provedCycle = cycles.entries.length;
        }
        return floor;
      };
      let liftAtCut = false;
      let liftedCycle: number | undefined;
      const purge = scheduler.purgeQueuedEvents.bind(scheduler);
      scheduler.purgeQueuedEvents = (predicate, reason) => {
        if (liftAtCut && provedCycle === cycles.entries.length) {
          liftAtCut = false;
          floor = undefined;
          liftedCycle = cycles.entries.length;
        }
        return purge(predicate, reason);
      };
      const stream = opened.stream();
      await cycles.reached(cycles.entries.length + 3);
      const shadowed = Engine.serverSeq(engine) + 1;
      floor = shadowed;
      // The held cycles advance to just below the floor, and every settle
      // after that crosses barriers over inputs above it, so the cycle the
      // lift cuts proves a head the floor has to hold back.
      const start = cycles.entries.length;
      await cycles.matching((end) =>
        cycles.entries.indexOf(end) >= start && end.watermark === shadowed - 1
      );
      liftAtCut = true;
      await cycles.matching(() =>
        liftedCycle !== undefined && cycles.entries.length > liftedCycle
      );
      await stream.stop();
      const last = stream.inputs[stream.inputs.length - 1].seq;
      await awaitAdmitted(server, () => readWatermarkSeq(engine) >= last);

      expect(cycles.entries[liftedCycle!].watermark).toBeLessThan(shadowed);
    });
  });
});
