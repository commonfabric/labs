import { assertEquals, assertNotEquals } from "@std/assert";

import {
  linkRefFrom,
  linkRefPayload,
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import {
  ProblematicValue,
  UnknownValue,
} from "@commonfabric/data-model/codec-common";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import {
  hashStableArrayValue,
  materializeStableArrayCells,
  planStableArrayCells,
} from "../src/array-cell-identity.ts";
import { canonicalJson } from "../src/canonical-json.ts";

Deno.test("canonical JSON sorts object keys inside arrays", () => {
  assertEquals(
    canonicalJson([{ z: 1, a: 2 }, "tail"]),
    '[{"a":2,"z":1},"tail"]',
  );
});

Deno.test("connector hashes distinguish `FabricValue`s that JSON conflates", async () => {
  assertNotEquals(
    await hashStableArrayValue([{ id: "event", detail: undefined }]),
    await hashStableArrayValue([{ id: "event" }]),
  );
  assertNotEquals(
    await hashStableArrayValue([undefined]),
    await hashStableArrayValue([null]),
  );
  assertNotEquals(
    await hashStableArrayValue([-0, NaN, Infinity]),
    await hashStableArrayValue([0, null, null]),
  );

  const sparse: unknown[] = [];
  sparse.length = 1;
  assertNotEquals(
    await hashStableArrayValue(sparse),
    await hashStableArrayValue([undefined]),
  );
});

Deno.test("connector hashes ignore object key insertion order", async () => {
  assertEquals(
    await hashStableArrayValue({ second: 2, first: 1 }),
    await hashStableArrayValue({ first: 1, second: 2 }),
  );
});

Deno.test("connector hashes match independently stored array children", async () => {
  const shared = { value: 1 };
  assertEquals(
    await hashStableArrayValue([shared, shared]),
    await hashStableArrayValue([{ value: 1 }, { value: 1 }]),
  );
  assertNotEquals(
    await hashStableArrayValue([shared, shared]),
    await hashStableArrayValue([
      { value: 1 },
      linkRefFrom({ path: ["0"] }),
    ]),
  );
});

Deno.test("connector hashes preserve native `FabricValue`s", async () => {
  assertNotEquals(
    await hashStableArrayValue(new Date(0)),
    await hashStableArrayValue(new Date(1)),
  );
  assertNotEquals(
    await hashStableArrayValue(/first/gi),
    await hashStableArrayValue(/second/gi),
  );
  assertNotEquals(
    await hashStableArrayValue(new Uint8Array([1])),
    await hashStableArrayValue(new Uint8Array([2])),
  );
});

Deno.test("deeply nested arrays are hashed without repeated planning", async () => {
  let value: unknown = "leaf";
  for (let depth = 0; depth < 16; depth++) value = [value];
  assertEquals(
    await hashStableArrayValue(value),
    "sha256:f318e21ba296a8e09bbaaf1083630d431a24082450a0ecac115a135fa2f26f72",
  );
});

Deno.test("stable plans freeze modern `FabricLink`s", async () => {
  setModernCellRepConfig(true);
  try {
    const payload = { path: ["before"] };
    const link = linkRefFrom(payload);
    const before = await hashStableArrayValue({ link });
    const plan = await planStableArrayCells(
      { link },
      { agentConnector: "modern-link-test" },
    );

    payload.path[0] = "after";
    const materialized = materializeStableArrayCells(
      plan,
      () => {
        throw new Error("link payload unexpectedly became an array cell");
      },
    ) as Record<string, unknown>;
    const capturedLink = materialized.link as ReturnType<typeof linkRefFrom>;
    assertEquals(linkRefPayload(capturedLink).path, ["before"]);
    assertEquals(Object.isFrozen(capturedLink), true);
    assertEquals(Object.isFrozen(linkRefPayload(capturedLink)), true);
    assertEquals(
      await hashStableArrayValue(materialized),
      before,
    );
  } finally {
    resetModernCellRepConfig();
  }
});

Deno.test("stable plans privately capture mutable `FabricInstance`s", async () => {
  setModernCellRepConfig(true);
  try {
    const linkPayload = { path: ["before"] };
    const unknownState = {
      nested: {
        link: linkRefFrom(linkPayload),
        value: "before",
      },
    };
    const problematicState = { nested: { value: "before" } };
    const errorCause = { nested: { value: "before" } };
    const unknown = new UnknownValue("Future@2", unknownState);
    const problematic = new ProblematicValue(
      "future@1",
      problematicState,
      "decode failed",
    );
    const error = new FabricError({
      type: "Error",
      message: "capture failed",
      stack: undefined,
      cause: errorCause,
      extras: [["linked", unknownState.nested.link]],
    });
    const before = await hashStableArrayValue({ error, problematic, unknown });
    const plan = await planStableArrayCells(
      { error, problematic, unknown },
      { agentConnector: "incomplete-clone-test" },
    );

    linkPayload.path[0] = "after";
    errorCause.nested.value = "after";
    unknownState.nested.value = "after";
    problematicState.nested.value = "after";

    const materialized = materializeStableArrayCells(
      plan,
      () => {
        throw new Error("`FabricInstance` unexpectedly became an array cell");
      },
    ) as {
      error: FabricError;
      problematic: ProblematicValue;
      unknown: UnknownValue;
    };
    const capturedErrorCause = materialized.error.cause as {
      nested: { value: string };
    };
    const capturedUnknownState = materialized.unknown.state as {
      nested: {
        link: ReturnType<typeof linkRefFrom>;
        value: string;
      };
    };
    const capturedProblematicState = materialized.problematic.state as {
      nested: { value: string };
    };

    assertEquals(materialized.error === error, false);
    assertEquals(materialized.unknown === unknown, false);
    assertEquals(materialized.problematic === problematic, false);
    assertEquals(capturedErrorCause.nested.value, "before");
    assertEquals(
      linkRefPayload(
        materialized.error.getExtra("linked") as ReturnType<
          typeof linkRefFrom
        >,
      ).path,
      ["before"],
    );
    assertEquals(capturedUnknownState.nested.value, "before");
    assertEquals(
      linkRefPayload(capturedUnknownState.nested.link).path,
      ["before"],
    );
    assertEquals(capturedProblematicState.nested.value, "before");
    assertEquals(materialized.problematic.error, "decode failed");
    assertEquals(Object.isFrozen(materialized.error), true);
    assertEquals(Object.isFrozen(capturedErrorCause), true);
    assertEquals(Object.isFrozen(materialized.unknown), true);
    assertEquals(Object.isFrozen(capturedUnknownState), true);
    assertEquals(Object.isFrozen(capturedUnknownState.nested), true);
    assertEquals(Object.isFrozen(capturedUnknownState.nested.link), true);
    assertEquals(Object.isFrozen(materialized.problematic), true);
    assertEquals(Object.isFrozen(capturedProblematicState), true);
    assertEquals(await hashStableArrayValue(materialized), before);
  } finally {
    resetModernCellRepConfig();
  }
});
