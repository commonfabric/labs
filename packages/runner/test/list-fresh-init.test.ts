import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import {
  newSharedServer,
  testPrincipalSessionOpenAuthFactory,
} from "./memory-v2-test-utils.ts";

// Fresh-init seeding guard for the list builtins (filter/flatMap/map).
//
// The builtins no longer seed the result container with an explicit early
// send([]) at container creation. A fresh (non-resume) reconcile instead seeds
// the container via the `priorSlots === undefined` path and the reconcile's own
// final write. This test pins that a brand-new builtin always produces a dense
// array on its first run — never a stuck-undefined container — across an empty
// input, an input where nothing matches, and one where some elements match. It
// records every emission through a sink, so a container that regressed to
// undefined after first becoming an array would be caught too.

const signer = await Identity.fromPassphrase("list fresh init");
const space = signer.did();

function lb(s: MemoryV2Server.Server) {
  return MemoryV2Client.loopback(s);
}
class F implements SessionFactory {
  #gs: () => MemoryV2Server.Server;

  constructor(gs: () => MemoryV2Server.Server) {
    this.#gs = gs;
  }
  async create(spaceId: string, sgnr?: Signer) {
    const client = await MemoryV2Client.connect({ transport: lb(this.#gs()) });
    const session = await client.mount(
      spaceId,
      {},
      testPrincipalSessionOpenAuthFactory(sgnr),
    );
    return { client, session };
  }
}
class SM extends StorageManager {
  static make(as: Identity, s: MemoryV2Server.Server) {
    return new SM({ as, memoryHost: new URL("memory://") } as Options, s);
  }
  private constructor(o: Options, s: MemoryV2Server.Server) {
    super(o, new F(() => s));
  }
  override registerSpaceHostDetailed() {
    return { accepted: false, reason: "no-remote-resolution" } as const;
  }
}

// Each call builds an isolated runtime over a fresh in-memory server, so every
// run is genuinely a first run (no durable carryover to resume against).
function runtime() {
  const server = newSharedServer();
  const sm = SM.make(signer, server);
  const rt = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: sm,
  });
  return { rt, server };
}

const FILTER_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { keep: boolean; label: string }[] }>(({ items }) => {",
      "  return { out: items.filter((item) => item.keep) };",
      "});",
    ].join("\n"),
  }],
};

const FLATMAP_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { keep: boolean; n: number }[] }>(({ items }) => {",
      "  return { out: items.flatMap((item) => item.keep ? item.n : undefined) };",
      "});",
    ].join("\n"),
  }],
};

const MAP_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { n: number }[] }>(({ items }) => {",
      "  return { out: items.map((item) => item.n) };",
      "});",
    ].join("\n"),
  }],
};

type Row = { keep?: boolean; n?: number; label?: string };

// Materialize one `out` snapshot to plain, comparable values while the runtime
// is still live. `project` pulls a primitive out of each element — the identity
// for flatMap/map (numbers), the label for filter (element cell references) — so
// the result never leaves the runtime as a live query-result proxy (those break
// structural equality and die after dispose). null marks an absent (undefined)
// container, distinct from a seeded empty array.
type Project = (x: unknown) => unknown;
const snapshotWith = (project: Project) => (v: unknown): unknown[] | null =>
  Array.isArray(v) ? (v as unknown[]).map(project) : v == null ? null : [NaN];

// Run a fresh pattern, record every `out` emission projected to plain values,
// and return the final value plus the full trajectory.
async function runFresh(
  program: RuntimeProgram,
  id: string,
  items: Row[],
  project: Project,
): Promise<{ final: unknown[] | null; trajectory: (unknown[] | null)[] }> {
  const { rt, server } = runtime();
  const snapshot = snapshotWith(project);
  try {
    const compiled = await rt.patternManager.compilePattern(program, { space });
    const tx0 = rt.edit();
    const rc = rt.getCell<{ out: unknown[] }>(
      space,
      id,
      compiled.resultSchema,
      tx0,
    );
    rt.run(tx0, compiled, { items }, rc);
    await tx0.commit().settled;

    const trajectory: (unknown[] | null)[] = [];
    const cancel = rc.key("out").sink((v) => {
      trajectory.push(snapshot(v));
    });

    for (let k = 0; k < 10; k++) {
      await rc.pull();
      await rt.idle();
      trajectory.push(snapshot(rc.key("out").get()));
    }
    cancel();
    const final = snapshot(rc.key("out").get());
    return { final, trajectory };
  } finally {
    await rt.dispose();
    await server.close();
  }
}

const IDENTITY: Project = (x) => x;
const LABEL: Project = (x) => (x as { label?: string }).label;

// Once `out` has been observed as an array, it must never be observed as
// undefined again — a fresh container that blinked back to absent would be a
// seeding regression.
function assertNoUndefinedAfterArray(trajectory: (unknown[] | null)[]): void {
  let sawArray = false;
  for (const t of trajectory) {
    if (Array.isArray(t)) sawArray = true;
    else if (sawArray && t === null) {
      throw new Error(
        `container regressed to undefined after being an array: ${
          JSON.stringify(trajectory)
        }`,
      );
    }
  }
}

describe("list builtin fresh-init seeding", () => {
  it("filter seeds [] on a fresh run over an empty input", async () => {
    const { final, trajectory } = await runFresh(
      FILTER_PROGRAM,
      "fi-filter-empty",
      [],
      LABEL,
    );
    expect(final).toEqual([]);
    assertNoUndefinedAfterArray(trajectory);
  });

  it("filter seeds [] on a fresh run where nothing matches", async () => {
    const items = [
      { keep: false, label: "a" },
      { keep: false, label: "b" },
      { keep: false, label: "c" },
    ];
    const { final, trajectory } = await runFresh(
      FILTER_PROGRAM,
      "fi-filter-none",
      items,
      LABEL,
    );
    expect(final).toEqual([]);
    assertNoUndefinedAfterArray(trajectory);
  });

  it("filter produces the matching subset on a fresh run", async () => {
    const items = [
      { keep: true, label: "a" },
      { keep: false, label: "b" },
      { keep: true, label: "c" },
    ];
    const { final, trajectory } = await runFresh(
      FILTER_PROGRAM,
      "fi-filter-some",
      items,
      LABEL,
    );
    expect(final).toEqual(["a", "c"]);
    assertNoUndefinedAfterArray(trajectory);
  });

  it("flatMap seeds [] on a fresh run over an empty input", async () => {
    const { final, trajectory } = await runFresh(
      FLATMAP_PROGRAM,
      "fi-flatmap-empty",
      [],
      IDENTITY,
    );
    expect(final).toEqual([]);
    assertNoUndefinedAfterArray(trajectory);
  });

  it("flatMap produces the kept values on a fresh run", async () => {
    const items = [
      { keep: true, n: 1 },
      { keep: false, n: 2 },
      { keep: true, n: 3 },
    ];
    const { final, trajectory } = await runFresh(
      FLATMAP_PROGRAM,
      "fi-flatmap-some",
      items,
      IDENTITY,
    );
    expect(final).toEqual([1, 3]);
    assertNoUndefinedAfterArray(trajectory);
  });

  it("map seeds [] on a fresh run over an empty input", async () => {
    const { final, trajectory } = await runFresh(
      MAP_PROGRAM,
      "fi-map-empty",
      [],
      IDENTITY,
    );
    expect(final).toEqual([]);
    assertNoUndefinedAfterArray(trajectory);
  });

  it("map produces the mapped values on a fresh run", async () => {
    const items = [{ n: 1 }, { n: 2 }, { n: 3 }];
    const { final, trajectory } = await runFresh(
      MAP_PROGRAM,
      "fi-map-some",
      items,
      IDENTITY,
    );
    expect(final).toEqual([1, 2, 3]);
    assertNoUndefinedAfterArray(trajectory);
  });
});
