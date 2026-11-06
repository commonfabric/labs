/** Plain-language rendering of a reviewed snapshot for the trusted dialog. */

import type { JSONValue } from "@commonfabric/runtime-client";

/** One labelled line of a reviewed value; `children` holds a nested object. */
export interface SnapshotLine {
  label: string;
  text: string;
  children?: SnapshotLine[];
}

/** A field name as words: `plusOne` and `plus_one` both read "Plus one". */
export function fieldLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words === "" ? key : words[0].toUpperCase() + words.slice(1);
}

/** A leaf value in words. Empty values are named, never dropped, so every
 * reviewed field stays visible. */
function leafText(value: JSONValue): string {
  if (value === null) return "(none)";
  if (typeof value === "string") return value === "" ? "(blank)" : value;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function isRecord(value: JSONValue): value is { [key: string]: JSONValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One field as a line: lists of plain values join with commas, objects and
 * lists of objects nest. */
function line(label: string, value: JSONValue): SnapshotLine {
  if (isRecord(value)) {
    return { label, text: "", children: snapshotLines(value) };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return { label, text: "(none)" };
    if (value.some((item) => isRecord(item) || Array.isArray(item))) {
      return {
        label,
        text: "",
        children: value.map((item, i) => line(`${i + 1}`, item)),
      };
    }
    return { label, text: value.map(leafText).join(", ") };
  }
  return { label, text: leafText(value) };
}

/** Every field of a reviewed value as labelled lines, in stored order. A
 * value that is not an object reads as one line. */
export function snapshotLines(value: JSONValue): SnapshotLine[] {
  if (isRecord(value)) {
    return Object.entries(value).map(([key, item]) =>
      line(fieldLabel(key), item)
    );
  }
  return [line("Value", value)];
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
