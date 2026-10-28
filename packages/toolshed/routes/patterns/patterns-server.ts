import { join } from "@std/path/join";

import {
  PatternsRoute,
  type PatternsRouteOptions,
} from "@commonfabric/runner/patterns-route.deno";
import { CONNECTOR_PATTERN_SOURCES } from "../../../connectors/pattern-sources.ts";

/**
 * The patterns route this deployment serves: the authored patterns tree, plus
 * each connector-owned tree at its stable route prefix.
 *
 * The route itself — its URL prefix, what `?identity` answers, and the caching
 * headers around both — is the runner's, not this route file's. A pattern's
 * content identity folds in each module's authored path, and the worker names
 * modules by their URL pathname (HttpProgramResolver), so an answer that
 * differed from the runner's own would be one no runtime could adopt.
 * `options` carries what the deployment says about all of it, its release
 * time among them.
 */
export function createPatternsRoute(
  options: PatternsRouteOptions = {},
): PatternsRoute {
  const repositoryRoot = join(
    import.meta.dirname || "",
    "..",
    "..",
    "..",
    "..",
  );
  return new PatternsRoute(
    join(repositoryRoot, "packages/patterns"),
    CONNECTOR_PATTERN_SOURCES.map((source) => ({
      routePrefix: `${source.keyPrefix}/`,
      directory: join(repositoryRoot, source.directory),
    })),
    options,
  );
}
