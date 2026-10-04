import { randomUUID } from "node:crypto";
import type {
  AgentDefinition,
  AgentHandoff,
  AgentState,
  MemoryChange,
  MemoryEvent,
  MemoryItem,
  OrchestrationState,
  PathMapping,
  Project,
  ProjectMemory,
  Provenance,
} from "../../contracts.ts";
import { memoryKinds } from "../../contracts.ts";
import { boundedText, cleanText, validId } from "./security.ts";
import { validateProvenance } from "./store.ts";

export type EngramMode = "merge" | "replace" | "cancel";

export interface EngramConflict {
  itemId: string;
  reason: string;
  current: string;
  incoming: string;
}

export interface EngramOrchestration {
  schemaVersion: 1;
  agents: AgentDefinition[];
  agentStates: AgentState[];
  handoffs: AgentHandoff[];
}

export interface EngramImportResult {
  changes: MemoryChange[];
  redactions: number;
  conflicts: EngramConflict[];
  orchestration: EngramOrchestration;
  history: MemoryEvent[];
  mappingCount: number;
}

function clean(value: string, project: Project): string {
  return cleanText(boundedText(value), project.root).text;
}

function portableHistory(history: MemoryEvent[], project: Project): MemoryEvent[] {
  return history.slice(-1000).map((event) => ({
    ...event,
    source: clean(event.source, project),
    ...(event.previous
      ? { previous: { ...event.previous, text: clean(event.previous.text, project) } }
      : {}),
    ...(event.current
      ? { current: { ...event.current, text: clean(event.current.text, project) } }
      : {}),
    provenance: event.provenance.map((entry) => ({
      source: clean(entry.source, project),
      date: entry.date,
      ...(entry.provider ? { provider: entry.provider } : {}),
    })),
  }));
}

export function exportEngram(
  project: Project,
  memory: ProjectMemory,
  orchestration?: OrchestrationState,
  mappings: PathMapping[] = [],
): string {
  const agents = (orchestration?.agents ?? []).map((agent) => ({
    ...agent,
    name: clean(agent.name, project),
    instructions: clean(agent.instructions, project),
  }));
  const agentIds = new Set(agents.map((agent) => agent.id));
  const envelope = {
    schemaVersion: 2,
    format: "mikoshi-engram",
    project: { id: project.id, name: clean(project.name, project) },
    exportedAt: new Date().toISOString(),
    items: memory.items.map((item) => ({
      ...item,
      text: clean(item.text, project),
      provenance: item.provenance.map((origin) => ({
        date: origin.date,
        ...(origin.provider ? { provider: origin.provider } : {}),
        source: clean(origin.source, project),
      })),
    })),
    history: portableHistory(memory.history, project),
    orchestration: {
      schemaVersion: 1,
      agents,
      agentStates: (orchestration?.agentStates ?? [])
        .filter((state) => agentIds.has(state.agentId))
        .map((state) => ({
          agentId: state.agentId,
          status: "idle" as const,
          ...(state.currentTask
            ? { currentTask: clean(state.currentTask, project) }
            : {}),
          updatedAt: state.updatedAt,
        })),
      handoffs: (orchestration?.handoffs ?? [])
        .filter(
          (handoff) =>
            agentIds.has(handoff.fromAgentId) && agentIds.has(handoff.toAgentId),
        )
        .map((handoff) => {
          const { fromTerminalId, toTerminalId, result, ...portableHandoff } = handoff;
          return {
            ...portableHandoff,
            fromRunId: "<LOCAL_RUN>",
            toRunId: undefined,
            task: clean(handoff.task, project),
            summary: clean(handoff.summary, project),
          };
        }),
    },
    // Host paths never leave this machine. Keep only portable mapping metadata.
    pathMappings: mappings.map(() => ({ sourceRoot: "<PROJECT_ROOT>" })),
  };
  return JSON.stringify(envelope, null, 2) + "\n";
}

function parseOrchestration(value: unknown, project: Project): EngramOrchestration {
  if (!value || typeof value !== "object")
    return { schemaVersion: 1, agents: [], agentStates: [], handoffs: [] };
  const candidate = value as Partial<EngramOrchestration>;
  if (
    candidate.schemaVersion !== 1 ||
    !Array.isArray(candidate.agents) ||
    !Array.isArray(candidate.agentStates) ||
    !Array.isArray(candidate.handoffs) ||
    candidate.agents.length > 100 ||
    candidate.agentStates.length > 100 ||
    candidate.handoffs.length > 500
  )
    throw new Error("Orquestração do Engram inválida.");

  const agents = candidate.agents.map((agent): AgentDefinition => {
    validId(agent.id);
    if (
      !["Orchestrator", "Worker", "Architect", "Backend", "Reviewer", "Tests"].includes(
        agent.role,
      ) ||
      !["codex", "claude", "antigravity", "kimi"].includes(agent.provider) ||
      !Number.isFinite(Date.parse(agent.createdAt))
    )
      throw new Error("Configuração de agente inválida no Engram.");
    return {
      id: agent.id,
      name: clean(boundedText(agent.name, 120), project),
      role: agent.role,
      provider: agent.provider,
      instructions: clean(boundedText(agent.instructions, 4000), project),
      createdAt: new Date(agent.createdAt).toISOString(),
    };
  });
  if (new Set(agents.map((agent) => agent.id)).size !== agents.length)
    throw new Error("Agentes duplicados no Engram.");
  const agentIds = new Set(agents.map((agent) => agent.id));
  const agentStates = candidate.agentStates
    .filter((state) => agentIds.has(state.agentId))
    .map(
      (state): AgentState => ({
        ...state,
        ...(state.currentTask
          ? { currentTask: clean(boundedText(state.currentTask, 3000), project) }
          : {}),
        // Runs are machine-local, so operational state is restored as idle.
        status: "idle",
        runId: undefined,
        updatedAt: new Date().toISOString(),
      }),
    );
  const handoffs = candidate.handoffs
    .filter(
      (handoff) => agentIds.has(handoff.fromAgentId) && agentIds.has(handoff.toAgentId),
    )
    .map(
      (handoff): AgentHandoff => ({
        ...handoff,
        task: clean(boundedText(handoff.task, 3000), project),
        summary: clean(boundedText(handoff.summary, 4000), project),
        // Run ids have no meaning on the receiving machine.
        id: randomUUID(),
        fromRunId: randomUUID(),
        toRunId: undefined,
        status: "pending",
      }),
    );
  return { schemaVersion: 1, agents, agentStates, handoffs };
}

export function importEngram(
  raw: string,
  project: Project,
  memory: ProjectMemory,
  mode: EngramMode = "merge",
): EngramImportResult {
  if (raw.length > 4_000_000) throw new Error("Engram muito grande.");
  const envelope = JSON.parse(raw);
  if (
    ![1, 2].includes(envelope.schemaVersion) ||
    envelope.format !== "mikoshi-engram" ||
    envelope.project?.id !== project.id ||
    !Array.isArray(envelope.items) ||
    envelope.items.length > 1000
  )
    throw new Error(
      "Engram inválido ou pertence a outro projeto. Mapeie a pasta com o mesmo .mikoshi/project.json.",
    );
  if (mode === "cancel")
    return {
      changes: [],
      redactions: 0,
      conflicts: [],
      orchestration: parseOrchestration(undefined, project),
      history: [],
      mappingCount: 0,
    };

  const changes: MemoryChange[] = [];
  const conflicts: EngramConflict[] = [];
  let redactions = 0;
  const incomingIds = new Set<string>();
  const importedIds = new Set<string>();
  for (const item of envelope.items as MemoryItem[]) {
    validId(item.id);
    if (incomingIds.has(item.id) || !memoryKinds.includes(item.kind))
      throw new Error("Itens de Engram inválidos ou duplicados.");
    incomingIds.add(item.id);
    const cleaned = cleanText(boundedText(item.text), project.root);
    redactions += cleaned.redactions;
    const existing = memory.items.find(
      (entry) =>
        entry.id === item.id ||
        entry.provenance.some((origin) => origin.source === "engram:" + item.id),
    );
    const provenance = validateProvenance(item.provenance).map((origin) => ({
      source: clean(origin.source, project),
      date: origin.date,
      ...(origin.provider ? { provider: origin.provider } : {}),
    }));
    const newOrigins = provenance.filter(
      (origin: Provenance) =>
        !existing?.provenance.some(
          (known) =>
            known.source === origin.source &&
            known.date === origin.date &&
            known.sessionId === origin.sessionId &&
            known.provider === origin.provider,
        ),
    );
    if (
      !existing &&
      memory.items.some(
        (entry) =>
          entry.status === "active" &&
          entry.kind === item.kind &&
          entry.text.trim().toLocaleLowerCase("pt-BR") ===
            cleaned.text.trim().toLocaleLowerCase("pt-BR"),
      )
    ) {
      const duplicate = memory.items.find(
        (entry) =>
          entry.status === "active" &&
          entry.kind === item.kind &&
          entry.text.trim().toLocaleLowerCase("pt-BR") ===
            cleaned.text.trim().toLocaleLowerCase("pt-BR"),
      )!;
      conflicts.push({
        itemId: item.id,
        reason: "Conteúdo equivalente já existe com outra identidade.",
        current: duplicate.text,
        incoming: cleaned.text,
      });
      continue;
    }
    if (
      existing &&
      existing.kind === item.kind &&
      existing.text === cleaned.text &&
      newOrigins.length === 0
    ) {
      importedIds.add(existing.id);
      continue;
    }
    if (existing && (existing.kind !== item.kind || existing.text !== cleaned.text)) {
      conflicts.push({
        itemId: existing.id,
        reason: "O mesmo item foi alterado de forma diferente nos dois Engrams.",
        current: existing.text,
        incoming: cleaned.text,
      });
    }
    changes.push({
      op: existing ? "update" : "add",
      ...(existing ? { targetId: existing.id } : {}),
      ...(!existing ? { itemId: item.id } : {}),
      kind: item.kind,
      text: cleaned.text,
      source: "engram:" + item.id,
      provenance: newOrigins,
      ...(item.evidence ? { evidence: item.evidence } : {}),
    });
    importedIds.add(existing?.id ?? item.id);
  }
  if (mode === "replace") {
    for (const item of memory.items) {
      if (item.status === "active" && !importedIds.has(item.id)) {
        changes.push({
          op: "mark_obsolete",
          targetId: item.id,
          kind: item.kind,
          text: item.text,
          source: "engram:replace",
        });
      }
    }
  }
  const orchestration = parseOrchestration(envelope.orchestration, project);
  const knownHistory = new Set(memory.history.map((event) => event.id));
  const validItemIds = new Set([...memory.items.map((item) => item.id), ...importedIds]);
  const history: MemoryEvent[] = [];
  if (envelope.schemaVersion === 2 && envelope.history !== undefined) {
    if (!Array.isArray(envelope.history) || envelope.history.length > 1000)
      throw new Error("Histórico do Engram inválido.");
    for (const rawEvent of envelope.history as MemoryEvent[]) {
      validId(rawEvent.id);
      validId(rawEvent.itemId);
      if (
        knownHistory.has(rawEvent.id) ||
        !validItemIds.has(rawEvent.itemId) ||
        !["ADD", "UPDATE", "REMOVE", "MARK_OBSOLETE", "RESTORE"].includes(
          rawEvent.operation,
        ) ||
        !Number.isFinite(Date.parse(rawEvent.date))
      )
        continue;
      const event: MemoryEvent = {
        id: rawEvent.id,
        itemId: rawEvent.itemId,
        operation: rawEvent.operation,
        source: clean(boundedText(rawEvent.source, 250), project),
        date: rawEvent.date,
        provenance: validateProvenance(rawEvent.provenance).map((origin) => ({
          source: clean(origin.source, project),
          date: origin.date,
          ...(origin.provider ? { provider: origin.provider } : {}),
        })),
        ...(rawEvent.previous
          ? {
              previous: {
                ...rawEvent.previous,
                text: clean(rawEvent.previous.text, project),
              },
            }
          : {}),
        ...(rawEvent.current
          ? {
              current: {
                ...rawEvent.current,
                text: clean(rawEvent.current.text, project),
              },
            }
          : {}),
      };
      history.push(event);
      knownHistory.add(event.id);
    }
  }
  return {
    changes,
    redactions,
    conflicts,
    orchestration,
    history,
    mappingCount: Array.isArray(envelope.pathMappings)
      ? Math.min(envelope.pathMappings.length, 100)
      : 0,
  };
}
