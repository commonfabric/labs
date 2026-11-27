import { expect } from "@std/expect";
import { basename, join } from "@std/path";
import ts from "typescript";

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
import { describe, it } from "@commonfabric/test-support/test";

/** An offset that throws when it is compared with a number. */
const OFFSET_THAT_THROWS = {
  valueOf(): number {
    throw new Error("hostile offset");
  },
} as unknown as number;

/**
 * A document registry that counts, by base name, how many programs hold each
 * file it has parsed. The registry keeps a file parsed while its count is
 * above zero.
 */
function countingRegistry(): {
  readonly registry: ts.DocumentRegistry;
  readonly held: (name: string) => number;
} {
  const inner = ts.createDocumentRegistry();
  const counts = new Map<string, number>();
  const count = (path: string, by: number) =>
    counts.set(basename(path), (counts.get(basename(path)) ?? 0) + by);
  return {
    registry: {
      ...inner,
      acquireDocumentWithKey: (
        ...acquire: Parameters<ts.DocumentRegistry["acquireDocumentWithKey"]>
      ) => {
        count(acquire[1], 1);
        return inner.acquireDocumentWithKey(...acquire);
      },
      releaseDocumentWithKey: (
        path: ts.Path,
        key: ts.DocumentRegistryBucketKey,
        scriptKind: ts.ScriptKind,
        impliedNodeFormat?: ts.ResolutionMode,
      ) => {
        count(path, -1);
        inner.releaseDocumentWithKey(path, key, scriptKind, impliedNodeFormat);
      },
    },
    held: (name) => counts.get(name) ?? 0,
  };
}

describe("semantics", () => {
  describe("localProgram()", () => {
    it("answers null and empty for queries that throw", () => {
      const program = localProgram(SPEC);
      expect(program.typeAt("/m.ts", OFFSET_THAT_THROWS)).toBeNull();
      expect(program.definitionsAt("/m.ts", OFFSET_THAT_THROWS)).toEqual([]);
      expect(program.typeAt("/m.ts", TEXT.indexOf("y"))).toBe("number");
    });

    it("returns what the file a query names and its imports declare, whichever file was asked about before", () => {
      // `user.ts` imports `dep.ts`, and reads a global that `declares.ts`
      // declares without importing it.

      const dir = Deno.makeTempDirSync();
      try {
        const user = join(dir, "user.ts");
        const dep = join(dir, "dep.ts");
        const declares = join(dir, "declares.ts");
        const other = join(dir, "other.ts");
        const userText = 'import { dep } from "./dep.ts";\n' +
          "const a = dep;\nconst b = fromDeclares;\n";
        const declaresText = "declare const fromDeclares: 1;\n" +
          "const c = fromDeclares;\n";
        Deno.writeTextFileSync(user, userText);
        Deno.writeTextFileSync(dep, "export const dep: 3 = 3;\n");
        Deno.writeTextFileSync(declares, declaresText);
        Deno.writeTextFileSync(other, "const d = 4;\n");
        const program = localProgram({
          ...SPEC,
          sections: [],
          cwd: dir,
          root: dir,
          realRoots: [user, declares],
        });
        const atDep = userText.indexOf("dep;");
        const atGlobal = userText.indexOf("fromDeclares");
        const depDefinition = [{
          name: "dep",
          fileName: dep,
          textSpan: { start: "export const ".length, length: 3 },
        }];

        expect(program.typeAt(user, atDep)).toBe("3");
        expect(program.definitionsAt(user, atDep)).toEqual(depDefinition);
        expect(program.typeAt(user, atGlobal)).toBeNull();
        expect(program.definitionsAt(user, atGlobal)).toEqual([]);
        expect(program.typeAt(declares, declaresText.lastIndexOf("from")))
          .toBe("1");
        expect(program.typeAt(user, atGlobal)).toBeNull();
        expect(program.definitionsAt(user, atGlobal)).toEqual([]);
        expect(program.definitionsAt(user, atDep)).toEqual(depDefinition);

        // A file the spec does not name is never a root.
        expect(program.typeAt(other, "const ".length)).toBeNull();
      } finally {
        Deno.removeSync(dir, { recursive: true });
      }
    });

    it("keeps parsed the files the latest roots reach, and frees those only older roots reach", () => {
      // Each `root-N.ts` imports a `dep-N.ts` that no other root reaches.

      const dir = Deno.makeTempDirSync();
      try {
        const roots = Array.from({ length: 18 }, (_, n) => {
          const root = join(dir, `root-${n}.ts`);
          Deno.writeTextFileSync(
            join(dir, `dep-${n}.ts`),
            `export const dep: ${n} = ${n};\n`,
          );
          Deno.writeTextFileSync(
            root,
            `import { dep } from "./dep-${n}.ts";\nconst a = dep;\n`,
          );
          return root;
        });
        const { registry, held } = countingRegistry();
        const program = localProgram({
          ...SPEC,
          sections: [],
          cwd: dir,
          root: dir,
          realRoots: roots,
        }, registry);
        const depType = (n: number) =>
          program.typeAt(
            roots[n],
            Deno.readTextFileSync(roots[n]).lastIndexOf("dep"),
          );

        for (let n = 0; n < roots.length; n++) {
          expect(depType(n)).toBe(`${n}`);
        }
        expect(held("dep-0.ts")).toBe(0);
        expect(held("dep-1.ts")).toBeGreaterThan(0);
        expect(held("dep-17.ts")).toBeGreaterThan(0);

        expect(depType(0)).toBe("0");
        expect(held("dep-0.ts")).toBeGreaterThan(0);
        expect(held("dep-1.ts")).toBe(0);
        expect(held("dep-2.ts")).toBeGreaterThan(0);
      } finally {
        Deno.removeSync(dir, { recursive: true });
      }
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
