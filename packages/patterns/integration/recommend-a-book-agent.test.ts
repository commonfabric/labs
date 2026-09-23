/** Runs the invitation's visitor agent against a disposable hosted Fabric. */

import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";

import { startAgentRunner } from "../../cli/commands/agent.ts";
import { setAclEntry } from "../../cli/lib/acl.ts";
import { loadIdentity } from "../../cli/lib/identity.ts";
import { loadPieces } from "../../cli/lib/piece.ts";
import { MultiRuntimeHarness } from "./multi-runtime-harness.ts";

const rootPath = fromFileUrl(new URL("../", import.meta.url));
const apiUrl = Deno.env.get("AGENT_DEMO_API_URL");

describe("recommend-a-book visitor agent", () => {
  it({
    name: "runs a member's invitation agent and returns private suggestions",
    ignore: apiUrl === undefined,
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async () => {
      const evidenceRoot = Deno.env.get("AGENT_DEMO_EVIDENCE_DIR");
      if (evidenceRoot) await Deno.mkdir(evidenceRoot, { recursive: true });
      const evidence = await Deno.makeTempDir({
        prefix: "recommend-a-book-agent-",
        ...(evidenceRoot ? { dir: evidenceRoot } : {}),
      });
      const ownerKey = join(evidence, "owner.key");
      const visitorKey = join(evidence, "visitor.key");
      const invitationKey = join(evidence, "invitation.key");
      await Deno.writeFile(ownerKey, await Identity.generatePkcs8(), {
        createNew: true,
      });
      await Deno.writeFile(visitorKey, await Identity.generatePkcs8(), {
        createNew: true,
      });
      await Deno.writeFile(invitationKey, await Identity.generatePkcs8(), {
        createNew: true,
      });
      const owner = await loadIdentity(ownerKey);
      const visitor = await loadIdentity(visitorKey);
      const invitation = await loadIdentity(invitationKey);
      const model = "scripted-personalized-book-demo";
      const requests: unknown[] = [];
      const modelServer = Deno.serve({
        hostname: "127.0.0.1",
        port: 0,
        onListen: () => {},
      }, async (request) => {
        if (request.method === "GET") {
          return Response.json({ data: [{ id: model }] });
        }
        const body = await request.json();
        requests.push(body);
        const messages = body.messages as Array<{
          role: string;
          tool_call_id?: string;
        }>;
        const submitted = messages.some((message) =>
          message.role === "tool" && message.tool_call_id === "suggest-book"
        );
        const message = submitted
          ? {
            role: "assistant",
            content: "The reader can review the suggestion.",
          }
          : {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "suggest-book",
              type: "function",
              function: {
                name: "submit_result",
                arguments: JSON.stringify({
                  result: {
                    books: [{
                      title: "Solaris",
                      author: "Stanisław Lem",
                      reason: "A thoughtful science-fiction recommendation.",
                    }, {
                      title: "The Left Hand of Darkness",
                      author: "Ursula K. Le Guin",
                      reason: "Already on the originator's shelf.",
                    }, {
                      title: "The Dispossessed",
                      author: "Ursula K. Le Guin",
                      reason: "A match for a favorite author.",
                    }],
                  },
                }),
              },
            }],
          };
        return Response.json({
          id: `recommend-${requests.length}`,
          object: "chat.completion",
          created: 0,
          model,
          choices: [{
            index: 0,
            message,
            finish_reason: submitted ? "stop" : "tool_calls",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      });
      const environment: Record<string, string> = {
        CF_HARNESS_HOME: join(evidence, "harness-home"),
        CF_HARNESS_MODEL_PROVIDER: "openai-compatible-gateway",
        CF_HARNESS_GATEWAY_BASE_URL:
          `http://127.0.0.1:${modelServer.addr.port}/`,
        CF_HARNESS_GATEWAY_AUTH_MODE: "none",
        CF_HARNESS_CFC_ENFORCEMENT_MODE: "enforce-strict",
      };
      const previous = new Map(
        Object.keys(environment).map((key) => [key, Deno.env.get(key)]),
      );
      for (const [key, value] of Object.entries(environment)) {
        Deno.env.set(key, value);
      }
      const loomConfigPath = join(evidence, "loom.json");
      await Deno.writeTextFile(
        loomConfigPath,
        JSON.stringify({
          cliPath: "/usr/bin/false",
          transport: {
            kind: "broker",
            queuePath: join(evidence, "loom-queue"),
          },
        }),
      );
      let harness: MultiRuntimeHarness | undefined;
      let runner: Awaited<ReturnType<typeof startAgentRunner>> | undefined;
      try {
        await setAclEntry(
          {
            apiUrl: apiUrl!,
            space: invitation.did(),
            identity: invitationKey,
          },
          owner.did(),
          "OWNER",
        );
        await setAclEntry(
          {
            apiUrl: apiUrl!,
            space: invitation.did(),
            identity: ownerKey,
          },
          visitor.did(),
          "WRITE",
        );
        for (
          const [identity, key] of [[owner, ownerKey], [
            visitor,
            visitorKey,
          ]] as const
        ) {
          const pieces = await loadPieces({
            apiUrl: apiUrl!,
            space: identity.did(),
            identity: key,
          });
          try {
            await pieces.ensureDefaultPattern();
          } finally {
            await pieces.runtime.dispose();
          }
        }
        harness = await MultiRuntimeHarness.create({
          apiUrl: new URL(apiUrl!),
          spaceName: invitation.did(),
          programPath:
            `${rootPath}integration/fixtures/recommend-a-book/main.tsx`,
          rootPath,
          watchPaths: [["$UI"]],
          sessions: [
            {
              label: "owner",
              identity: owner,
              cfc: {
                cfcEnforcementMode: "enforce-strict",
                cfcFlowLabels: "persist",
                cfcReadMaxConfidentiality: [
                  cfcAtom.user(owner.did()),
                  cfcAtom.space(invitation.did()),
                ],
                experimental: { agentBuiltin: true, serverExecution: false },
              },
            },
            {
              label: "visitor",
              identity: visitor,
              cfc: {
                cfcEnforcementMode: "enforce-strict",
                cfcFlowLabels: "persist",
                cfcReadMaxConfidentiality: [
                  cfcAtom.user(visitor.did()),
                  cfcAtom.space(invitation.did()),
                ],
                experimental: { agentBuiltin: true, serverExecution: false },
              },
            },
          ],
        });
        const [ownerSession, visitorSession] = harness.sessions;
        await harness.settle();
        await ownerSession.client().call("publishLibrary", {
          value: {
            books: [{
              title: "The Left Hand of Darkness",
              author: "Ursula K. Le Guin",
            }],
            favoriteAuthors: ["Ursula K. Le Guin"],
          },
        });
        await harness.settle();
        expect(
          (await visitorSession.client().call("agentQueue") as {
            entries: Array<{ state: string }>;
          }).entries[0]?.state,
        ).toBe("queued");

        let completed!: () => void;
        let failed!: (error: Error) => void;
        const done = new Promise<void>((resolve, reject) => {
          completed = resolve;
          failed = reject;
        });
        const runnerMessages: string[] = [];
        runner = await startAgentRunner({
          identityPath: visitorKey,
          home: visitor.did(),
          homeHost: apiUrl!,
          runnerHost: apiUrl!,
          tools: ["loom_search", "loom_page_read"],
          maxConcurrent: 1,
          leaseMs: 300_000,
          workRoot: join(evidence, "runs"),
          loomRetrievalConfigPath: loomConfigPath,
          model,
        }, (line) => {
          runnerMessages.push(line);
          if (line.includes("ended completed")) completed();
          if (/ended (failed|refused|cancelled)/.test(line)) {
            failed(new Error(runnerMessages.join("\n")));
          }
        });
        await done;
        await harness.settle();
        expect(requests.length).toBeGreaterThan(0);
        const visitorView = await visitorSession.client().call(
          "viewText",
        ) as string;
        expect(visitorView).toContain("Solaris");
        expect(visitorView).toContain("The Dispossessed");
        expect(visitorView).not.toContain("The Left Hand of Darkness");
        expect(visitorView.indexOf("The Dispossessed")).toBeLessThan(
          visitorView.indexOf("Solaris"),
        );
        expect(await ownerSession.client().call("viewText")).not.toContain(
          "Solaris",
        );
      } finally {
        await runner?.stop();
        await harness?.dispose();
        await modelServer.shutdown();
        for (const [key, value] of previous) {
          if (value === undefined) Deno.env.delete(key);
          else Deno.env.set(key, value);
        }
      }
    },
  });
});
