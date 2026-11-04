import { hashOf } from "@commonfabric/data-model";
import { stableFabricValue } from "./stable-fabric-value.ts";

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

export function canonicalJson(value: unknown): string {
  const jsonSafe = JSON.parse(JSON.stringify(value)) as unknown;
  return JSON.stringify(sortJson(jsonSafe));
}

export function hashFabricValue(value: unknown): string {
  const digest = hashOf(stableFabricValue(value)).bytes;
  const hex = [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}
