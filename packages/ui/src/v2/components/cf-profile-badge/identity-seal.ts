/**
 * identity-seal — a deterministic, generative identity treatment derived purely
 * from a principal DID.
 *
 * The point: the same identity yields the *same* aura everywhere it appears, so
 * the treatment reads as a recognizable fingerprint of that person — you learn
 * your friend's colors. Combined with `cf-profile-badge` only drawing it when
 * the profile cell carries a runtime-attested `represents-principal` CFC label
 * (read over trusted IPC on the main thread), the aura becomes hard to forge:
 * a user-space pattern can mimic the CSS, but not the attestation that unlocks
 * it, and the colors it would have to reproduce are pinned to a DID it does not
 * control.
 *
 * Pure + framework-free so it is trivially unit-testable and identical wherever
 * it runs.
 */

export type IdentitySeal = {
  /** The DID this seal was derived from (normalized). */
  did: string;

  /** Primary hue (0–360), the main per-identity differentiator. */
  hue: number;

  /** The ring's ordered hues (degrees), used to build the conic aura. */
  hues: readonly number[];

  /** Conic-gradient rotation offset, in degrees. */
  angle: number;

  /** Ready-to-use CSS `conic-gradient(...)` for the aura ring. */
  ringGradient: string;

  /** Accent color (HSL string) for the seal mark when verified. */
  accent: string;
};

/**
 * Deterministic 32-bit FNV-1a hash of a string.
 *
 * Deliberately a tiny non-cryptographic hash, NOT `@commonfabric/content-hash`:
 * this seeds a *visual* fingerprint and must be synchronous and dependency-free
 * (content-hash is async SHA-256 for content addressing — the wrong tool here).
 */
const fnv1a = (input: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

/**
 * splitmix32 — derives a stream of well-distributed values in [0, 1) from a
 * 32-bit seed. Deterministic and dependency-free (no Math.random).
 */
const splitmix32 = (seed: number): () => number => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    t = t ^ (t >>> 15);
    return (t >>> 0) / 4294967296;
  };
};

/**
 * Normalizes a DID for hashing so that surrounding whitespace doesn't change
 * the aura. Nothing else is folded: a DID is the exact prefix `did:` followed
 * by a case-sensitive method and identifier, so two strings that differ in any
 * other character are two different principals and get two different seals.
 */
export const normalizeDid = (did: string): string => did.trim();

const RING_STOPS = 6;
const SATURATION = 80;
const LIGHTNESS = 58;

/**
 * Derives the deterministic identity seal for a principal DID. Same input →
 * byte-identical output, on any thread, in any session.
 */
export const identitySeal = (did: string): IdentitySeal => {
  const normalized = normalizeDid(did);
  const next = splitmix32(fnv1a(normalized) || 1);

  const hue = Math.floor(next() * 360);
  // Spread the remaining ring hues around the wheel. A per-identity "span"
  // controls whether the aura is tight (analogous) or wide (near-complementary),
  // giving identities distinct character beyond just the base hue.
  const span = 40 + Math.floor(next() * 140); // 40–180°
  const direction = next() < 0.5 ? -1 : 1;
  const hues: number[] = [];
  for (let i = 0; i < RING_STOPS; i++) {
    const t = i / (RING_STOPS - 1); // 0..1
    const jitter = (next() - 0.5) * 18;
    hues.push(((hue + direction * span * t + jitter) % 360 + 360) % 360);
  }

  const angle = Math.floor(next() * 360);

  const stops = hues
    .map((h, i) => {
      const pos = Math.round((i / RING_STOPS) * 360);
      return `hsl(${Math.round(h)} ${SATURATION}% ${LIGHTNESS}%) ${pos}deg`;
    })
    .join(", ");
  // Close the loop back to the first hue for a seamless ring.
  const ringGradient = `conic-gradient(from ${angle}deg, ${stops}, hsl(${
    Math.round(hues[0])
  } ${SATURATION}% ${LIGHTNESS}%) 360deg)`;

  const accent = `hsl(${hue} ${SATURATION}% 44%)`;

  return { did: normalized, hue, hues, angle, ringGradient, accent };
};
