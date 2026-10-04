import type {
  AgentCanvasConnection as CanvasConnection,
  AgentCanvasPosition,
  AgentState,
  OrchestrationState,
} from "../../contracts";

export interface AgentCanvasNode extends AgentCanvasPosition {
  name: string;
  role: string;
  provider: OrchestrationState["agents"][number]["provider"];
  status: AgentState["status"];
  currentTask?: string;
}

export interface AgentCanvasModel {
  nodes: AgentCanvasNode[];
  connections: CanvasConnection[];
  viewport: { x: number; y: number; zoom: number };
}

export function buildAgentCanvasModel(
  orchestration: OrchestrationState,
): AgentCanvasModel {
  const states = new Map(
    orchestration.agentStates.map((state) => [state.agentId, state]),
  );
  const savedPositions = new Map(
    (orchestration.canvas?.positions ?? []).map((position) => [
      position.agentId,
      position,
    ]),
  );
  const nodes = orchestration.agents.map((agent, index) => {
    const state = states.get(agent.id);
    const position = savedPositions.get(agent.id) ?? {
      agentId: agent.id,
      x: 100 + (index % 3) * 760,
      y: 100 + Math.floor(index / 3) * 620,
      width: 700,
      height: 560,
    };
    return {
      ...position,
      name: agent.name,
      role: agent.name === "Chat livre" ? "Chat livre" : agent.role,
      provider: agent.provider,
      status: state?.status ?? "idle",
      ...(state?.currentTask ? { currentTask: state.currentTask } : {}),
    };
  });
  const agentIds = new Set(nodes.map((node) => node.agentId));
  const connections = (orchestration.canvas?.connections ?? []).filter(
    (connection) =>
      agentIds.has(connection.fromAgentId) && agentIds.has(connection.toAgentId),
  );

  return {
    nodes,
    connections,
    viewport: orchestration.canvas?.viewport ?? { x: 0, y: 0, zoom: 1 },
  };
}
