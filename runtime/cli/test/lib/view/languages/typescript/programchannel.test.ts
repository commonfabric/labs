import { expect } from "@std/expect";

import {
  type ProgramQuery,
  workerProgram,
} from "../../../../../lib/view/languages/typescript/programchannel.ts";
import {
  ProgramWorker,
  SPEC,
  TEXT,
  UNLOADABLE_PROGRAM_WORKER,
  X_DEFINITION,
} from "./program-fixtures.ts";
import { describe, it } from "@commonfabric/test-support/test";

const TYPE_OF_Y: ProgramQuery = {
  question: "typeAt",
  fileName: "/m.ts",
  offset: TEXT.indexOf("y"),
};

describe("programchannel", () => {
  describe("workerProgram()", () => {
    it("answers type and definition queries from the program the worker builds", async () => {
      const worker = new ProgramWorker();
      const program = workerProgram(SPEC, () => worker)!;
      try {
        await worker.started();
        expect(program.ask(TYPE_OF_Y)).toEqual({
          type: "number",
          definitions: [],
        });
        expect(
          program.ask({
            question: "definitionsAt",
            fileName: "/m.ts",
            offset: TEXT.lastIndexOf("x"),
          }),
        ).toEqual({ type: null, definitions: X_DEFINITION });
        expect(
          program.ask({ question: "typeAt", fileName: "/m.ts", offset: 1_000 }),
        ).toEqual({ type: null, definitions: [] });
      } finally {
        program.dispose();
      }
    });

    it("returns undefined, without waiting, before the worker says it is serving", async () => {
      // A worker whose module cannot load never says it is serving.

      const worker = new ProgramWorker({
        url: new URL("./no-such-module.ts", import.meta.url),
      });
      const program = workerProgram(SPEC, () => worker)!;
      try {
        expect(program.ask(TYPE_OF_Y)).toBeUndefined();
        await worker.errored;
        expect(program.ask(TYPE_OF_Y)).toBeUndefined();
      } finally {
        program.dispose();
      }
    });

    it("returns undefined once the worker fails to load the program it said it would serve", async () => {
      const worker = new ProgramWorker({ url: UNLOADABLE_PROGRAM_WORKER });
      const program = workerProgram(SPEC, () => worker)!;
      try {
        await worker.started();
        expect(program.ask(TYPE_OF_Y)).toBeUndefined();
        expect(program.ask(TYPE_OF_Y)).toBeUndefined();
      } finally {
        program.dispose();
      }
    });

    it("returns undefined for a query the worker fails on, and for every query after it", async () => {
      // A query that is not one fails as the worker reads it.

      const worker = new ProgramWorker();
      const program = workerProgram(SPEC, () => worker)!;
      try {
        await worker.started();
        expect(program.ask(null as unknown as ProgramQuery)).toBeUndefined();
        expect(program.ask(TYPE_OF_Y)).toBeUndefined();
      } finally {
        program.dispose();
      }
    });

    it("returns undefined for every query once the worker fails as it starts", async () => {
      // Without its port, the worker fails as it starts serving.

      const worker = new ProgramWorker({
        alter: ({ spec, state }) => ({ spec, state }),
      });
      const program = workerProgram(SPEC, () => worker)!;
      try {
        await worker.started();
        expect(program.ask(TYPE_OF_Y)).toBeUndefined();
      } finally {
        program.dispose();
      }
    });

    it("returns undefined, and ends the worker, when its start message cannot be sent", () => {
      // A function cannot be copied to another thread.

      const worker = new ProgramWorker({ alter: () => () => {} });
      expect(workerProgram(SPEC, () => worker)).toBeUndefined();
      expect(worker.terminations).toBe(1);
    });

    it("returns undefined when the worker cannot start", () => {
      expect(
        workerProgram(SPEC, () => {
          throw new Error("no worker");
        }),
      ).toBeUndefined();
    });
  });
});
