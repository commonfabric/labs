import { assert, assertEquals } from "@std/assert";
import {
  materializeStableArrayCells,
  planStableArrayCells,
  type StableArrayCellPlan,
} from "../src/array-cell-identity.ts";

class FakeCell {
  constructor(
    readonly cause: unknown,
    readonly value: unknown,
  ) {}
}

function materialize(plan: StableArrayCellPlan) {
  const writes: Array<{ cause: unknown; value: unknown }> = [];
  const value = materializeStableArrayCells(
    plan,
    (cause, value) => {
      writes.push({ cause, value });
      return new FakeCell(cause, value);
    },
  );
  return { value, writes };
}

function cellsById(value: unknown): Map<string, FakeCell> {
  const cells = value as FakeCell[];
  return new Map(cells.map((cell) => {
    return [String((cell.value as Record<string, unknown>).id), cell];
  }));
}

Deno.test("array object cells keep their causes when their array is reordered", async () => {
  const scope = { agentConnector: "session-index" };
  const first = materialize(
    await planStableArrayCells({
      sessions: [
        { id: "alpha", title: "Alpha" },
        { id: "beta", title: "Beta" },
      ],
    }, scope),
  );
  const reordered = materialize(
    await planStableArrayCells({
      sessions: [
        { id: "beta", title: "Beta renamed" },
        { id: "alpha", title: "Alpha renamed" },
      ],
    }, scope),
  );

  const firstCells = cellsById(
    (first.value as Record<string, unknown>).sessions,
  );
  const reorderedCells = cellsById(
    (reordered.value as Record<string, unknown>).sessions,
  );
  assertEquals(
    firstCells.get("alpha")?.cause,
    reorderedCells.get("alpha")?.cause,
  );
  assertEquals(
    firstCells.get("beta")?.cause,
    reorderedCells.get("beta")?.cause,
  );
});

Deno.test("every array element is materialized as a stable cell", async () => {
  const { value, writes } = materialize(
    await planStableArrayCells({
      sources: [{
        id: "codex",
        errors: [{ message: "bad session" }],
        matrix: [[{ id: "nested", value: 1 }]],
      }],
      primitives: ["one", 2, false, null],
    }, { agentConnector: "health" }),
  );

  const root = value as Record<string, unknown>;
  const source = (root.sources as FakeCell[])[0];
  assert(source instanceof FakeCell);
  const sourceValue = source.value as Record<string, unknown>;
  assert((sourceValue.errors as unknown[])[0] instanceof FakeCell);
  const nestedArray = (sourceValue.matrix as FakeCell[])[0];
  assert(nestedArray instanceof FakeCell);
  const nestedArrayValue = nestedArray.value as unknown[];
  assert(nestedArrayValue[0] instanceof FakeCell);
  const primitives = root.primitives as FakeCell[];
  assert(primitives.every((value) => value instanceof FakeCell));
  assertEquals(
    primitives.map((cell) => cell.value),
    ["one", 2, false, null],
  );
  assertEquals(writes.length, 8);
});

Deno.test("primitive array elements keep content-derived causes when reordered", async () => {
  const scope = { agentConnector: "source" };
  const first = materialize(
    await planStableArrayCells({ modes: ["ask", "edit"] }, scope),
  );
  const reordered = materialize(
    await planStableArrayCells({ modes: ["edit", "ask"] }, scope),
  );

  const cellsByValue = (
    result: ReturnType<typeof materialize>,
  ): Map<unknown, unknown> =>
    new Map(
      ((result.value as Record<string, unknown>).modes as FakeCell[]).map(
        (cell) => [cell.value, cell.cause],
      ),
    );
  assertEquals(cellsByValue(first), cellsByValue(reordered));
});

Deno.test("nested ids are scoped to their owning array object", async () => {
  const { value } = materialize(
    await planStableArrayCells({
      sessions: [
        { key: "codex/one", messages: [{ id: "message-1", text: "one" }] },
        { key: "codex/two", messages: [{ id: "message-1", text: "two" }] },
      ],
    }, { agentConnector: "session-index" }),
  );

  const sessions = (value as Record<string, unknown>).sessions as FakeCell[];
  const messageCauses = sessions.map((session) => {
    const sessionValue = session.value as Record<string, unknown>;
    return (sessionValue.messages as FakeCell[])[0].cause;
  });
  assert(JSON.stringify(messageCauses[0]) !== JSON.stringify(messageCauses[1]));
});

Deno.test("unidentified objects use content identity instead of array position", async () => {
  const scope = { agentConnector: "health" };
  const first = materialize(
    await planStableArrayCells({
      errors: [{ message: "first" }, { message: "second" }],
    }, scope),
  );
  const reordered = materialize(
    await planStableArrayCells({
      errors: [{ message: "second" }, { message: "first" }],
    }, scope),
  );

  const causeByMessage = (result: ReturnType<typeof materialize>) =>
    new Map(
      ((result.value as Record<string, unknown>).errors as FakeCell[]).map(
        (cell) => {
          const written = cell.value as Record<string, unknown>;
          return [String(written.message), cell.cause];
        },
      ),
    );

  assertEquals(
    causeByMessage(first).get("first"),
    causeByMessage(reordered).get("first"),
  );
  assertEquals(
    causeByMessage(first).get("second"),
    causeByMessage(reordered).get("second"),
  );
});

Deno.test("stable structural identity wins over mutable chunk content", async () => {
  const scope = { agentConnector: "session" };
  const first = materialize(
    await planStableArrayCells({
      chunks: [{ part: 0, contentHash: "sha256:old", eventCount: 1 }],
    }, scope),
  );
  const updated = materialize(
    await planStableArrayCells({
      chunks: [{ part: 0, contentHash: "sha256:new", eventCount: 2 }],
    }, scope),
  );

  const cause = (result: ReturnType<typeof materialize>) =>
    ((result.value as Record<string, unknown>).chunks as FakeCell[])[0].cause;
  assertEquals(cause(first), cause(updated));
});

Deno.test("command identity wins over the shared session identity", async () => {
  const scope = { agentConnector: "receipt-index" };
  const first = materialize(
    await planStableArrayCells({
      receipts: [
        {
          commandId: "command-1",
          sourceId: "codex",
          nativeSessionId: "session-1",
          status: "in-flight",
        },
        {
          commandId: "command-2",
          sourceId: "codex",
          nativeSessionId: "session-1",
          status: "succeeded",
        },
      ],
    }, scope),
  );
  const updated = materialize(
    await planStableArrayCells({
      receipts: [{
        commandId: "command-1",
        sourceId: "codex",
        nativeSessionId: "session-1",
        status: "succeeded",
      }],
    }, scope),
  );

  const cells = (result: ReturnType<typeof materialize>) =>
    (result.value as Record<string, unknown>).receipts as FakeCell[];
  assertEquals(cells(first)[0].cause, cells(updated)[0].cause);
  assert(
    JSON.stringify(cells(first)[0].cause) !==
      JSON.stringify(cells(first)[1].cause),
  );
});
