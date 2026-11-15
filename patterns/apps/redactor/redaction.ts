/**
 * Pure redaction logic: find personal information in text, swap each value for
 * a realistic stand-in, swap the stand-ins back in a reply, and check a reply
 * for originals that slipped through.
 *
 * Nothing here knows about cells or labels. `policy.tsx` wraps `redact` in the
 * one computation whose output the redaction policy releases, so everything
 * this module computes from a confidential draft stays confidential except that
 * one string.
 *
 * Ported from jkomoros/community-patterns `redactor.tsx`. Two behaviors are
 * new: stand-ins are chosen deterministically (a computation may not draw
 * randomness), and a stand-in that already occurs in the draft is skipped, so
 * restoring a reply can never overwrite a real mention of it.
 */

export type PIICategory =
  | "name"
  | "email"
  | "phone"
  | "ssn"
  | "address"
  | "custom";

export interface PIIEntry {
  category: PIICategory;
  value: string;
}

export interface Detection extends PIIEntry {
  /** "vault" for an entry the user stored; otherwise the detector's name. */
  source: string;
}

/** One stand-in and the original it replaced. */
export interface Substitution {
  category: PIICategory;
  original: string;
  standIn: string;
}

export interface Redaction {
  redacted: string;
  substitutions: Substitution[];
}

export const CATEGORY_LABELS: Record<PIICategory, string> = {
  name: "Name",
  email: "Email",
  phone: "Phone",
  ssn: "SSN",
  address: "Address",
  custom: "Other",
};

// ---------------------------------------------------------------------------
// Canonicalization: matching survives case, spacing, punctuation, zero-width
// characters and look-alike letters, so "J0hn  Smith" or "Јohn" (Cyrillic J)
// still match "John Smith".
// ---------------------------------------------------------------------------

const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  "а": "a",
  "е": "e",
  "о": "o",
  "р": "p",
  "с": "c",
  "у": "y",
  "х": "x",
  "А": "A",
  "В": "B",
  "Е": "E",
  "К": "K",
  "М": "M",
  "Н": "H",
  "О": "O",
  "Р": "P",
  "С": "C",
  "Т": "T",
  "У": "Y",
  "Х": "X",
  "Ј": "J",
  "ј": "j",
  // Greek
  "α": "a",
  "ο": "o",
  "ρ": "p",
  "τ": "t",
  "υ": "u",
  "Α": "A",
  "Β": "B",
  "Ε": "E",
  "Η": "H",
  "Ι": "I",
  "Κ": "K",
  "Μ": "M",
  "Ν": "N",
  "Ο": "O",
  "Ρ": "P",
  "Τ": "T",
  "Υ": "Y",
  "Χ": "X",
  "Ζ": "Z",
};

const ZERO_WIDTH = new Set(["​", "‌", "‍", "﻿", "­"]);

const SKIPPED = /[\s\p{P}\p{S}]/u;

/** The canonical form of `text`, and for each canonical character the index
 * of the character it came from in the NFKC-normalized text. */
export const canonicalize = (
  text: string,
): { canonical: string; positions: number[] } => {
  const chars = Array.from(text.normalize("NFKC"));
  const kept = chars
    .map((char, index) => ({ char: CONFUSABLES[char] ?? char, index }))
    .filter(({ char }) => !ZERO_WIDTH.has(char) && !SKIPPED.test(char));
  // Positions index code points; map them to string offsets.
  const offsets = chars.reduce<number[]>(
    (acc, char) => [...acc, acc[acc.length - 1] + char.length],
    [0],
  );
  return {
    canonical: kept.map(({ char }) => char.toLowerCase()).join(""),
    positions: kept.map(({ index }) => offsets[index]),
  };
};

const isBoundary = (text: string, index: number): boolean =>
  index < 0 || index >= text.length || /[\s\p{P}]/u.test(text[index]);

// ---------------------------------------------------------------------------
// Expanding vault entries into the strings to look for
// ---------------------------------------------------------------------------

const COMMON_MAIL_PROVIDERS = new Set([
  "gmail",
  "hotmail",
  "yahoo",
  "outlook",
  "icloud",
  "aol",
  "protonmail",
  "mail",
  "live",
  "msn",
]);

interface Needle extends PIIEntry {
  canonical: string;
  /** For one word of a multi-word name: the whole name, and which word. */
  partOf?: { whole: string; index: number; count: number };
}

/** Each entry, plus the parts of it that identify someone on their own: each
 * part of a name, an address's local part, and a non-webmail domain. Longest
 * first, so "John Smith" wins over "John". */
const needlesFor = (entries: readonly PIIEntry[]): Needle[] => {
  const expanded = entries.flatMap((entry): Omit<Needle, "canonical">[] => {
    const value = entry.value.trim();
    if (entry.category === "name") {
      const parts = value.split(/\s+/);
      return [
        entry,
        ...(parts.length > 1
          ? parts
            .map((p, index) => ({
              category: "name" as const,
              value: p,
              partOf: { whole: value, index, count: parts.length },
            }))
            .filter((p) => p.value.length >= 2)
          : []),
      ];
    }
    if (entry.category === "email") {
      const at = value.lastIndexOf("@");
      if (at <= 0) return [entry];
      const domain = value.slice(at + 1).toLowerCase();
      return [
        entry,
        { category: "custom", value: value.slice(0, at) },
        ...(COMMON_MAIL_PROVIDERS.has(domain.split(".")[0])
          ? []
          : [{ category: "custom" as const, value: domain }]),
      ];
    }
    return [entry];
  });
  const seen = new Set<string>();
  return expanded
    .map((e) => ({ ...e, canonical: canonicalize(e.value).canonical }))
    .filter((e) => {
      if (e.canonical.length === 0 || seen.has(e.canonical)) return false;
      seen.add(e.canonical);
      return true;
    })
    .sort((a, b) => b.canonical.length - a.canonical.length);
};

interface Match {
  needle: Needle;
  start: number;
  end: number;
}

/** Every whole-word occurrence of every needle, without overlaps, in text
 * order. */
const findMatches = (text: string, needles: readonly Needle[]): Match[] => {
  const normalized = text.normalize("NFKC");
  const { canonical, positions } = canonicalize(normalized);
  const taken = new Set<number>();
  const matches: Match[] = [];
  for (const needle of needles) {
    let from = 0;
    for (;;) {
      const at = canonical.indexOf(needle.canonical, from);
      if (at === -1) break;
      from = at + 1;
      const span = Array.from(
        { length: needle.canonical.length },
        (_, i) => at + i,
      );
      if (span.some((i) => taken.has(i))) continue;
      let start = positions[at];
      let end = positions[at + needle.canonical.length - 1] + 1;
      while (start > 0 && !isBoundary(normalized, start - 1)) start--;
      while (end < normalized.length && !isBoundary(normalized, end)) end++;
      // Only a whole word: "Al" must not take a bite out of "Alberta".
      const covered = canonicalize(normalized.slice(start, end)).canonical;
      if (covered !== needle.canonical) continue;
      span.forEach((i) => taken.add(i));
      matches.push({ needle, start, end });
    }
  }
  return matches.sort((a, b) => a.start - b.start);
};

// ---------------------------------------------------------------------------
// Detecting common formats in the draft itself
// ---------------------------------------------------------------------------

const digitsOf = (s: string): string => s.replace(/\D/g, "");

const luhn = (value: string): boolean => {
  const digits = digitsOf(value);
  if (digits.length < 13 || digits.length > 19) return false;
  const sum = Array.from(digits)
    .reverse()
    .map((d, i) => {
      const n = Number(d) * (i % 2 === 1 ? 2 : 1);
      return n > 9 ? n - 9 : n;
    })
    .reduce((a, b) => a + b, 0);
  return sum % 10 === 0;
};

const validSSN = (value: string): boolean => {
  const digits = digitsOf(value);
  if (digits.length !== 9) return false;
  const area = Number(digits.slice(0, 3));
  return area !== 0 && area !== 666 && area < 900 &&
    Number(digits.slice(3, 5)) !== 0 && Number(digits.slice(5)) !== 0;
};

const validUSPhone = (value: string): boolean => {
  const digits = digitsOf(value);
  const ten = digits.length === 11 && digits[0] === "1"
    ? digits.slice(1)
    : digits;
  return ten.length === 10 && Number(ten[0]) >= 2 && Number(ten[3]) >= 2;
};

const DETECTORS: readonly {
  name: string;
  category: PIICategory;
  source: string;
  valid?: "ssn" | "luhn" | "phone";
}[] = [
  {
    name: "email",
    category: "email",
    source: "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}",
  },
  {
    name: "ssn",
    category: "ssn",
    source: "\\b\\d{3}-\\d{2}-\\d{4}\\b",
    valid: "ssn",
  },
  {
    name: "card",
    category: "custom",
    source: "\\b(?:\\d{4}[- ]?){3,4}\\d{1,4}\\b",
    valid: "luhn",
  },
  {
    name: "phone",
    category: "phone",
    source:
      "(?:\\+1[- .]?)?(?:\\(\\d{3}\\)|\\b\\d{3})[- .]?\\d{3}[- .]?\\d{4}\\b",
    valid: "phone",
  },
];

const passes = (valid: string | undefined, value: string): boolean =>
  valid === "ssn"
    ? validSSN(value)
    : valid === "luhn"
    ? luhn(value)
    : valid === "phone"
    ? validUSPhone(value)
    : true;

/** Values in `text` that look like an email, SSN, card number or US phone. */
export const autoDetect = (text: string): Detection[] => {
  const found: { start: number; end: number; detection: Detection }[] = [];
  for (const detector of DETECTORS) {
    for (const match of text.matchAll(new RegExp(detector.source, "g"))) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (found.some((f) => start < f.end && end > f.start)) continue;
      if (!passes(detector.valid, match[0])) continue;
      found.push({
        start,
        end,
        detection: {
          category: detector.category,
          value: match[0],
          source: detector.name,
        },
      });
    }
  }
  return found.sort((a, b) => a.start - b.start).map((f) => f.detection);
};

/** The vault's entries, then whatever detection adds that the vault lacks. */
export const detections = (
  text: string,
  vault: readonly PIIEntry[],
  autoDetectEnabled: boolean,
): Detection[] => {
  const fromVault = vault
    .filter((e) => e.value.trim() !== "")
    .map((e): Detection => ({ ...e, source: "vault" }));
  if (!autoDetectEnabled) return fromVault;
  const known = new Set(
    fromVault.map((e) => canonicalize(e.value).canonical),
  );
  return [
    ...fromVault,
    ...autoDetect(text).filter((d) =>
      !known.has(canonicalize(d.value).canonical)
    ),
  ];
};

// ---------------------------------------------------------------------------
// Stand-ins: realistic, reserved-for-fiction values chosen by order of first
// appearance within each category. They reveal how many distinct values of
// each kind the draft held and in what order, and nothing else about them.
// ---------------------------------------------------------------------------

const FIRST = [
  "Alice",
  "Bob",
  "Carol",
  "David",
  "Eve",
  "Frank",
  "Grace",
  "Henry",
  "Iris",
  "Jack",
];
const LAST = [
  "Anderson",
  "Brown",
  "Chen",
  "Davis",
  "Evans",
  "Foster",
  "Garcia",
  "Harris",
  "Irving",
  "Jones",
];
const DOMAINS = ["example.com", "example.org", "example.net"];
const STREETS = ["Example St", "Test Ave", "Sample Blvd", "Demo Ln", "Mock Dr"];
const CITIES = ["Anytown", "Somewhere", "Testville", "Mocksburg", "Sampletown"];

/** The `n`th stand-in of a category (n from 0). */
export const standInFor = (category: PIICategory, n: number): string => {
  switch (category) {
    case "name":
      return `${FIRST[n % FIRST.length]} ${
        LAST[Math.floor(n / FIRST.length) % LAST.length]
      }`;
    case "email":
      return `${FIRST[n % FIRST.length].toLowerCase()}${n + 1}@${
        DOMAINS[n % DOMAINS.length]
      }`;
    case "phone": // 555-0100 through 555-0199 are reserved for fiction.
      return `(555) 555-01${String(n % 100).padStart(2, "0")}`;
    case "ssn": // Area 900 and above is never issued.
      return `900-${String(Math.floor(n / 9999) % 100).padStart(2, "0")}-${
        String((n % 9999) + 1).padStart(4, "0")
      }`;
    case "address":
      return `${100 + n} ${STREETS[n % STREETS.length]}, ${
        CITIES[n % CITIES.length]
      }`;
    default:
      return `[REDACTED-${String(n + 1).padStart(3, "0")}]`;
  }
};

/** Replace every detected value in `text` with a stand-in. The same original
 * always gets the same stand-in within one redaction, and no stand-in is one
 * that already occurs in `text`. */
export const redact = (
  text: string,
  found: readonly PIIEntry[],
): Redaction => {
  const matches = findMatches(text, needlesFor(found));
  const normalized = text.normalize("NFKC");
  const occurs = canonicalize(normalized).canonical;
  const byOriginal = new Map<string, Substitution>();
  const counters: Partial<Record<PIICategory, number>> = {};
  const nextStandIn = (category: PIICategory): string => {
    for (;;) {
      const n = counters[category] ?? 0;
      counters[category] = n + 1;
      const candidate = standInFor(category, n);
      // A name's words are used alone too, so each must be new to the text.
      const words = category === "name" ? candidate.split(" ") : [];
      if (
        [candidate, ...words].every((w) =>
          !occurs.includes(canonicalize(w).canonical)
        )
      ) {
        return candidate;
      }
    }
  };
  const wholeNames = new Map<string, string>();
  const standInForNeedle = (needle: Needle): string => {
    if (!needle.partOf) return nextStandIn(needle.category);
    const key = canonicalize(needle.partOf.whole).canonical;
    const whole = wholeNames.get(key) ??
      byOriginal.get(key)?.standIn ?? nextStandIn("name");
    wholeNames.set(key, whole);
    const words = whole.split(" ");
    // First word to first word, last to last; a middle word keeps the first.
    return needle.partOf.index === needle.partOf.count - 1
      ? words[words.length - 1]
      : words[0];
  };
  const pieces: string[] = [];
  let last = 0;
  for (const { needle, start, end } of matches) {
    if (!needle.partOf && needle.category === "name") {
      const reserved = wholeNames.get(needle.canonical);
      if (reserved && !byOriginal.has(needle.canonical)) {
        byOriginal.set(needle.canonical, {
          category: "name",
          original: normalized.slice(start, end),
          standIn: reserved,
        });
      }
    }
    const existing = byOriginal.get(needle.canonical);
    const substitution = existing ?? {
      category: needle.category,
      original: normalized.slice(start, end),
      standIn: standInForNeedle(needle),
    };
    byOriginal.set(needle.canonical, substitution);
    pieces.push(normalized.slice(last, start), substitution.standIn);
    last = end;
  }
  pieces.push(normalized.slice(last));
  return { redacted: pieces.join(""), substitutions: [...byOriginal.values()] };
};

/** Put the originals back into a reply, longest stand-in first. */
export const restore = (
  reply: string,
  substitutions: readonly Substitution[],
): string =>
  [...substitutions]
    .sort((a, b) => b.standIn.length - a.standIn.length)
    .reduce(
      (text, s) =>
        text.replace(
          new RegExp(
            `(?<![\\p{L}\\p{N}])${escapeRegExp(s.standIn)}(?![\\p{L}\\p{N}])`,
            "gu",
          ),
          () => s.original,
        ),
      reply,
    );

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Shorter values match too much ordinary text to report as leaks. */
const MIN_LEAK_LENGTH = 3;

/** Originals that appear in `text` although it should hold only stand-ins:
 * on the redacted draft, a value redaction missed; on a model's reply before
 * restoring, a value the model somehow knew. */
export const leaksIn = (
  text: string,
  found: readonly PIIEntry[],
): string[] => {
  const needles = needlesFor(found).filter((n) =>
    n.canonical.length >= MIN_LEAK_LENGTH
  );
  return [
    ...new Set(findMatches(text, needles).map((m) => m.needle.value)),
  ];
};
