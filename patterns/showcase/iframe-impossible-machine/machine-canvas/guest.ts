/** Owns the React Flow state that must survive collaborative rerenders. */

import * as flowLifecycle from "../flow-lifecycle.ts";

type StateUpdate<T> = T | ((current: T) => T);

/** React Flow node fields used by the canvas lifecycle. */
export interface CanvasNode extends flowLifecycle.PositionedNode {
  /** React Flow node renderer key. */
  type?: string;
}

/** React Flow change fields inspected by the canvas lifecycle. */
export interface CanvasNodeChange {
  /** Kind of React Flow change. */
  type: string;
}

/** The React operations used by the canvas, injectable for lifecycle tests. */
export interface CanvasReactRuntime {
  useState<T>(initial: T): [T, (update: StateUpdate<T>) => void];
  useRef<T>(initial: T): { current: T };
  useLayoutEffect(effect: () => void, dependencies: readonly unknown[]): void;
  useCallback<T>(callback: T, dependencies: readonly unknown[]): T;
  createElement(
    type: unknown,
    properties: Record<string, unknown> | null,
    ...children: unknown[]
  ): object;
}

/** The React Flow operations and components used by the canvas. */
export interface CanvasFlowRuntime<N extends CanvasNode> {
  ReactFlow: unknown;
  Background: unknown;
  Controls: unknown;
  MiniMap: unknown;
  applyNodeChanges(changes: CanvasNodeChange[], nodes: N[]): N[];
}

/** Durable callbacks and projections consumed by the collaborative canvas. */
export interface MachineCanvasProps<N extends CanvasNode> {
  authoritativeNodes: N[];
  edges: readonly unknown[];
  onConnect(connection: {
    source: string | null;
    target: string | null;
  }): void;
  onNodeSelection(nodeId: string): Promise<boolean>;
  authoritativeSelection: string | null;
  onPositionCommit(
    nodeId: string,
    position: flowLifecycle.XYPosition,
  ): Promise<flowLifecycle.XYPosition | undefined>;
}

/** Creates the canvas component around an explicit, testable hook boundary. */
export function createMachineCanvas<N extends CanvasNode>(
  react: CanvasReactRuntime,
  flow: CanvasFlowRuntime<N>,
  nodeTypes: Readonly<Record<string, unknown>>,
  kindColors: Readonly<Record<string, string>>,
): (properties: MachineCanvasProps<N>) => object {
  return function MachineCanvas({
    authoritativeNodes,
    edges,
    onConnect,
    onNodeSelection,
    authoritativeSelection,
    onPositionCommit,
  }: MachineCanvasProps<N>) {
    const [nodes, setNodes] = react.useState(authoritativeNodes);
    const draftsRef = react.useRef<
      Record<string, flowLifecycle.PositionDraft>
    >({});
    const authoritativeNodesRef = react.useRef(authoritativeNodes);
    const selectionDraftRef = react.useRef<
      { nodeId: string; token: number; confirmed: boolean } | undefined
    >(undefined);
    const selectionSequenceRef = react.useRef(0);
    const authoritativeSelectionRef = react.useRef(authoritativeSelection);

    react.useLayoutEffect(() => {
      authoritativeNodesRef.current = authoritativeNodes;
      authoritativeSelectionRef.current = authoritativeSelection;
      if (
        selectionDraftRef.current?.confirmed === true &&
        selectionDraftRef.current.nodeId === authoritativeSelection
      ) {
        selectionDraftRef.current = undefined;
      }
      setNodes((current) =>
        flowLifecycle.reconcileCollaborativeNodes(
          current,
          authoritativeNodes,
          draftsRef.current,
          selectionDraftRef.current?.nodeId,
        )
      );
    }, [authoritativeNodes, authoritativeSelection]);

    const handleNodeChanges = react.useCallback(
      (changes: CanvasNodeChange[]) => {
        flowLifecycle.capturePositionDrafts(changes, draftsRef);
        setNodes((current) => flow.applyNodeChanges(changes, current));
      },
      [],
    );

    const handleNodeDragStop = react.useCallback(
      (node: N) => {
        const draft = draftsRef.current[node.id] ?? {
          position: node.position,
          token: 0,
        };
        void onPositionCommit(node.id, draft.position).then((committed) => {
          const result = flowLifecycle.reconcilePositionCommit(
            draftsRef,
            node.id,
            draft,
            committed,
            authoritativeNodesRef.current.find(
              (candidate) => candidate.id === node.id,
            )?.position,
          );
          if (!result.settled || result.position === undefined) return;
          const position = result.position;
          setNodes((current) =>
            current.map((candidate) =>
              candidate.id === node.id ? { ...candidate, position } : candidate
            )
          );
        });
      },
      [onPositionCommit],
    );

    const handleNodeSelection = react.useCallback(
      (nodeId: string) => {
        if (
          authoritativeSelection === nodeId &&
          selectionDraftRef.current === undefined
        ) return;
        const draft = {
          nodeId,
          token: ++selectionSequenceRef.current,
          confirmed: false,
        };
        selectionDraftRef.current = draft;
        setNodes((current) =>
          flowLifecycle.reconcileCollaborativeNodes(
            current,
            authoritativeNodesRef.current,
            draftsRef.current,
            nodeId,
          )
        );
        void onNodeSelection(nodeId).then((succeeded) => {
          if (selectionDraftRef.current?.token !== draft.token) return;
          if (succeeded) {
            selectionDraftRef.current = { ...draft, confirmed: true };
            if (authoritativeSelectionRef.current !== nodeId) return;
          }
          selectionDraftRef.current = undefined;
          setNodes((current) =>
            flowLifecycle.reconcileCollaborativeNodes(
              current,
              authoritativeNodesRef.current,
              draftsRef.current,
            )
          );
        });
      },
      [authoritativeSelection, onNodeSelection],
    );

    return react.createElement(
      flow.ReactFlow,
      {
        nodes,
        edges,
        nodeTypes,
        onNodesChange: handleNodeChanges,
        onNodeClick: (_event: unknown, node: N) => handleNodeSelection(node.id),
        onNodeDragStop: (_event: unknown, node: N) => handleNodeDragStop(node),
        onConnect,
        nodesDraggable: true,
        nodesConnectable: true,
        elementsSelectable: true,
        fitView: true,
        fitViewOptions: { padding: 0.1 },
        minZoom: 0.35,
        maxZoom: 1.6,
        defaultEdgeOptions: { type: "smoothstep" },
        colorMode: "dark",
      },
      react.createElement(flow.Background, {
        color: "#26334a",
        gap: 28,
        size: 1.2,
      }),
      react.createElement(flow.Controls, {
        showInteractive: false,
        fitViewOptions: { padding: 0.1 },
      }),
      react.createElement(flow.MiniMap, {
        pannable: true,
        zoomable: true,
        nodeColor: (node: N) => kindColors[node.type ?? "sensor"],
        nodeStrokeColor: "#07111f",
        maskColor: "rgba(5, 12, 24, 0.72)",
      }),
    );
  };
}
