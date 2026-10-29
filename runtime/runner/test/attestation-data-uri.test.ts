/**
 * `load()` is the storage-transaction-side reader of `data:` URI documents,
 * separate from `data-uri.ts`'s `valueFromDataUri()`. Both route payload
 * text through `valueFromDataUriPayloadText()`, so the two readers cannot
 * silently diverge on what a payload means.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { DATA_URI_MEDIA_TYPE } from "@commonfabric/data-model/codec-data-uri";
import { JsonCodecEngine } from "@commonfabric/data-model/codec-json";
import { jsonFromFabricValue } from "@commonfabric/data-model/codecs";
import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";

import type { URI } from "../src/sigil-types.ts";
import { load } from "../src/storage/transaction/attestation.ts";

/** `data:` cell URI (base64url payload) with the given payload text. */
const uriOf = (payload: string): URI =>
  `data:${DATA_URI_MEDIA_TYPE},${
    toUnpaddedBase64url(new TextEncoder().encode(payload))
  }` as URI;

describe("attestation `load()` of `data:` URIs", () => {
  it("errors on a historical bare-JSON payload", () => {
    const { ok, error } = load({ id: uriOf('{"value":{"x":1}}') });
    expect(ok).toBeUndefined();
    expect(error?.name).toBe("InvalidDataURIError");
  });

  it("synthesizes the document around the decoded value", () => {
    const { ok, error } = load({ id: uriOf(jsonFromFabricValue({ x: 1 })) });
    expect(error).toBeUndefined();
    expect(ok!.value).toEqual({ value: { x: 1 } });
    expect(ok!.address.path).toEqual([]);
    expect(Object.isFrozen(ok!.value)).toBe(true);
  });

  it("loads an encoded-`FabricValue` payload", () => {
    const value = { b: 1, a: [true, null, "x"] };
    const { ok, error } = load({ id: uriOf(jsonFromFabricValue(value)) });
    expect(error).toBeUndefined();
    expect(ok!.value).toEqual({ value });
  });

  it("preserves non-finite numbers in an encoded payload", () => {
    const { ok, error } = load({
      id: uriOf(jsonFromFabricValue([NaN, -0, Infinity])),
    });
    expect(error).toBeUndefined();
    const items = (ok!.value as { value: number[] }).value;
    expect(Object.is(items[0], NaN)).toBe(true);
    expect(Object.is(items[1], -0)).toBe(true);
    expect(Object.is(items[2], Infinity)).toBe(true);
  });

  it("errors on an undecodable payload", () => {
    const { ok, error } = load({ id: uriOf("{nope") });
    expect(ok).toBeUndefined();
    expect(error?.name).toBe("InvalidDataURIError");
  });

  it("errors on an undecodable payload past the codec tag", () => {
    const { ok, error } = load({
      id: uriOf(
        JsonCodecEngine.wrapEncodedValueForTesting("{nope", true),
      ),
    });
    expect(ok).toBeUndefined();
    expect(error?.name).toBe("InvalidDataURIError");
  });

  it("rejects the `application/json` media type", () => {
    const { ok, error } = load({
      id: `data:application/json,${
        toUnpaddedBase64url(
          new TextEncoder().encode(jsonFromFabricValue({ a: 1 })),
        )
      }` as URI,
    });
    expect(ok).toBeUndefined();
    expect(error?.name).toBe("UnsupportedMediaTypeError");
  });

  it("errors on an empty payload", () => {
    const { ok, error } = load({
      id: `data:${DATA_URI_MEDIA_TYPE},` as URI,
    });
    expect(ok).toBeUndefined();
    expect(error?.name).toBe("InvalidDataURIError");
  });

  it("errors on an unsupported media type", () => {
    const { error } = load({ id: "data:text/plain,hello" as URI });
    expect(error?.name).toBe("UnsupportedMediaTypeError");
  });

  it("errors on a parameterized header", () => {
    // A parameterized header passes the prefix pre-gate but is not the exact
    // media type (this format has no parameters).

    const payload = toUnpaddedBase64url(
      new TextEncoder().encode(jsonFromFabricValue({ a: 1 })),
    );
    const { ok, error } = load({
      id: `data:${DATA_URI_MEDIA_TYPE};base64,${payload}` as URI,
    });
    expect(ok).toBeUndefined();
    expect(error?.name).toBe("UnsupportedMediaTypeError");
  });

  it("errors on a percent-encoded payload", () => {
    // Extraction-level failure (as opposed to payload-decode failure): a
    // percent-encoded payload is not base64url.

    const { ok, error } = load({
      id: `data:${DATA_URI_MEDIA_TYPE},${
        encodeURIComponent(jsonFromFabricValue({ a: 1 }))
      }` as URI,
    });
    expect(ok).toBeUndefined();
    expect(error?.name).toBe("InvalidDataURIError");
  });
});
