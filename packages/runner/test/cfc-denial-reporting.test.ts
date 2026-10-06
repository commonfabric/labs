import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cfcAtom } from "@commonfabric/api/cfc";
import { internSchema } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/utils/logger";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { resetCfcDenialAnnouncements } from "../src/cfc/denial-report.ts";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";
import { enqueueSinkRequestPostCommitEffect } from "../src/cfc/sink-request.ts";
import type { CfcEnforcementMode } from "../src/cfc/types.ts";
import type { JSONSchema, Pattern } from "../src/builder/types.ts";
import { seedStoredEnvelope } from "./cfc-seed-envelope.ts";

// The write gate says what it turned away, on the logger, without being asked.
// Two refusals appear below. A `writeAuthorizedBy` field written by a setup
// constant that carries no writer identity is the smallest one. A labeled read
// feeding a `fetchJson` sink request whose ceiling excludes the label is the
// one whose prepare reason names a confidentiality atom, which is what the
// headline may not carry.

const signer = await Identity.fromPassphrase("runner-cfc-denial-reporting");

const HEADLINE = "a policy check refused the commit";

/** The atom the sink ceiling below will not admit. Its id appears nowhere else. */
const SECRET_SPACE = cfcAtom.space("space:the-acquisition-of-Acme");
const SECRET_SPACE_ID = "the-acquisition-of-Acme";
const SINK_CEILING = cfcAtom.user("did:key:alice");

const resultSchema = {
  type: "object",
  properties: {
    savedTitle: {
      type: "string",
      ifc: {
        writeAuthorizedBy: {
          __ctWriterIdentityOf: {
            file: "/main.tsx",
            path: ["commitTrustedSaveTitle"],
          },
        },
      },
    },
  },
  required: ["savedTitle"],
} as const satisfies JSONSchema;

const unauthorizedPattern = {
  argumentSchema: { type: "object", properties: {} } as const,
  resultSchema,
  result: { savedTitle: "not user authorized" },
  nodes: [],
} satisfies Pattern;

const SECRET_SCHEMA = internSchema(
  {
    type: "object",
    properties: {
      secret: { type: "string", ifc: { confidentiality: ["never-fits"] } },
    },
    required: ["secret"],
  } satisfies JSONSchema,
  true,
);

/**
 * Everything written to the console while `body` runs. `debug` raises the
 * `cfc` logger to the level a developer turns on to see a denial's inputs.
 */
const capturing = async (
  body: () => Promise<void> | void,
  options: { debug?: boolean } = {},
): Promise<string> => {
  const logger = getLogger("cfc");
  const level = logger.level;
  const stderrRoute = Deno.env.get("LOG_TO_STDERR");
  Deno.env.set("LOG_TO_STDERR", "0");
  const real = globalThis.console;
  const lines: string[] = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.map((arg) => JSON.stringify(arg) ?? "").join(" "));
  };
  globalThis.console = {
    ...real,
    warn: capture,
    error: capture,
    info: capture,
    log: capture,
    debug: capture,
  } as Console;
  logger.level = options.debug ? "debug" : "info";
  resetCfcDenialAnnouncements();
  try {
    await body();
  } finally {
    globalThis.console = real;
    if (stderrRoute === undefined) Deno.env.delete("LOG_TO_STDERR");
    else Deno.env.set("LOG_TO_STDERR", stderrRoute);
    logger.level = level;
  }
  return lines.join("\n");
};

/** A runtime whose `fetchJson` ceiling admits one user atom and nothing else. */
const withRuntime = async (
  mode: CfcEnforcementMode,
  body: (runtime: Runtime) => Promise<void> | void,
): Promise<void> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcEnforcementMode: mode,
    cfcSinkMaxConfidentiality: { fetchJson: [SINK_CEILING] },
    trustSnapshotProvider: () => ({
      id: "trust-snapshot-denial-reporting",
      actingPrincipal: signer.did(),
    }),
  });
  try {
    await body(runtime);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

/** Seed a cell whose stored label carries the atom the sink ceiling excludes. */
const seedSecret = async (runtime: Runtime, id: string): Promise<void> => {
  const seed = runtime.edit();
  const target = runtime.getCell(signer.did(), id, undefined, seed);
  seedStoredEnvelope(seed, {
    space: signer.did(),
    scope: "space",
    id: target.getAsNormalizedFullLink().id,
    path: [],
  }, {
    value: { secret: "rosebud" },
    cfc: {
      version: 1,
      schemaHash: SECRET_SCHEMA.taggedHashString,
      labelMap: {
        version: 1,
        entries: [{
          path: ["secret"],
          label: { confidentiality: [SECRET_SPACE] },
        }],
      },
    },
  });
  seed.writeOrThrow({
    space: signer.did(),
    scope: "space",
    id: `cid:${SECRET_SCHEMA.taggedHashString}`,
    path: [],
  }, { value: SECRET_SCHEMA.schema });
  expect((await seed.commit().settled).ok).toBeDefined();
};

/**
 * Read the labeled cell into a `fetchJson` sink request and prepare, which is
 * where the gate decides. The transaction is abandoned rather than committed,
 * the shape a caller takes when it sees prepare refuse.
 */
const readThenSinkThenAbort = (runtime: Runtime, id: string): void => {
  const tx = runtime.edit();
  const cell = runtime.getCell(signer.did(), id, SECRET_SCHEMA.schema, tx);
  expect(cell.key("secret").get()).toBe("rosebud");
  enqueueSinkRequestPostCommitEffect(
    tx,
    "fetchJson",
    `fetchJson:${id}`,
    createFrozenRequestSnapshot({ url: "https://example.com/exfil" }),
    "fetchJson-start",
    () => {},
  );
  tx.prepareCfc();
  expect(tx.getCfcState().prepare.status).toBe("invalidated");
  tx.abort();
};

/** Run the refused setup under one enforcement mode. */
const refusedSetup = (mode: CfcEnforcementMode, name: string) => async () => {
  await withRuntime(mode, async (runtime) => {
    const resultCell = runtime.getCell(signer.did(), name, resultSchema);
    try {
      await runtime.setup(undefined, unauthorizedPattern, {}, resultCell);
    } catch {
      // The refusal is the subject; what it said is the assertion.
    }
  });
};

describe("cfc-denial-reporting", () => {
  describe("the write gate", () => {
    it("names the kind of decision without being asked", async () => {
      const said = await capturing(
        refusedSetup("enforce-explicit", "denial-headline"),
      );
      expect(said).toContain(HEADLINE);
    });

    it("keeps the prepare reason out of what it says by default", async () => {
      const said = await capturing(
        refusedSetup("enforce-explicit", "denial-reason-hidden"),
      );
      expect(said).not.toContain("writeAuthorizedBy");
    });

    it("names the reasons and the dials once raised to debug", async () => {
      const said = await capturing(
        refusedSetup("enforce-explicit", "denial-debug"),
        { debug: true },
      );
      expect(said).toContain("writeAuthorizedBy");
      expect(said).toContain("enforce-explicit");
    });

    // The property the split exists for. A sink-ceiling reason renders the
    // atoms it refused over as JSON, so this is the refusal whose reason
    // carries a confidentiality label rather than only a schema path.
    it("keeps a refused confidentiality atom out of what it says by default", async () => {
      const said = await capturing(async () => {
        await withRuntime("enforce-explicit", async (runtime) => {
          await seedSecret(runtime, "denial-sink-default");
          readThenSinkThenAbort(runtime, "denial-sink-default");
        });
      });
      expect(said).toContain(HEADLINE);
      expect(said).not.toContain(SECRET_SPACE_ID);
    });

    it("names the refused confidentiality atom once raised to debug", async () => {
      const said = await capturing(async () => {
        await withRuntime("enforce-explicit", async (runtime) => {
          await seedSecret(runtime, "denial-sink-debug");
          readThenSinkThenAbort(runtime, "denial-sink-debug");
        });
      }, { debug: true });
      expect(said).toContain(SECRET_SPACE_ID);
    });

    // A caller that sees prepare refuse abandons the transaction, so the
    // commit that would otherwise report never runs.
    it("reports a prepare that refuses a transaction never offered for commit", async () => {
      const said = await capturing(async () => {
        await withRuntime("enforce-explicit", async (runtime) => {
          await seedSecret(runtime, "denial-prepare-only");
          readThenSinkThenAbort(runtime, "denial-prepare-only");
        });
      });
      expect(said).toContain(HEADLINE);
    });

    it("announces one kind of decision once however often it recurs", async () => {
      const said = await capturing(async () => {
        await withRuntime("enforce-explicit", async (runtime) => {
          await seedSecret(runtime, "denial-repeat");
          for (let attempt = 0; attempt < 5; attempt++) {
            readThenSinkThenAbort(runtime, "denial-repeat");
          }
        });
      });
      expect(said.split(HEADLINE).length - 1).toBe(1);
    });

    it("says nothing for a decision that stopped nothing", async () => {
      // Observe lets the commit through. Nothing was turned away, so there is
      // no denial; the reasons stay on the transaction's diagnostics.
      const said = await capturing(
        refusedSetup("observe", "denial-observe"),
        { debug: true },
      );
      expect(said).not.toContain(HEADLINE);
    });

    it("says nothing for a transaction the gate let through", async () => {
      const plainSchema = {
        type: "object",
        properties: { savedTitle: { type: "string" } },
        required: ["savedTitle"],
      } as const satisfies JSONSchema;
      const said = await capturing(async () => {
        await withRuntime("enforce-explicit", async (runtime) => {
          const resultCell = runtime.getCell(
            signer.did(),
            "denial-clean",
            plainSchema,
          );
          await runtime.setup(
            undefined,
            {
              argumentSchema: { type: "object", properties: {} } as const,
              resultSchema: plainSchema,
              result: { savedTitle: "fine" },
              nodes: [],
            } satisfies Pattern,
            {},
            resultCell,
          );
        });
      }, { debug: true });
      expect(said).not.toContain(HEADLINE);
    });
  });
});
