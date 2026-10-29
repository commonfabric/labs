/** Hashtag lexing for free text. */

// A hashtag is `#` followed by a run of Unicode letters, combining marks,
// numbers, and underscores. Letters from any script are accepted (Latin with
// diacritics, CJK, Cyrillic, and so on), not just unaccented a-z. Any other
// character, including a hyphen, whitespace, or the end of the text,
// terminates the tag.
const HASHTAG_PATTERN = /#([\p{L}\p{M}\p{N}_]+)/gu;

/**
 * Extracts hashtag tokens from free text. A token starts at `#` and runs
 * through Unicode letters, combining marks, numbers, and underscores; a
 * hyphen, space, or other punctuation ends it. Returns the tokens lowercased,
 * without the leading `#`, deduplicated, in order of first appearance.
 *
 * **Note:** The lexing here is looser than the convention the same syntax
 * implies elsewhere, in ways a caller minting durable tags out of prose is
 * exposed to:
 *
 * - A `#` is recognized wherever it sits, with no preceding-boundary check and
 *   no requirement that the token contain a letter. So text which merely
 *   _mentions_ a tag produces one, as does text which is not about tags at all:
 *   `Fixes issue #4267` yields `["4267"]`, `#ff0000` yields `["ff0000"]`, and
 *   `https://example.com/docs#install` yields `["install"]`.
 * - Tokens are not Unicode-normalized, so two that render identically need not
 *   be equal: `#café` written NFD (5 code points) and NFC (4) yield different
 *   strings, and a producer and consumer in different forms silently never
 *   match. `toLowerCase()` is likewise not case folding (`#İstanbul`).
 * - `\p{Cf}` characters terminate a token, so scripts which use them
 *   word-internally are cut short: Persian `#می‌رود` yields just `["می"]` at
 *   the ZWNJ (U+200C).
 */
export function extractHashtags(text: string): string[] {
  const tags: string[] = [];
  for (const match of text.matchAll(HASHTAG_PATTERN)) {
    const tag = match[1]!.toLowerCase();
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags;
}
