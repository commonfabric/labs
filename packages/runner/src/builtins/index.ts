import type {
  BuiltInAgentParams,
  BuiltInGenerateObjectParams,
  BuiltInGenerateTextParams,
} from "@commonfabric/api";

import type { Cell } from "../cell.ts";
import { raw } from "../module.ts";
import type { Runtime } from "../runtime.ts";
import { agent } from "./agent.ts";
import { aggregate, aggregateNode } from "./aggregate.ts";
import { cellFromUrl } from "./cell-from-url.ts";
import { collectionIndex } from "./collection-index.ts";
import { collectionIndexKeys } from "./collection-index-keys.ts";
import { collectionIndexMember } from "./collection-index-member.ts";
import { compileAndRun } from "./compile-and-run.ts";
import { fetchProgram } from "./fetch-program.ts";
import {
  fetchBinary,
  fetchJson,
  fetchJsonUnchecked,
  fetchText,
} from "./fetch.ts";
import { filter } from "./filter.ts";
import { flatMap } from "./flatmap.ts";
import { IF_ELSE_ARGUMENT_SCHEMA, ifElse } from "./if-else.ts";
import { inspectConfLabel } from "./inspect-conf-label.ts";
import { llmDialog } from "./llm-dialog.ts";
import { generateObject, generateText, llm } from "./llm.ts";
import { map } from "./map.ts";
import { navigateTo } from "./navigate-to.ts";
import { sqliteDatabase, sqliteQuery } from "./sqlite-builtins.ts";
import { str, STR_ARGUMENT_SCHEMA } from "./str.ts";
import { streamData } from "./stream-data.ts";
import { unless } from "./unless.ts";
import { when } from "./when.ts";
import { wish } from "./wish.ts";

const WISH_DEBOUNCE_MS = 50;

/**
 * Register all built-in modules with a runtime's module registry
 *
 * NOTE: Keep `builder/builtin-replayability.ts` in sync with these
 * registrations. At pattern-build time these runtime registrations are
 * invisible — builtins are just string names — and the computed-cell
 * classifier trusts only names listed there as replayable (unknown names
 * fail strict). When adding a builtin here, record it there: in
 * `REPLAYABLE_BUILTIN_REFS` if replaying the node deterministically
 * reproduces its writes, otherwise in the documented non-replayable list.
 */
export function registerBuiltins(runtime: Runtime) {
  const moduleRegistry = runtime.moduleRegistry;

  moduleRegistry.addModuleByRef("cellFromUrl", raw(cellFromUrl));
  moduleRegistry.addModuleByRef("aggregate", raw(aggregate));
  moduleRegistry.addModuleByRef("collectionIndex", raw(collectionIndex));
  moduleRegistry.addModuleByRef(
    "collectionIndexKeys",
    raw(collectionIndexKeys),
  );
  moduleRegistry.addModuleByRef("aggregateNode", raw(aggregateNode));
  moduleRegistry.addModuleByRef(
    "collectionIndexMember",
    raw(collectionIndexMember),
  );
  moduleRegistry.addModuleByRef("map", raw(map));
  moduleRegistry.addModuleByRef("filter", raw(filter));
  moduleRegistry.addModuleByRef("flatMap", raw(flatMap));
  moduleRegistry.addModuleByRef("fetchBinary", raw(fetchBinary));
  moduleRegistry.addModuleByRef("fetchText", raw(fetchText));
  moduleRegistry.addModuleByRef("fetchJson", raw(fetchJson));
  moduleRegistry.addModuleByRef(
    "fetchJsonUnchecked",
    raw(fetchJsonUnchecked),
  );
  moduleRegistry.addModuleByRef("fetchProgram", raw(fetchProgram));
  moduleRegistry.addModuleByRef("streamData", raw(streamData));
  moduleRegistry.addModuleByRef("llm", raw(llm));
  moduleRegistry.addModuleByRef("llmDialog", raw(llmDialog));
  moduleRegistry.addModuleByRef(
    "ifElse",
    raw(ifElse, { argumentSchema: IF_ELSE_ARGUMENT_SCHEMA }),
  );
  moduleRegistry.addModuleByRef(
    "str",
    raw(str, { argumentSchema: STR_ARGUMENT_SCHEMA }),
  );
  moduleRegistry.addModuleByRef("when", raw(when));
  moduleRegistry.addModuleByRef("unless", raw(unless));
  moduleRegistry.addModuleByRef("compileAndRun", raw(compileAndRun));
  moduleRegistry.addModuleByRef("sqliteDatabase", raw(sqliteDatabase));
  // sqliteQuery re-runs when its `reactOn` input changes. (Writes are the
  // imperative SqliteDb.exec, folded into the caller's commit — not a builtin
  // node.)
  moduleRegistry.addModuleByRef("sqliteQuery", raw(sqliteQuery));
  moduleRegistry.addModuleByRef(
    "generateObject",
    raw<BuiltInGenerateObjectParams, {
      pending: Cell<boolean>;
      result: Cell<Record<string, unknown> | undefined>;
      error: Cell<string | undefined>;
      partial: Cell<string | undefined>;
      requestHash: Cell<string | undefined>;
    }>(generateObject),
  );
  moduleRegistry.addModuleByRef(
    "generateText",
    raw<BuiltInGenerateTextParams, {
      pending: Cell<boolean>;
      result: Cell<string | undefined>;
      error: Cell<string | undefined>;
      partial: Cell<string | undefined>;
      requestHash: Cell<string | undefined>;
    }>(generateText),
  );
  // `agent` stages a sink request and creates its run record after commit;
  // the result cell derives from that record, so it is scheduled as a
  // computation and effectful only through the outbox, like `generateObject`.
  moduleRegistry.addModuleByRef(
    "agent",
    raw<BuiltInAgentParams, {
      pending: Cell<boolean>;
      result: Cell<unknown>;
      error: Cell<string | undefined>;
      requestHash: Cell<string | undefined>;
      run: Cell<unknown>;
    }>(agent),
  );
  moduleRegistry.addModuleByRef(
    "navigateTo",
    raw(navigateTo),
  );
  // inv-12 Stage 2 (spec §4.6.4.1): the bounded label-introspection surface.
  // Pure read/derive/write — not an effect; reactivity comes from its
  // journaled input + envelope reads.
  moduleRegistry.addModuleByRef("inspectConfLabel", raw(inspectConfLabel));
  moduleRegistry.addModuleByRef(
    "wish",
    raw(wish, { debounce: WISH_DEBOUNCE_MS }),
  );
}
