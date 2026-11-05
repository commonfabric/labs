/**
 * Traverse replay oracle test: replays each captured fixture in
 * test/traverse-replay/fixtures/ and asserts the oracle (result hashes,
 * read set, schema-tracker contents) matches the checked-in golden.
 *
 * A failure here means traversal semantics changed. If unintended, fix the
 * regression. If intended, regenerate goldens (see
 * test/traverse-replay/regen-goldens.ts) and justify the golden diff in the
 * PR.
 */

import { assert } from "@std/assert";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/data-model";
import { DATA_URI_MEDIA_TYPE } from "@commonfabric/data-model/codec-data-uri";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import {
  diffOracles,
  listFixturePaths,
  loadGolden,
} from "./traverse-replay/goldens.ts";
import { loadFixture, replayFixture } from "./traverse-replay/replay.ts";
import {
  fixtureDocKey,
  type TraverseFixture,
} from "../src/traverse-recorder.ts";

Deno.test("traverse replay matches golden oracles", async (t) => {
  const fixtures = listFixturePaths();
  assert(fixtures.length > 0, "no fixtures found");
  for (const { name, path } of fixtures) {
    await t.step(name, async () => {
      const golden = await loadGolden(name);
      assert(
        golden !== undefined,
        `missing golden for fixture "${name}" - run ` +
          `test/traverse-replay/regen-goldens.ts and review the diff`,
      );
      const fixture = await loadFixture(path);
      const { oracle } = replayFixture(fixture, { collectOracle: true });
      const problems = diffOracles(golden, oracle!);
      assert(
        problems.length === 0,
        `oracle mismatch for "${name}" (traversal semantics changed):\n` +
          problems.join("\n"),
      );
    });
  }
});

Deno.test("traverse replay records batched plain-schema reads", () => {
  const space = "did:key:z6MkpXpeKbhbddoVvxQndKtnNZmGfpSbXXmVw88bswFy2hHh";
  const sourceId = "of:fixture-source";
  const rowIds = ["of:fixture-row-one", "of:fixture-row-two"];
  const link = (id: string) =>
    linkRefFrom({ id, space, scope: "space", path: [] });
  const docs: Record<string, FabricValue> = {};
  docs[fixtureDocKey({ space, id: sourceId })] = {
    value: rowIds.map(link),
  };
  docs[fixtureDocKey({ space, id: rowIds[0] })] = {
    value: { label: "First" },
  };
  docs[fixtureDocKey({ space, id: rowIds[1] })] = {
    value: { label: "Second" },
  };
  const fixture: TraverseFixture = {
    version: 2,
    meta: { name: "batched-plain-schema", source: "focused regression" },
    selectors: [{
      path: ["value"],
      schema: {
        type: "array",
        items: {
          type: "object",
          properties: { label: { type: "string" } },
        },
      },
    }],
    links: [],
    docs,
    invocations: [{
      address: {
        space,
        id: sourceId,
        type: "application/json",
        path: ["value"],
        scope: "space",
      },
      selector: 0,
      traverseCells: false,
      context: 0,
    }],
  };

  const { oracle } = replayFixture(fixture, { collectOracle: true });
  assert(oracle !== undefined);
  assert(
    oracle.readSet.includes(
      `${space}|space|${sourceId}|["value","0"]|nt`,
    ),
  );
  assert(
    oracle.readSet.includes(
      `${space}|space|${sourceId}|["value","0"]|t`,
    ),
  );
  assert(
    oracle.readSet.includes(
      `${space}|space|${rowIds[0]}|["value","label"]|nt`,
    ),
  );
});

Deno.test("plain primitive-array traversal records indices after failure", () => {
  const space = "did:key:z6MkpXpeKbhbddoVvxQndKtnNZmGfpSbXXmVw88bswFy2hHh";
  const sourceId = "of:invalid-primitive-tail";
  const docs: Record<string, FabricValue> = {};
  docs[fixtureDocKey({ space, id: sourceId })] = {
    value: [[1, "still-read"]],
  };
  const fixture: TraverseFixture = {
    version: 2,
    meta: { name: "invalid-primitive-tail", source: "focused regression" },
    selectors: [{
      path: ["value"],
      schema: {
        type: "array",
        items: { type: "array", items: { type: "string" } },
      },
    }],
    links: [],
    docs,
    invocations: [{
      address: {
        space,
        id: sourceId,
        type: "application/json",
        path: ["value"],
        scope: "space",
      },
      selector: 0,
      traverseCells: false,
      context: 0,
    }],
  };

  const { oracle } = replayFixture(fixture, { collectOracle: true });
  assert(oracle !== undefined);
  assert(
    oracle.readSet.some((read) =>
      read.includes(`data:${DATA_URI_MEDIA_TYPE}`) &&
      read.endsWith('|["value","1"]|nt')
    ),
  );
});

Deno.test("traverse replay refuses a fixture of another format version", async () => {
  // A version-1 fixture names the traversal flag `includeMeta`, which this
  // replay does not read, so every invocation in it would replay as a
  // value-shaped traversal; the loader names the version instead.
  const path = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      version: 1,
      meta: { name: "stale", source: "focused regression" },
      selectors: [],
      links: [],
      docs: {},
      invocations: [],
    }),
  );
  await expect(loadFixture(path)).rejects.toThrow("format version 1");
});
