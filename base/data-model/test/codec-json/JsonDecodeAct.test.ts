import { expect } from "@std/expect";

import { isDeepFrozen } from "@/deep-freeze.ts";
import { NULL_LIVE_ENVIRONMENT } from "@/codec-common";
import { JsonCodecEngine } from "@/codec-json";
import { JsonDecodeAct } from "@/codec-json/JsonDecodeAct.ts";
import type { JsonCodecValue } from "@/codec-json/interface.ts";
import { createDefaultJsonRegistry } from "@/codecs.ts";
import { describe, it } from "@commonfabric/test-support/test";

describe("JsonDecodeAct", () => {
  // The walk reuses parsed subtrees that need no translation, and rebuilds
  // the ancestors of a translated tag or hole. Parsed values belong to one
  // act, so reuse preserves frozen results and mutable ownership.

  describe("instance members", () => {
    describe("decodeValue()", () => {
      for (const mutable of [false, true]) {
        describe(mutable ? "a mutable decode" : "a frozen decode", () => {
          /** One act over the standard codecs, with this group's frozenness. */
          function act(): JsonDecodeAct {
            return new JsonDecodeAct(
              new JsonCodecEngine({
                registry: createDefaultJsonRegistry(),
                mutable,
              }),
              NULL_LIVE_ENVIRONMENT,
            );
          }

          it("reuses a parsed tree whose values need no translation", () => {
            const decode = act();
            const parsed = decode.encodedFromSerializedForm(
              'fvj1:{"items":[null,true,0,{"name":"room"}],"empty":{}}',
            );
            const result = decode.decodeValue(parsed);

            expect(result).toBe(parsed);
            expect(isDeepFrozen(result)).toBe(!mutable);
          });

          it("copies changed ancestors and keeps their unchanged children", () => {
            const decode = act();
            const parsed = decode.encodedFromSerializedForm(
              'fvj1:{"before":{"name":"room"},"items":[{"kept":true},{"/Undefined@1":null},{"after":1}]}',
            ) as Record<string, JsonCodecValue>;
            const result = decode.decodeValue(parsed) as Record<
              string,
              unknown
            >;
            const items = result.items as unknown[];
            const originalItems = parsed.items as unknown[];

            expect(result).not.toBe(parsed);
            expect(result.before).toBe(parsed.before);
            expect(items).not.toBe(originalItems);
            expect(items[0]).toBe(originalItems[0]);
            expect(items[1]).toBeUndefined();
            expect(1 in items).toBe(true);
            expect(items[2]).toBe(originalItems[2]);
            expect(originalItems[1]).toEqual({ "/Undefined@1": null });
            expect(isDeepFrozen(result)).toBe(!mutable);
          });

          it("keeps the prefix and suffix around an expanded hole run", () => {
            const decode = act();
            const parsed = decode.encodedFromSerializedForm(
              'fvj1:[{"before":1},{"/hole":2},{"after":2},{"/hole":1}]',
            ) as JsonCodecValue[];
            const result = decode.decodeValue(parsed) as unknown[];

            expect(result).not.toBe(parsed);
            expect(result.length).toBe(5);
            expect(result[0]).toBe(parsed[0]);
            expect(1 in result).toBe(false);
            expect(2 in result).toBe(false);
            expect(result[3]).toBe(parsed[2]);
            expect(4 in result).toBe(false);
            expect(isDeepFrozen(result)).toBe(!mutable);
          });
        });
      }

      it("keeps mutable results from separate parses independent", () => {
        const engine = new JsonCodecEngine({
          registry: createDefaultJsonRegistry(),
          mutable: true,
        });
        const text = 'fvj1:{"items":[{"name":"room"}]}';
        const first = engine.decode(text) as { items: { name: string }[] };
        const second = engine.decode(text) as { items: { name: string }[] };
        first.items[0]!.name = "changed";

        expect(second.items[0]!.name).toBe("room");
        expect(Object.isFrozen(first.items[0])).toBe(false);
      });
    });
  });
});
