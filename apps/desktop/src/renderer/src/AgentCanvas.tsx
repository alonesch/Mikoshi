import { useEffect, useRef, useState } from "react";
import type { FormEvent, JSX, MouseEvent as ReactMouseEvent, PointerEvent } from "react";
import type { AgentCanvasState, AgentRole, ProviderId } from "../../contracts";
import type { AgentCanvasModel, AgentCanvasNode } from "./agent-canvas-model";
import { AgentTerminal } from "./AgentTerminal";

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
  onSaveCanvas,
}: AgentCanvasProps): JSX.Element {
  const [canvas, setCanvas] = useState(model);
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

  useEffect(() => setCanvas(model), [model]);
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
    if (activeTool !== "terminal" || !board.current) return;
    const target = event.target;
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
    if (!drag.current) return;
    drag.current = null;
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

  const nodeById = new Map(canvas.nodes.map((node) => [node.agentId, node]));

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
                  <path d="M0,0 L8,4 L0,8 z" fill="#91d8c2" />
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
            {canvas.nodes.map((node) => (
              <article
                aria-label={`Agente ${node.name}`}
                className={
                  "canvas-node " + (node.agentId === selectedAgentId ? "selected" : "")
                }
                key={node.agentId}
                style={{
                  height: node.height,
                  left: node.x,
                  top: node.y,
                  width: node.width,
                }}
              >
                <header
                  className="canvas-node-header"
                  onPointerDown={(event) => {
                    if (event.target instanceof Element && event.target.closest("button"))
                      return;
                    beginDrag(event, {
                      type: "move",
                      agentId: node.agentId,
                      pointerX: event.clientX,
                      pointerY: event.clientY,
                      x: node.x,
                      y: node.y,
                    });
                  }}
                >
                  <strong>{node.name}</strong>
                  <button
                    aria-label={`Selecionar ${node.name}`}
                    disabled={disabled}
                    onClick={() => onSelectAgent(node.agentId)}
                    title="Selecionar agente"
                  >
                    ↗
                  </button>
                  <button
                    aria-label={`Excluir terminal ${node.name}`}
                    className="canvas-node-delete"
                    disabled={disabled}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Excluir o terminal "${node.name}" do workspace? A sessão ativa será encerrada.`,
                        )
                      )
                        void onDeleteAgent(node.agentId);
                    }}
                    title="Excluir terminal"
                  >
                    ×
                  </button>
                </header>
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
                    />
                  )}
                  <button
                    className={connectingFrom === node.agentId ? "selected" : ""}
                    disabled={disabled}
                    onClick={() => connectAgent(node.agentId)}
                  >
                    {connectingFrom === node.agentId
                      ? "Origem selecionada"
                      : connectingFrom
                        ? "Conectar destino"
                        : "Conectar a outro agente"}
                  </button>
                </div>
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
              </article>
            ))}
          </div>
        )}
      </div>
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
            <div className="terminal-creation-header">
              <button
                className="text-button"
                type="button"
                onClick={() => setCreationPosition(null)}
              >
                Cancelar
              </button>
              <strong>Novo terminal</strong>
              <button disabled={disabled || !availableProviders.length} type="submit">
                Criar
              </button>
            </div>
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
                  {providerLabels[provider]}
                </button>
              ))}
              {!availableProviders.length && (
                <button className="secondary" onClick={onOpenSettings} type="button">
                  Configurar providers
                </button>
              )}
            </div>
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
                  {tab === "details"
                    ? "Detalhes"
                    : tab === "appearance"
                      ? "Aparência"
                      : "Agente"}
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
                    Orquestrador
                  </button>
                  <button
                    className={agentMode === "free" ? "active" : ""}
                    onClick={() => setAgentPreset("free")}
                    type="button"
                  >
                    Chat livre
                  </button>
                  <button
                    className={agentMode === "specialist" ? "active" : ""}
                    onClick={() => setAgentPreset("specialist")}
                    type="button"
                  >
                    Especialista
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
