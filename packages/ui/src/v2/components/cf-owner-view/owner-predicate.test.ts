import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { authenticatedOwnerFromLabel } from "./owner-predicate.ts";

describe("authenticatedOwnerFromLabel", () => {
  it("matches the acting principal to one persisted originator attestation", () => {
    const view = {
      version: 1 as const,
      entries: [{
        path: [],
        label: {
          integrity: [{
            kind: "represents-principal",
            subject: "did:key:alice",
          }],
        },
      }],
    };
    expect(authenticatedOwnerFromLabel(view, "did:key:alice")).toBe(true);
    expect(authenticatedOwnerFromLabel(view, "did:key:bob")).toBe(false);
  });

  it("fails closed for absent and conflicting attestations", () => {
    expect(authenticatedOwnerFromLabel(undefined, "did:key:alice")).toBe(false);
    expect(
      authenticatedOwnerFromLabel({
        version: 1,
        entries: [{
          path: [],
          label: {
            integrity: [
              { kind: "represents-principal", subject: "did:key:alice" },
              { kind: "represents-principal", subject: "did:key:bob" },
            ],
          },
        }],
      }, "did:key:alice"),
    ).toBe(false);
  });

  it("does not treat a child field as the originator", () => {
    const child = {
      path: ["profile"],
      label: {
        integrity: [{ kind: "represents-principal", subject: "did:key:alice" }],
      },
    };
    expect(
      authenticatedOwnerFromLabel(
        { version: 1, entries: [child] },
        "did:key:alice",
      ),
    ).toBe(false);
    expect(authenticatedOwnerFromLabel({
      version: 1,
      entries: [{
        path: [],
        label: {
          integrity: [{ kind: "represents-principal", subject: "did:key:bob" }],
        },
      }, child],
    }, "did:key:alice")).toBe(false);
  });
});
