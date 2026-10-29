/**
 * One mention in a document: where it points, and whether the label carrying
 * it in the text is the user's own wording.
 */
export interface MentionRef {
  /**
   * The mention's destination. Typed `unknown` because a mention may address
   * any piece; read it through `asSchema` before naming fields on it, since a
   * read under an unknown schema stops at the reference and carries none of
   * the piece's fields.
   */
  destination: unknown;

  /**
   * Whether the label in the document and the destination's name have
   * deliberately diverged. While it is set, a change to the destination's
   * title leaves the label alone.
   */
  modifiedTitle: boolean;
}

/**
 * A document's mentions, keyed by the token that appears in its text. The
 * keys are local to one document: they carry no meaning anywhere else, which
 * is what lets them be short.
 */
export type MentionRefMap = Record<string, MentionRef>;

export {
  MentionRefMapSchema,
  MentionRefSchema,
} from "@commonfabric/runner/component-read-contract";

/** Length of a freshly minted key. */
const KEY_LENGTH = 6;

/** Longest key {@link mintRefKey} widens to before it gives up. */
const MAX_KEY_LENGTH = 10;

const KEY_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Samples drawn at one length before widening. */
const SAMPLES_PER_LENGTH = 4;

/**
 * The shape of a reference key, as a regular-expression fragment, so that the
 * parser and the mint cannot drift apart on the alphabet or the length.
 */
export const MENTION_REF_KEY_SOURCE =
  `[0-9a-z]{${KEY_LENGTH},${MAX_KEY_LENGTH}}`;

/**
 * One entry per destination, keeping the first of each.
 *
 * What counts as the same destination is the caller's to say — here it is a
 * cell's own id, which is what makes a piece reached through two different
 * keys, or through both mention forms at once, a single mention of one piece.
 * An entry `identityOf` cannot name is kept as it came: it has nothing to
 * compare, and dropping it would lose a mention rather than deduplicate one.
 */
export function dedupeByDestination<T>(
  pieces: T[],
  identityOf: (piece: T) => string | undefined,
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const piece of pieces) {
    const id = identityOf(piece);
    if (id !== undefined) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    result.push(piece);
  }
  return result;
}

/**
 * A label the parser will read back.
 *
 * The token's label may hold anything but `]` and a newline, and a piece is
 * free to be named with either. Left verbatim, such a name mints a token no
 * parse recognizes: unprotected text, no pill, and absent from `$mentioned`
 * while its map entry sits there naming a destination nothing reaches.
 */
export function labelForToken(name: string): string {
  return name.replace(/\r?\n/g, " ").replace(/\]/g, ")");
}

/**
 * Mint a reference key that nothing in `taken` holds.
 *
 * Six characters over a 36-symbol alphabet is 2.2 billion keys against a map
 * holding one entry per mention in one document, so widening is about
 * termination rather than expected cost: the work is bounded at
 * {@link SAMPLES_PER_LENGTH} samples per length instead of resampling one
 * length forever.
 *
 * The modulo below biases four symbols of the alphabet slightly. A key is an
 * opaque local token rather than a secret, so uniformity buys nothing that
 * would pay for the rejection loop.
 */
export function mintRefKey(taken: ReadonlySet<string>): string {
  const bytes = new Uint8Array(MAX_KEY_LENGTH);

  for (let length = KEY_LENGTH; length <= MAX_KEY_LENGTH; length++) {
    for (let sample = 0; sample < SAMPLES_PER_LENGTH; sample++) {
      crypto.getRandomValues(bytes.subarray(0, length));
      let key = "";
      for (let i = 0; i < length; i++) {
        key += KEY_ALPHABET[bytes[i] % KEY_ALPHABET.length];
      }
      if (!taken.has(key)) return key;
    }
  }

  throw new Error(
    `no free mention reference key at ${MAX_KEY_LENGTH} characters ` +
      `(${taken.size} taken)`,
  );
}
