import { stableCellId } from "@commonfabric/agents-connector";
import type { AgentFabricTarget } from "@commonfabric/agents-connector/fabric";
import type { PiecesController } from "@commonfabric/piece/ops";
import { abortable } from "./abort.ts";
import {
  commandWriterAuthorization,
  writerModuleIdentity,
} from "./command-authorization.ts";
import type { CommandProducerConfig } from "./config.ts";

/** A producer pattern the host accepts commands from, and its queue. */
export interface BoundCommandProducer {
  id: string;
  piece: string;
  commandCellId: string;
}

/**
 * Binds one command queue per configured producer and links each queue into
 * its producer piece's `commands` input. A producer is a deployed piece whose
 * pattern declares `commandAuthorization`, the verified handler that may
 * write its queue; the queue is protected for the owner with that handler as
 * its only writer, so the piece can send commands and nothing else can.
 *
 * The queue's policy names the module that defines the handler. A handler
 * the pattern imports from another module would bind the queue to that
 * module, and every pattern importing the same handler would then satisfy the
 * policy; so a producer's writer is required to be defined in the producer's
 * own pattern module.
 */
export async function bindCommandProducers(
  manager: PiecesController,
  target: AgentFabricTarget,
  producers: readonly CommandProducerConfig[],
  signal?: AbortSignal,
): Promise<BoundCommandProducer[]> {
  const bound: BoundCommandProducer[] = [];
  for (const producer of producers) {
    const piece = await abortable(manager.get(producer.piece), signal);
    const pattern = await abortable(piece.getPattern(), signal);
    const authorization = commandWriterAuthorization(pattern);
    if (authorization === undefined) {
      throw new Error(
        `command producer ${producer.id} declares no verified command writer authorization`,
      );
    }
    const patternRef = manager.runtime.patternManager.getArtifactEntryRef(
      pattern,
    );
    if (!patternRef) {
      throw new Error(
        `command producer ${producer.id}'s pattern has no recorded identity`,
      );
    }
    const writerModule = writerModuleIdentity(authorization);
    if (writerModule !== patternRef.identity) {
      throw new Error(
        `command producer ${producer.id} declares a command writer from module ${
          writerModule ?? "(none)"
        }, not from its own pattern module ${patternRef.identity}`,
      );
    }
    const cell = await abortable(
      target.bindProducerCommandCell(producer.id, authorization),
      signal,
    );
    const commandCellId = stableCellId(cell.resolveAsCell());
    await abortable(
      manager.link(commandCellId, [], producer.piece, ["commands"], {
        start: false,
      }),
      signal,
    );
    bound.push({ id: producer.id, piece: producer.piece, commandCellId });
  }
  return bound;
}
