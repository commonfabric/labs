import * as cfcModule from "@commonfabric/api/cfc-authoring";
import type { StaticCache } from "@commonfabric/static";
import turndown from "turndown";

import { createBuilder } from "../builder/factory.ts";
import { freezeSandboxValue } from "./hardening.ts";
export type { RuntimeModuleIdentifier } from "./runtime-module-policy.ts";
export {
  isRuntimeModuleIdentifier,
  RuntimeModuleIdentifiers,
} from "./runtime-module-policy.ts";

export const getRuntimeModuleTypes = (() => {
  let depTypes:
    | Record<string, string>
    | undefined;
  return async (cache: StaticCache) => {
    if (depTypes) {
      return depTypes;
    }
    const builderTypes = await cache.getText("types/commonfabric.d.ts");
    const cfcTypes = await cache.getText("types/cfc.ts");
    const schemaTypes = await cache.getText("types/commonfabric-schema.d.ts");
    depTypes = {
      "commonfabric": builderTypes,
      "commonfabric/cfc": cfcTypes,
      "commonfabric/schema": schemaTypes,
      "commontools": builderTypes,
      "commontools/schema": schemaTypes,
      "turndown": await cache.getText("types/turndown.d.ts"),
      "@commontools/html": builderTypes,
      "@commontools/builder": builderTypes,
      "@commontools/runner": builderTypes,
      "cfc.ts": cfcTypes,
    };
    return depTypes;
  };
})();

export function getRuntimeModuleExports() {
  const { commonfabric, exportsCallback } = createBuilder();
  const commontools = commonfabric;
  const runtimeExports = freezeSandboxValue({
    "commonfabric": commonfabric,
    "commonfabric/cfc": { ...cfcModule },
    // commonfabric/schema only exports types, no runtime values needed
    "commonfabric/schema": {},
    "commontools": commontools,
    // commontools/schema only exports types, no runtime values needed
    "commontools/schema": {},
    // __esModule marks this namespace as ESM-shaped, so an importer compiled
    // with esModuleInterop (`__importDefault`) reads `default` rather than
    // wrapping the whole namespace.
    "turndown": { default: turndown, __esModule: true },
    "@commontools/html": commontools,
    "@commontools/builder": commontools,
    "@commontools/runner": commontools,
  });

  return {
    runtimeExports,
    exportsCallback,
  };
}
