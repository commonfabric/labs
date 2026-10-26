import { assertEquals, assertThrows } from "@std/assert";
import {
  chunkEvents,
  encodedJsonBytes,
  iterateEventChunks,
} from "../src/chunking.ts";

Deno.test("event chunking rejects invalid byte targets", () => {
  for (const targetBytes of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assertThrows(
      () => chunkEvents([], targetBytes),
      Error,
      "targetBytes must be a positive safe integer",
    );
  }
});

Deno.test("chunkEvents keeps provider events whole and deterministic", () => {
  const events = [
    { id: "a", text: "12345678" },
    { id: "b", text: "abcdefgh" },
    { id: "c", text: "oversized-event-is-still-whole" },
  ];
  const targetBytes = encodedJsonBytes([events[0]]);
  const chunks = chunkEvents(events, targetBytes);

  assertEquals(chunks.map((chunk) => chunk.events.map((event) => event.id)), [
    ["a"],
    ["b"],
    ["c"],
  ]);
  assertEquals(chunks.map((chunk) => chunk.part), [0, 1, 2]);
  assertEquals(chunkEvents(events, targetBytes), chunks);
});

Deno.test("chunkEvents returns one empty chunk for an empty complete snapshot", () => {
  assertEquals(chunkEvents([], 512), [{
    part: 0,
    events: [],
    byteLength: encodedJsonBytes([]),
  }]);
});

Deno.test("chunkEvents reports the exact size of multi-event chunks", () => {
  const events = [{ value: 1 }, { value: 2 }, { value: 3 }];
  assertEquals(chunkEvents(events, 1024), [{
    part: 0,
    events,
    byteLength: encodedJsonBytes(events),
  }]);
});

Deno.test("chunkEvents serializes each provider event once", () => {
  let serializations = 0;
  const events = [
    {
      id: "a",
      toJSON() {
        serializations++;
        return { id: "a", text: "é" };
      },
    },
    {
      id: "b",
      toJSON() {
        serializations++;
        return { id: "b", text: "世界" };
      },
    },
  ];

  const chunks = chunkEvents(events, 1);

  assertEquals(serializations, 2);
  assertEquals(chunks.map((chunk) => chunk.events[0].id), ["a", "b"]);
  assertEquals(chunks.map((chunk) => chunk.byteLength), [
    encodedJsonBytes([{ id: "a", text: "é" }]),
    encodedJsonBytes([{ id: "b", text: "世界" }]),
  ]);
});

Deno.test("event chunk iteration does not inspect the whole session", () => {
  let captures = 0;
  const events = ["a", "b", "c"].map((id) => ({
    toJSON() {
      captures++;
      return { id, text: "event" };
    },
  }));
  const chunks = iterateEventChunks(events, 1);

  assertEquals(chunks.next().value?.events, [events[0]]);
  assertEquals(captures, 2);
  assertEquals(chunks.next().value?.events, [events[1]]);
  assertEquals(captures, 3);
  assertEquals(chunks.next().value?.events, [events[2]]);
  assertEquals(chunks.next().done, true);
});

Deno.test("chunkEvents measures bigint using the Fabric JSON encoding", () => {
  const events = [
    { id: "positive", value: 1n },
    { id: "negative", value: -1n },
    { id: "large", value: 2n ** 100n },
  ];
  const chunks = chunkEvents(events, encodedJsonBytes([events[0]]));
  assertEquals(chunks.map((chunk) => chunk.events.length), [1, 1, 1]);
  assertEquals(
    chunks.map((chunk) => chunk.byteLength),
    events.map((event) => encodedJsonBytes([event])),
  );
});
