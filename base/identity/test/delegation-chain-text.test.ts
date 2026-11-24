// Flat `Deno.test` cases: this package's tests also run in a browser through
// `deno-web-test`, which does not support `@std/testing/bdd`.

import { expect } from "@std/expect";

import {
  decodeDelegationChains,
  DELEGATION_CHAIN_FORMAT,
  encodeDelegationChains,
} from "../src/delegation-chain-text.ts";
import { DelegationError } from "../src/delegation.ts";

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

Deno.test("delegation-chain-text: decodes the chains it encoded, each link byte for byte", () => {
  const chains = [[bytes(1, 2, 3), bytes(255, 0)], [bytes(7)]];
  const text = encodeDelegationChains(chains);
  expect(JSON.parse(text)).toMatchObject({ format: DELEGATION_CHAIN_FORMAT });
  expect(decodeDelegationChains(text)).toEqual(chains);
});

Deno.test("delegation-chain-text: encodes no chains as an empty list", () => {
  expect(decodeDelegationChains(encodeDelegationChains([]))).toEqual([]);
});

Deno.test("delegation-chain-text: throws a DelegationError naming an empty chain it is asked to encode", () => {
  expect(() => encodeDelegationChains([[bytes(1)], []])).toThrow(
    new DelegationError("chain 1 is empty"),
  );
});

Deno.test("delegation-chain-text: reads a text carrying fields it does not know", () => {
  const text = JSON.stringify({
    format: DELEGATION_CHAIN_FORMAT,
    chains: [["AQID"]],
    issuedBy: "someone",
  });
  expect(decodeDelegationChains(text)).toEqual([[bytes(1, 2, 3)]]);
});

Deno.test("delegation-chain-text: throws a DelegationError for text that is not JSON", () => {
  expect(() => decodeDelegationChains("{")).toThrow(DelegationError);
});

Deno.test("delegation-chain-text: throws a DelegationError for a JSON value that is not an object", () => {
  expect(() => decodeDelegationChains("[]")).toThrow("not a JSON object");
});

Deno.test("delegation-chain-text: throws a DelegationError for another format", () => {
  const text = JSON.stringify({ format: "other", chains: [] });
  expect(() => decodeDelegationChains(text)).toThrow(
    `names a format other than ${DELEGATION_CHAIN_FORMAT}`,
  );
});

Deno.test("delegation-chain-text: throws a DelegationError for a text without a list of chains", () => {
  for (const chains of [undefined, "AQID", { 0: ["AQID"] }]) {
    const text = JSON.stringify({ format: DELEGATION_CHAIN_FORMAT, chains });
    expect(() => decodeDelegationChains(text)).toThrow(
      "the chain text lists no chains",
    );
  }
});

Deno.test("delegation-chain-text: throws a DelegationError naming a link that is not a string", () => {
  const text = JSON.stringify({
    format: DELEGATION_CHAIN_FORMAT,
    chains: [["AQID"], ["AQID", 7]],
  });
  expect(() => decodeDelegationChains(text)).toThrow(
    "chain 1 link 1 is not a string",
  );
});

Deno.test("delegation-chain-text: throws a DelegationError for an empty chain", () => {
  const text = JSON.stringify({
    format: DELEGATION_CHAIN_FORMAT,
    chains: [[]],
  });
  expect(() => decodeDelegationChains(text)).toThrow(
    "chain 0 is not a non-empty list",
  );
});

Deno.test("delegation-chain-text: throws a DelegationError for a link that is not base64url", () => {
  const text = JSON.stringify({
    format: DELEGATION_CHAIN_FORMAT,
    chains: [["AQID", "not base64url!"]],
  });
  expect(() => decodeDelegationChains(text)).toThrow(
    "chain 0 link 1 is not base64url",
  );
});
