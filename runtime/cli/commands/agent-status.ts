/** Reads readiness from the private runner socket without submitting work. */

import { type IncomingMessage, request } from "@node/http";
import { Command } from "@cliffy/command";

/** Reads authenticated runner health, retaining unknown fields for inspection. */
export async function readRunnerHealth(socketPath: string): Promise<unknown> {
  const token = (await Deno.readTextFile(`${socketPath}.token`)).trim();
  return await new Promise((resolve, reject) => {
    const req = request({
      socketPath,
      path: "/health",
      headers: { authorization: `Bearer ${token}` },
    }, (response: IncomingMessage) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk: string) => body += chunk);
      response.on("error", reject);
      response.on("end", () => {
        if (response.statusCode !== 200 && response.statusCode !== 503) {
          reject(
            new Error(
              `Runner health returned HTTP ${response.statusCode}: ${body}`,
            ),
          );
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** The readiness inspector's socket read and output. */
export interface AgentStatusDeps {
  read: (path: string) => Promise<unknown>;
  print: (value: string) => void;
}

/** Builds `cf agent status`, printing every field the runner reports. */
export function createAgentStatusCommand(deps: AgentStatusDeps = {
  read: readRunnerHealth,
  print: console.log,
}) {
  return new Command()
    .description("Print runner readiness, routes and configuration as JSON.")
    .option(
      "--local-jobs-socket <path:string>",
      "Runner's private Unix socket.",
      { required: true },
    )
    .action(async (options) => {
      deps.print(
        JSON.stringify(await deps.read(options.localJobsSocket), null, 2),
      );
    });
}
