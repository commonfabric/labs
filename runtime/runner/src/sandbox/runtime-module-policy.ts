import { parseFabricRef } from "./fabric-import-specifier.ts";

export type RuntimeModuleIdentifier =
  | "commonfabric"
  | "commonfabric/cfc"
  | "commonfabric/schema"
  | "turndown";

export const RuntimeModuleIdentifiers = [
  "commonfabric",
  "commonfabric/cfc",
  "commonfabric/schema",
  "turndown",
] as const satisfies readonly RuntimeModuleIdentifier[];

const RuntimeModuleIdentifierSet = new Set<string>(RuntimeModuleIdentifiers);
const ALLOWED_LOCAL_IMPORT_PREFIXES = ["./", "../", "/"] as const;

export function isRuntimeModuleIdentifier(
  value: unknown,
): value is RuntimeModuleIdentifier {
  return typeof value === "string" && RuntimeModuleIdentifierSet.has(value);
}

export function isAllowedAuthoredImportSpecifier(specifier: string): boolean {
  if (specifier.startsWith("cf:")) {
    try {
      return parseFabricRef(specifier) !== undefined;
    } catch {
      return false;
    }
  }
  return isRuntimeModuleIdentifier(specifier) ||
    ALLOWED_LOCAL_IMPORT_PREFIXES.some((prefix) =>
      specifier.startsWith(prefix)
    );
}
