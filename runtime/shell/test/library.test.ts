import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import * as library from "../src/library.ts";
import * as identity from "@commonfabric/identity";
import * as runtime from "@commonfabric/lib-shell/runtime";
import * as credentials from "@commonfabric/lib-shell/credentials";
import * as runtimeClient from "@commonfabric/runtime-client";
import * as webWorker from "@commonfabric/runtime-client/transports/web-worker";
import * as messagePort from "@commonfabric/runtime-client/transports/message-port";
import * as slugs from "@commonfabric/runner/slugs";
import * as schemas from "@commonfabric/runner/schemas";
import * as httpAuth from "@commonfabric/runner/toolshed-http-auth";
import * as cellReference from "@commonfabric/runner/cell-reference";
import * as homeSchemas from "@commonfabric/home-schemas";
import * as cellRep from "@commonfabric/data-model/cell-rep";
import * as codecs from "@commonfabric/data-model/codecs";
import * as fabricInstances from "@commonfabric/data-model/fabric-instances";
import * as runtimeContext from "@commonfabric/ui/runtime-context";

describe("library", () => {
  // The bundle built from `library.ts` is the API an embedding host loads
  // beside the worker, so each name it exports has to be the declaring
  // module's own object: a copy would be a second class identity, which an
  // `instanceof` across the two would not recognize.

  /** Each name the library exports, with the module that declares it. */
  const sources: Record<string, Record<string, unknown>> = {
    createSession: identity,
    Identity: identity,
    KeyStore: identity,
    createRuntimeClientOptions: runtime,
    resolveSpaceDid: runtime,
    resolveWorkerUrl: runtime,
    RuntimeInternals: runtime,
    createKeyFileCredential: credentials,
    saveCredential: credentials,
    attachOptionsFrom: runtimeClient,
    isCellHandle: runtimeClient,
    observeAuthorship: runtimeClient,
    RuntimeClient: runtimeClient,
    WebWorkerRuntimeTransport: webWorker,
    MessagePortRuntimeTransport: messagePort,
    slugIdForSpace: slugs,
    rendererVDOMSchema: schemas,
    signFirstPartyHttpRequest: httpAuth,
    siteTableCause: homeSchemas,
    siteTableSchema: homeSchemas,
    linkRefPayload: cellRep,
    fabricFromJsonValue: codecs,
    jsonFromFabricValue: codecs,
    FabricLink: fabricInstances,
    runtimeContext: runtimeContext,
    spaceContext: runtimeContext,
    renderCellReference: cellReference,
  } satisfies Record<keyof typeof library, Record<string, unknown>>;

  it("exports exactly the names of its contract", () => {
    expect(Object.keys(library).sort()).toEqual(Object.keys(sources).sort());
  });

  it("exports each name as the declaring module's own object", () => {
    const copies = Object.entries(library)
      .filter(([name, value]) => value !== sources[name]?.[name])
      .map(([name]) => name);

    expect(copies).toEqual([]);
  });

  it("leaves out the shell's own credential and build helpers", () => {
    expect("clearStoredCredential" in library).toBe(false);
    expect("fetchBuildHash" in library).toBe(false);
    expect("clearStoredCredential" in credentials).toBe(true);
  });
});
