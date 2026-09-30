import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { getTimingStatsBreakdown } from "@commonfabric/utils/logger";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { type JSONSchema, NAME } from "../src/builder/types.ts";
import { wish } from "../src/builtins/wish.ts";
import { useCancelGroup } from "../src/cancel.ts";
import { resolvedSchema } from "./schema-ref-helpers.ts";
import { Runtime } from "../src/runtime.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";

const signer = await Identity.fromPassphrase("wish shared hashtag test");
const space = signer.did();

function schemaForMentionable(index: number): JSONSchema {
  return {
    type: "object",
    title: `Shared hashtag test note ${index}`,
    description:
      "This schema intentionally has #something-else, not the queried tag.",
    properties: {
      [NAME]: { type: "string" },
      body: { type: "string" },
    },
  };
}

function matchingSchemaForMentionable(index: number): JSONSchema {
  return {
    type: "object",
    title: `Shared hashtag test notebook ${index}`,
    description: "This schema intentionally matches #notebook.",
    properties: {
      [NAME]: { type: "string" },
      body: { type: "string" },
      extra: { type: "string" },
    },
  };
}

const nameOnlyWishSchema: JSONSchema = {
  type: "object",
  properties: {
    [NAME]: { type: "string" },
  },
};

const bodyOnlyWishSchema: JSONSchema = {
  type: "object",
  properties: {
    body: { type: "string" },
  },
};

function wishSearchCount(): number {
  const timing = getTimingStatsBreakdown();
  return timing["runner.wish-flow"]?.[
    "wish/phase-query/mentionable-filter/#notebook"
  ]?.count ?? 0;
}

function rawLinkSchema(value: unknown): unknown {
  return (value as Record<string, any>)?.["/"]?.[LINK_V1_TAG]?.schema;
}

Deno.test(
  "shared hashtag wish node scans mentionables once for repeated identical wishes",
  async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    try {
      const tx = runtime.edit();
      const spaceCell = runtime.getCell(space, space, undefined, tx).withTx(tx);
      const defaultPatternCell = runtime.getCell(
        space,
        "shared-hashtag-default-pattern",
        undefined,
        tx,
      );
      const backlinksIndexCell = runtime.getCell(
        space,
        "shared-hashtag-backlinks-index",
        undefined,
        tx,
      );
      const mentionables = Array.from({ length: 30 }, (_, index) => {
        const cell = runtime.getCell(
          space,
          `shared-hashtag-mentionable-${index}`,
          schemaForMentionable(index),
          tx,
        );
        cell.set({
          [NAME]: `note-${index}`,
          body: `body-${index}`,
        });
        return cell;
      });

      backlinksIndexCell.set({ mentionable: mentionables });
      defaultPatternCell.set({ backlinksIndex: backlinksIndexCell });
      spaceCell.key("defaultPattern").set(defaultPatternCell);

      const { commonfabric } = createTrustedBuilder(runtime);
      const wishPattern = commonfabric.pattern(() => {
        return {
          result: commonfabric.wish({
            query: "#notebook",
            scope: ["."],
            headless: true,
          }),
        };
      });

      const before = wishSearchCount();
      const results = Array.from({ length: 30 }, (_, index) => {
        const resultCell = runtime.getCell(
          space,
          `shared-hashtag-result-${index}`,
          undefined,
          tx,
        );
        return runtime.run(tx, wishPattern, {}, resultCell);
      });
      await tx.commit();

      const values = await Promise.all(results.map((result) => result.pull()));
      expect(wishSearchCount() - before).toBe(1);
      for (const value of values) {
        const wishResult = (value as { result?: { error?: string } }).result;
        expect(wishResult?.error).toContain("No mentionables found matching");
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  },
);

Deno.test(
  "shared hashtag wish node scans once across schema-bearing wishes",
  async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    try {
      const tx = runtime.edit();
      const spaceCell = runtime.getCell(space, space, undefined, tx).withTx(tx);
      const defaultPatternCell = runtime.getCell(
        space,
        "shared-hashtag-schema-default-pattern",
        undefined,
        tx,
      );
      const backlinksIndexCell = runtime.getCell(
        space,
        "shared-hashtag-schema-backlinks-index",
        undefined,
        tx,
      );
      const mentionables = Array.from({ length: 30 }, (_, index) => {
        const cell = runtime.getCell(
          space,
          `shared-hashtag-schema-mentionable-${index}`,
          matchingSchemaForMentionable(index),
          tx,
        );
        cell.set({
          [NAME]: "notebook",
          body: `body-${index}`,
          extra: `extra-${index}`,
        });
        return cell;
      });

      backlinksIndexCell.set({ mentionable: mentionables });
      defaultPatternCell.set({ backlinksIndex: backlinksIndexCell });
      spaceCell.key("defaultPattern").set(defaultPatternCell);

      const { commonfabric } = createTrustedBuilder(runtime);
      const nameWishPattern = commonfabric.pattern(() => {
        return {
          result: commonfabric.wish({
            query: "#notebook",
            scope: ["."],
            headless: true,
          }, nameOnlyWishSchema),
        };
      });
      const bodyWishPattern = commonfabric.pattern(() => {
        return {
          result: commonfabric.wish({
            query: "#notebook",
            scope: ["."],
            headless: true,
          }, bodyOnlyWishSchema),
        };
      });

      const before = wishSearchCount();
      const results = Array.from({ length: 30 }, (_, index) => {
        const resultCell = runtime.getCell(
          space,
          `shared-hashtag-schema-result-${index}`,
          undefined,
          tx,
        );
        return runtime.run(
          tx,
          index % 2 === 0 ? nameWishPattern : bodyWishPattern,
          {},
          resultCell,
        );
      });

      await tx.commit();

      const values = await Promise.all(results.map((result) => result.pull()));
      expect(wishSearchCount() - before).toBe(1);
      for (const value of values) {
        const wishResult = (value as { result?: { candidates?: unknown[] } })
          .result;
        expect(wishResult?.candidates?.length).toBe(30);
      }
      for (
        const [index, resourceSchema] of [
          nameOnlyWishSchema,
          bodyOnlyWishSchema,
        ].entries()
      ) {
        const stateSchema = resolvedSchema(
          rawLinkSchema(results[index].key("result").getRaw()) as JSONSchema,
        ) as { properties: { candidates: { items: JSONSchema } } };
        expect(stateSchema.properties.candidates.items).toEqual(resourceSchema);
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  },
);

Deno.test(
  "shared hashtag wish node keeps its resolver across a second run for the same query",
  async () => {
    // A node's resolver is keyed by space, query, and scope. A second run
    // that computes the same key while the node still holds the resolver
    // reuses it, so the mentionables are not scanned again; only a run whose
    // key differs releases one resolver and acquires another. The node is
    // driven directly here, because nothing else re-runs it with its inputs
    // unchanged.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const [cancel, addCancel] = useCancelGroup();

    try {
      const tx = runtime.edit();
      const spaceCell = runtime.getCell(space, space, undefined, tx).withTx(tx);
      const defaultPatternCell = runtime.getCell(
        space,
        "shared-hashtag-reuse-default-pattern",
        undefined,
        tx,
      );
      const backlinksIndexCell = runtime.getCell(
        space,
        "shared-hashtag-reuse-backlinks-index",
        undefined,
        tx,
      );
      const mentionable = runtime.getCell(
        space,
        "shared-hashtag-reuse-mentionable",
        matchingSchemaForMentionable(0),
        tx,
      );
      mentionable.set({ [NAME]: "notebook", body: "body", extra: "extra" });
      backlinksIndexCell.set({ mentionable: [mentionable] });
      defaultPatternCell.set({ backlinksIndex: backlinksIndexCell });
      spaceCell.key("defaultPattern").set(defaultPatternCell);
      const inputs = runtime.getCell<Record<string, unknown>>(
        space,
        "shared-hashtag-reuse-inputs",
        undefined,
        tx,
      );
      inputs.set({ query: "#notebook", scope: ["."], headless: true });
      const parent = runtime.getCell<Record<string, unknown>>(
        space,
        "shared-hashtag-reuse-parent",
        undefined,
        tx,
      );
      parent.set({});
      await tx.commit();

      const sent: unknown[] = [];
      const action = wish(
        inputs as unknown as Parameters<typeof wish>[0],
        (_tx, value) => {
          sent.push(value);
        },
        addCancel,
        [],
        parent,
        runtime,
      );
      // A resolver is one scheduler subscription; acquiring a second one
      // would be a second.
      const subscribe = runtime.scheduler.subscribe.bind(runtime.scheduler);
      let subscriptions = 0;
      runtime.scheduler.subscribe = ((...args) => {
        subscriptions++;
        return subscribe(...args);
      }) as typeof runtime.scheduler.subscribe;

      const first = runtime.edit();
      action.action(first);
      await first.commit();
      await runtime.idle();
      expect(subscriptions).toBe(1);

      const second = runtime.edit();
      action.action(second);
      await second.commit();
      await runtime.idle();
      expect(sent.length).toBe(2);
      expect(subscriptions).toBe(1);
    } finally {
      cancel();
      await runtime.dispose({ closeStorage: false });
      await storageManager.close();
    }
  },
);
