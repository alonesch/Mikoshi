import { useEffect, useRef, useState } from "react";
import type { FormEvent, JSX, MouseEvent as ReactMouseEvent, PointerEvent } from "react";
import type { AgentCanvasState, AgentRole, ProviderId } from "../../contracts";
import type { AgentCanvasModel, AgentCanvasNode } from "./agent-canvas-model";
import { AgentTerminal } from "./AgentTerminal";
import { hasTerminalOutput } from "./terminal-activity";
import { ScrambleText } from "./ScrambleText";

export interface AgentCanvasCreation {
  provider: ProviderId;
  mode: "orchestrator" | "free" | "specialist";
  role: AgentRole;
  name: string;
  instructions: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const statusLabels: Record<string, string> = {
  idle: "Disponível",
  running: "Em execução",
  waiting_handoff: "Aguardando handoff",
  waiting_review: "Aguardando revisão",
  failed: "Falhou",
};
const providerLabels: Record<ProviderId, string> = {
  codex: "Codex",
  claude: "Claude Code",
  antigravity: "Antigravity",
  kimi: "Kimi Code",
};
const providerMarks: Record<ProviderId, string> = {
  codex:
    "M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 0 0-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 0 1 .476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z",
  claude:
    "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z",
  antigravity:
    "M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z",
  kimi: "m1.053 16.91 9.538 2.55a21 20.981 0 0 0 .06 2.031l5.956 1.592a12 11.99 0 0 1-15.554-6.172m-1.02-5.79 11.352 3.035a21 20.981 0 0 0-.469 2.01l10.817 2.89a12 11.99 0 0 1-1.845 2.004L.658 15.918a12 11.99 0 0 1-.625-4.796m1.593-5.146L13.573 9.17a21 20.981 0 0 0-1.01 1.874l11.297 3.02a21 20.981 0 0 1-.67 2.362l-11.55-3.087L.125 10.26a12 11.99 0 0 1 1.499-4.285ZM6.067 1.58l11.285 3.016a21 20.981 0 0 0-1.688 1.719l7.824 2.091a21 20.981 0 0 1 .513 2.664L2.107 5.218a12 11.99 0 0 1 3.96-3.638M21.68 4.866 7.222 1.003A12 11.99 0 0 1 21.68 4.866",
};

interface AgentCanvasProps {
  model: AgentCanvasModel;
  selectedAgentId: string;
  projectReady: boolean;
  providerAvailable?: boolean;
  availableProviders?: ProviderId[];
  projectId?: string;
  projectRoot?: string;
  disabled: boolean;
  onSelectAgent: (agentId: string) => void;
  onDeleteAgent: (agentId: string) => Promise<void>;
  onCreateCanvasAgent: (creation: AgentCanvasCreation) => Promise<boolean>;
  onOpenSettings: () => void;
  onCanvasBackgroundClick?: () => void;
  onSaveCanvas: (canvas: AgentCanvasState) => Promise<void>;
}

type DragState =
  | { type: "pan"; pointerX: number; pointerY: number; x: number; y: number }
  | {
      type: "move";
      agentId: string;
      pointerX: number;
      pointerY: number;
      x: number;
      y: number;
      moved: boolean;
    }
  | {
      type: "resize";
      agentId: string;
      pointerX: number;
      pointerY: number;
      width: number;
      height: number;
    };

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function connectionPath(source: AgentCanvasNode, target: AgentCanvasNode): string {
  const startX = source.x + source.width;
  const startY = source.y + 58;
  const endX = target.x;
  const endY = target.y + 58;
  const curve = Math.max(60, Math.abs(endX - startX) / 2);
  return `M ${startX} ${startY} C ${startX + curve} ${startY}, ${endX - curve} ${endY}, ${endX} ${endY}`;
}

const compactWidth = 420;
const compactHeight = 76;
const activityDuration = 8000;

export function AgentCanvas({
  model,
  selectedAgentId,
  projectReady,
  providerAvailable = true,
  availableProviders = [],
  projectId,
  projectRoot,
  disabled,
  onSelectAgent,
  onDeleteAgent,
  onCreateCanvasAgent,
  onOpenSettings,
  onCanvasBackgroundClick,
  onSaveCanvas,
}: AgentCanvasProps): JSX.Element {
  const [canvas, setCanvas] = useState(model);
  const [collapsedAgentIds, setCollapsedAgentIds] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<AgentCanvasNode | null>(null);
  const [activeAgentIds, setActiveAgentIds] = useState<Set<string>>(new Set());
  const activityTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [connectingFrom, setConnectingFrom] = useState("");
  const [activeTool, setActiveTool] = useState<"select" | "terminal">("select");
  const [creationPosition, setCreationPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [creationTab, setCreationTab] = useState<"details" | "appearance" | "agent">(
    "details",
  );
  const [agentMode, setAgentMode] = useState<AgentCanvasCreation["mode"]>("free");
  const [specialistRole, setSpecialistRole] = useState<AgentRole>("Tests");
  const [agentName, setAgentName] = useState("Chat livre");
  const [agentInstructions, setAgentInstructions] = useState(
    "Converse livremente com a pessoa usuária. Não assuma uma tarefa até que ela seja informada.",
  );
  const [terminalSize, setTerminalSize] = useState<"normal" | "large">("normal");
  const [terminalProvider, setTerminalProvider] = useState<ProviderId>(
    availableProviders[0] ?? "codex",
  );
  const drag = useRef<DragState | null>(null);
  const board = useRef<HTMLDivElement>(null);
  const cancelDeleteButton = useRef<HTMLButtonElement>(null);

  useEffect(() => setCanvas(model), [model]);
  useEffect(() => {
    if (!deleteTarget) return;
    cancelDeleteButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setDeleteTarget(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleteTarget]);
  function markAgentActive(agentId: string): void {
    const previousTimer = activityTimers.current.get(agentId);
    if (previousTimer) clearTimeout(previousTimer);
    setActiveAgentIds((previous) => new Set(previous).add(agentId));
    activityTimers.current.set(
      agentId,
      setTimeout(() => {
        activityTimers.current.delete(agentId);
        setActiveAgentIds((previous) => {
          const next = new Set(previous);
          next.delete(agentId);
          return next;
        });
      }, activityDuration),
    );
  }
  useEffect(() => {
    setActiveAgentIds(new Set());
    const timers = activityTimers.current;
    const unsubscribe = window.mikoshi.onAgentTerminalEvent((event) => {
      if (event.projectId !== projectId) return;
      if (event.type === "data" && hasTerminalOutput(event.data ?? "")) {
        markAgentActive(event.agentId);
      } else if (event.type === "exit") {
        const previousTimer = timers.get(event.agentId);
        if (previousTimer) clearTimeout(previousTimer);
        timers.delete(event.agentId);
        setActiveAgentIds((previous) => {
          const next = new Set(previous);
          next.delete(event.agentId);
          return next;
        });
      }
    });
    return () => {
      unsubscribe();
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, [projectId]);
  useEffect(() => {
    const defaultProvider = availableProviders[0];
    if (!defaultProvider) return;
    if (!availableProviders.includes(terminalProvider))
      setTerminalProvider(defaultProvider);
  }, [availableProviders, terminalProvider]);

  function setAgentPreset(mode: AgentCanvasCreation["mode"]): void {
    setAgentMode(mode);
    setAgentName(
      mode === "orchestrator"
        ? "Orchestrator"
        : mode === "free"
          ? "Chat livre"
          : specialistRole === "Tests"
            ? "Tester"
            : specialistRole,
    );
    setAgentInstructions(
      mode === "orchestrator"
        ? "Coordene o trabalho deste workspace. Analise as tarefas, decomponha o trabalho e explique etapas que podem ser encaminhadas a agentes conectados no canvas."
        : mode === "free"
          ? "Converse livremente com a pessoa usuária. Não assuma uma tarefa até que ela seja informada."
          : "",
    );
  }

  function placeTerminal(event: ReactMouseEvent<HTMLDivElement>): void {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".canvas-node, button"))
      onCanvasBackgroundClick?.();
    if (activeTool !== "terminal" || !board.current) return;
    if (target instanceof Element && target.closest(".canvas-node")) return;
    const rect = board.current.getBoundingClientRect();
    setCreationPosition({
      x: (event.clientX - rect.left - canvas.viewport.x) / canvas.viewport.zoom,
      y: (event.clientY - rect.top - canvas.viewport.y) / canvas.viewport.zoom,
    });
    setActiveTool("select");
    setCreationTab("details");
  }

  async function createTerminal(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!creationPosition || !terminalProvider) return;
    const role: AgentRole =
      agentMode === "orchestrator"
        ? "Orchestrator"
        : agentMode === "free"
          ? "Architect"
          : specialistRole;
    const size =
      terminalSize === "large"
        ? { width: 960, height: 760 }
        : { width: 760, height: 620 };
    const created = await onCreateCanvasAgent({
      provider: terminalProvider,
      mode: agentMode,
      role,
      name: agentName.trim(),
      instructions: agentInstructions.trim(),
      ...creationPosition,
      ...size,
    });
    if (created) setCreationPosition(null);
  }

  async function persist(next: AgentCanvasModel): Promise<void> {
    setCanvas(next);
    await onSaveCanvas({
      positions: next.nodes.map(({ agentId, x, y, width, height }) => ({
        agentId,
        x,
        y,
        width,
        height,
      })),
      connections: next.connections,
      viewport: next.viewport,
    });
  }

  function beginDrag(event: PointerEvent<HTMLElement>, state: DragState): void {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    board.current?.setPointerCapture(event.pointerId);
    drag.current = state;
  }

  function toggleCollapsed(agentId: string): void {
    setCollapsedAgentIds((previous) => {
      const next = new Set(previous);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>): void {
    const current = drag.current;
    if (!current) return;
    const scale = canvas.viewport.zoom;
    const deltaX = (event.clientX - current.pointerX) / scale;
    const deltaY = (event.clientY - current.pointerY) / scale;
    if (current.type === "pan") {
      setCanvas({
        ...canvas,
        viewport: {
          ...canvas.viewport,
          x: current.x + event.clientX - current.pointerX,
          y: current.y + event.clientY - current.pointerY,
        },
      });
      return;
    }
    if (current.type === "move") {
      if (
        Math.hypot(event.clientX - current.pointerX, event.clientY - current.pointerY) <
          5 &&
        !current.moved
      )
        return;
      current.moved = true;
    }
    setCanvas({
      ...canvas,
      nodes: canvas.nodes.map((node) => {
        if (node.agentId !== current.agentId) return node;
        if (current.type === "move")
          return { ...node, x: current.x + deltaX, y: current.y + deltaY };
        return {
          ...node,
          width: clamp(current.width + deltaX, 220, 1200),
          height: clamp(current.height + deltaY, 300, 1000),
        };
      }),
    });
  }

  async function finishDrag(): Promise<void> {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (current.type === "move" && !current.moved) {
      onSelectAgent(current.agentId);
      toggleCollapsed(current.agentId);
      return;
    }
    await persist(canvas);
  }

  async function changeZoom(amount: number): Promise<void> {
    const next = {
      ...canvas,
      viewport: {
        ...canvas.viewport,
        zoom: clamp(canvas.viewport.zoom + amount, 0.35, 2),
      },
    };
    await persist(next);
  }

  async function resetViewport(): Promise<void> {
    await persist({ ...canvas, viewport: { x: 0, y: 0, zoom: 1 } });
  }

  function connectAgent(agentId: string): void {
    if (!connectingFrom) {
      setConnectingFrom(agentId);
      return;
    }
    if (connectingFrom === agentId) {
      setConnectingFrom("");
      return;
    }
    const alreadyConnected = canvas.connections.some(
      (connection) =>
        connection.fromAgentId === connectingFrom && connection.toAgentId === agentId,
    );
    if (!alreadyConnected) {
      void persist({
        ...canvas,
        connections: [
          ...canvas.connections,
          { id: crypto.randomUUID(), fromAgentId: connectingFrom, toAgentId: agentId },
        ],
      });
    }
    setConnectingFrom("");
  }

  async function removeConnection(connectionId: string): Promise<void> {
    await persist({
      ...canvas,
      connections: canvas.connections.filter(({ id }) => id !== connectionId),
    });
  }

  const nodeById = new Map(
    canvas.nodes.map((node) => [
      node.agentId,
      collapsedAgentIds.has(node.agentId)
        ? { ...node, width: Math.min(node.width, compactWidth), height: compactHeight }
        : node,
    ]),
  );

  return (
    <section className="agent-canvas-section">
      <div className="canvas-tools" aria-label="Ferramentas do canvas">
        <button
          aria-label="Selecionar e mover"
          aria-pressed={activeTool === "select"}
          className={activeTool === "select" ? "active" : ""}
          disabled={disabled}
          onClick={() => setActiveTool("select")}
          title="Selecionar e mover"
        >
          ↖
        </button>
        <button
          aria-label="Criar terminal"
          aria-pressed={activeTool === "terminal"}
          className={activeTool === "terminal" ? "active" : ""}
          disabled={disabled || !projectReady || !providerAvailable}
          onClick={() => setActiveTool("terminal")}
          title={
            !projectReady
              ? "Selecione um workspace primeiro"
              : !providerAvailable
                ? "Adicione um provider nas configurações"
                : "Criar terminal"
          }
        >
          ▣
        </button>
      </div>
      <div
        aria-label="Canvas espacial de agentes"
        className={`agent-canvas ${activeTool === "terminal" ? "placing-terminal" : ""}`}
        onClick={placeTerminal}
        onPointerMove={handlePointerMove}
        onPointerUp={() => void finishDrag()}
        onPointerCancel={() => void finishDrag()}
        onPointerDown={(event) => {
          const target = event.target;
          if (activeTool === "terminal") return;
          if (disabled || (target instanceof Element && target.closest(".canvas-node")))
            return;
          beginDrag(event, {
            type: "pan",
            pointerX: event.clientX,
            pointerY: event.clientY,
            x: canvas.viewport.x,
            y: canvas.viewport.y,
          });
        }}
        ref={board}
      >
        {!projectReady ? (
          <div className="canvas-empty">
            <strong>Seu workspace começa com um projeto</strong>
            <p>Abra a lateral e selecione uma pasta para criar o workspace.</p>
          </div>
        ) : canvas.nodes.length === 0 ? (
          <div className="canvas-empty">
            <strong>O canvas ainda não tem terminais</strong>
            <p>
              {providerAvailable
                ? "Use Criar terminal na barra superior e escolha onde posicionar o agente."
                : "Adicione um provider nas configurações para criar um terminal."}
            </p>
            {!providerAvailable && (
              <button className="secondary" disabled={disabled} onClick={onOpenSettings}>
                Configurar providers
              </button>
            )}
          </div>
        ) : (
          <div
            className="canvas-world"
            style={{
              transform: `translate(${canvas.viewport.x}px, ${canvas.viewport.y}px) scale(${canvas.viewport.zoom})`,
            }}
          >
            <svg aria-hidden="true" className="canvas-wires" height="4000" width="5000">
              <defs>
                <marker
                  id="agent-wire-arrow"
                  markerHeight="8"
                  markerWidth="8"
                  orient="auto"
                  refX="7"
                  refY="4"
                >
                  <path d="M0,0 L8,4 L0,8 z" fill="#51e7f2" />
                </marker>
              </defs>
              {canvas.connections.map((connection) => {
                const source = nodeById.get(connection.fromAgentId);
                const target = nodeById.get(connection.toAgentId);
                return source && target ? (
                  <path
                    d={connectionPath(source, target)}
                    key={connection.id}
                    markerEnd="url(#agent-wire-arrow)"
                  />
                ) : null;
              })}
            </svg>
            {canvas.nodes.map((node) => {
              const collapsed = collapsedAgentIds.has(node.agentId);
              const active =
                node.status === "running" || activeAgentIds.has(node.agentId);
              return (
                <article
                  aria-label={`Agente ${node.name}`}
                  onPointerDown={(event) => {
                    if (
                      event.target instanceof Element &&
                      event.target.closest(".canvas-node-header")
                    )
                      return;
                    onSelectAgent(node.agentId);
                  }}
                  className={`canvas-node${node.agentId === selectedAgentId ? " selected" : ""}${collapsed ? " collapsed" : ""}${active ? " active" : ""}`}
                  key={node.agentId}
                  style={{
                    height: collapsed ? compactHeight : node.height,
                    left: node.x,
                    top: node.y,
                    width: collapsed ? Math.min(node.width, compactWidth) : node.width,
                  }}
                >
                  <div className="canvas-node-frame">
                    <header
                      className="canvas-node-header"
                      onPointerDown={(event) => {
                        if (
                          event.target instanceof Element &&
                          event.target.closest("button")
                        )
                          return;
                        beginDrag(event, {
                          type: "move",
                          agentId: node.agentId,
                          pointerX: event.clientX,
                          pointerY: event.clientY,
                          x: node.x,
                          y: node.y,
                          moved: false,
                        });
                      }}
                    >
                      <div
                        className="canvas-node-heading"
                        role="button"
                        tabIndex={0}
                        aria-label={`${collapsed ? "Expandir" : "Recolher"} ${node.name}`}
                        aria-expanded={!collapsed}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onSelectAgent(node.agentId);
                            toggleCollapsed(node.agentId);
                          }
                        }}
                      >
                        <strong>{node.name}</strong>
                        <small>
                          {active ? "EM USO" : (statusLabels[node.status] ?? node.status)}
                        </small>
                      </div>
                      <span
                        aria-label={providerLabels[node.provider]}
                        className="canvas-provider-mark"
                        role="img"
                        title={providerLabels[node.provider]}
                      >
                        <svg aria-hidden="true" viewBox="0 0 24 24">
                          <path d={providerMarks[node.provider]} />
                        </svg>
                      </span>
                      <button
                        aria-label={`Excluir terminal ${node.name}`}
                        className="canvas-node-delete"
                        disabled={disabled}
                        onClick={() => setDeleteTarget(node)}
                        title="Excluir terminal"
                      >
                        ×
                      </button>
                    </header>
                    {!collapsed && (
                      <div className="canvas-node-body">
                        <span>
                          {node.role} · {node.provider}
                        </span>
                        <small>{statusLabels[node.status] ?? node.status}</small>
                        {node.currentTask && <small>{node.currentTask}</small>}
                        {projectId && (
                          <AgentTerminal
                            projectId={projectId}
                            agentId={node.agentId}
                            disabled={disabled}
                            onInput={() => markAgentActive(node.agentId)}
                          />
                        )}
                        <button
                          className={connectingFrom === node.agentId ? "selected" : ""}
                          disabled={disabled}
                          onClick={() => connectAgent(node.agentId)}
                        >
                          <ScrambleText
                            text={
                              connectingFrom === node.agentId
                                ? "Origem selecionada"
                                : connectingFrom
                                  ? "Conectar destino"
                                  : "Conectar a outro agente"
                            }
                          />
                        </button>
                      </div>
                    )}
                  </div>
                  {!collapsed && (
                    <button
                      aria-label={`Redimensionar ${node.name}`}
                      className="canvas-node-resize"
                      disabled={disabled}
                      onPointerDown={(event) =>
                        beginDrag(event, {
                          type: "resize",
                          agentId: node.agentId,
                          pointerX: event.clientX,
                          pointerY: event.clientY,
                          width: node.width,
                          height: node.height,
                        })
                      }
                    />
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
      {deleteTarget && (
        <div
          className="mikoshi-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDeleteTarget(null);
          }}
        >
          <div
            aria-labelledby="delete-agent-title"
            aria-modal="true"
            className="mikoshi-confirm-dialog"
            role="dialog"
          >
            <span className="mikoshi-dialog-eyebrow">TERMINAL / REMOÇÃO</span>
            <h2 id="delete-agent-title">Excluir {deleteTarget.name}?</h2>
            <p>O cartão será removido do canvas e a sessão ativa será encerrada.</p>
            <div className="mikoshi-dialog-actions">
              <button
                className="secondary"
                ref={cancelDeleteButton}
                onClick={() => setDeleteTarget(null)}
              >
                Cancelar
              </button>
              <button
                className="danger"
                disabled={disabled}
                onClick={() => {
                  const agentId = deleteTarget.agentId;
                  setDeleteTarget(null);
                  void onDeleteAgent(agentId);
                }}
              >
                Excluir terminal
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="canvas-zoom" aria-label="Zoom do canvas">
        <button
          aria-label="Diminuir zoom"
          disabled={disabled}
          onClick={() => void changeZoom(-0.1)}
        >
          −
        </button>
        <button
          disabled={disabled}
          onClick={() => void resetViewport()}
          title="Centralizar canvas"
        >
          {Math.round(canvas.viewport.zoom * 100)}%
        </button>
        <button
          aria-label="Aumentar zoom"
          disabled={disabled}
          onClick={() => void changeZoom(0.1)}
        >
          +
        </button>
      </div>
      {creationPosition && (
        <div
          className="terminal-creation-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCreationPosition(null);
          }}
        >
          <form
            aria-label="Criar terminal"
            aria-modal="true"
            className="terminal-creation-dialog"
            onSubmit={(event) => void createTerminal(event)}
            role="dialog"
          >
            <div className="terminal-creation-overline">
              MIKOSHI / INSTALAÇÃO DE AGENTE
            </div>
            <div className="terminal-creation-header">
              <button
                className="text-button"
                type="button"
                onClick={() => setCreationPosition(null)}
              >
                <ScrambleText text="Cancelar" />
              </button>
              <strong>
                <ScrambleText text="NOVO TERMINAL" />
              </strong>
              <button disabled={disabled || !availableProviders.length} type="submit">
                <ScrambleText text="INSTALAR" />
              </button>
            </div>
            <p className="terminal-creation-lead">
              Selecione a interface, configure o agente e instale o terminal no canvas.
            </p>
            <div className="terminal-creation-section-label">01 / INTERFACE</div>
            <div className="provider-quick-picks" aria-label="Provider">
              {availableProviders.map((provider) => (
                <button
                  aria-pressed={terminalProvider === provider}
                  className={terminalProvider === provider ? "active" : ""}
                  disabled={disabled}
                  key={provider}
                  onClick={() => setTerminalProvider(provider)}
                  type="button"
                >
                  <ScrambleText text={providerLabels[provider]} />
                </button>
              ))}
              {!availableProviders.length && (
                <button className="secondary" onClick={onOpenSettings} type="button">
                  <ScrambleText text="Configurar providers" />
                </button>
              )}
            </div>
            <div className="terminal-creation-section-label">02 / CONFIGURAÇÃO</div>
            <div
              className="terminal-creation-tabs"
              role="tablist"
              aria-label="Opções do terminal"
            >
              {(["details", "appearance", "agent"] as const).map((tab) => (
                <button
                  aria-selected={creationTab === tab}
                  className={creationTab === tab ? "active" : ""}
                  key={tab}
                  onClick={() => setCreationTab(tab)}
                  role="tab"
                  type="button"
                >
                  <span className="terminal-tab-index">
                    {tab === "details" ? "01" : tab === "appearance" ? "02" : "03"}
                  </span>
                  <ScrambleText
                    text={
                      tab === "details"
                        ? "Detalhes"
                        : tab === "appearance"
                          ? "Aparência"
                          : "Agente"
                    }
                  />
                </button>
              ))}
            </div>
            {creationTab === "details" && (
              <div className="terminal-creation-content">
                <label>
                  Nome do terminal
                  <input
                    autoFocus
                    maxLength={80}
                    value={agentName}
                    onChange={(event) => setAgentName(event.target.value)}
                    placeholder="Nome do terminal"
                  />
                </label>
                <label>
                  Executa em
                  <input readOnly value={projectRoot ?? "Workspace atual"} />
                </label>
                <label>
                  Diretório de trabalho
                  <input readOnly value={projectRoot ?? "Selecione um workspace"} />
                </label>
              </div>
            )}
            {creationTab === "appearance" && (
              <div className="terminal-creation-content">
                <label>
                  Tamanho do terminal
                  <select
                    value={terminalSize}
                    onChange={(event) =>
                      setTerminalSize(event.target.value as "normal" | "large")
                    }
                  >
                    <option value="normal">Normal · 760 × 620</option>
                    <option value="large">Amplo · 960 × 760</option>
                  </select>
                </label>
              </div>
            )}
            {creationTab === "agent" && (
              <div className="terminal-creation-content">
                <div className="agent-mode-options">
                  <button
                    className={agentMode === "orchestrator" ? "active" : ""}
                    onClick={() => setAgentPreset("orchestrator")}
                    type="button"
                  >
                    <ScrambleText text="Orquestrador" />
                  </button>
                  <button
                    className={agentMode === "free" ? "active" : ""}
                    onClick={() => setAgentPreset("free")}
                    type="button"
                  >
                    <ScrambleText text="Chat livre" />
                  </button>
                  <button
                    className={agentMode === "specialist" ? "active" : ""}
                    onClick={() => setAgentPreset("specialist")}
                    type="button"
                  >
                    <ScrambleText text="Especialista" />
                  </button>
                </div>
                {agentMode === "specialist" && (
                  <label>
                    Especialidade
                    <select
                      value={specialistRole}
                      onChange={(event) => {
                        const nextRole = event.target.value as AgentRole;
                        setSpecialistRole(nextRole);
                        setAgentName(nextRole === "Tests" ? "Tester" : nextRole);
                      }}
                    >
                      <option value="Tests">Tester</option>
                      <option value="Architect">Architect</option>
                      <option value="Reviewer">Reviewer</option>
                      <option value="Backend">Backend</option>
                    </select>
                  </label>
                )}
                <label>
                  Instruções do agente
                  <textarea
                    maxLength={3000}
                    value={agentInstructions}
                    onChange={(event) => setAgentInstructions(event.target.value)}
                    placeholder="Opcional"
                  />
                </label>
              </div>
            )}
          </form>
        </div>
      )}
      {connectingFrom && (
        <p className="muted canvas-hint">
          Escolha outro agente para criar a conexão, ou clique na origem novamente para
          cancelar.
        </p>
      )}
      {canvas.connections.length > 0 && (
        <div className="canvas-connection-list" aria-label="Conexões do fluxo">
          <strong>Fluxo entre agentes</strong>
          {canvas.connections.map((connection) => (
            <div className="canvas-connection" key={connection.id}>
              <span>{nodeById.get(connection.fromAgentId)?.name ?? "Agente"}</span>
              <span aria-hidden="true" className="connection-arrow">
                →
              </span>
              <span>{nodeById.get(connection.toAgentId)?.name ?? "Agente"}</span>
              <button
                disabled={disabled}
                onClick={() => void removeConnection(connection.id)}
              >
                Remover conexão
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
