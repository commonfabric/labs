import { type StaticCache } from "@commonfabric/static";

// Returns an object mapping typescript lib name
// to a string of standalone .d.ts content.
// Includes the following types:
// * "es2023"
// * "jsx"
// * "dom"
export const getTypeScriptEnvironmentTypes = (() => {
  let cached: Record<string, string> | undefined;
  return async (cache: StaticCache): Promise<Record<string, string>> => {
    if (cached) {
      return cached;
    }
    const es2023 = await cache.getText("types/es2023.d.ts");
    const jsx = await cache.getText("types/jsx.d.ts");
    const dom = await cache.getText("types/dom.d.ts");

    cached = {
      es2023,
      dom,
      jsx,
    };
    return cached;
  };
})();
