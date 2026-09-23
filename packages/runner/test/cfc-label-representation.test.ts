import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { hashStringOf } from "@commonfabric/data-model";
import {
  commitCfcFieldValue,
  commitmentAwareEquals,
  isCfcFieldCommitment,
  transformCfcLabelForCrossSpacePersist,
} from "../src/cfc/label-representation.ts";

describe("CFC label representation transform (inv-12 Stage 1)", () => {
  // Inv-12 Stage 1 (SC-25; docs/specs/cfc-label-metadata-confidentiality.md §2;
  // spec §4.6.4.1): the cross-space representation transform. Every
  // commitment-classified source-bearing atom field is replaced by its
  // canonical digest wrapped in the self-describing marker `{digestOf:
  // "<hash>"}`; public-classified and unclassified fields persist verbatim. The
  // transform is deterministic, idempotent, and copy-on-write.

  const alice = "did:key:alice";
  const bob = "did:key:bob";

  describe("commitment marker discipline", () => {
    it("recognizes exactly the sole-key digestOf string shape", () => {
      expect(isCfcFieldCommitment({ digestOf: "abc" })).toBe(true);
      expect(isCfcFieldCommitment({ digestOf: "abc", extra: 1 })).toBe(false);
      expect(isCfcFieldCommitment({ digestOf: 5 })).toBe(false);
      expect(isCfcFieldCommitment({ digestof: "abc" })).toBe(false);
      expect(isCfcFieldCommitment("abc")).toBe(false);
      expect(isCfcFieldCommitment(null)).toBe(false);
      expect(isCfcFieldCommitment([{ digestOf: "abc" }])).toBe(false);
    });

    it("commits a field value to its canonical hashStringOf digest", () => {
      const source = { space: alice, id: "of:doc", path: ["secret"] };
      expect(commitCfcFieldValue(source)).toEqual({
        digestOf: hashStringOf(source),
      });
      // Key order canonicalizes: the digest is the record digest, not a
      // serialization of insertion order.
      expect(commitCfcFieldValue({ b: 2, a: 1 })).toEqual(
        commitCfcFieldValue({ a: 1, b: 2 }),
      );
    });
  });

  describe("commitment-aware equality", () => {
    it("digest-compares a plaintext value against a marker (both directions)", () => {
      const marker = commitCfcFieldValue(alice);
      expect(commitmentAwareEquals(alice, marker)).toBe(true);
      expect(commitmentAwareEquals(marker, alice)).toBe(true);
      expect(commitmentAwareEquals(bob, marker)).toBe(false);
      expect(commitmentAwareEquals(marker, bob)).toBe(false);
    });

    it("compares marker-vs-marker structurally", () => {
      const marker = commitCfcFieldValue(alice);
      expect(commitmentAwareEquals(marker, commitCfcFieldValue(alice))).toBe(
        true,
      );
      expect(commitmentAwareEquals(marker, commitCfcFieldValue(bob))).toBe(
        false,
      );
    });

    it("recurses through records and arrays", () => {
      const committedUser = {
        type: CFC_ATOM_TYPE.User,
        subject: commitCfcFieldValue(alice),
      };
      expect(
        commitmentAwareEquals(
          { type: CFC_ATOM_TYPE.User, subject: alice },
          committedUser,
        ),
      ).toBe(true);
      expect(
        commitmentAwareEquals(
          { type: CFC_ATOM_TYPE.User, subject: bob },
          committedUser,
        ),
      ).toBe(false);
      expect(
        commitmentAwareEquals(
          [{ subject: alice }],
          [{ subject: commitCfcFieldValue(alice) }],
        ),
      ).toBe(true);
      // Field-set mismatches stay unequal.
      expect(
        commitmentAwareEquals(
          { type: CFC_ATOM_TYPE.User },
          committedUser,
        ),
      ).toBe(false);
    });

    it("returns for two plaintext records what their digests say", () => {
      // A lone surrogate is digested as the replacement character, so these
      // two records have one digest. Each equals the other's commitment, and
      // so each must equal the other.
      const lone = { subject: "\uD800" };
      const replaced = { subject: "\uFFFD" };
      expect(hashStringOf(lone)).toBe(hashStringOf(replaced));
      expect(
        commitmentAwareEquals(lone, { subject: commitCfcFieldValue("\uFFFD") }),
      ).toBe(true);
      expect(commitmentAwareEquals(lone, replaced)).toBe(true);
    });

    it("treats a malformed digestOf-bearing record as an opaque value", () => {
      // Extra keys disqualify the marker shape: only structural equality
      // applies (fail-closed — never digest-matched).
      const malformed = { digestOf: hashStringOf(alice), extra: true };
      expect(commitmentAwareEquals(alice, malformed)).toBe(false);
      expect(commitmentAwareEquals(malformed, malformed)).toBe(true);
    });
  });

  describe("transformCfcLabelForCrossSpacePersist", () => {
    it("commits Caveat.source and keeps kind/type verbatim", () => {
      const source = { space: bob, id: "of:remote", path: [] };
      const caveat = {
        type: CFC_ATOM_TYPE.Caveat,
        kind: "prompt-influence",
        source,
      };
      const transformed = transformCfcLabelForCrossSpacePersist({
        confidentiality: [caveat],
      });
      expect(transformed.confidentiality).toEqual([{
        type: CFC_ATOM_TYPE.Caveat,
        kind: "prompt-influence",
        source: { digestOf: hashStringOf(source) },
      }]);
    });

    it("commits User.subject / PersonalSpace.owner, keeps Space.id public", () => {
      const transformed = transformCfcLabelForCrossSpacePersist({
        confidentiality: [
          { type: CFC_ATOM_TYPE.User, subject: alice },
          { type: CFC_ATOM_TYPE.PersonalSpace, owner: alice },
          { type: CFC_ATOM_TYPE.Space, id: bob },
        ],
      });
      expect(transformed.confidentiality).toEqual([
        { type: CFC_ATOM_TYPE.User, subject: commitCfcFieldValue(alice) },
        {
          type: CFC_ATOM_TYPE.PersonalSpace,
          owner: commitCfcFieldValue(alice),
        },
        // Space.id stays PLAINTEXT: §4.9.3 must dereference it for the ACL
        // point query (the SC-25 recorded initial-assignment exception).
        { type: CFC_ATOM_TYPE.Space, id: bob },
      ]);
    });

    it("keeps module-policy lookup fields public and commits its subject", () => {
      const moduleRef = {
        type: CFC_ATOM_TYPE.Policy,
        policyRefKind: "module",
        moduleIdentity: "sha256:module",
        symbol: "releaseRules",
        policyDigest: "sha256:manifest",
        subject: alice,
      };
      expect(
        transformCfcLabelForCrossSpacePersist({
          confidentiality: [moduleRef],
        }).confidentiality,
      ).toEqual([{
        ...moduleRef,
        subject: commitCfcFieldValue(alice),
      }]);
    });

    it("commits nested TransformedBy identity fields via family-scoped paths", () => {
      const transformed = transformCfcLabelForCrossSpacePersist({
        integrity: [{
          type: CFC_ATOM_TYPE.TransformedBy,
          identity: {
            kind: "verified",
            moduleIdentity: "cf:module/abc",
            sourceFile: "/patterns/secret-app.tsx",
            bindingPath: ["handlers", "onSave"],
            codeHash: "deadbeef",
          },
        }],
      });
      expect(transformed.integrity).toEqual([{
        type: CFC_ATOM_TYPE.TransformedBy,
        identity: {
          kind: "verified",
          // Content-addressed identity is the PUBLIC trust anchor.
          moduleIdentity: "cf:module/abc",
          sourceFile: commitCfcFieldValue("/patterns/secret-app.tsx"),
          bindingPath: commitCfcFieldValue(["handlers", "onSave"]),
          // Unclassified fields persist verbatim: the table owns the
          // protected set.
          codeHash: "deadbeef",
        },
      }]);
    });

    it("keeps authored-by / represents-principal subjects public", () => {
      const label = {
        integrity: [
          { kind: "authored-by", subject: alice },
          { kind: "represents-principal", subject: bob },
        ],
      };
      const transformed = transformCfcLabelForCrossSpacePersist(label);
      // Nothing to change: the SAME label object comes back (copy-on-write).
      expect(transformed).toBe(label);
    });

    it("commits HasRole principal+space and ExternalIngest audience in integrity", () => {
      const transformed = transformCfcLabelForCrossSpacePersist({
        integrity: [
          {
            type: CFC_ATOM_TYPE.HasRole,
            principal: alice,
            space: bob,
            role: "reader",
          },
          cfcAtom.externalIngest("email", alice, "123", "digest"),
        ],
      });
      expect(transformed.integrity?.[0]).toEqual({
        type: CFC_ATOM_TYPE.HasRole,
        principal: commitCfcFieldValue(alice),
        space: commitCfcFieldValue(bob),
        role: "reader",
      });
      const ingest = transformed.integrity?.[1] as Record<string, unknown>;
      expect(ingest.audience).toEqual(commitCfcFieldValue(alice));
      expect(ingest.channel).toBe("email");
    });

    it("transforms atoms nested inside other atoms and OR-clauses", () => {
      const source = { space: bob, id: "of:remote", path: [] };
      const transformed = transformCfcLabelForCrossSpacePersist({
        confidentiality: [
          {
            anyOf: [
              { type: CFC_ATOM_TYPE.User, subject: alice },
              { type: CFC_ATOM_TYPE.Space, id: bob },
            ],
          },
          {
            type: CFC_ATOM_TYPE.Caveat,
            kind: "derived-from",
            source,
            by: { type: CFC_ATOM_TYPE.User, subject: bob },
          },
        ],
      });
      expect(transformed.confidentiality).toEqual([
        {
          anyOf: [
            { type: CFC_ATOM_TYPE.User, subject: commitCfcFieldValue(alice) },
            { type: CFC_ATOM_TYPE.Space, id: bob },
          ],
        },
        {
          type: CFC_ATOM_TYPE.Caveat,
          kind: "derived-from",
          source: commitCfcFieldValue(source),
          // The nested User atom re-enters the table under its own family.
          by: { type: CFC_ATOM_TYPE.User, subject: commitCfcFieldValue(bob) },
        },
      ]);
    });

    it("is idempotent and deterministic", () => {
      const label = {
        confidentiality: [
          { type: CFC_ATOM_TYPE.User, subject: alice },
          "opaque-string-atom",
        ],
        integrity: [{
          type: CFC_ATOM_TYPE.HasRole,
          principal: alice,
          space: bob,
          role: "reader",
        }],
      };
      const once = transformCfcLabelForCrossSpacePersist(label);
      const twice = transformCfcLabelForCrossSpacePersist(once);
      // Second application changes nothing — same reference back.
      expect(twice).toBe(once);
      // Deterministic across invocations on equal input.
      expect(transformCfcLabelForCrossSpacePersist({
        confidentiality: [{ type: CFC_ATOM_TYPE.User, subject: alice }],
      })).toEqual({
        confidentiality: [{
          type: CFC_ATOM_TYPE.User,
          subject: commitCfcFieldValue(alice),
        }],
      });
    });

    it("passes string atoms and unclassified structures through verbatim", () => {
      const label = {
        confidentiality: [
          "source-root",
          { type: "https://example.com/custom", payload: { deep: alice } },
        ],
      };
      expect(transformCfcLabelForCrossSpacePersist(label)).toBe(label);
    });

    it("passes a marker in atom position through the walk untouched", () => {
      // A commitment marker encountered as a VALUE during the walk (not at
      // a classified field) — e.g. a committed clause element inside a
      // stored list being re-derived — returns by reference: the top-level
      // passthrough arm of the transform.
      const marker = commitCfcFieldValue("did:key:alice");
      const label = { confidentiality: [marker] };
      expect(transformCfcLabelForCrossSpacePersist(label)).toBe(label);
    });

    it("leaves an already-committed field untouched (marker passthrough)", () => {
      const label = {
        confidentiality: [{
          type: CFC_ATOM_TYPE.User,
          subject: commitCfcFieldValue(alice),
        }],
      };
      expect(transformCfcLabelForCrossSpacePersist(label)).toBe(label);
    });
  });
});
