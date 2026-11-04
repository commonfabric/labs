import { NAME, UI } from "@commonfabric/runner/shared";
import { $conn, type RuntimeClient } from "./runtime-client.ts";
import { PieceRef, RequestType } from "./protocol/mod.ts";
import { InitializedRuntimeConnection } from "./client/connection.ts";
import { VNode } from "./vnode-types.ts";
import { CellHandle } from "./cell-handle.ts";

export type PieceType = {
  [NAME]?: CellHandle<string> | string;
  [UI]?: CellHandle<VNode> | VNode;
};

export class PieceHandle<T = PieceType> {
  #conn: InitializedRuntimeConnection;
  #cell: CellHandle<T>;

  constructor(
    rt: RuntimeClient,
    ref: PieceRef,
  ) {
    this.#conn = rt[$conn]();
    this.#cell = new CellHandle<T>(rt, ref.cell);
  }

  cell(): CellHandle<T> {
    return this.#cell;
  }

  /**
   * The piece-root ROUTING/DISPLAY form of the id: consumers feed shell
   * URLs, `cf-piece` lookups, menu entries, and equality against
   * URL-derived bare pieceIds, so `of:` is stripped to match that bare
   * convention. Piece roots are minted unkinded, so only `of:` ids arrive
   * here; a `computed:` scheme (which would indicate a bug upstream) stays
   * visible rather than being laundered into the bare-id world. For
   * identity, use `cell().id()` — the full schemed URI.
   */
  id(): string {
    return this.#cell.id().replace(/^of:/, "");
  }

  name(): string | undefined {
    const data = this.#cell.get() as Record<string, unknown> | undefined;
    if (data && typeof data === "object" && NAME in data) {
      return data[NAME] as string;
    }
  }

  async start(): Promise<boolean> {
    const res = await this.#conn.request<RequestType.PieceStart>({
      type: RequestType.PieceStart,
      pieceId: this.id(),
      // The piece's cell knows its whole address — start/stop route to that
      // space's piece context, and resolve the id in the scope the cell was
      // reached through. One id in two scopes is two documents.
      space: this.#cell.space(),
      scope: this.#cell.ref().scope,
    });
    return res.value;
  }

  async stop(): Promise<boolean> {
    const res = await this.#conn.request<RequestType.PieceStop>({
      type: RequestType.PieceStop,
      pieceId: this.id(),
      space: this.#cell.space(),
      scope: this.#cell.ref().scope,
    });
    return res.value;
  }
}
