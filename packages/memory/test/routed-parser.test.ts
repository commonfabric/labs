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
import { getMemoryProtocolFlags } from "../v2.ts";
const space = (await Identity.fromRaw(new Uint8Array(32).fill(91))).did();
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
    ) expect(() => parseRoutedJson(source)).toThrow();
    expect(parseRoutedJson(' \n\t { "ok" : true } \r ')).toEqual({ ok: true });
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
    expect(decodeRoutedFrame(envelope(payload), true).space).toBe(space);
    expect(decodeRoutedFrame(encodeRoutedFrame(payload), false).payload).toBe(
      payload,
    );
    expect(() => decodeRoutedFrame(envelope(payload, ""), true)).toThrow();
    expect(() => decodeRoutedFrame(envelope(payload).slice(0, -1), true))
      .toThrow();
    const corrupt = envelope(payload);
    corrupt[corrupt.length - 8] ^= 1;
    expect(() => decodeRoutedFrame(corrupt, true)).toThrow();
    expect(() =>
      decodeRoutedFrame(
        new Uint8Array([
          ...envelope(payload),
          ...gzipSync(new Uint8Array([0])),
        ]),
        true,
      )
    ).toThrow();
    expect(() => decodeRoutedFrame(envelope(payload), false)).toThrow();
    expect(() =>
      decodeRoutedFrame(
        envelope(
          'fvj1:{"type":"transact","requestId":"r1","space":"' + space +
            '","value":"' + "a".repeat(100000) + '"}',
        ),
        true,
      )
    ).toThrow();
  });
  it("requires negotiated routed flags and rejects unknown or tagged security records", () => {
    const flags = {
      ...getMemoryProtocolFlags(),
      modernCellRep: true,
      connectionAuth: true,
      routedAuthV1: true,
    };
    expect(routedFlags(flags).length).toBeLessThan(2048);
    for (
      const invalid of [
        { ...flags, connectionAuth: false },
        { ...flags, routedAuthV1: false },
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
    expect(() => encodeRoutedFrame(payload)).toThrow();
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
        decodeRoutedFrame(bytes, true);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
      try {
        parseRoutedJson(new TextDecoder().decode(bytes));
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
  });
});
