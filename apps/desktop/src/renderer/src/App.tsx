import { useEffect, useState } from "react";
import type { JSX } from "react";
import { AgentCanvas } from "./AgentCanvas";
import type { AgentCanvasCreation } from "./AgentCanvas";
import { buildAgentCanvasModel, type AgentCanvasModel } from "./agent-canvas-model";
import type {
  AgentCanvasState,
  AgentRole,
  MemoryDraft,
  MemoryChange,
  MemoryKind,
  MemoryOperation,
  MemoryApproval,
  Permission,
  PathMappingPreview,
  Project,
  ProjectSnapshot,
  ProviderStatus,
  ProviderId,
  Selection,
  WorkingContext,
} from "../../contracts";

const labels: Record<MemoryKind, string> = {
  decision: "Decisão",
  instruction: "Instrução",
  fact: "Fato",
  task: "Tarefa",
  issue: "Problema",
  preference: "Preferência",
};
const providerNames: Record<ProviderId, string> = {
  codex: "Codex",
  claude: "Claude Code",
  antigravity: "Google Antigravity",
  kimi: "Kimi Code",
};
const providerIds: ProviderId[] = ["codex", "claude", "antigravity", "kimi"];
const statuses: Record<string, string> = {
  running: "Em execução",
  waiting_review: "Aguardando revisão da memória",
  completed: "Concluído",
  failed: "Falhou",
  cancelled: "Cancelado",
  interrupted: "Interrompido",
};
const operationLabels: Record<MemoryChange["op"], string> = {
  add: "Adicionar",
  update: "Atualizar",
  delete: "Remover",
  mark_obsolete: "Marcar obsoleta",
  restore: "Restaurar",
};
const historyLabels: Record<MemoryOperation, string> = {
  ADD: "Adicionada",
  UPDATE: "Atualizada",
  REMOVE: "Removida",
  MARK_OBSOLETE: "Marcada como obsoleta",
  RESTORE: "Restaurada",
};
const emptyCanvasModel: AgentCanvasModel = {
  nodes: [],
  connections: [],
  viewport: { x: 0, y: 0, zoom: 1 },
};

function DraftReview({
  draft,
  snapshot,
  busy,
  onApply,
  onReject,
}: {
  draft: MemoryDraft;
  snapshot: ProjectSnapshot;
  busy: boolean;
  onApply: (approval: MemoryApproval) => void;
  onReject: () => void;
}): JSX.Element {
  const [selected, setSelected] = useState(draft.changes.map(() => true));
  const [texts, setTexts] = useState(draft.changes.map((change) => change.text));
  const [selectedAgents, setSelectedAgents] = useState(
    draft.engramOrchestration?.agents.map((agent) => agent.id) ?? [],
  );
  const [selectedHandoffs, setSelectedHandoffs] = useState(
    draft.engramOrchestration?.handoffs.map((handoff) => handoff.id) ?? [],
  );
  const [includeHistory, setIncludeHistory] = useState(
    Boolean(draft.engramHistory?.length),
  );
  return (
    <section className="review">
      <h3>Revisar diff · {draft.source}</h3>
      <p>
        Revisão base {draft.baseRevision} · {draft.redactions} redações automáticas.
        Edite, aprove ou rejeite. Nenhuma alteração foi aplicada.
      </p>
      {draft.changes.map((change, index) => (
        <div className="change" key={index}>
          <label>
            <input
              type="checkbox"
              checked={selected[index]}
              onChange={(event) =>
                setSelected((values) =>
                  values.map((value, i) => (i === index ? event.target.checked : value)),
                )
              }
            />
            {operationLabels[change.op]} · {labels[change.kind]}
          </label>
          {change.targetId && (
            <p className="muted">
              Antes:{" "}
              {snapshot.memory.items.find((item) => item.id === change.targetId)?.text ??
                "Item não encontrado"}
            </p>
          )}
          <textarea
            aria-label={"Alteração " + (index + 1)}
            value={texts[index]}
            disabled={change.op === "delete" || change.op === "mark_obsolete"}
            onChange={(event) =>
              setTexts((values) =>
                values.map((value, i) => (i === index ? event.target.value : value)),
              )
            }
          />
          <small>Origem: {change.source}</small>
          {change.evidence && <small> · Evidência: {change.evidence}</small>}
        </div>
      ))}
      {draft.securitySummary && (
        <p className="notice">
          Scanner: {draft.securitySummary.highConfidenceRedactions} segredos reconhecidos
          removidos e {draft.securitySummary.heuristicCandidates} candidatos de entropia.
          Texto mascarado não foi enviado ao provider. Revise linhas alteradas para
          detectar falsos positivos; recupere fatos conferindo a fonte, nunca copiando
          credenciais.
        </p>
      )}
      {draft.conflicts && draft.conflicts.length > 0 && (
        <div className="alert">
          <strong>Conflitos que exigem revisão</strong>
          {draft.conflicts.map((conflict) => (
            <div className="change" key={conflict.itemId}>
              <small>{conflict.reason}</small>
              <p>Atual: {conflict.current}</p>
              <p>Engram: {conflict.incoming}</p>
            </div>
          ))}
        </div>
      )}
      {draft.engramOrchestration && (
        <div className="change">
          <strong>Configurações do Engram · revisão separada</strong>
          <p className="muted">
            {draft.engramOrchestration.agents.length} agentes e{" "}
            {draft.engramOrchestration.handoffs.length} handoffs candidatos. Handoffs só
            são restaurados se os dois agentes forem aprovados.
            {draft.mappingCount
              ? ` ${draft.mappingCount} mapeamentos portáveis detectados; raízes locais não foram importadas.`
              : ""}
          </p>
          {draft.engramOrchestration.agents.map((agent) => (
            <div key={agent.id}>
              <label>
                <input
                  type="checkbox"
                  checked={selectedAgents.includes(agent.id)}
                  onChange={(event) =>
                    setSelectedAgents((ids) =>
                      event.target.checked
                        ? [...ids, agent.id]
                        : ids.filter((id) => id !== agent.id),
                    )
                  }
                />
                {agent.name} · {agent.role} · {agent.provider} —{" "}
                {agent.instructions || "sem instruções"}
              </label>
              {snapshot.orchestration.agents.some(
                (current) => current.id === agent.id,
              ) && (
                <small className="muted">
                  Substituir configuração atual:{" "}
                  {
                    snapshot.orchestration.agents.find(
                      (current) => current.id === agent.id,
                    )?.name
                  }{" "}
                  ·{" "}
                  {
                    snapshot.orchestration.agents.find(
                      (current) => current.id === agent.id,
                    )?.role
                  }{" "}
                  ·{" "}
                  {
                    snapshot.orchestration.agents.find(
                      (current) => current.id === agent.id,
                    )?.provider
                  }
                  .
                </small>
              )}
            </div>
          ))}
          {draft.engramOrchestration.handoffs.map((handoff) => (
            <label key={handoff.id}>
              <input
                type="checkbox"
                checked={selectedHandoffs.includes(handoff.id)}
                disabled={
                  !selectedAgents.includes(handoff.fromAgentId) ||
                  !selectedAgents.includes(handoff.toAgentId)
                }
                onChange={(event) =>
                  setSelectedHandoffs((ids) =>
                    event.target.checked
                      ? [...ids, handoff.id]
                      : ids.filter((id) => id !== handoff.id),
                  )
                }
              />
              Handoff ·{" "}
              {draft.engramOrchestration?.agents.find(
                (agent) => agent.id === handoff.fromAgentId,
              )?.name ?? "Agente"}
              {" → "}
              {draft.engramOrchestration?.agents.find(
                (agent) => agent.id === handoff.toAgentId,
              )?.name ?? "Agente"}
              {" · "}
              {handoff.task} — {handoff.summary}
            </label>
          ))}
        </div>
      )}
      {draft.engramHistory && draft.engramHistory.length > 0 && (
        <label>
          <input
            type="checkbox"
            checked={includeHistory}
            onChange={(event) => setIncludeHistory(event.target.checked)}
          />
          Importar também {draft.engramHistory.length} eventos de auditoria anteriores.
          Eventos duplicados ou sem item correspondente serão ignorados.
        </label>
      )}
      <div className="actions">
        <button
          disabled={
            busy ||
            (!selected.some(Boolean) &&
              !selectedAgents.length &&
              !selectedHandoffs.length &&
              !includeHistory)
          }
          onClick={() =>
            onApply({
              changes: selected.flatMap((checked, index) =>
                checked ? [{ index, text: texts[index] }] : [],
              ),
              agentIds: selectedAgents,
              handoffIds: selectedHandoffs,
              includeHistory,
            })
          }
        >
          Aprovar selecionadas
        </button>
        <button className="secondary" disabled={busy} onClick={onReject}>
          Rejeitar diff
        </button>
      </div>
    </section>
  );
}

export function App(): JSX.Element {
  const [projects, setProjects] = useState<Project[]>([]);
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeView, setActiveView] = useState<"canvas" | "memory">("canvas");
  const [projectFilter, setProjectFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [task, setTask] = useState("");
  const [role, setRole] = useState<AgentRole>("Architect");
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [handoffTask, setHandoffTask] = useState("");
  const [handoffTargetId, setHandoffTargetId] = useState("");
  const [handoffRunId, setHandoffRunId] = useState("");
  const [mappingSourceRoot, setMappingSourceRoot] = useState("");
  const [mappingPreview, setMappingPreview] = useState<PathMappingPreview | null>(null);
  const [permission, setPermission] = useState<Permission>("read-only");
  const [context, setContext] = useState<WorkingContext | null>(null);
  const [kind, setKind] = useState<MemoryKind>("decision");
  const [memoryText, setMemoryText] = useState("");
  const [replacementId, setReplacementId] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const active = snapshot?.runs.find((run) => run.status === "running");
  const currentDraft = snapshot?.drafts[0];
  const selectedAgent = snapshot?.orchestration.agents.find(
    (agent) => agent.id === selectedAgentId,
  );
  const provider = providers.find((entry) => entry.provider === selectedAgent?.provider);
  const kimiReadOnlyBlocked =
    selectedAgent?.provider === "kimi" && permission === "read-only";
  const handoffSourceAgentId = snapshot?.runs.find(
    (run) => run.id === handoffRunId,
  )?.agentId;
  const canvasHandoffTargets = new Set(
    snapshot?.orchestration.canvas?.connections
      .filter((connection) => connection.fromAgentId === handoffSourceAgentId)
      .map((connection) => connection.toAgentId) ?? [],
  );
  const handoffCandidates = snapshot?.orchestration.agents.filter(
    (agent) =>
      agent.id !== handoffSourceAgentId &&
      (canvasHandoffTargets.size === 0 || canvasHandoffTargets.has(agent.id)),
  );

  async function action(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Falha no aplicativo.");
    } finally {
      setBusy(false);
    }
  }
  async function refresh(id: string): Promise<void> {
    const next = await window.mikoshi.getProject(id);
    setSnapshot(next);
    setProjects(await window.mikoshi.listProjects());
  }
  useEffect(() => {
    let cancelled = false;
    void Promise.all([window.mikoshi.listProjects(), window.mikoshi.providerStatus()])
      .then(async ([list, state]) => {
        if (cancelled) return;
        setProjects(list);
        setProviders(state);
        if (list.length) {
          const next = await window.mikoshi.getProject(list[0].id);
          if (!cancelled) setSnapshot(next);
        }
      })
      .catch((failure) => {
        if (!cancelled) setError(String(failure));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    setContext(null);
  }, [task, role, permission, snapshot?.project.id, snapshot?.memory.revision]);
  useEffect(
    () =>
      window.mikoshi.onAgentHandoffEvent(({ projectId, handoff }) => {
        setSnapshot((current) => {
          if (!current || current.project.id !== projectId) return current;
          return {
            ...current,
            orchestration: {
              ...current.orchestration,
              handoffs: [
                handoff,
                ...current.orchestration.handoffs.filter(
                  (entry) => entry.id !== handoff.id,
                ),
              ],
            },
          };
        });
      }),
    [],
  );
  useEffect(() => {
    setEditingId(null);
    setMemoryText("");
    setTask("");
  }, [snapshot?.project.id]);
  useEffect(() => {
    const agents = snapshot?.orchestration.agents ?? [];
    if (agents.length && !agents.some((agent) => agent.id === selectedAgentId)) {
      setSelectedAgentId(agents[0].id);
      setRole(agents[0].role);
    }
  }, [snapshot?.project.id, snapshot?.orchestration.agents, selectedAgentId]);
  useEffect(() => {
    if (!selectedAgent) return;
    setRole(selectedAgent.role);
  }, [selectedAgent?.id]);
  useEffect(() => {
    if (!snapshot?.project.id || !active) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void window.mikoshi
        .getProject(snapshot.project.id)
        .then((next) => {
          if (!cancelled) setSnapshot(next);
        })
        .catch((failure) => {
          if (!cancelled) setError(String(failure));
        });
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [snapshot?.project.id, active?.id]);

  const taskInput = {
    task,
    role: selectedAgent?.role ?? role,
    permission,
    ...(selectedAgent
      ? {
          agentId: selectedAgent.id,
          agentName: selectedAgent.name,
          agentInstructions: selectedAgent.instructions,
        }
      : {}),
  };

  async function handleSelectProject(): Promise<void> {
    await action(async () => {
      const next = await window.mikoshi.selectProject();
      if (next) {
        setSnapshot(next);
        setProjects(await window.mikoshi.listProjects());
        setActiveView("canvas");
      }
    });
  }

  async function handleBootstrap(): Promise<void> {
    if (!snapshot) return;
    await action(async () => {
      await window.mikoshi.bootstrap(snapshot.project.id);
      await refresh(snapshot.project.id);
    });
  }

  async function handlePrepareContext(): Promise<void> {
    if (!snapshot) return;
    await action(async () => {
      setContext(await window.mikoshi.buildContext(snapshot.project.id, taskInput));
    });
  }

  async function handleStartAgent(): Promise<void> {
    if (!snapshot || !selectedAgent) return;
    await action(async () => {
      await window.mikoshi.startManagedAgent(
        snapshot.project.id,
        selectedAgent.id,
        task,
        permission,
      );
      await refresh(snapshot.project.id);
      setContext(null);
    });
  }

  async function handleCreateCanvasAgent(
    creation: AgentCanvasCreation,
  ): Promise<boolean> {
    if (!snapshot) return false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const knownAgentIds = new Set(
        snapshot.orchestration.agents.map((agent) => agent.id),
      );
      let next = await window.mikoshi.createCanvasAgent(
        snapshot.project.id,
        creation.provider,
        creation.role,
      );
      const createdAgent = next.orchestration.agents.find(
        (agent) => !knownAgentIds.has(agent.id),
      );
      if (!createdAgent) throw new Error("A Mikoshi não retornou o novo agente.");

      next = await window.mikoshi.saveAgent(snapshot.project.id, {
        id: createdAgent.id,
        name: creation.name || createdAgent.name,
        role: creation.role,
        provider: creation.provider,
        instructions: creation.instructions || createdAgent.instructions,
      });
      const canvas = next.orchestration.canvas ?? {
        positions: [],
        connections: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      };
      next = await window.mikoshi.saveAgentCanvas(snapshot.project.id, {
        ...canvas,
        positions: [
          ...canvas.positions.filter((position) => position.agentId !== createdAgent.id),
          {
            agentId: createdAgent.id,
            x: creation.x,
            y: creation.y,
            width: creation.width,
            height: creation.height,
          },
        ],
      });

      setSelectedAgentId(createdAgent.id);
      setRole(creation.role);
      try {
        await window.mikoshi.startAgentTerminal(
          snapshot.project.id,
          createdAgent.id,
          100,
          30,
        );
      } catch (terminalFailure) {
        setError(
          terminalFailure instanceof Error
            ? `Terminal criado, mas não foi possível iniciar a CLI: ${terminalFailure.message}`
            : "Terminal criado, mas não foi possível iniciar a CLI.",
        );
      }
      setSnapshot(await window.mikoshi.getProject(snapshot.project.id));
      setNotice(`${creation.name || creation.role} criado no canvas.`);
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Falha ao criar terminal.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteCanvasAgent(agentId: string): Promise<void> {
    if (!snapshot) return;
    await action(async () => {
      const next = await window.mikoshi.deleteAgent(snapshot.project.id, agentId);
      setSnapshot(next);
      if (selectedAgentId === agentId)
        setSelectedAgentId(next.orchestration.agents[0]?.id ?? "");
      setNotice("Terminal removido do workspace.");
    });
  }

  async function handlePreviewPathMapping(): Promise<void> {
    if (!snapshot) return;
    await action(async () => {
      setMappingPreview(
        await window.mikoshi.previewPathMapping(snapshot.project.id, mappingSourceRoot),
      );
    });
  }

  async function handleSavePathMapping(): Promise<void> {
    if (!snapshot || !mappingPreview?.targetExists) return;
    await action(async () => {
      setSnapshot(
        await window.mikoshi.savePathMapping(snapshot.project.id, mappingSourceRoot),
      );
      setNotice(
        "Mapeamento local salvo. Só referências dentro da raiz de origem serão convertidas.",
      );
      setMappingSourceRoot("");
      setMappingPreview(null);
    });
  }

  async function handleHandoff(): Promise<void> {
    if (!snapshot || !handoffRunId || !handoffTargetId) return;
    await action(async () => {
      await window.mikoshi.handoffAgent(
        snapshot.project.id,
        handoffRunId,
        handoffTargetId,
        handoffTask,
      );
      await refresh(snapshot.project.id);
      setNotice("Handoff registrado pela Mikoshi e enviado ao agente de destino.");
    });
  }

  async function handleCancelAgent(): Promise<void> {
    if (!snapshot || !active) return;
    await action(async () => {
      await window.mikoshi.cancelAgent(snapshot.project.id, active.id);
      await refresh(snapshot.project.id);
    });
  }

  async function handleSaveAgentCanvas(canvas: AgentCanvasState): Promise<void> {
    if (!snapshot) return;
    await action(async () => {
      setSnapshot(await window.mikoshi.saveAgentCanvas(snapshot.project.id, canvas));
    });
  }

  return (
    <main className="mikoshi-shell">
      <header className="app-topbar">
        <button
          aria-label={sidebarOpen ? "Recolher menu" : "Abrir menu"}
          className="icon-button"
          onClick={() => setSidebarOpen((open) => !open)}
          title={sidebarOpen ? "Recolher menu" : "Abrir menu"}
        >
          ☰
        </button>
        <strong>{snapshot?.project.name ?? "Mikoshi"}</strong>
        <span className="badge">Canvas de agentes</span>
      </header>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <div className={`layout ${sidebarOpen ? "" : "drawer-collapsed"}`}>
        <aside className="workspace-drawer" aria-label="Menu principal">
          <div className="drawer-project-heading">
            <input
              aria-label="Filtrar workspaces"
              placeholder="Filtrar"
              value={projectFilter}
              onChange={(event) => setProjectFilter(event.target.value)}
            />
            <button
              aria-label="Adicionar workspace"
              className="icon-button"
              disabled={busy || Boolean(active)}
              onClick={handleSelectProject}
              title="Adicionar workspace"
            >
              +
            </button>
          </div>
          <strong className="drawer-section-label">WORKSPACES</strong>
          <nav className="workspace-list">
            {projects
              .filter((project) =>
                `${project.name} ${project.root}`
                  .toLocaleLowerCase()
                  .includes(projectFilter.toLocaleLowerCase()),
              )
              .map((project) => (
                <button
                  className={
                    "project " + (project.id === snapshot?.project.id ? "selected" : "")
                  }
                  key={project.id}
                  disabled={busy || Boolean(active)}
                  onClick={() =>
                    void action(async () => {
                      setSnapshot(await window.mikoshi.getProject(project.id));
                      setActiveView("canvas");
                    })
                  }
                >
                  {project.name}
                  <small>{project.root}</small>
                </button>
              ))}
          </nav>
          <div className="drawer-navigation">
            <button
              className={activeView === "canvas" ? "selected" : ""}
              onClick={() => setActiveView("canvas")}
            >
              Canvas
            </button>
          </div>
          <div className="drawer-footer">
            <button className="secondary" onClick={() => setSettingsOpen(true)}>
              Configurações
            </button>
          </div>
        </aside>
        {!snapshot ? (
          <div className={`content content-${activeView}`}>
            {activeView === "memory" && (
              <section className="empty">
                <h2>Selecione um workspace</h2>
                <p>Memória, importação e exportação ficam disponíveis por projeto.</p>
                <button onClick={handleSelectProject}>Criar workspace</button>
              </section>
            )}
            <section className="agent-workspace-section">
              <AgentCanvas
                model={emptyCanvasModel}
                selectedAgentId=""
                projectReady={false}
                providerAvailable={providers.some((entry) => entry.installed)}
                availableProviders={providers
                  .filter((entry) => entry.installed)
                  .map((entry) => entry.provider)}
                disabled={busy}
                onSelectAgent={() => undefined}
                onDeleteAgent={async () => undefined}
                onCreateCanvasAgent={async () => false}
                onOpenSettings={() => setSettingsOpen(true)}
                onSaveCanvas={async () => undefined}
              />
            </section>
          </div>
        ) : (
          <div className={`content content-${activeView}`}>
            <section>
              <h2>{snapshot.project.name}</h2>
              <small className="muted">
                ID {snapshot.project.id} · revisão da memória {snapshot.memory.revision}
              </small>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void handlePreviewPathMapping();
                }}
              >
                <h3>Paths entre máquinas</h3>
                <label>
                  Raiz antiga deste projeto
                  <input
                    required
                    maxLength={2000}
                    value={mappingSourceRoot}
                    onChange={(event) => {
                      setMappingSourceRoot(event.target.value);
                      setMappingPreview(null);
                    }}
                    placeholder="F:\\Repos\\MeuProjeto ou /home/user/repos/meu-projeto"
                  />
                </label>
                <div className="actions">
                  <button
                    className="secondary"
                    disabled={busy || !mappingSourceRoot.trim()}
                  >
                    Pré-visualizar
                  </button>
                  {mappingPreview && (
                    <button
                      type="button"
                      disabled={busy || !mappingPreview.targetExists}
                      onClick={() => void handleSavePathMapping()}
                    >
                      Salvar mapeamento
                    </button>
                  )}
                </div>
                {mappingPreview && (
                  <p className={mappingPreview.targetExists ? "notice" : "alert"}>
                    {mappingPreview.sourceRoot} → {mappingPreview.targetRoot}
                    {" · "}
                    {mappingPreview.referenceCount} referências locais detectadas.
                    {!mappingPreview.targetExists && " A raiz de destino não existe."}
                  </p>
                )}
                {snapshot.pathMappings.map((mapping) => (
                  <small className="muted" key={mapping.sourceRoot}>
                    {mapping.sourceRoot} → {mapping.targetRoot}
                  </small>
                ))}
              </form>
              <div className="actions">
                <button disabled={busy || Boolean(active)} onClick={handleBootstrap}>
                  Bootstrap para revisão
                </button>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      if (await window.mikoshi.exportEngram(snapshot.project.id))
                        setNotice(
                          "Engram exportado com memória e contexto do projeto. Paths locais e execuções ficam nesta máquina.",
                        );
                    })
                  }
                >
                  Exportar Engram
                </button>
                <button
                  className="secondary"
                  disabled={busy || Boolean(active)}
                  onClick={() =>
                    void action(async () => {
                      await window.mikoshi.importEngram(snapshot.project.id);
                      await refresh(snapshot.project.id);
                    })
                  }
                >
                  Importar para revisão
                </button>
              </div>
              <h3>
                Memória canônica ·{" "}
                {snapshot.memory.items.filter((item) => item.status === "active").length}{" "}
                ativas
                {" · "}
                {snapshot.memory.items.length} no histórico
              </h3>
              {!snapshot.memory.items.length && (
                <p className="muted">
                  Nenhuma memória aprovada. O bootstrap lê somente documentação e
                  manifesto reconhecidos.
                </p>
              )}
              <div className="memories">
                {snapshot.memory.items.map((item) => (
                  <article key={item.id}>
                    <strong>
                      {labels[item.kind]} ·{" "}
                      {item.status === "active"
                        ? "Ativa"
                        : item.status === "obsolete"
                          ? "Obsoleta"
                          : "Removida"}
                    </strong>
                    <p>{item.text}</p>
                    <small>
                      {item.provenance.at(-1)?.source} · {item.provenance.at(-1)?.date}
                    </small>
                    <div className="actions">
                      {item.status === "active" && (
                        <>
                          <button
                            className="secondary"
                            disabled={busy || Boolean(active)}
                            onClick={() => {
                              setEditingId(item.id);
                              setKind(item.kind);
                              setMemoryText(item.text);
                            }}
                          >
                            Editar
                          </button>
                          <button
                            className="secondary"
                            disabled={busy || Boolean(active)}
                            onClick={() =>
                              void action(async () => {
                                await window.mikoshi.proposeMemory(snapshot.project.id, [
                                  {
                                    op: "mark_obsolete",
                                    targetId: item.id,
                                    ...(replacementId
                                      ? { replacedBy: replacementId }
                                      : {}),
                                    kind: item.kind,
                                    text: item.text,
                                    source: "manual",
                                  },
                                ]);
                                await refresh(snapshot.project.id);
                              })
                            }
                          >
                            Marcar obsoleta
                          </button>
                          <button
                            className="secondary"
                            disabled={busy || Boolean(active)}
                            onClick={() =>
                              void action(async () => {
                                await window.mikoshi.proposeMemory(snapshot.project.id, [
                                  {
                                    op: "delete",
                                    targetId: item.id,
                                    kind: item.kind,
                                    text: "Remover item",
                                    source: "manual",
                                  },
                                ]);
                                await refresh(snapshot.project.id);
                              })
                            }
                          >
                            Propor remoção
                          </button>
                        </>
                      )}
                      {item.status !== "active" && (
                        <button
                          className="secondary"
                          disabled={busy || Boolean(active)}
                          onClick={() =>
                            void action(async () => {
                              await window.mikoshi.proposeMemory(snapshot.project.id, [
                                {
                                  op: "restore",
                                  targetId: item.id,
                                  kind: item.kind,
                                  text: item.text,
                                  source: "manual",
                                },
                              ]);
                              await refresh(snapshot.project.id);
                            })
                          }
                        >
                          Propor restauração
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void action(async () => {
                    await window.mikoshi.proposeMemory(snapshot.project.id, [
                      {
                        op: editingId ? "update" : "add",
                        ...(editingId ? { targetId: editingId } : {}),
                        kind,
                        text: memoryText,
                        source: "manual",
                      },
                    ]);
                    setMemoryText("");
                    setEditingId(null);
                    await refresh(snapshot.project.id);
                  });
                }}
              >
                <h3>{editingId ? "Editar memória por diff" : "Adicionar memória"}</h3>
                <label>
                  Tipo
                  <select
                    value={kind}
                    onChange={(event) => setKind(event.target.value as MemoryKind)}
                  >
                    {Object.entries(labels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Substituída por (opcional)
                  <select
                    value={replacementId}
                    onChange={(event) => setReplacementId(event.target.value)}
                  >
                    <option value="">Sem referência</option>
                    {snapshot.memory.items
                      .filter((item) => item.status === "active" && item.id !== editingId)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {labels[item.kind]} · {item.text.slice(0, 100)}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Conteúdo
                  <textarea
                    value={memoryText}
                    maxLength={4000}
                    required
                    onChange={(event) => setMemoryText(event.target.value)}
                  />
                </label>
                <div className="actions">
                  <button disabled={busy || Boolean(active)}>Propor diff</button>
                  {editingId && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setEditingId(null);
                        setMemoryText("");
                      }}
                    >
                      Cancelar edição
                    </button>
                  )}
                </div>
              </form>
              <details>
                <summary>
                  Auditoria de memória · {snapshot.memory.history.length} eventos
                </summary>
                {snapshot.memory.history
                  .slice(-30)
                  .reverse()
                  .map((event) => (
                    <article className="run" key={event.id}>
                      <strong>{historyLabels[event.operation]}</strong>
                      <p>{event.current?.text ?? event.previous?.text}</p>
                      <small>
                        {event.source} · {event.date}
                      </small>
                    </article>
                  ))}
              </details>
            </section>
            {currentDraft && (
              <DraftReview
                key={currentDraft.id}
                draft={currentDraft}
                snapshot={snapshot}
                busy={busy || Boolean(active)}
                onApply={(selections) =>
                  void action(async () => {
                    setSnapshot(
                      await window.mikoshi.applyMemory(
                        snapshot.project.id,
                        currentDraft.id,
                        selections,
                      ),
                    );
                    setNotice(
                      "Alterações aprovadas. Os demais itens da memória foram preservados.",
                    );
                  })
                }
                onReject={() =>
                  void action(async () => {
                    setSnapshot(
                      await window.mikoshi.rejectMemory(
                        snapshot.project.id,
                        currentDraft.id,
                      ),
                    );
                  })
                }
              />
            )}
            {snapshot.drafts.length > 1 && (
              <p className="muted">
                {snapshot.drafts.length - 1} outros diffs pendentes. Revise ou rejeite o
                atual para acessar o próximo.
              </p>
            )}
            <section className="agent-workspace-section">
              <AgentCanvas
                model={buildAgentCanvasModel(snapshot.orchestration)}
                projectId={snapshot.project.id}
                projectRoot={snapshot.project.root}
                selectedAgentId={selectedAgentId}
                projectReady
                providerAvailable={providers.some((entry) => entry.installed)}
                availableProviders={providers
                  .filter((entry) => entry.installed)
                  .map((entry) => entry.provider)}
                disabled={busy || Boolean(active)}
                onSelectAgent={(agentId) => {
                  setSelectedAgentId(agentId);
                }}
                onDeleteAgent={handleDeleteCanvasAgent}
                onCreateCanvasAgent={handleCreateCanvasAgent}
                onOpenSettings={() => setSettingsOpen(true)}
                onSaveCanvas={handleSaveAgentCanvas}
              />
            </section>
            <details className="advanced-workflows">
              <summary>Execução estruturada e handoffs (gera diffs revisáveis)</summary>
              <section>
                <h2>Executar agente</h2>
                <p className="muted">
                  Cada execução tem seu próprio contexto temporário. Papéis e resultados
                  ficam no estado operacional, separado da memória canônica.
                </p>
                <div className="fields">
                  <label>
                    Agente
                    <select
                      value={selectedAgentId}
                      disabled={busy || Boolean(active)}
                      onChange={(event) => {
                        setSelectedAgentId(event.target.value);
                      }}
                    >
                      {!snapshot.orchestration.agents.length && (
                        <option value="">Crie um agente primeiro</option>
                      )}
                      {snapshot.orchestration.agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name} · {agent.provider}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Permissão
                    <select
                      value={permission}
                      disabled={busy || Boolean(active)}
                      onChange={(event) =>
                        setPermission(event.target.value as Permission)
                      }
                    >
                      <option value="read-only">Somente leitura</option>
                      <option value="workspace-write">
                        Permitir alterações no projeto
                      </option>
                    </select>
                  </label>
                </div>
                {permission === "workspace-write" && (
                  <p className="notice">
                    Esta execução poderá alterar arquivos do projeto. Cancelar não desfaz
                    alterações já realizadas.
                  </p>
                )}
                {kimiReadOnlyBlocked && (
                  <p className="notice">
                    O modo print da CLI do Kimi não oferece garantia de somente leitura.
                    Para usar esse provider, selecione “Permitir alterações no projeto”.
                  </p>
                )}
                {selectedAgent?.provider === "antigravity" &&
                  permission === "read-only" && (
                    <p className="muted">
                      Antigravity usa o modo plan. Chamadas de comando podem ser negadas;
                      para executar testes, selecione a permissão de escrita e confira as
                      regras locais de comando da CLI. Esse modo também pode alterar
                      arquivos.
                    </p>
                  )}
                <label>
                  Tarefa
                  <textarea
                    value={task}
                    maxLength={3000}
                    disabled={busy || Boolean(active)}
                    onChange={(event) => setTask(event.target.value)}
                    placeholder="Descreva o objetivo e o resultado esperado."
                  />
                </label>
                <div className="actions">
                  <button
                    className="secondary"
                    disabled={busy || Boolean(active) || !task.trim() || !selectedAgent}
                    onClick={handlePrepareContext}
                  >
                    Preparar contexto
                  </button>
                  <button
                    disabled={
                      busy ||
                      Boolean(active) ||
                      !context ||
                      !selectedAgent ||
                      kimiReadOnlyBlocked ||
                      provider?.authenticated === false
                    }
                    onClick={handleStartAgent}
                  >
                    Executar agente
                  </button>
                  {active && (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={handleCancelAgent}
                    >
                      Cancelar agente
                    </button>
                  )}
                </div>
                {context && (
                  <details open>
                    <summary>
                      Working context · {context.includedIds.length} memórias ·{" "}
                      {context.omitted} omitidas · {context.redactions} redações
                    </summary>
                    <pre>{context.text}</pre>
                  </details>
                )}
                <h3>Estado operacional</h3>
                {!snapshot.runs.length && (
                  <p className="muted">Nenhuma execução ainda.</p>
                )}
                {snapshot.runs.map((run) => (
                  <article key={run.id} className="run">
                    <strong>
                      {run.role} · {run.provider} → {statuses[run.status]}
                    </strong>
                    <p>{run.task}</p>
                    <small>
                      {run.permission} · {run.startedAt}
                    </small>
                    {run.status === "running" && (
                      <p role="status">
                        Executando na CLI local. A resposta aparecerá aqui.
                      </p>
                    )}
                    {run.output && <pre>{run.output}</pre>}
                    {run.error && <p className="alert">{run.error}</p>}
                    {run.draftId && run.status === "waiting_review" && (
                      <p className="notice">
                        A resposta propôs mudanças de memória. Revise o diff acima para
                        concluir.
                      </p>
                    )}
                  </article>
                ))}
                <h3>Último handoff</h3>
                {snapshot.orchestration.handoffs[0] ? (
                  <article className="run">
                    <strong>
                      {
                        snapshot.orchestration.agents.find(
                          (agent) =>
                            agent.id === snapshot.orchestration.handoffs[0].fromAgentId,
                        )?.name
                      }
                      {" → "}
                      {
                        snapshot.orchestration.agents.find(
                          (agent) =>
                            agent.id === snapshot.orchestration.handoffs[0].toAgentId,
                        )?.name
                      }
                      {" · "}
                      {snapshot.orchestration.handoffs[0].status}
                    </strong>
                    <p>{snapshot.orchestration.handoffs[0].task}</p>
                    <small>{snapshot.orchestration.handoffs[0].summary}</small>
                  </article>
                ) : (
                  <p className="muted">Ainda não há handoffs.</p>
                )}
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleHandoff();
                  }}
                >
                  <h3>Transferir tarefa</h3>
                  <label>
                    Execução concluída
                    <select
                      value={handoffRunId}
                      onChange={(event) => {
                        setHandoffRunId(event.target.value);
                        setHandoffTargetId("");
                      }}
                    >
                      <option value="">Escolha uma execução</option>
                      {snapshot.runs
                        .filter((run) => run.status === "completed" && run.agentId)
                        .map((run) => (
                          <option key={run.id} value={run.id}>
                            {run.role} · {run.task}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Agente de destino
                    <select
                      value={handoffTargetId}
                      onChange={(event) => setHandoffTargetId(event.target.value)}
                    >
                      <option value="">Escolha outro agente</option>
                      {handoffCandidates?.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name} · {agent.provider}
                        </option>
                      ))}
                    </select>
                    {canvasHandoffTargets.size > 0 && (
                      <small className="muted">
                        Destinos limitados pelas conexões de saída deste agente no canvas.
                      </small>
                    )}
                  </label>
                  <label>
                    Próxima tarefa
                    <textarea
                      required
                      maxLength={3000}
                      value={handoffTask}
                      onChange={(event) => setHandoffTask(event.target.value)}
                    />
                  </label>
                  <button
                    disabled={
                      busy ||
                      Boolean(active) ||
                      !handoffRunId ||
                      !handoffTargetId ||
                      !handoffTask.trim()
                    }
                  >
                    Registrar handoff e iniciar destino
                  </button>
                </form>
              </section>
            </details>
          </div>
        )}
      </div>
      {settingsOpen && (
        <div
          className="settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false);
          }}
        >
          <section
            aria-label="Configurações de providers"
            aria-modal="true"
            className="settings-dialog"
            role="dialog"
          >
            <div className="canvas-heading">
              <div>
                <h2>Configurações · Providers</h2>
                <p className="muted">
                  Verifique uma CLI para localizar o executável nesta máquina e
                  adicioná-la ao workspace.
                </p>
              </div>
              <div className="settings-header-actions">
                <button
                  className="secondary"
                  onClick={() => {
                    setSettingsOpen(false);
                    setActiveView("memory");
                  }}
                >
                  Memória e Engram
                </button>
                <button className="secondary" onClick={() => setSettingsOpen(false)}>
                  Fechar
                </button>
              </div>
            </div>
            {providerIds.map((providerId) => {
              const registered = providers.find((entry) => entry.provider === providerId);
              return (
                <article className="settings-provider" key={providerId}>
                  <div>
                    <strong>{providerNames[providerId]}</strong>
                    <small className="muted">
                      {registered
                        ? registered.installed
                          ? `${registered.version} · ${registered.message}`
                          : registered.message
                        : "Ainda não verificado nesta máquina."}
                    </small>
                  </div>
                  <button
                    className={registered ? "secondary" : ""}
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const status = await window.mikoshi.verifyProvider(providerId);
                        setProviders((current) => [
                          status,
                          ...current.filter((entry) => entry.provider !== providerId),
                        ]);
                        setNotice(
                          status.installed
                            ? `${providerNames[providerId]} encontrado e adicionado.`
                            : `${providerNames[providerId]} não foi encontrado.`,
                        );
                      })
                    }
                  >
                    {registered ? "Verificar novamente" : "Verificar e adicionar"}
                  </button>
                </article>
              );
            })}
            <p className="muted">
              A autenticação continua sob controle da CLI local. Os executáveis não são
              portados no Engram.
            </p>
          </section>
        </div>
      )}
    </main>
  );
}
