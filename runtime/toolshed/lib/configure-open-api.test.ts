import { assert, assertEquals } from "@std/assert";

import env from "@/env.ts";
import app from "@/app.ts";
import { createRouter } from "@/lib/create-app.ts";
import configureOpenAPI from "@/lib/configure-open-api.ts";
import { DESCRIPTORS } from "@/routes/integrations/provider-registry.ts";
import { createOAuth2Routes } from "@/routes/integrations/oauth2-common/oauth2-common.routes.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

Deno.test("openapi reference", async (t) => {
  // `@/app.ts` is the app the server serves: `configureOpenAPI` plus every
  // router. The document is generated per request from the schemas of the
  // routes mounted on it.

  await t.step("GET /doc serves the OpenAPI document", async () => {
    const response = await app.request("/doc");
    assertEquals(response.status, 200);

    const json = await response.json();
    assertEquals(json.openapi, "3.0.0");
    assertEquals(json.info.title, "Toolshed API");
  });

  await t.step("the document covers the mounted routes", async () => {
    // Generation walks the schemas of the mounted routes, so these four paths,
    // from four separate routers, stand as evidence that the walk reached real
    // route schemas and not an empty app.

    const doc = await (await app.request("/doc")).json();

    for (
      const path of [
        "/_health",
        "/api/ai/llm",
        "/api/storage/memory",
        "/api/whoami",
      ]
    ) {
      assert(path in doc.paths, `${path} is missing from the document`);
    }
  });

  await t.step("the OAuth2 provider route schemas serialize", async () => {
    // `buildProviderRouters` mounts an OAuth2 provider only when that
    // provider's credentials are set, and the test environment sets none, so
    // the app above carries no provider paths. A deployment that configures
    // them generates a document from these schemas too. Registering the route
    // definitions against a throwaway router puts them through the generator
    // here, without the credentials — and the network calls — that mounting
    // them for real needs.

    const probe = createRouter();
    configureOpenAPI(probe);

    for (const descriptor of DESCRIPTORS) {
      for (const route of Object.values(createOAuth2Routes(descriptor.name))) {
        probe.openapi(route, (c) => c.json({}, 200) as never);
      }
    }

    const response = await probe.request("/doc");
    assertEquals(response.status, 200);

    const doc = await response.json();
    for (const descriptor of DESCRIPTORS) {
      const path = `/api/integrations/${descriptor.name}-oauth/login`;
      assert(path in doc.paths, `${path} is missing from the document`);
    }
  });

  await t.step("the streamed LLM response is described", async () => {
    // `POST /api/ai/llm` answers with JSON or with a stream depending on the
    // request's `stream` flag. The streamed body is UTF-8 text carrying one
    // JSON event per line, which the document states as a string with a
    // description.

    const doc = await (await app.request("/doc")).json();
    const content = doc.paths["/api/ai/llm"].post.responses["200"].content;

    assertEquals(Object.keys(content).sort(), [
      "application/json",
      "text/event-stream",
    ]);

    const streamed = content["text/event-stream"].schema;
    assertEquals(streamed.type, "string");
    assert(
      streamed.description.includes("Newline-delimited JSON events"),
      `the streamed body is undescribed: ${JSON.stringify(streamed)}`,
    );
  });

  await t.step("the JSON LLM response is the bare message", async () => {
    // The non-streaming branch answers with the reply message written straight
    // to the response body, which the handler produces with
    // `c.json(result.message)`: an object carrying a `role` and its `content`.
    // The document describes that message, not a `{type, body}` envelope
    // wrapped around it.

    const doc = await (await app.request("/doc")).json();
    const schema = doc.paths["/api/ai/llm"].post.responses["200"]
      .content["application/json"].schema;

    assertEquals(schema.type, "object");
    assertEquals([...schema.required].sort(), ["content", "role"]);
    assert(
      schema.properties.role.enum.includes("assistant"),
      `the message role is undescribed: ${
        JSON.stringify(schema.properties.role)
      }`,
    );
    assert(
      !("type" in schema.properties) && !("body" in schema.properties),
      `the response carries an envelope: ${
        JSON.stringify(Object.keys(schema.properties))
      }`,
    );
  });

  await t.step(
    "query parameters are documented under `parameters`",
    async () => {
      // A route that declares its query parameters through the top-level
      // `query` key instead of `request.query` slips that key past
      // `createRoute`, which copies it verbatim into the Operation Object and
      // serializes the zod schema's internals under it. Correctly declared
      // query parameters land in the Operation's `parameters` array instead.
      // These two routes carry query parameters and stand for that whole class.

      const doc = await (await app.request("/doc")).json();

      for (
        const [path, params] of [
          ["/api/ai/img", ["prompt", "width", "height"]],
          ["/api/ai/llm/models", ["search", "capability", "task"]],
        ] as const
      ) {
        const operation = doc.paths[path].get;
        assert(
          !("query" in operation),
          `${path} carries a raw \`query\` key: ${
            JSON.stringify(operation.query)
          }`,
        );

        const documented = (operation.parameters ?? [])
          .filter((p: { in: string }) => p.in === "query")
          .map((p: { name: string }) => p.name)
          .sort();
        assertEquals(
          documented,
          [...params].sort(),
          `${path} does not document its query parameters`,
        );
      }
    },
  );

  await t.step("the document carries no raw zod internals", async () => {
    // A zod schema handed to a place the generator does not recognize is copied
    // into the document verbatim, and serializing it dumps the library's
    // internal fields — `def`/`_def` (the schema definition), `_zod` and
    // `~standard` (the instance handles), `_cached` — into the output. None of
    // those are OpenAPI keys, so finding one anywhere in the document marks a
    // leaked schema.

    const doc = await (await app.request("/doc")).json();

    const forbidden = new Set(["def", "_def", "_zod", "~standard", "_cached"]);
    const leaks: string[] = [];
    const scan = (value: unknown, path: string) => {
      if (Array.isArray(value)) {
        value.forEach((item, i) => scan(item, `${path}[${i}]`));
      } else if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          if (forbidden.has(key)) leaks.push(`${path}.${key}`);
          scan(child, `${path}.${key}`);
        }
      }
    };
    scan(doc, "$");

    assertEquals(
      leaks,
      [],
      `the document leaks zod internals at: ${leaks.join(", ")}`,
    );
  });

  await t.step(
    "GET /reference points at a document the app serves",
    async () => {
      // Scalar renders the configuration it is handed into the page without
      // validating it, serializing an unknown key as readily as a known one.
      // The document URL is read back out of the page and fetched, so the two
      // routes are checked against each other rather than against a repeated
      // literal.

      const response = await app.request("/reference");
      assertEquals(response.status, 200);

      const html = await response.text();
      const match = html.match(/createApiReference\([^,]*,\s*(\{[\s\S]*?\})\)/);
      assert(match, "no Scalar configuration rendered into /reference");

      const config = JSON.parse(match[1]);
      assert(
        typeof config.url === "string",
        `Scalar carries the document URL under 'url'; got: ${match[1]}`,
      );
      assertEquals((await app.request(config.url)).status, 200);
    },
  );
});
