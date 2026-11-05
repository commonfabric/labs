/** Verifies replay order, payload storage, and temporary-file cleanup. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";

import { ObservationSpool } from "./observation-spool.ts";
import type { Observation } from "./score.ts";

/** One execution with a distinct name and the given start time. */
function observation(name: string, startedAt: string): Observation {
  return {
    test: { k: "unit", s: "example", n: name },
    outcome: "pass",
    day: startedAt.slice(0, 10),
    startedAt,
    commit: name,
    source: "main",
    place: "main",
  };
}

describe("ObservationSpool", () => {
  describe("constructor()", () => {
    it("removes the temporary file when opening it fails", () => {
      const created = spy(Deno, "makeTempFileSync");
      const opened = stub(Deno, "openSync", () => {
        throw new Error("open failed");
      });
      try {
        expect(() => new ObservationSpool()).toThrow("open failed");
        const path = created.calls[0]!.returned!;
        expect(() => Deno.statSync(path)).toThrow(Deno.errors.NotFound);
      } finally {
        opened.restore();
        created.restore();
      }
    });
  });

  describe("instance members", () => {
    for (const operation of ["readSync", "writeSync"] as const) {
      for (const bytes of [0, -1]) {
        it(`throws after \`${operation}()\` returns \`${bytes}\``, () => {
          const opened = spy(Deno, "openSync");
          try {
            using spool = new ObservationSpool();
            const run = [observation("stored", "2026-08-20T01:00:00Z")];
            if (operation === "readSync") spool.add(run);
            let attempts = 0;
            const io = stub(opened.calls[0]!.returned!, operation, () => {
              if (++attempts === 1) return bytes;
              throw new Error("I/O was repeated without progress");
            });
            try {
              expect(() => {
                if (operation === "writeSync") spool.add(run);
                else [...spool];
              }).toThrow("observation spool made no progress");
              expect(io.calls.length).toBe(1);
            } finally {
              io.restore();
            }
          } finally {
            opened.restore();
          }
        });
      }
    }

    it("completes partial reads and writes across byte boundaries", () => {
      const opened = spy(Deno, "openSync");
      try {
        using spool = new ObservationSpool();
        const file = opened.calls[0]!.returned!;
        const read = file.readSync.bind(file);
        const write = file.writeSync.bind(file);
        const reader = stub(
          file,
          "readSync",
          (bytes) => read(bytes.subarray(0, 7)),
        );
        const writer = stub(
          file,
          "writeSync",
          (bytes) => write(bytes.subarray(0, 7)),
        );
        try {
          const run = [observation("donut 🍩", "2026-08-20T01:00:00Z")];
          spool.add(run);
          expect([...spool]).toEqual(run);
          expect(reader.calls.length).toBeGreaterThan(1);
          expect(writer.calls.length).toBeGreaterThan(1);
        } finally {
          reader.restore();
          writer.restore();
        }
      } finally {
        opened.restore();
      }
    });

    it("replays stored runs in time order on every iteration", () => {
      using spool = new ObservationSpool();
      const later = observation("later", "2026-08-21T01:00:00.100Z");
      const earlier = observation("earlier", "2026-08-20T01:00:00Z");
      const tied = observation("tied", earlier.startedAt);
      spool.add([later]);
      spool.add([earlier, tied]);
      const expected = [earlier, tied, { ...later }];
      later.outcome = "fail";
      later.day = "2026-08-19";
      expect([...spool]).toEqual(expected);
      expect([...spool]).toEqual(expected);
      expect(spool.count).toBe(3);
      expect(spool.newestDay).toBe("2026-08-21");
    });

    it("orders fractional timestamps by instant", () => {
      using spool = new ObservationSpool();
      const later = observation("later", "2026-08-20T01:00:00.100Z");
      const earlier = observation("earlier", "2026-08-20T01:00:00Z");
      spool.add([later]);
      spool.add([earlier]);
      expect([...spool]).toEqual([earlier, later]);
    });

    it("replays nothing when no run has observations", () => {
      using spool = new ObservationSpool();
      spool.add([]);
      expect([...spool]).toEqual([]);
      expect(spool.count).toBe(0);
      expect(spool.newestDay).toBeUndefined();
    });

    it("refuses a run with invalid or differing start times", () => {
      using spool = new ObservationSpool();
      expect(() => spool.add([observation("invalid", "not a date")]))
        .toThrow("one valid start time");
      expect(() =>
        spool.add([
          observation("earlier", "2026-08-20T01:00:00Z"),
          observation("later", "2026-08-20T02:00:00Z"),
        ])
      ).toThrow("one valid start time");
      expect(spool.count).toBe(0);
    });

    it("refuses a replay started while another is running", () => {
      // Both would move the one file cursor these share.
      using spool = new ObservationSpool();
      spool.add([observation("stored", "2026-08-20T01:00:00Z")]);
      expect(() => {
        for (const _ of spool) for (const __ of spool);
      }).toThrow("already being replayed");
    });

    it("replays again once the previous replay has finished", () => {
      using spool = new ObservationSpool();
      spool.add([observation("stored", "2026-08-20T01:00:00Z")]);
      expect([...spool]).toEqual([...spool]);
    });

    it("refuses a truncated payload and removes it on disposal", () => {
      const created = spy(Deno, "makeTempFileSync");
      try {
        {
          using spool = new ObservationSpool();
          spool.add([observation("stored", "2026-08-20T01:00:00Z")]);
          Deno.truncateSync(created.calls[0]!.returned!, 1);
          expect(() => [...spool]).toThrow("observation spool is truncated");
        }
        expect(() => Deno.statSync(created.calls[0]!.returned!))
          .toThrow(Deno.errors.NotFound);
      } finally {
        created.restore();
      }
    });
  });
});
