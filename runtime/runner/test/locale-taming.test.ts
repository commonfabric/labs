/**
 * Sanitized locale methods under SES lockdown (locale-taming.ts).
 *
 * `localeTaming: "safe"` used to alias every `toLocale*` method to its
 * non-locale equivalent, silently ignoring arguments. The sanitized wrappers
 * keep the methods functional but pin the ambient defaults: omitted locale →
 * "en-US", omitted Date timeZone → "UTC". Explicit arguments pass through.
 *
 * Assertions run INSIDE a lockdown compartment (the pattern-visible surface).
 * Fixed timestamp: 1752192000000 = 2025-07-11T00:00:00Z, a Friday.
 *
 * Expected strings are exact for date-only / number formatting (stable across
 * ICU versions); time strings match the AM/PM separator loosely because ICU
 * 72 changed it to U+202F.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { evaluateFunctionSourceInSES } from "../src/sandbox/ses-runtime.ts";
import { pinLocales } from "../src/sandbox/locale-taming.ts";

const T = 1752192000000; // 2025-07-11T00:00:00Z (Friday)

const inSES = (expr: string): unknown =>
  evaluateFunctionSourceInSES(`(() => (${expr}))()`, { lockdown: true });

describe("sanitized locale methods under SES lockdown", () => {
  describe("Date.prototype.toLocaleDateString", () => {
    it("honors the options bag (the localeTaming:'safe' alias ignored it)", () => {
      expect(
        inSES(
          `new Date(${T}).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })`,
        ),
      ).toBe("Friday, Jul 11");
    });

    it("defaults an omitted timeZone to UTC, not the host timezone", () => {
      // 2025-07-11T00:00:00Z is 7/11 in UTC but 7/10 in every zone west of it;
      // an ambient-timezone default would make this assertion host-dependent.
      expect(inSES(`new Date(${T}).toLocaleDateString()`)).toBe("7/11/2025");
    });

    it("defaults an omitted locale to en-US, including the [] spelling", () => {
      expect(
        inSES(`new Date(${T}).toLocaleDateString([], { month: "long" })`),
      ).toBe("July");
    });

    it("honors an explicit timeZone", () => {
      expect(
        inSES(
          `new Date(${T}).toLocaleDateString("en-US", { timeZone: "America/New_York" })`,
        ),
      ).toBe("7/10/2025");
    });

    it("honors an explicit locale", () => {
      expect(inSES(`new Date(${T}).toLocaleDateString("de-DE")`)).toBe(
        "11.7.2025",
      );
    });
  });

  describe("Date.prototype.toLocaleTimeString / toLocaleString", () => {
    it("formats UTC midnight, honoring options", () => {
      const time = inSES(
        `new Date(${T}).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })`,
      ) as string;
      // ICU ≥72 uses U+202F before AM/PM; older ICU uses a plain space.
      expect(time).toMatch(/^12:00[\s ]AM$/);
    });

    it("toLocaleString combines date and time in UTC by default", () => {
      const s = inSES(`new Date(${T}).toLocaleString()`) as string;
      expect(s).toMatch(/^7\/11\/2025, 12:00:00[\s ]AM$/);
    });
  });

  describe("Number / BigInt toLocaleString", () => {
    it("defaults to en-US grouping (the alias returned toString output)", () => {
      expect(inSES(`(1234567.89).toLocaleString()`)).toBe("1,234,567.89");
    });

    it("honors an explicit locale", () => {
      expect(inSES(`(1234567.89).toLocaleString("de-DE")`)).toBe(
        "1.234.567,89",
      );
    });

    it("covers BigInt", () => {
      expect(inSES(`(123456789n).toLocaleString()`)).toBe("123,456,789");
    });
  });

  describe("String locale methods", () => {
    it("localeCompare defaults deterministically and honors explicit locales", () => {
      // "ä" sorts before "z" in German but after "z" in Swedish — the classic
      // collation divergence; both being honored proves arguments flow through.
      expect(inSES(`"ä".localeCompare("z", "de")`)).toBeLessThan(0);
      expect(inSES(`"ä".localeCompare("z", "sv")`)).toBeGreaterThan(0);
      expect(inSES(`"a".localeCompare("b")`)).toBeLessThan(0);
    });

    it("case mappings default to en-US and honor explicit locales", () => {
      expect(inSES(`"i".toLocaleUpperCase()`)).toBe("I");
      // Turkish dotted capital İ — only with the explicit locale.
      expect(inSES(`"i".toLocaleUpperCase("tr")`)).toBe("İ");
    });
  });

  describe("host-locale leak closure (unsupported-tag fallback)", () => {
    // ECMA-402 resolves a well-formed-but-unsupported requested tag to the
    // HOST default locale — a read of the user's language/region. pinLocales
    // closes it by appending "en-US" to every request, so resolution never
    // reaches the host default. The closure itself can't be asserted
    // in-process (the realm's default locale is fixed at startup and CI hosts
    // run en/C); it was verified manually via
    //   LC_ALL=de_DE.UTF-8 deno eval '...toLocaleString("xx")'
    // — so these tests pin the mechanism (the appended fallback) and the
    // resulting in-compartment behavior.

    it("appends the pinned default to every requested-locales shape", () => {
      expect(pinLocales(undefined)).toBe("en-US");
      expect(pinLocales([])).toEqual(["en-US"]);
      expect(pinLocales("de-DE")).toEqual(["de-DE", "en-US"]);
      expect(pinLocales(["fr", "de-DE"])).toEqual(["fr", "de-DE", "en-US"]);
    });

    it("resolves an unsupported tag to en-US output, not the host default", () => {
      expect(inSES(`(1234567.89).toLocaleString("xx")`)).toBe("1,234,567.89");
      expect(inSES(`new Date(${T}).toLocaleDateString("xx")`)).toBe(
        "7/11/2025",
      );
    });

    it("still throws RangeError on malformed tags", () => {
      expect(() => inSES(`(1).toLocaleString("not a tag!")`)).toThrow(
        RangeError,
      );
    });

    it("timeZone has no analogous fallback hole: invalid values throw, they never resolve to the host zone", () => {
      // The ECMA-402 asymmetry: locale resolution silently falls back (the
      // leak pinLocales closes); timeZone validation throws. Only omission
      // (undefined) reaches a default — and the wrapper pins that to UTC.
      expect(() =>
        inSES(
          `new Date(${T}).toLocaleDateString("en-US", { timeZone: "Not/AZone" })`,
        )
      ).toThrow(RangeError);
      // undefined = omitted → pinned UTC; null is an explicit invalid value
      // and throws natively — the wrapper preserves that.
      expect(
        inSES(
          `new Date(${T}).toLocaleDateString("en-US", { timeZone: undefined })`,
        ),
      ).toBe("7/11/2025");
      expect(() =>
        inSES(
          `new Date(${T}).toLocaleDateString("en-US", { timeZone: null })`,
        )
      ).toThrow(RangeError);
    });
  });

  describe("locale argument handling (no leak, no lost behavior)", () => {
    it("honors an array-LIKE locale list, not just real arrays", () => {
      // ECMA-402 CanonicalizeLocaleList accepts array-likes; treating one as a
      // single tag would ToString it to "[object Object]" and throw.
      expect(
        inSES(`(1234.5).toLocaleString({ 0: "de-DE", length: 1 })`),
      ).toBe("1.234,5");
    });
  });

  describe("Date options fail closed on non-plain shapes (host-zone leak defense)", () => {
    // T2 straddles a day boundary: 2025-07-10T23:30:00Z is 7/10 in UTC but
    // 7/11 in Europe/Berlin — so a host-zone leak (Berlin) would show as a
    // different DATE than the pinned UTC. Under native semantics every rejected
    // shape below formats in the host zone (V8 boxes primitives and accepts
    // functions / objects with an absent timeZone), so the wrapper throws.
    const T2 = 1752190200000;

    it("throws on a primitive options value (native would box it → host zone)", () => {
      expect(() => inSES(`new Date(${T2}).toLocaleDateString("en-US", 42)`))
        .toThrow(TypeError);
      expect(() => inSES(`new Date(${T2}).toLocaleDateString("en-US", "x")`))
        .toThrow(TypeError);
    });

    it("throws on a function options value (a function is an object → host zone)", () => {
      expect(() =>
        inSES(`new Date(${T2}).toLocaleDateString("en-US", () => {})`)
      ).toThrow(TypeError);
    });

    it("throws on null options (native throws too; kept consistent)", () => {
      expect(() => inSES(`new Date(${T2}).toLocaleDateString("en-US", null)`))
        .toThrow(TypeError);
    });

    it("throws on a timeZone getter rather than reading it", () => {
      expect(() =>
        inSES(
          `new Date(${T2}).toLocaleDateString("en-US", { get timeZone() { return "America/New_York"; } })`,
        )
      ).toThrow(TypeError);
    });

    it("throws on an inherited (non-own) timeZone", () => {
      expect(() =>
        inSES(
          `new Date(${T2}).toLocaleDateString("en-US", Object.create({ timeZone: "America/New_York" }))`,
        )
      ).toThrow(TypeError);
    });

    it("still accepts a plain object with an own data timeZone (or none)", () => {
      // Regression guard: the fail-closed checks must not reject the ONLY
      // options shape real patterns use.
      expect(
        inSES(
          `new Date(${T2}).toLocaleDateString("en-US", { timeZone: "America/New_York" })`,
        ),
      ).toBe("7/10/2025");
      expect(inSES(`new Date(${T2}).toLocaleDateString("en-US", {})`)).toBe(
        "7/10/2025", // no timeZone → pinned UTC → 7/10
      );
    });
  });

  describe("Intl is absent from the compartment", () => {
    it("exposes no Intl object — resolvedOptions().timeZone is unreachable", () => {
      // The toLocale* methods format via the engine's INTERNAL Intl; the
      // compartment global `Intl` is not installed, so the classic host-zone
      // read `new Intl.DateTimeFormat().resolvedOptions().timeZone` throws
      // rather than returning the host zone.
      expect(inSES(`typeof Intl`)).toBe("undefined");
      expect(() =>
        inSES(`new Intl.DateTimeFormat().resolvedOptions().timeZone`)
      ).toThrow();
    });
  });

  describe("delegating methods", () => {
    it("Array.prototype.toLocaleString reaches the sanitized element methods", () => {
      expect(inSES(`[1234.5, new Date(${T})].toLocaleString()`)).toMatch(
        /^1,234\.5,7\/11\/2025, 12:00:00[\s ]AM$/,
      );
    });
  });
});
