import { assertEquals } from "@std/assert";
import {
  experimentalOptionsForDeployedClient,
  SERVER_EXPERIMENTAL_PATH,
} from "@commonfabric/runner";
import env from "@/env.ts";
import createApp from "@/lib/create-app.ts";
import { cfcPostureReport } from "@commonfabric/runner/cfc";
import { publishCfcPosture } from "@/lib/cfc-posture.ts";
import { publishExperimentalPosture } from "@/lib/experimental-posture.ts";
import router from "@/routes/meta/meta.index.ts";
import * as routes from "@/routes/meta/meta.routes.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const app = createApp().route("/", router);

Deno.test("meta routes", async (t) => {
  await t.step("GET /api/meta returns 200 with meta status", async () => {
    const response = await app.request("/api/meta");
    assertEquals(response.status, 200);

    const json = await response.json();
    // DID of "./test.key"
    assertEquals(
      json.did,
      "did:key:z6Mkqqy6FetDFSzm3oegQmJEUWrqBpxAZvWrw3xZTyNqJYj9",
    );
    assertEquals(json.gitSha, null);
    // A source run has no compiled marker: the shell's baked
    // server-execution define is unknown (null), like gitSha.
    assertEquals(json.shellServerExecutionDefine, null);
  });

  await t.step(
    "GET /api/meta reports no posture until one is published",
    async () => {
      // The state of a server whose Runtime does not exist yet. Set here
      // rather than assumed: the posture is module state, and another test
      // file in the same process publishes one.
      publishExperimentalPosture(null);
      publishCfcPosture(null);
      const json = await (await app.request("/api/meta")).json();
      assertEquals(json.experimental, null);
      assertEquals(json.cfc, null);
    },
  );

  await t.step(
    "GET /api/meta reports the published CFC posture",
    async () => {
      publishCfcPosture({
        cfcEnforcementMode: "enforce-explicit",
        cfcFlowLabels: "persist",
        cfcWriteFloor: "enforce",
        cfcTriggerReadGating: true,
        cfcDecomposedEnvelopes: false,
        cfcContentAddressedLabels: false,
        cfcPolicyEvaluation: "enforce",
        cfcLabelMetadataProtection: "enforce",
        cfcDeclaredMonotonicity: "enforce",
        cfcPolicySnapshot: { records: [], digest: "digest-1" },
        cfcSinkMaxConfidentiality: { fetchText: [], fetchJson: [] },
      });
      try {
        const json = await (await app.request("/api/meta")).json();
        // The shared record, whole: the route serves what the runner built,
        // so the expectation is that record rather than a second statement of
        // its fields (`packages/runner/test/cfc-posture-report.test.ts` is
        // where the record's own shape is pinned).
        assertEquals(
          json.cfc,
          JSON.parse(JSON.stringify(cfcPostureReport({
            cfcEnforcementMode: "enforce-explicit",
            cfcFlowLabels: "persist",
            cfcWriteFloor: "enforce",
            cfcTriggerReadGating: true,
            cfcDecomposedEnvelopes: false,
            cfcContentAddressedLabels: false,
            cfcPolicyEvaluation: "enforce",
            cfcLabelMetadataProtection: "enforce",
            cfcDeclaredMonotonicity: "enforce",
            cfcPolicySnapshot: { records: [], digest: "digest-1" },
            cfcSinkMaxConfidentiality: { fetchText: [], fetchJson: [] },
          }))),
        );
        // The two properties the route exists to carry, stated here because a
        // reader of this file should not have to derive them: an ungated sink
        // is named rather than absent, and it is published as a deviation.
        assertEquals(json.cfc.sinks.length, 11);
        assertEquals(json.cfc.deviations.length, 4);
      } finally {
        publishCfcPosture(null);
      }
    },
  );

  await t.step(
    "GET /api/meta reports the Runtime's resolved flags",
    async () => {
      publishExperimentalPosture({
        modernCellRep: false,
        serverExecution: true,
      });
      try {
        const json = await (await app.request("/api/meta")).json();
        assertEquals(json.experimental, {
          modernCellRep: false,
          serverExecution: true,
        });
      } finally {
        publishExperimentalPosture(null);
      }
    },
  );

  await t.step("serves the document clients read their posture from", () => {
    // The client half names this path as a constant it cannot see the route
    // from; moving the route without moving the constant would leave every
    // deployed client silently back on its own environment.
    assertEquals(SERVER_EXPERIMENTAL_PATH, routes.index.path);
  });

  await t.step("a client resolves its posture from this response", async () => {
    // The two halves meet only in the shape of this document: the route
    // decides the field, `experimentalOptionsForDeployedClient` reads it, and
    // nothing else would notice one of them renaming it. Driven through the
    // real handler rather than a fixture, for exactly that reason.
    publishExperimentalPosture({
      modernCellRep: true,
      lazyMaterialization: false,
    });
    try {
      const adopted = await experimentalOptionsForDeployedClient({
        apiUrl: new URL("http://toolshed.test"),
        // An explicit override still outranks what the server publishes.
        env: (name) =>
          name === "EXPERIMENTAL_MODERN_CELL_REP" ? "false" : undefined,
        fetch: async (input) =>
          await app.request(new URL(String(input)).pathname),
      });
      // The published posture declares no readerSchemaPrecedence, so the
      // client adopts the legacy strict `false` a pre-flag server runs.
      assertEquals(adopted, {
        modernCellRep: false,
        lazyMaterialization: false,
        readerSchemaPrecedence: false,
      });
    } finally {
      publishExperimentalPosture(null);
    }
  });
});
