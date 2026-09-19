/**
 * Minting and swapping machinery for the session-local handle table declared
 * in `./contracts/handle-table.ts`: derives tokens for cell addresses,
 * replaces address occurrences in model-bound values with those tokens, and
 * replaces tokens in model-produced values with the canonical address
 * strings. Pure functions over the table value — nothing here reads or
 * writes state, and swapping never throws on text it cannot parse.
 */

import type { JSONSchema } from "@commonfabric/api";
import { sha256 } from "@commonfabric/content-hash";
import {
  ENTITY_URI_SCHEMES,
  hasEntityUriScheme,
} from "@commonfabric/runner/entity-kind";
import {
  addressKey,
  type NormalizedFullLink,
  parseLLMFriendlyLink,
  renderCellReference,
} from "@commonfabric/runner/shared";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import {
  ADDRESS_HANDLE_TOKEN_PREFIX,
  HANDLE_TOKEN_ALPHABET,
  HANDLE_TOKEN_PATTERN,
  HARNESS_HANDLE_TABLE_TYPE,
  type HarnessHandleCapability,
  type HarnessHandleEntry,
  type HarnessHandleReferent,
  type HarnessHandleTable,
  MIN_HANDLE_TOKEN_SUFFIX_LENGTH,
  REFERENT_HANDLE_TOKEN_PREFIX,
  REFERENT_TOKEN_PATTERN,
} from "./contracts/handle-table.ts";
import type { HarnessSkillAcquisition } from "./contracts/skill.ts";

/** Acquisition fields every recorded provenance must carry as a non-empty string. */
const ACQUISITION_STRING_FIELDS = [
  "registryId",
  "commitSha",
  "sourceUrl",
  "valueDigest",
  "receivedAt",
] as const satisfies readonly (keyof HarnessSkillAcquisition)[];

/**
 * Digest function used to derive token suffixes. A seam for tests that need
 * to force a suffix collision; production callers leave it defaulted to
 * SHA-256.
 */
export type HandleTokenHasher = (
  input: Uint8Array<ArrayBuffer>,
) => Promise<Uint8Array<ArrayBuffer>>;

// The canonical SHA-256 from `@commonfabric/content-hash`, wrapped to fit the
// async hasher seam.
const sha256Hasher: HandleTokenHasher = (input) =>
  Promise.resolve(sha256(input) as Uint8Array<ArrayBuffer>);

/**
 * Normalizes `refText` — an LLM-friendly link string, or a bare `of:`- or
 * `computed:`-schemed entity URI — to a normalized link. A ref with no
 * embedded space DID yields a link without `space`; the two operations
 * applied to the result tolerate that (`addressKey()` serializes the absence
 * deterministically, and the reference renderer preserves the absence), which is
 * what the cast relies on.
 *
 * This is the rule minting holds a ref to, exported so a surface taking a
 * ref from an operator can refuse it under the same rule before a run
 * exists to spend on it.
 *
 * @throws Error when the text does not parse, or names an id outside the
 * entity URI schemes (a bare hash, an `opaque:` handle, a human name).
 */
export const parseHandleRef = (refText: string): NormalizedFullLink => {
  const trimmed = refText.trimStart();
  const parsed = parseLLMFriendlyLink(
    trimmed.startsWith("/") ? trimmed : `/${trimmed}`,
  );
  if (parsed.id === undefined || !hasEntityUriScheme(parsed.id)) {
    throw new Error(
      `Handle refs must name an entity URI (\`of:\`/\`computed:\`): \`${refText}\``,
    );
  }
  return {
    id: parsed.path.length === 0 ? parsed.id.trimEnd() : parsed.id,
    path: parsed.path,
    scope: parsed.scope ?? "space",
    ...(parsed.space !== undefined ? { space: parsed.space } : {}),
  } as NormalizedFullLink;
};

/**
 * Helper for minting, which serializes a complete link without context.
 * Unresolved references retain the implicit base scope of their intake form.
 */
const canonicalRef = (link: NormalizedFullLink): string =>
  renderCellReference(link, link.space === undefined ? { scope: "space" } : {});

/**
 * Helper for minting, which derives one fixed-width token suffix: SHA-256 of
 * `<salt>\0<addressKey>` (or `<salt>\0<addressKey>\0<attempt>` for attempts
 * past the first) mapped byte-by-byte into the alphabet. Every suffix is
 * exactly {@link MIN_HANDLE_TOKEN_SUFFIX_LENGTH} characters, so no token can
 * be a prefix of another.
 */
const deriveTokenSuffix = async (
  salt: string,
  key: string,
  attempt: number,
  hasher: HandleTokenHasher,
): Promise<string> => {
  const preimage = attempt === 0
    ? `${salt}\0${key}`
    : `${salt}\0${key}\0${attempt}`;
  const digest = await hasher(new TextEncoder().encode(preimage));
  let suffix = "";
  for (const byte of digest.subarray(0, MIN_HANDLE_TOKEN_SUFFIX_LENGTH)) {
    suffix += HANDLE_TOKEN_ALPHABET[byte % HANDLE_TOKEN_ALPHABET.length];
  }
  return suffix;
};

/**
 * Copies `key` onto `target` as an own data property. Assignment would
 * install an own `__proto__` key as the object's prototype; a define keeps it
 * data, so the deep walkers here and in the prompt loop cannot be steered
 * into prototype pollution by hostile tool output.
 */
export const defineOwnEntry = (
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void => {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
};

/** Constructs an empty handle table salted with `salt` (the run id). */
export const createHarnessHandleTable = (
  salt: string,
): HarnessHandleTable => ({
  type: HARNESS_HANDLE_TABLE_TYPE,
  version: 1,
  salt,
  entries: [],
});

/** Options of {@link mintAddressHandle}. */
export interface MintAddressHandleOptions {
  /** Digest seam; defaults to SHA-256. */
  hasher?: HandleTokenHasher;

  /** Restricts materialization to one capability-typed consumer. */
  capability?: HarnessHandleCapability;

  /**
   * Shape of the value at the address, when the caller already knows it out of
   * its OWN work — the result schema of a pattern this harness compiled and
   * ran, say. A mint never reads the referent to discover one, and never takes
   * one off the reference it is given: a schema that arrived with data is
   * data, and the entry it would land on is one a model can ask about. What
   * this records is marked `schemaSource: "harness"`, and that is the only
   * provenance `describe_handle` discloses.
   */
  schema?: JSONSchema;

  /**
   * Where the caller fetched the value at the address from, when the caller is
   * the host step that fetched it. Recorded verbatim onto the entry, and
   * filled the same way a schema is: an entry that already carries one keeps
   * it, because the token holders already delegating through it were told
   * about the first.
   */
  acquisition?: HarnessSkillAcquisition;
}

/**
 * Mints an address handle for `refText`, returning the updated table and the
 * token. Minting is idempotent per address: two spellings of one address —
 * an LLM-friendly link and the bare entity URI, say — normalize to the same
 * `addressKey` and share one token. The token suffix is derived
 * deterministically from the table's salt and the address, always exactly
 * {@link MIN_HANDLE_TOKEN_SUFFIX_LENGTH} characters; while the suffix
 * collides with a token already held by a different address, a fresh suffix
 * is re-derived with an attempt counter mixed into the hash preimage.
 *
 * A schema fills a gap but never replaces one: minting an address whose entry
 * carries no schema records the one supplied here, while an entry that
 * already carries a schema keeps it. Two schemas for one address describe two
 * views of the same cell, and the first is the one every token holder has
 * already been told about.
 *
 * @throws Error when `refText` does not name an entity address; see
 * `swapLinksForTokens()` for the swallow-and-skip caller.
 */
export const mintAddressHandle = async (
  table: HarnessHandleTable,
  refText: string,
  options: MintAddressHandleOptions = {},
): Promise<{ table: HarnessHandleTable; token: string }> => {
  const hasher = options.hasher ?? sha256Hasher;
  const link = parseHandleRef(refText);
  const key = addressKey(link);
  const schema = options.schema;
  const capability = options.capability;
  const acquisition = options.acquisition;
  const existing = table.entries.find((entry) => entry.addressKey === key);
  if (existing !== undefined) {
    const nextCapability = existing.capability ?? capability;
    if (
      (existing.schema !== undefined || schema === undefined) &&
      (existing.acquisition !== undefined || acquisition === undefined) &&
      existing.capability === nextCapability
    ) {
      return { table, token: existing.token };
    }
    return {
      table: {
        ...table,
        entries: table.entries.map((entry) =>
          entry === existing
            ? {
              ...entry,
              ...(entry.schema === undefined && schema !== undefined
                ? { schema, schemaSource: "harness" as const }
                : {}),
              ...(entry.acquisition === undefined && acquisition !== undefined
                ? { acquisition }
                : {}),
              ...(nextCapability !== undefined
                ? { capability: nextCapability }
                : {}),
            }
            : entry
        ),
      },
      token: existing.token,
    };
  }
  let attempt = 0;
  let suffix = await deriveTokenSuffix(table.salt, key, attempt, hasher);
  // Any table entry holding the candidate token has a different addressKey —
  // the same key returned above — so each hit means a genuine collision.
  while (
    table.entries.some(
      (entry) => entry.token === ADDRESS_HANDLE_TOKEN_PREFIX + suffix,
    )
  ) {
    attempt += 1;
    suffix = await deriveTokenSuffix(table.salt, key, attempt, hasher);
  }
  const entry: HarnessHandleEntry = {
    token: ADDRESS_HANDLE_TOKEN_PREFIX + suffix,
    kind: "address",
    ref: canonicalRef(link),
    addressKey: key,
    ...(capability !== undefined ? { capability } : {}),
    ...(schema !== undefined
      ? { schema, schemaSource: "harness" as const }
      : {}),
    ...(acquisition !== undefined ? { acquisition } : {}),
  };
  return {
    table: { ...table, entries: [...table.entries, entry] },
    token: entry.token,
  };
};

/**
 * Mints a referent handle for content a tool observed, returning the updated
 * table and the token. Minting is idempotent per referent: the same source,
 * content, label, and label source share one token, so a row a run retrieves
 * twice is held once. The suffix is derived the way an address handle's is.
 */
export const mintReferentHandle = async (
  table: HarnessHandleTable,
  referent: Omit<HarnessHandleReferent, "token" | "kind">,
  options: { hasher?: HandleTokenHasher } = {},
): Promise<{ table: HarnessHandleTable; token: string }> => {
  const hasher = options.hasher ?? sha256Hasher;
  const referents = table.referents ?? [];
  const key = JSON.stringify([
    "referent",
    referent.source,
    referent.value,
    referent.label,
    referent.labelSource,
  ]);
  const existing = referents.find((held) =>
    JSON.stringify([
      "referent",
      held.source,
      held.value,
      held.label,
      held.labelSource,
    ]) === key
  );
  if (existing !== undefined) return { table, token: existing.token };
  let attempt = 0;
  let suffix = await deriveTokenSuffix(table.salt, key, attempt, hasher);
  while (
    referents.some((held) =>
      held.token === REFERENT_HANDLE_TOKEN_PREFIX + suffix
    )
  ) {
    attempt += 1;
    suffix = await deriveTokenSuffix(table.salt, key, attempt, hasher);
  }
  const token = REFERENT_HANDLE_TOKEN_PREFIX + suffix;
  return {
    table: {
      ...table,
      referents: [...referents, { token, kind: "document", ...referent }],
    },
    token,
  };
};

/** Returns the referent holding `token`, or `undefined` when none does. */
export const resolveReferentToken = (
  table: HarnessHandleTable,
  token: string,
): HarnessHandleReferent | undefined =>
  table.referents?.find((held) => held.token === token);

/** Returns the entry holding `token`, or `undefined` when none does. */
export const resolveHandleToken = (
  table: HarnessHandleTable,
  token: string,
): HarnessHandleEntry | undefined =>
  table.entries.find((entry) => entry.token === token);

/**
 * The `addressKey` of the address `refText` names, or `undefined` when the
 * text does not name an entity address at all. Normalization is the one
 * minting uses, so any spelling of one address — the bare entity URI, the
 * LLM-friendly link — yields one key.
 */
export const handleRefAddressKey = (refText: string): string | undefined => {
  try {
    return addressKey(parseHandleRef(refText));
  } catch {
    return undefined;
  }
};

/**
 * Returns the entry whose address `refText` names, or `undefined` when the
 * table holds no entry for that address. Entry identity is `addressKey`, the
 * same identity minting is idempotent over, so this is the inverse of
 * {@link resolveHandleToken}: it answers whether the run holds a handle to
 * the address a caller wrote out in full.
 */
export const resolveHandleRef = (
  table: HarnessHandleTable,
  refText: string,
): HarnessHandleEntry | undefined => {
  const key = handleRefAddressKey(refText);
  return key === undefined
    ? undefined
    : table.entries.find((entry) => entry.addressKey === key);
};

// The free-text address grammar, assembled from the entity URI schemes so a
// new scheme cannot leave a stale alternation here. The scheme prefix is the
// sole positive marker; after it, any `<tag>:<base64url-ish>` tagged hash is
// accepted (`fid1` today, whatever `FabricHash` tags come later), and the
// runner's parser decides whether the occurrence is a real address. A bare
// tagged hash (`fid1:<hash>` with no scheme) is deliberately unmatchable:
// schema hashes, blob ids, and slugs share that encoding, so only the schemed
// forms are positively an address.
const HASH_CHAR = "[A-Za-z0-9_-]";
const ENTITY_ID_SOURCE = `(?:${
  ENTITY_URI_SCHEMES.join("|")
}):[A-Za-z0-9]+:${HASH_CHAR}+`;
// A path segment ends at whitespace, quotes, backticks, or closing
// punctuation, so an address at the end of a sentence does not swallow it.
const PATH_SEGMENT_SOURCE = `[^/\\s"'\`\\)\\]\\}>,;]+`;
// The scanner captures the whole occurrence; the shared reader decides whether
// its member and qualifiers are valid. Complete prefixes are consumed with the
// piece, so a refused occurrence cannot be rescanned as a shorter reference.
const LINK_OCCURRENCE_SOURCE = `(?:(?://|/@)[^/\\s]+/|/)?` +
  `(?<![A-Za-z0-9_:.@-])` +
  ENTITY_ID_SOURCE +
  `(?:[#@](?:${PATH_SEGMENT_SOURCE})?)?` +
  `(?:/(?:${PATH_SEGMENT_SOURCE})?)*`;

/**
 * Replaces every positively-marked address occurrence in `value` with a
 * minted token, deep-walking arrays, objects, and strings without mutating
 * the input. Three forms are swapped: address substrings in string leaves
 * (LLM-friendly links and standalone schemed entity URIs), the same substrings
 * in object KEYS, and whole single-key `{"@link": "<address>"}` objects, which
 * become the token string. An occurrence the runner cannot parse is left
 * untouched, as is an
 * `@link` whose string is not an entity address (an `opaque:` handle among
 * them) — swapping never throws on weird text.
 */
export const swapLinksForTokens = async (
  table: HarnessHandleTable,
  value: unknown,
  hasher: HandleTokenHasher = sha256Hasher,
): Promise<{ table: HarnessHandleTable; value: unknown }> => {
  if (typeof value === "string") {
    return await swapLinksInString(table, value, hasher);
  }
  if (Array.isArray(value)) {
    const swapped: unknown[] = [];
    for (const item of value) {
      const result = await swapLinksForTokens(table, item, hasher);
      table = result.table;
      swapped.push(result.value);
    }
    return { table, value: swapped };
  }
  if (isObjectOrArray(value)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const target = record["@link"];
    if (keys.length === 1 && typeof target === "string") {
      try {
        const minted = await mintAddressHandle(table, target, { hasher });
        return { table: minted.table, value: minted.token };
      } catch {
        // Not an entity address — an `opaque:` handle, or malformed text.
        return { table, value };
      }
    }
    const swapped: Record<string, unknown> = {};
    for (const key of keys) {
      // A property name is text like any other, and a schema's property names
      // are whoever authored the schema's own text, so an address can occur in
      // one. It gets the same swap a string leaf gets, through the same
      // helper: an address the model is shown is a token wherever it sits. Two
      // keys whose addresses mint one token collapse into one key, which is
      // the same answer the model would get asking about either.
      const swappedKey = await swapLinksInString(table, key, hasher);
      table = swappedKey.table;
      const result = await swapLinksForTokens(table, record[key], hasher);
      table = result.table;
      defineOwnEntry(swapped, swappedKey.value, result.value);
    }
    return { table, value: swapped };
  }
  return { table, value };
};

/**
 * Helper for `swapLinksForTokens()`, which swaps address occurrences within
 * one string leaf. An occurrence whose text matches the grammar but fails
 * the runner's parse is copied through unchanged.
 */
const swapLinksInString = async (
  table: HarnessHandleTable,
  text: string,
  hasher: HandleTokenHasher,
): Promise<{ table: HarnessHandleTable; value: string }> => {
  const pattern = new RegExp(LINK_OCCURRENCE_SOURCE, "g");
  let swapped = "";
  let copiedUpTo = 0;
  for (const match of text.matchAll(pattern)) {
    const occurrence = match[0];
    let token: string;
    try {
      const minted = await mintAddressHandle(
        table,
        occurrence.startsWith("/") ? occurrence : `/${occurrence}`,
        { hasher },
      );
      table = minted.table;
      token = minted.token;
    } catch {
      continue;
    }
    swapped += text.slice(copiedUpTo, match.index) + token;
    copiedUpTo = match.index + occurrence.length;
  }
  return { table, value: swapped + text.slice(copiedUpTo) };
};

/**
 * Helper for `swapTokensForRefs()`, which replaces every known handle token
 * within one string with its entry's canonical `ref`.
 */
const swapTokensInString = (
  table: HarnessHandleTable,
  text: string,
): string =>
  text.replace(
    new RegExp(HANDLE_TOKEN_PATTERN.source, "g"),
    (token) => {
      const entry = resolveHandleToken(table, token);
      return entry?.capability === undefined ? entry?.ref ?? token : token;
    },
  );

/**
 * Replaces every known handle token in `value` with its entry's canonical
 * `ref` string, deep-walking arrays, objects, and strings without mutating
 * the input. Tokens are replaced in string leaves, in object VALUES, and in
 * object KEYS — the inverse of the three places `swapLinksForTokens()` puts
 * them, so a key the model was shown as a token reaches the tool as the
 * address it stands for. A well-formed token the table does not hold is left
 * untouched.
 *
 * Restoring a key can collide, in the same way and with the same answer as the
 * outbound direction: a restored key equal to another key of the same object —
 * a literal address the model also wrote, or another key restoring to the same
 * ref — leaves one entry, the last one walked. Both spellings name one address,
 * so both would have reached the tool as one key regardless.
 */
export const swapTokensForRefs = (
  table: HarnessHandleTable,
  value: unknown,
): unknown => {
  if (typeof value === "string") {
    return swapTokensInString(table, value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => swapTokensForRefs(table, item));
  }
  if (isObjectOrArray(value)) {
    const swapped: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      defineOwnEntry(
        swapped,
        swapTokensInString(table, key),
        swapTokensForRefs(table, item),
      );
    }
    return swapped;
  }
  return value;
};

/** Token grammar accepted by {@link assertValidHarnessHandleTable}. */
const FULL_TOKEN_PATTERN = new RegExp(`^${HANDLE_TOKEN_PATTERN.source}$`);

/** Referent token grammar accepted by the same check. */
const FULL_REFERENT_TOKEN_PATTERN = new RegExp(
  `^${REFERENT_TOKEN_PATTERN.source}$`,
);

/** Helper for the table check, which validates the referents it holds. */
const assertValidReferents = (referents: unknown): void => {
  if (referents === undefined) return;
  if (!Array.isArray(referents)) {
    throw new Error("invalid handle table: referents must be an array");
  }
  const tokens = new Set<string>();
  for (const referent of referents) {
    if (!isObjectNotArray(referent)) {
      throw new Error("invalid handle table: referent is not an object");
    }
    const { token, kind, source, label, labelSource } = referent;
    if (
      typeof token !== "string" || !FULL_REFERENT_TOKEN_PATTERN.test(token)
    ) {
      throw new Error(
        `invalid handle table: malformed referent token \`${String(token)}\``,
      );
    }
    if (kind !== "document") {
      throw new Error(
        `invalid handle table: referent kind must be \`document\`, got \`${
          String(kind)
        }\``,
      );
    }
    if (typeof source !== "string" || source.length === 0) {
      throw new Error(
        `invalid handle table: referent \`${token}\` has an empty source`,
      );
    }
    if (!isObjectNotArray(label)) {
      throw new Error(
        `invalid handle table: referent \`${token}\` has a label that is not an object`,
      );
    }
    if (labelSource !== "row" && labelSource !== "query") {
      throw new Error(
        `invalid handle table: referent \`${token}\` has an unknown labelSource \`${
          String(labelSource)
        }\``,
      );
    }
    if (tokens.has(token)) {
      throw new Error(`invalid handle table: duplicate token \`${token}\``);
    }
    tokens.add(token);
  }
};

/**
 * Asserts that `table` is a well-formed version-1 handle table, guarding the
 * seams that adopt one from persisted state: a version this code does not
 * understand, an empty salt, a malformed entry, or a duplicate token or
 * address is refused with an error naming the problem rather than carried
 * silently into a run.
 *
 * @throws Error naming the first problem found.
 */
export const assertValidHarnessHandleTable = (
  table: HarnessHandleTable,
): void => {
  const raw = table as unknown as Record<string, unknown>;
  if (raw.type !== HARNESS_HANDLE_TABLE_TYPE) {
    throw new Error(
      `invalid handle table: type must be \`${HARNESS_HANDLE_TABLE_TYPE}\`, got \`${
        String(raw.type)
      }\``,
    );
  }
  if (raw.version !== 1) {
    throw new Error(
      `unsupported handle table version: ${String(raw.version)}`,
    );
  }
  if (typeof raw.salt !== "string" || raw.salt.length === 0) {
    throw new Error("invalid handle table: salt must be a non-empty string");
  }
  if (!Array.isArray(raw.entries)) {
    throw new Error("invalid handle table: entries must be an array");
  }
  assertValidReferents(raw.referents);
  const tokens = new Set<string>();
  const addressKeys = new Set<string>();
  for (const entry of table.entries) {
    if (!isObjectOrArray(entry)) {
      throw new Error("invalid handle table: entry is not an object");
    }
    if (
      typeof entry.token !== "string" || !FULL_TOKEN_PATTERN.test(entry.token)
    ) {
      throw new Error(
        `invalid handle table: malformed token \`${String(entry.token)}\``,
      );
    }
    if (entry.kind !== "address") {
      throw new Error(
        `invalid handle table: entry kind must be \`address\`, got \`${
          String(entry.kind)
        }\``,
      );
    }
    if (typeof entry.ref !== "string" || entry.ref.length === 0) {
      throw new Error(
        `invalid handle table: entry \`${entry.token}\` has an empty ref`,
      );
    }
    if (typeof entry.addressKey !== "string" || entry.addressKey.length === 0) {
      throw new Error(
        `invalid handle table: entry \`${entry.token}\` has an empty addressKey`,
      );
    }
    if (
      entry.schema !== undefined && typeof entry.schema !== "boolean" &&
      !isObjectNotArray(entry.schema)
    ) {
      throw new Error(
        `invalid handle table: entry \`${entry.token}\` has a schema that is not a JSON Schema object or boolean`,
      );
    }
    if (entry.schemaSource !== undefined && entry.schemaSource !== "harness") {
      throw new Error(
        `invalid handle table: entry \`${entry.token}\` has an unknown schemaSource \`${
          String(entry.schemaSource)
        }\``,
      );
    }
    if (entry.schemaSource !== undefined && entry.schema === undefined) {
      throw new Error(
        `invalid handle table: entry \`${entry.token}\` claims schema provenance \`${entry.schemaSource}\` with no schema`,
      );
    }
    if (
      entry.capability !== undefined && entry.capability !== "skill-context"
    ) {
      throw new Error(
        `invalid handle table: entry \`${entry.token}\` has an unknown capability \`${
          String(entry.capability)
        }\``,
      );
    }
    if (entry.acquisition !== undefined) {
      // Shape before fields: a persisted table is untrusted input, and reading
      // a field off a null or an array would fail as a TypeError naming
      // neither the table nor the entry.
      if (!isObjectNotArray(entry.acquisition)) {
        throw new Error(
          `invalid handle table: entry \`${entry.token}\` has an acquisition that is not an object`,
        );
      }
      // Acquisition provenance is trusted-side only, so a table that arrives
      // claiming it on a handle no acquisition could have minted is refused
      // rather than read: a `skill-context` capability is what says the value
      // is skill text a host step fetched.
      if (entry.capability !== "skill-context") {
        throw new Error(
          `invalid handle table: entry \`${entry.token}\` carries acquisition provenance without the \`skill-context\` capability`,
        );
      }
      for (const field of ACQUISITION_STRING_FIELDS) {
        const value = entry.acquisition[field];
        if (typeof value !== "string" || value.length === 0) {
          throw new Error(
            `invalid handle table: entry \`${entry.token}\` has an empty acquisition \`${field}\``,
          );
        }
      }
      if (entry.acquisition.verification !== "git-commit-sha") {
        throw new Error(
          `invalid handle table: entry \`${entry.token}\` has an unknown acquisition verification \`${
            String(entry.acquisition.verification)
          }\``,
        );
      }
    }
    if (tokens.has(entry.token)) {
      throw new Error(
        `invalid handle table: duplicate token \`${entry.token}\``,
      );
    }
    tokens.add(entry.token);
    if (addressKeys.has(entry.addressKey)) {
      throw new Error(
        `invalid handle table: duplicate addressKey for token \`${entry.token}\``,
      );
    }
    addressKeys.add(entry.addressKey);
  }
};
