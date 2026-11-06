/** Plain-language rendering of a reviewed snapshot for the trusted dialog. */

import type { JSONValue } from "@commonfabric/runtime-client";

/**
 * One line of a reviewed value. `key` is the field's name exactly as
 * stored: the pattern chose it, so the dialog shows it as data, never as
 * prose. `empty` marks a value with nothing in it, which the dialog names
 * in its own words and style, so a string that merely reads "(blank)" is
 * not mistaken for one. `children` holds a nested object or list.
 */
export interface SnapshotLine {
  key: string;
  text: string;
  empty: boolean;
  children?: SnapshotLine[];
}

/** A leaf value as text, and whether it holds nothing. Empty values are
 * named, never dropped, so every reviewed field stays visible. */
function leaf(value: JSONValue): { text: string; empty: boolean } {
  if (value === null) return { text: "none", empty: true };
  if (value === "") return { text: "blank", empty: true };
  if (typeof value === "string" && value.trim() === "") {
    return { text: `only spaces (${value.length})`, empty: true };
  }
  return { text: String(value), empty: false };
}

function isRecord(value: JSONValue): value is { [key: string]: JSONValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One field as a line; objects and non-empty lists nest, one line per
 * entry, so no two values can read as one. */
function line(key: string, value: JSONValue): SnapshotLine {
  if (isRecord(value)) {
    if (Object.keys(value).length === 0) {
      return { key, text: "none", empty: true };
    }
    return { key, text: "", empty: false, children: snapshotLines(value) };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return { key, text: "none", empty: true };
    return {
      key,
      text: "",
      empty: false,
      children: value.map((item, i) => line(`${i}`, item)),
    };
  }
  return { key, ...leaf(value) };
}

/** Every field of a reviewed value as lines, in the order JSON gives them
 * (number-like keys first, as in the exact data). A value
 * that is not an object reads as one line with an empty key. */
export function snapshotLines(value: JSONValue): SnapshotLine[] {
  if (isRecord(value)) {
    return Object.entries(value).map(([key, item]) => line(key, item));
  }
  return [line("", value)];
}

/** Who a verified audience atom names, in words. */
export function audienceWords(audience: JSONValue): string {
  const type = isRecord(audience) && typeof audience.type === "string"
    ? audience.type
    : "";
  if (type.endsWith("/User")) return "One verified person";
  if (type.endsWith("/Space")) return "Everyone in one verified space";
  return "A verified audience";
}

/** The DID a verified audience atom names, or "" when it names none. */
export function audienceId(audience: JSONValue): string {
  return isRecord(audience) && typeof audience.subject === "string"
    ? audience.subject
    : "";
}
