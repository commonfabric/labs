/**
 * How `shortDid()` shortens a DID for display, run as a pattern because it
 * takes the DID apart with `parseDID()` from `commonfabric`, which only the
 * pattern runtime binds.
 */

import { assert, pattern, TESTS } from "commonfabric";
import { shortDid } from "./short-did.ts";

/** Four characters of one code point and two UTF-16 units each. */
const WIDE_TAIL = "\u{1F369}\u{1F369}\u{1F369}\u{1F369}";

export default pattern(() => {
  const longDidKey = assert(() =>
    shortDid("did:key:z6MkecWJLQz2vTvJQeDQbKjZ7CMuGJQDW62248YMiefPYdTN") ===
      "did:key:…YdTN"
  );
  const partOfTwentyWhole = assert(() =>
    shortDid(`did:key:${"a".repeat(20)}`) === `did:key:${"a".repeat(20)}`
  );
  const partOfTwentyOneShortened = assert(() =>
    shortDid(`did:key:${"a".repeat(21)}`) === "did:key:…aaaa"
  );
  const lastFourNotFirstFour = assert(() =>
    shortDid(`did:key:${"a".repeat(20)}WXYZ`) === "did:key:…WXYZ"
  );
  const shortDidWebWhole = assert(() =>
    shortDid("did:web:example.com") === "did:web:example.com"
  );
  const longPartWithColonsShortened = assert(() =>
    shortDid("did:web:example.com:users:alice-in-wonderland") ===
      "did:web:…land"
  );
  const emptyPartWhole = assert(() => shortDid("did:key:") === "did:key:");
  const twentyCodePointsWhole = assert(() =>
    shortDid(`did:key:${"a".repeat(16)}${WIDE_TAIL}`) ===
      `did:key:${"a".repeat(16)}${WIDE_TAIL}`
  );
  const twentyOneCodePointsCutByCodePoint = assert(() =>
    shortDid(`did:key:${"a".repeat(17)}${WIDE_TAIL}`) ===
      `did:key:…${WIDE_TAIL}`
  );
  const starUnchanged = assert(() => shortDid("*") === "*");
  const nameUnchanged = assert(() => shortDid("alice") === "alice");
  const emptyMethodUnchanged = assert(() =>
    shortDid(`did::${"a".repeat(30)}`) === `did::${"a".repeat(30)}`
  );
  const noPartUnchanged = assert(() => shortDid("did:key") === "did:key");
  const uppercasePrefixUnchanged = assert(() =>
    shortDid(`DID:key:${"a".repeat(30)}`) === `DID:key:${"a".repeat(30)}`
  );
  const emptyStringEmpty = assert(() => shortDid("") === "");
  const undefinedEmpty = assert(() => shortDid(undefined) === "");

  return {
    [TESTS]: [
      { assertion: longDidKey },
      { assertion: partOfTwentyWhole },
      { assertion: partOfTwentyOneShortened },
      { assertion: lastFourNotFirstFour },
      { assertion: shortDidWebWhole },
      { assertion: longPartWithColonsShortened },
      { assertion: emptyPartWhole },
      { assertion: twentyCodePointsWhole },
      { assertion: twentyOneCodePointsCutByCodePoint },
      { assertion: starUnchanged },
      { assertion: nameUnchanged },
      { assertion: emptyMethodUnchanged },
      { assertion: noPartUnchanged },
      { assertion: uppercasePrefixUnchanged },
      { assertion: emptyStringEmpty },
      { assertion: undefinedEmpty },
    ],
  };
});
