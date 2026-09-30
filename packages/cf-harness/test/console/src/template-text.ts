/** Reads Lit templates for assertions without executing event handlers. */

import type { TemplateResult } from "lit";

/** Flattens literal text and nested templates, ignoring non-text values. */
export const templateText = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(templateText).join("");
  if (typeof value !== "object") return "";
  const template = value as Partial<TemplateResult>;
  return (template.strings ?? []).map((part, index) =>
    part + templateText(template.values?.[index])
  ).join("");
};
