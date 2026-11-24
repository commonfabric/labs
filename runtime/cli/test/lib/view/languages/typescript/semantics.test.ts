import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  _internal,
  localProgram,
} from "../../../../../lib/view/languages/typescript/semantics.ts";
import {
  ProgramWorker,
  SILENT_WORKER,
  SPEC,
  TEXT,
  X_DEFINITION,
} from "./program-fixtures.ts";

/** An offset that throws when it is compared with a number. */
const OFFSET_THAT_THROWS = {
  valueOf(): number {
    throw new Error("hostile offset");
  },
} as unknown as number;

describe("semantics", () => {
  describe("localProgram()", () => {
    it("answers null and empty for queries that throw", () => {
      const program = localProgram(SPEC);
      expect(program.typeAt("/m.ts", OFFSET_THAT_THROWS)).toBeNull();
      expect(program.definitionsAt("/m.ts", OFFSET_THAT_THROWS)).toEqual([]);
      expect(program.typeAt("/m.ts", TEXT.indexOf("y"))).toBe("number");
    });
  });

  describe("programBackend()", () => {
    it("prewarms with the program worker, and answers on this thread once disposed", () => {
      const program = _internal.programBackend(SPEC);
      program.prewarm();
      program.dispose();
      expect(program.typeAt("/m.ts", TEXT.indexOf("y"))).toBe("number");
    });

    it("answers from one worker however often it prewarms, until disposed", async () => {
      const workers: ProgramWorker[] = [];
      const program = _internal.programBackend(SPEC, () => {
        const worker = new ProgramWorker();
        workers.push(worker);
        return worker;
      });
      program.prewarm();
      program.prewarm();
      try {
        expect(workers.length).toBe(1);
        await workers[0].started();
        expect(program.typeAt("/m.ts", TEXT.indexOf("y"))).toBe("number");
        expect(program.definitionsAt("/m.ts", TEXT.lastIndexOf("x")))
          .toEqual(X_DEFINITION);
        expect(workers[0].terminations).toBe(0);
      } finally {
        program.dispose();
      }
      expect(workers[0].terminations).toBe(1);
      // A disposed backend answers on this thread, and starts no worker.
      program.prewarm();
      expect(program.typeAt("/m.ts", TEXT.indexOf("y"))).toBe("number");
      expect(workers.length).toBe(1);
    });

    it("answers on this thread, and ends the worker, when the worker is not serving", () => {
      const worker = new ProgramWorker({ url: SILENT_WORKER });
      const program = _internal.programBackend(SPEC, () => worker);
      try {
        program.prewarm();
        expect(program.definitionsAt("/m.ts", TEXT.lastIndexOf("x")))
          .toEqual(X_DEFINITION);
        expect(worker.terminations).toBe(1);
        expect(program.typeAt("/m.ts", TEXT.indexOf("y"))).toBe("number");
      } finally {
        program.dispose();
      }
    });

    it("starts no worker once a query has built the program on this thread", () => {
      let started = 0;
      const program = _internal.programBackend(SPEC, () => {
        started++;
        return new ProgramWorker();
      });
      expect(program.typeAt("/m.ts", TEXT.indexOf("y"))).toBe("number");
      program.prewarm();
      expect(program.typeAt("/m.ts", TEXT.indexOf("x"))).toBe("number");
      expect(started).toBe(0);
    });

    it("answers on this thread when no worker can start", () => {
      const program = _internal.programBackend(SPEC, () => {
        throw new Error("no worker");
      });
      program.prewarm();
      expect(program.typeAt("/m.ts", TEXT.indexOf("y"))).toBe("number");
      expect(program.typeAt("/m.ts", TEXT.length + 10)).toBeNull();
    });
  });
});
