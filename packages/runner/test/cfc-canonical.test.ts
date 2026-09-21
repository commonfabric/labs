/**
 * The prepared digest binds the SET of dereferences a transaction performed,
 * never the number of times it read each link. Both halves of that rule are
 * pinned here: a repeat collapses, and dereferences differing in any field
 * stay apart — including the pair that a payload field named `value` produces,
 * whose canonical path still opens with the element canonicalization strips.
 *
 * Policy inputs retain their structural hash tiebreak order and bind mutable
 * values independently on each call. Other digest fields are covered beside
 * their gates, including temporal writes in cfc-write-prefix-provenance.test.ts.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { hashStringOf } from "@commonfabric/data-model";

import {
  canonicalizePreparedDigestInput,
  type CfcDereferenceTrace,
  preparedDigestFor,
  type PreparedDigestInput,
} from "../src/cfc/mod.ts";

const signer = await Identity.fromPassphrase("runner-cfc-canonical");

describe("canonical", () => {
  const address = (id: string, ...path: string[]) => ({
    space: signer.did(),
    scope: "space" as const,
    id: `of:${id}`,
    path,
  });

  const trace = (
    source: CfcDereferenceTrace["source"],
    target: CfcDereferenceTrace["target"],
    kind: CfcDereferenceTrace["kind"] = "value",
  ): CfcDereferenceTrace => ({ source, target, kind });

  const baseInput = (
    overrides: Partial<PreparedDigestInput>,
  ): PreparedDigestInput => ({
    consumedReads: [],
    attemptedWrites: [],
    writes: [],
    writeAttemptLog: [],
    dereferenceTraces: [],
    triggerReads: [],
    writePolicyInputs: [],
    implementationIdentity: undefined,
    trustSnapshot: undefined,
    ...overrides,
  });

  const digestOf = (traces: CfcDereferenceTrace[]) =>
    preparedDigestFor(baseInput({ dereferenceTraces: traces }));

  it("preserves literal value field paths in initialization permissions", () => {
    const inputAt = (path: string[]) =>
      baseInput({
        writePolicyInputs: [{
          kind: "initialization",
          mode: "default",
          target: address("initialized", ...path),
          value: [],
        }],
      });
    for (const path of [["value"], ["value", "name"]]) {
      const input = inputAt(path);
      expect(canonicalizePreparedDigestInput(input).writePolicyInputs[0])
        .toEqual(input.writePolicyInputs[0]);
      expect(
        canonicalizePreparedDigestInput(canonicalizePreparedDigestInput(input))
          .writePolicyInputs,
      ).toEqual(input.writePolicyInputs);
      expect(preparedDigestFor(input)).not.toBe(
        preparedDigestFor(inputAt(path.slice(1))),
      );
    }
  });

  it("preserves hash-tiebreak order and value binding across mutable policy inputs", () => {
    const inputs = Array.from({ length: 40 }, (_, index) => ({
      kind: "custom" as const,
      name: "same-primary-key",
      value: { index, payload: `value-${index}` },
    }));
    const input = baseInput({ writePolicyInputs: inputs });
    const expected = () =>
      [...inputs].sort((left, right) => {
        const a = hashStringOf(left);
        const b = hashStringOf(right);
        return a < b ? -1 : a > b ? 1 : 0;
      });
    expect(canonicalizePreparedDigestInput(input).writePolicyInputs).toEqual(
      expected(),
    );
    const before = preparedDigestFor(input);
    inputs[0].value.payload = "changed";
    expect(canonicalizePreparedDigestInput(input).writePolicyInputs).toEqual(
      expected(),
    );
    expect(preparedDigestFor(input)).not.toBe(before);
  });

  it("orders external observations with the same source by their content", () => {
    const observation = (content: string) => ({
      source: address("external"),
      flow: { confidentiality: [content], integrity: [] },
      consumed: { confidentiality: [], integrity: [] },
      labeledSpaces: [],
      sources: [],
    });
    const first = observation("first");
    const second = observation("second");

    expect(preparedDigestFor(baseInput({
      externalContentObservations: [first, second],
    }))).toBe(preparedDigestFor(baseInput({
      externalContentObservations: [second, first],
    })));
    expect(
      canonicalizePreparedDigestInput(baseInput({
        externalContentObservations: [first, second],
      })).externalContentObservations,
    ).toHaveLength(2);
    expect(preparedDigestFor(baseInput({
      externalContentObservations: [first, second],
    }))).not.toBe(preparedDigestFor(baseInput({
      externalContentObservations: [first],
    })));
  });

  describe("dereference traces in the prepared digest", () => {
    const hop = trace(address("board"), address("row"));

    it("digests a repeated dereference the same as a single one", () => {
      // The digest binds WHICH dereferences ran, not how many times a link
      // was read: a quadratic scan over a list resolves each element's link
      // once per pass, and those passes observe nothing the first did not.
      expect(digestOf([hop, hop, hop])).toBe(digestOf([hop]));
    });

    it("digests a structurally equal repeat the same as a single one", () => {
      // Equality is by content, not object identity — the traces a walk
      // records are freshly built per hop.
      const equal = trace(address("board"), address("row"));
      expect(digestOf([hop, equal])).toBe(digestOf([hop]));
    });

    it("collapses a repeat that differs only by a leading `value` element", () => {
      // Dedupe runs after canonicalization, which strips the leading `value`
      // element. Before it, these two are unequal records.
      const raw = trace(
        address("board", "value", "items"),
        address("row", "value", "cells"),
      );
      const canonical = trace(
        address("board", "items"),
        address("row", "cells"),
      );
      expect(digestOf([raw, canonical])).toBe(digestOf([canonical]));
    });

    it("distinguishes a payload field named `value` from the field it sits over", () => {
      // Envelope `["value","value","x"]` is the payload path `value.x`; a
      // payload field may legitimately be named `value`. It canonicalizes to
      // `["value","x"]`, which a comparator that strips again would flatten
      // onto payload `x` — two distinct dereferences merging into one, and
      // the digest binding only the survivor.
      const overValue = trace(
        address("board", "value", "value", "x"),
        address("row"),
      );
      const overRoot = trace(address("board", "value", "x"), address("row"));
      expect(digestOf([overValue, overRoot])).not.toBe(digestOf([overRoot]));
      expect(
        canonicalizePreparedDigestInput(
          baseInput({ dereferenceTraces: [overValue, overRoot] }),
        ).dereferenceTraces,
      ).toHaveLength(2);
    });

    it("distinguishes a payload field named `value` on the target side", () => {
      const overValue = trace(
        address("board"),
        address("row", "value", "value", "x"),
      );
      const overRoot = trace(address("board"), address("row", "value", "x"));
      // Asserted on the canonical length, not on the digest: a merge leaves
      // whichever trace sorted first, whose content differs from `overRoot`
      // anyway, so comparing digests would pass without the two surviving.
      expect(
        canonicalizePreparedDigestInput(
          baseInput({ dereferenceTraces: [overValue, overRoot] }),
        ).dereferenceTraces,
      ).toHaveLength(2);
    });

    it("collapses a repeat under a payload field named `value`", () => {
      // The other side of the same distinction: re-reading `value.x` is one
      // dereference, exactly as re-reading any other path is.
      const overValue = trace(
        address("board", "value", "value", "x"),
        address("row"),
      );
      expect(digestOf([overValue, overValue])).toBe(digestOf([overValue]));
    });

    it("distinguishes two different dereferences from one repeated twice", () => {
      // The guard against a dedupe that collapses too much: two distinct
      // hops must not digest as one hop read twice.
      const other = trace(address("board"), address("other-row"));
      expect(digestOf([hop, other])).not.toBe(digestOf([hop, hop]));
    });

    it("distinguishes traces that differ only in their source", () => {
      const elsewhere = trace(address("other-board"), address("row"));
      expect(digestOf([hop, elsewhere])).not.toBe(digestOf([hop]));
    });

    it("distinguishes traces that differ only in their kind", () => {
      const redirect = trace(
        address("board"),
        address("row"),
        "write-redirect",
      );
      expect(digestOf([hop, redirect])).not.toBe(digestOf([hop]));
    });

    it("distinguishes traces that differ only in their target path", () => {
      const deeper = trace(address("board"), address("row", "cells"));
      expect(digestOf([hop, deeper])).not.toBe(digestOf([hop]));
    });

    it("digests the same set regardless of the order it is presented in", () => {
      const other = trace(address("board"), address("other-row"));
      expect(digestOf([hop, other])).toBe(digestOf([other, hop]));
    });

    it("canonicalizes interleaved repeats to one entry per distinct trace", () => {
      const other = trace(address("board"), address("other-row"));
      const canonical = canonicalizePreparedDigestInput(
        baseInput({ dereferenceTraces: [hop, other, hop, other, hop] }),
      );
      expect(canonical.dereferenceTraces).toHaveLength(2);
    });
  });
});
