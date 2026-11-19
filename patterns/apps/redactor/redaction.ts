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
 * randomness), and a stand-in that already occurs in the draft's visible text
 * is skipped, so restoring a reply can never overwrite a real mention of it.
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
// characters and look-alike letters, so "JOHN  smith" or "Јohn Smith" (Cyrillic
// J) still match "John Smith". Digits are not folded into letters ("J0hn" does
// not match): a 0 stays a digit, so numbers match only as written.
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

const foldMarks = (s: string): string =>
  s.normalize("NFKD").replace(/\p{M}/gu, "");

/** The canonical form of `text`, and for each canonical character the index
 * of the character it came from in the NFKC-normalized text. */
export const canonicalize = (
  text: string,
): { canonical: string; positions: number[] } => {
  const chars = Array.from(text.normalize("NFKC"));
  const kept = chars
    .flatMap((char, index) =>
      // Fold look-alikes, then accents: "José" matches "Jose".
      Array.from(foldMarks(CONFUSABLES[char] ?? char)).map((c) => ({
        char: c,
        index,
      }))
    )
    .filter(({ char }) => !ZERO_WIDTH.has(char) && !SKIPPED.test(char));
  // Positions index code points; map them to string offsets.
  const offsets = [0];
  for (const char of chars) {
    offsets.push(offsets[offsets.length - 1] + char.length);
  }
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

/** A word of a multi-word name that is matched on its own: at least two
 * characters once canonical, so an initial like "J." is not a needle. */
const isNamePart = (part: string): boolean =>
  canonicalize(part).canonical.length >= 2;

/** The shortest part of an email that is matched on its own. */
const MIN_PART = 4;

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
            .filter((p) => isNamePart(p.value))
          : []),
      ];
    }
    if (entry.category === "email") {
      const at = value.lastIndexOf("@");
      if (at <= 0) return [entry];
      const domain = value.slice(at + 1).toLowerCase();
      // A short local part or domain ("me@x.co") would match ordinary words.
      const local = value.slice(0, at);
      return [
        entry,
        ...(local.length >= MIN_PART
          ? [{ category: "custom" as const, value: local }]
          : []),
        ...(COMMON_MAIL_PROVIDERS.has(domain.split(".")[0]) ||
            domain.length < MIN_PART
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
// each kind the draft held and in what order, and nothing else about them: a
// candidate is skipped only when it collides with text that stays visible, or
// with another stand-in, never because of a value being hidden.
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
  "Kara",
  "Liam",
  "Maya",
  "Noah",
  "Olive",
  "Paul",
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
  "Kim",
  "Lopez",
  "Moore",
  "Nguyen",
];
const DOMAINS = ["example.com", "example.org", "example.net"];
const STREETS = ["Example St", "Test Ave", "Sample Blvd", "Demo Ln", "Mock Dr"];
const CITIES = ["Anytown", "Somewhere", "Testville", "Mocksburg", "Sampletown"];

/** The `n`th stand-in of a non-name category (n from 0). */
export const standInFor = (category: PIICategory, n: number): string => {
  switch (category) {
    case "email":
      return `${FIRST[n % FIRST.length].toLowerCase()}${n + 1}@${
        DOMAINS[n % DOMAINS.length]
      }`;
    case "phone": { // 555-0100 through 555-0199 are reserved for fiction.
      const base = `(555) 555-01${String(n % 100).padStart(2, "0")}`;
      // Past 100 numbers, an extension keeps every stand-in distinct.
      return n < 100 ? base : `${base} ext. ${Math.floor(n / 100) + 1}`;
    }
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

const wordsOf = (text: string): string[] =>
  foldMarks(text.normalize("NFKC")).toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== "");

/** A pool word with an `n`th-cycle suffix once the pool runs out. */
const poolWord = (pool: readonly string[], n: number): string =>
  n < pool.length
    ? pool[n]
    : `${pool[n % pool.length]}${
      String.fromCharCode(65 + (Math.floor(n / pool.length) - 1) % 26)
    }`;

/** Replace every detected value in `text` with a stand-in. The same original
 * always gets the same stand-in within one redaction. Each distinct word of a
 * name gets its own stand-in word (first names from one pool, surnames from
 * another), so "Rivera" alone becomes the surname of "Jordan Rivera"'s
 * stand-in, and no two different words share a stand-in word.
 *
 * The result depends only on the text and on the values that match in it: a
 * found value that never matches (a vault entry the draft does not mention, or
 * the unmentioned words of a name) draws no stand-in and changes nothing. */
export const redact = (
  text: string,
  found: readonly PIIEntry[],
): Redaction => {
  const normalized = text.normalize("NFKC");
  const matches = findMatches(normalized, needlesFor(found));
  // Words that stay visible: no stand-in may be one, or restoring would
  // rewrite visible text. Hidden values are deliberately not consulted, so a
  // stand-in carries no hint of one; `restore` swaps in one pass, so a
  // stand-in that happens to equal a hidden word is never swapped twice.
  const visible = matches
    .reduceRight(
      (t, m) => t.slice(0, m.start) + " " + t.slice(m.end),
      normalized,
    );
  const taken = new Set(wordsOf(visible));
  const visibleLower = foldMarks(visible).toLowerCase();
  const counters: Record<string, number> = {};
  const take = (key: string, make: (n: number) => string): string => {
    for (;;) {
      const n = counters[key] ?? 0;
      counters[key] = n + 1;
      const candidate = make(n);
      const words = wordsOf(candidate);
      const free = key === "first" || key === "last"
        ? words.every((w) => !taken.has(w))
        : !visibleLower.includes(candidate.toLowerCase());
      if (free) {
        words.forEach((w) => taken.add(w));
        return candidate;
      }
    }
  };

  // One stand-in word per distinct name word, drawn when that word first
  // matches, so a word the draft never mentions draws nothing.
  const nameWords = new Map<string, string>();
  const wordFor = (word: string, surname: boolean): string => {
    const key = canonicalize(word).canonical;
    const existing = nameWords.get(key);
    if (existing !== undefined) return existing;
    const standIn = surname
      ? take("last", (n) => poolWord(LAST, n))
      : take("first", (n) => poolWord(FIRST, n));
    nameWords.set(key, standIn);
    return standIn;
  };

  const byOriginal = new Map<string, Substitution>();
  const add = (category: PIICategory, original: string, standIn: string) => {
    const key = canonicalize(original).canonical;
    if (!byOriginal.has(key)) {
      byOriginal.set(key, { category, original, standIn });
    }
    return byOriginal.get(key)!.standIn;
  };

  const pieces: string[] = [];
  let last = 0;
  for (const { needle, start, end } of matches) {
    const original = normalized.slice(start, end);
    let standIn: string;
    if (needle.category === "name" && needle.partOf) {
      const { index, count } = needle.partOf;
      standIn = add(
        "name",
        original,
        wordFor(needle.value, count > 1 && index === count - 1),
      );
    } else if (needle.category === "name") {
      const whole = needle.value.trim();
      const parts = whole.split(/\s+/);
      const words = parts.map((p, i) =>
        wordFor(p, parts.length > 1 && i === parts.length - 1)
      );
      // Every form of the name restores: the whole, and each word alone.
      add("name", whole, words.join(" "));
      parts.forEach((p, i) => {
        if (parts.length > 1 && isNamePart(p)) add("name", p, words[i]);
      });
      standIn = add("name", original, words.join(" "));
    } else {
      standIn = byOriginal.get(needle.canonical)?.standIn ??
        add(
          needle.category,
          original,
          take(needle.category, (n) => standInFor(needle.category, n)),
        );
    }
    pieces.push(normalized.slice(last, start), standIn);
    last = end;
  }
  pieces.push(normalized.slice(last));
  return { redacted: pieces.join(""), substitutions: [...byOriginal.values()] };
};

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Put the originals back into a reply: whole words, any case, longest
 * stand-in first, in a single pass, so an original that happens to read like
 * another stand-in is never swapped a second time. */
export const restore = (
  reply: string,
  substitutions: readonly Substitution[],
): string => {
  const byStandIn = new Map<string, string>();
  for (
    const s of [...substitutions].sort((a, b) =>
      b.standIn.length - a.standIn.length
    )
  ) {
    const key = s.standIn.toLowerCase();
    if (s.standIn !== "" && !byStandIn.has(key)) byStandIn.set(key, s.original);
  }
  if (byStandIn.size === 0) return reply;
  const any = [...byStandIn.keys()].map(escapeRegExp).join("|");
  return reply.replace(
    new RegExp(`(?<![\\p{L}\\p{N}])(?:${any})(?![\\p{L}\\p{N}])`, "giu"),
    (m) => byStandIn.get(m.toLowerCase()) ?? m,
  );
};

/** Shorter words match too much ordinary text to report. */
const MIN_LEAK_WORD = 3;

/** Pieces of the found values that still appear in `text`, which should hold
 * only stand-ins. Deliberately looser than redaction's matcher, so it catches
 * what redaction's whole-value matching missed: any word of a value (accents
 * and case folded), and any run of four or more of a value's digits. */
export const leaksIn = (
  text: string,
  found: readonly PIIEntry[],
  substitutions: readonly Substitution[] = [],
): string[] => {
  // The stand-ins themselves are expected; look only at what remains.
  const remaining = substitutions.reduce(
    (t, sub) =>
      t.replace(
        new RegExp(
          `(?<![\\p{L}\\p{N}])${escapeRegExp(sub.standIn)}(?![\\p{L}\\p{N}])`,
          "giu",
        ),
        " ",
      ),
    text,
  );
  const textWords = new Set(wordsOf(remaining));
  const textDigits = remaining.replace(/\D/g, "");
  return [
    ...new Set(found.flatMap((f) => {
      const words = wordsOf(f.value).filter((w) =>
        w.length >= MIN_LEAK_WORD && !/^\d+$/.test(w) && textWords.has(w)
      );
      const digits = f.value.replace(/\D/g, "");
      const digitLeak = digits.length >= 4 &&
        Array.from(
          { length: digits.length - 3 },
          (_, i) => digits.slice(i, i + 4),
        ).some((run) => textDigits.includes(run));
      return words.length > 0 || digitLeak ? [f.value] : [];
    })),
  ];
};
