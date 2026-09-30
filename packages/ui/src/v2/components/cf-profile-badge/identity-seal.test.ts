import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { identitySeal, normalizeDid } from "./identity-seal.ts";

const DID_A = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const DID_B = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRrm6XYMq2dnQ";

describe("identitySeal", () => {
  it("is deterministic — same DID yields byte-identical output", () => {
    expect(identitySeal(DID_A)).toEqual(identitySeal(DID_A));
  });

  it("is stable across surrounding whitespace", () => {
    expect(identitySeal(`  ${DID_A}  `)).toEqual(identitySeal(DID_A));
    expect(normalizeDid("  did:key:abc ")).toBe("did:key:abc");
  });

  it("keeps a differently-cased prefix a different principal", () => {
    // `DID:key:abc` is not a DID — the prefix is compared exactly — so it is
    // some other string, and it must not fold onto the DID it resembles.
    expect(normalizeDid("DID:key:abc")).toBe("DID:key:abc");
    expect(identitySeal("DID:key:abc")).not.toEqual(
      identitySeal("did:key:abc"),
    );
  });

  it("distinguishes different identities by primary hue", () => {
    expect(identitySeal(DID_A).hue).not.toBe(identitySeal(DID_B).hue);
  });

  it("produces a usable conic-gradient ring and HSL accent", () => {
    const seal = identitySeal(DID_A);
    expect(seal.ringGradient).toMatch(/^conic-gradient\(from \d+deg,/);
    expect(seal.ringGradient).toContain("hsl(");
    expect(seal.accent).toMatch(/^hsl\(\d+ \d+% \d+%\)$/);
    expect(seal.angle).toBeGreaterThanOrEqual(0);
    expect(seal.angle).toBeLessThan(360);
  });

  it("keeps every derived hue within [0, 360)", () => {
    for (const did of [DID_A, DID_B, "did:key:short", "ben", ""]) {
      for (const h of identitySeal(did).hues) {
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThan(360);
      }
    }
  });

  it("does not collapse to one hue for many distinct DIDs", () => {
    // Sanity: a spread of identities should not all map to the same color.
    const hues = new Set(
      Array.from(
        { length: 64 },
        (_, i) => identitySeal(`did:key:seed-${i}`).hue,
      ),
    );
    expect(hues.size).toBeGreaterThan(20);
  });
});
