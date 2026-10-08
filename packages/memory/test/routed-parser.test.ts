import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity, isCanonicalEd25519DID } from "@commonfabric/identity";
import { gzipSync } from "fflate";
import {
  decodeRoutedFrame,
  encodeRoutedFrame,
  parseRoutedJson,
  routedFlags,
} from "../v2/routed-parser.ts";
import { DEFAULT_ROUTED_HOST_LIMITS } from "../v2/routed-host.ts";
import { countValues, routedFrameOf } from "./support/routed-slots.ts";
import { getMemoryProtocolFlags } from "../v2.ts";
const space = (await Identity.fromRaw(new Uint8Array(32).fill(91))).did();
/** A slot cap no frame in this file reaches unless a test says so. */
const SLOTS = 1024;
/**
 * The slot-counting vector shared with the router (infra
 * `memory-router/src/parser.rs`): one slot per JSON value, whether scalar,
 * object or array, keys free, the root included, so this frame body is 30
 * slots. The literal and the count are for infra to mirror in the router's
 * tests.
 */
const COUNTING_VECTOR =
  '{"type":"session/effect","sessionId":"s1","effect":{"type":"sync",' +
  '"fromSeq":0,"toSeq":2,"upserts":[{"branch":"","id":"of:1","scope":"s",' +
  '"seq":1,"doc":{"a":[1,2,3],"b":{},"c":[],"d":null,"e":true,"f":"x"}},' +
  '{"branch":"","id":"of:2","scope":"s","seq":2,"doc":{}}],"removes":[]}}';
const COUNTING_VECTOR_SLOTS = 30;
function envelope(payload: string, hint: string = space) {
  const zipped = gzipSync(new TextEncoder().encode(payload));
  const header = new Uint8Array(11 + hint.length);
  header.set(new TextEncoder().encode("mcmp\x02"));
  const view = new DataView(header.buffer);
  view.setUint32(5, new TextEncoder().encode(payload).length);
  view.setUint16(9, hint.length);
  header.set(new TextEncoder().encode(hint), 11);
  return new Uint8Array([...header, ...zipped]);
}
describe("routed untrusted parsers", () => {
  it("rejects duplicate decoded keys, prototype keys, surrogate errors and excess structure", () => {
    for (
      const source of [
        '{"a":1,"a":2}',
        '{"a":1,"\\u0061":2}',
        '{"__proto__":{}}',
        '{"constructor":1}',
        '"\\ud800"',
        '"unterminated',
        '{"x":1e999}',
        "[".repeat(66) + "0" + "]".repeat(66),
      ]
    ) expect(() => parseRoutedJson(source, SLOTS)).toThrow();
    expect(parseRoutedJson(' \n\t { "ok" : true } \r ', SLOTS)).toEqual({
      ok: true,
    });
  });
  it("counts slots as the router does: one per value, keys free, root included", () => {
    const parsed = JSON.parse(COUNTING_VECTOR);
    expect(countValues(parsed)).toBe(COUNTING_VECTOR_SLOTS);
    expect(parseRoutedJson(COUNTING_VECTOR, COUNTING_VECTOR_SLOTS)).toEqual(
      parsed,
    );
    expect(() => parseRoutedJson(COUNTING_VECTOR, COUNTING_VECTOR_SLOTS - 1))
      .toThrow();
    // Every scalar kind, an empty object and an empty array take one slot each.
    expect(parseRoutedJson('[null,true,1,"x",{},[]]', 7)).toEqual([
      null,
      true,
      1,
      "x",
      {},
      [],
    ]);
    expect(() => parseRoutedJson('[null,true,1,"x",{},[]]', 6)).toThrow();
    for (const cap of [0, -1, 1.5, Number.NaN]) {
      expect(() => parseRoutedJson("1", cap)).toThrow();
    }
    // The frame prefix, the envelope and its hint are not values.
    const frame = `fvj1:${COUNTING_VECTOR}`;
    expect(decodeRoutedFrame(frame, false, COUNTING_VECTOR_SLOTS).body).toEqual(
      parsed,
    );
    expect(() => decodeRoutedFrame(frame, false, COUNTING_VECTOR_SLOTS - 1))
      .toThrow();
    expect(
      decodeRoutedFrame(envelope(frame, ""), true, COUNTING_VECTOR_SLOTS).body,
    ).toEqual(parsed);
    expect(() =>
      decodeRoutedFrame(envelope(frame, ""), true, COUNTING_VECTOR_SLOTS - 1)
    ).toThrow();
  });
  it("keeps the nesting cap at 64 whatever the slot cap", () => {
    expect(parseRoutedJson("[".repeat(64) + "0" + "]".repeat(64), SLOTS))
      .toBeDefined();
    expect(() => parseRoutedJson("[".repeat(65) + "0" + "]".repeat(65), SLOTS))
      .toThrow();
  });
  it("applies the sender's and the receiver's slot cap to a whole frame", () => {
    const cap = 2000;
    const exact = routedFrameOf(cap);
    const over = routedFrameOf(cap + 1);
    expect(countValues(JSON.parse(exact.slice(5)))).toBe(cap);
    const encoded = encodeRoutedFrame(exact, cap);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(decodeRoutedFrame(encoded, true, cap).payload).toBe(exact);
    expect(() => decodeRoutedFrame(encoded, true, cap - 1)).toThrow();
    expect(decodeRoutedFrame(exact, false, cap).payload).toBe(exact);
    expect(() => decodeRoutedFrame(exact, false, cap - 1)).toThrow();
    expect(() => encodeRoutedFrame(over, cap)).toThrow();
    expect(() => decodeRoutedFrame(over, false, cap)).toThrow();
    expect(() => decodeRoutedFrame(envelope(over, ""), true, cap)).toThrow();
    expect(decodeRoutedFrame(envelope(over, ""), true, cap + 1).payload).toBe(
      over,
    );
  });
  it("admits a 119,721-slot document-shaped sync frame at the default cap", () => {
    // The rehearsal's largest first-open sync frame is 119,720 slots without
    // the schema table; this one is one more, shaped like a sync effect whose
    // upserts carry nested documents, then padded to the exact count.
    const upserts: Record<string, unknown>[] = [];
    for (let i = 0; i < 7041; i++) {
      upserts.push({
        branch: "",
        id: `of:${i}`,
        scope: "s",
        seq: i + 1,
        doc: { value: { a: 1, b: "x", c: [1, 2, 3], d: { e: true, f: null } } },
      });
    }
    const message = {
      type: "session/effect",
      space,
      sessionId: "s1",
      effect: { type: "sync", fromSeq: 0, toSeq: 7042, upserts, removes: [] },
    };
    const target = 119_721;
    // The padding upsert is its object, four scalars and the array: 6 slots.
    const pad = target - countValues(message) - 6;
    expect(pad).toBeGreaterThan(0);
    upserts.push({
      branch: "",
      id: "of:pad",
      scope: "s",
      seq: 7042,
      doc: Array(pad).fill(0),
    });
    expect(countValues(message)).toBe(target);
    const frame = `fvj1:${JSON.stringify(message)}`;
    const cap = DEFAULT_ROUTED_HOST_LIMITS.frameSlots;
    expect(cap).toBe(150_000);
    const encoded = encodeRoutedFrame(frame, cap);
    expect(decodeRoutedFrame(encoded, true, cap).body.type).toBe(
      "session/effect",
    );
    expect(() => decodeRoutedFrame(encoded, true, target - 1)).toThrow();
    // The fixed cap this replaced would have refused it.
    expect(() => decodeRoutedFrame(encoded, true, 100_000)).toThrow();
  });
  it("checks DIDs rather than accepting a did:key prefix", () => {
    expect(isCanonicalEd25519DID(space)).toBe(true);
    for (
      const did of [
        "did:key:z6Mk-test",
        space + "x",
        space + "#key-1",
        "did:key:z" + "1".repeat(34),
      ]
    ) expect(isCanonicalEd25519DID(did)).toBe(false);
  });
  it("accepts the modern routed codec and independently checks header and body", () => {
    const payload = `fvj1:${
      JSON.stringify({
        type: "session.open",
        requestId: "r1",
        space,
        principal: space,
        session: {},
      })
    }`;
    expect(decodeRoutedFrame(envelope(payload), true, SLOTS).space).toBe(
      space,
    );
    expect(
      decodeRoutedFrame(encodeRoutedFrame(payload, SLOTS), false, SLOTS)
        .payload,
    ).toBe(payload);
    expect(() => decodeRoutedFrame(envelope(payload, ""), true, SLOTS))
      .toThrow();
    expect(() => decodeRoutedFrame(envelope(payload).slice(0, -1), true, SLOTS))
      .toThrow();
    const corrupt = envelope(payload);
    corrupt[corrupt.length - 8] ^= 1;
    expect(() => decodeRoutedFrame(corrupt, true, SLOTS)).toThrow();
    expect(() =>
      decodeRoutedFrame(
        new Uint8Array([
          ...envelope(payload),
          ...gzipSync(new Uint8Array([0])),
        ]),
        true,
        SLOTS,
      )
    ).toThrow();
    expect(() => decodeRoutedFrame(envelope(payload), false, SLOTS)).toThrow();
    expect(() =>
      decodeRoutedFrame(
        envelope(
          'fvj1:{"type":"transact","requestId":"r1","space":"' + space +
            '","value":"' + "a".repeat(100000) + '"}',
        ),
        true,
        SLOTS,
      )
    ).toThrow();
  });
  it("requires negotiated routed flags and rejects unknown or tagged security records", () => {
    const flags = {
      ...getMemoryProtocolFlags(),
      connectionAuth: true,
      routedAuthV1: true,
    };
    expect(routedFlags(flags).length).toBeLessThan(2048);
    // Either cell representation passes: client and toolshed agree on it at
    // the toolshed's handshake, not here.
    for (const modernCellRep of [false, true]) {
      expect(routedFlags({ ...flags, modernCellRep }).length).toBeGreaterThan(
        0,
      );
    }
    for (
      const invalid of [
        { ...flags, connectionAuth: false },
        { ...flags, routedAuthV1: false },
        { ...flags, stableExpressionResultIds: false },
        { ...flags, modernCellRep: "true" },
        { ...flags, arbitraryFutureAuthority: true },
        { ...flags, "/tag": true },
      ]
    ) expect(() => routedFlags(invalid)).toThrow();
  });
  it("refuses an expanded payload when its raw fallback cannot fit the wire bound", () => {
    const payload = `fvj1:${
      JSON.stringify({
        type: "transact",
        requestId: "large",
        space,
        value: "a".repeat(9 * 1024 * 1024),
      })
    }`;
    expect(() => encodeRoutedFrame(payload, SLOTS)).toThrow();
  });
  it("mutation exercises binary and JSON parsers without parser panics", () => {
    const seed = envelope(
      `fvj1:${
        JSON.stringify({
          type: "session.open",
          requestId: "r1",
          space,
          principal: space,
          session: {},
        })
      }`,
    );
    for (let i = 0; i < 3000; i++) {
      const bytes = seed.slice();
      bytes[i % bytes.length] ^= (i % 255) + 1;
      try {
        decodeRoutedFrame(bytes, true, SLOTS);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
      try {
        parseRoutedJson(new TextDecoder().decode(bytes), SLOTS);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
  });
});
