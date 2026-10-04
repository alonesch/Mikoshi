import { randomUUID } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  lstat,
  realpath,
  readdir,
} from "node:fs/promises";
import { join, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { memoryKinds } from "../../contracts.ts";
import type {
  Project,
  AgentDefinition,
  AgentHandoff,
  AgentCanvasState,
  AgentState,
  OrchestrationState,
  PathMapping,
  PathMappingPreview,
  ProjectMemory,
  MemoryDraft,
  MemoryChange,
  Selection,
  AgentRun,
  Provenance,
  MemoryEvent,
  MemoryItem,
  MemoryOperation,
  MemoryStatus,
  MemoryApproval,
  ProviderId,
  ProviderRegistration,
} from "../../contracts.ts";
import { cleanText, validId, boundedText } from "./security.ts";
import {
  countMappedPathReferences,
  pathExists,
  previewPathMapping,
  remapTextPaths,
} from "./path-mapping.ts";

const execute = promisify(execFile);
async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(file: string, fallback?: T): Promise<T> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 4_000_000)
      throw new Error("Arquivo de dados inválido ou muito grande.");
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && fallback !== undefined)
      return fallback;
    throw error;
  }
}
export async function writeJson(file: string, data: unknown): Promise<void> {
  const content = JSON.stringify(data, null, 2) + "\n";
  if (Buffer.byteLength(content) > 4_000_000) {
    throw new Error(
      "Dados excedem o limite local de 4 MB. Nenhuma alteração foi gravada.",
    );
  }
  const temporary = file + "." + randomUUID() + ".tmp";
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, file);
}
function remoteIdentity(remote: string): string | undefined {
  const raw = remote.trim();
  try {
    const url = new URL(raw);
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return undefined;
    return (
      url.hostname.toLowerCase() + url.pathname.replace(/\.git$/, "").replace(/\/$/, "")
    );
  } catch {
    const scp = raw.match(/^(?:[^@\s]+@)?([^:\s]+):([^\s]+)$/);
    return scp ? scp[1].toLowerCase() + "/" + scp[2].replace(/\.git$/, "") : undefined;
  }
}

export function validateChanges(input: unknown, limit = 100): MemoryChange[] {
  if (!Array.isArray(input) || input.length > limit)
    throw new Error(`Diff inválido (máximo ${limit} alterações).`);
  return (input as unknown[]).map((value: unknown) => {
    if (!value || typeof value !== "object")
      throw new Error("Alteração de memória inválida.");
    const change = value as Partial<MemoryChange>;
    const operations: MemoryChange["op"][] = [
      "add",
      "update",
      "delete",
      "mark_obsolete",
      "restore",
    ];
    if (
      typeof change.op !== "string" ||
      !operations.includes(change.op as MemoryChange["op"]) ||
      typeof change.kind !== "string" ||
      !memoryKinds.includes(change.kind as MemoryChange["kind"])
    )
      throw new Error("Alteração de memória inválida.");
    const op = change.op as MemoryChange["op"];
    const kind = change.kind as MemoryChange["kind"];
    const evidenceTypes: NonNullable<MemoryChange["evidence"]>[] = [
      "observed",
      "explicit",
      "inferred",
      "convention",
      "task",
      "issue",
      "instruction",
    ];
    if (
      change.evidence !== undefined &&
      (typeof change.evidence !== "string" ||
        !evidenceTypes.includes(change.evidence as NonNullable<MemoryChange["evidence"]>))
    )
      throw new Error("Classificação de evidência inválida.");
    if (op !== "add") validId(change.targetId);
    if (change.itemId !== undefined) validId(change.itemId);
    if (change.replacedBy !== undefined) validId(change.replacedBy);
    return {
      op,
      kind,
      text: op === "delete" ? "Remover item" : boundedText(change.text),
      source: boundedText(change.source, 250),
      ...(op !== "add" ? { targetId: change.targetId } : {}),
      ...(op === "add" ? { itemId: change.itemId ?? randomUUID() } : {}),
      ...(change.replacedBy ? { replacedBy: change.replacedBy } : {}),
      ...(change.evidence ? { evidence: change.evidence } : {}),
      ...(change.provenance ? { provenance: validateProvenance(change.provenance) } : {}),
    };
  });
}

export function validateProvenance(input: unknown): Provenance[] {
  if (!Array.isArray(input) || input.length > 1000) {
    throw new Error("Proveniência inválida.");
  }
  return input.map((origin) => {
    const date = boundedText(origin?.date, 40);
    if (!Number.isFinite(Date.parse(date))) {
      throw new Error("Data da proveniência inválida.");
    }
    if (origin.sessionId !== undefined) validId(origin.sessionId);
    return {
      source: boundedText(origin.source, 250),
      date,
      ...(origin.sessionId ? { sessionId: origin.sessionId } : {}),
      ...(origin.provider &&
      ["codex", "claude", "antigravity", "kimi"].includes(origin.provider)
        ? { provider: origin.provider as ProviderId }
        : {}),
    };
  });
}

export function mergeProvenance(origins: Provenance[]): Provenance[] {
  const unique = new Map(
    origins.map((origin) => [
      [origin.source, origin.date, origin.sessionId ?? "", origin.provider ?? ""].join(
        "\0",
      ),
      origin,
    ]),
  );
  return validateProvenance([...unique.values()]);
}

function normalizedMemoryText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function memoryOperation(op: MemoryChange["op"]): MemoryOperation {
  switch (op) {
    case "add":
      return "ADD";
    case "update":
      return "UPDATE";
    case "delete":
      return "REMOVE";
    case "mark_obsolete":
      return "MARK_OBSOLETE";
    case "restore":
      return "RESTORE";
  }
}

export class ProjectStore {
  dataRoot: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(dataRoot: string) {
    this.dataRoot = dataRoot;
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
  async list(): Promise<Project[]> {
    await mkdir(join(this.dataRoot, "projects"), { recursive: true });
    const projects = await readJson<Project[]>(join(this.dataRoot, "projects.json"), []);
    if (!Array.isArray(projects)) throw new Error("Registro de projetos corrompido.");
    for (const p of projects) {
      validId(p.id);
      boundedText(p.name, 200);
      boundedText(p.root, 2000);
    }
    return projects;
  }
  async providers(): Promise<ProviderRegistration[]> {
    const providers = await readJson<ProviderRegistration[]>(
      join(this.dataRoot, "providers.json"),
      [],
    );
    if (!Array.isArray(providers) || providers.length > 4)
      throw new Error("Registro local de providers inválido.");
    return providers;
  }
  async saveProvider(registration: ProviderRegistration): Promise<void> {
    await this.serial(async () => {
      const providers = await this.providers();
      await writeJson(join(this.dataRoot, "providers.json"), [
        registration,
        ...providers.filter((entry) => entry.provider !== registration.provider),
      ]);
    });
  }
  async project(id: string): Promise<Project> {
    validId(id);
    const project = (await this.list()).find((p) => p.id === id);
    if (!project) throw new Error("Projeto não registrado.");
    return project;
  }
  directory(id: string): string {
    validId(id);
    return join(this.dataRoot, "projects", id);
  }
  async pathMappings(id: string): Promise<PathMapping[]> {
    const project = await this.project(id);
    const mappings = await readJson<unknown>(
      join(this.directory(id), "path-mappings.json"),
      [],
    );
    if (!Array.isArray(mappings) || mappings.length > 30)
      throw new Error("Registro de path mappings inválido.");
    const available = await pathExists(project.root);
    return (mappings as unknown[]).map((value: unknown) => {
      if (!value || typeof value !== "object")
        throw new Error("Registro de path mapping inválido.");
      const mapping = value as Partial<PathMapping>;
      const normalized = previewPathMapping(mapping.sourceRoot ?? "", project.root);
      return { ...normalized, targetExists: available };
    });
  }
  async savePathMapping(id: string, sourceRoot: string): Promise<PathMapping[]> {
    return this.serial(async () => {
      const project = await this.project(id);
      const mapping = previewPathMapping(sourceRoot, project.root);
      if (!(await pathExists(project.root)))
        throw new Error("A raiz de destino do projeto não existe ou não é uma pasta.");
      const mappings = await this.pathMappings(id);
      const sameRoot = (value: string): string => value.replace(/\\/g, "/").toLowerCase();
      const result = [
        { ...mapping, targetExists: true },
        ...mappings.filter(
          (entry) => sameRoot(entry.sourceRoot) !== sameRoot(mapping.sourceRoot),
        ),
      ].slice(0, 30);
      await writeJson(join(this.directory(id), "path-mappings.json"), result);
      return result;
    });
  }
  async previewPathMapping(id: string, sourceRoot: string): Promise<PathMappingPreview> {
    const project = await this.project(id);
    const mapping = previewPathMapping(sourceRoot, project.root);
    const memory = await this.memory(id);
    const targetExists = await pathExists(project.root);
    const referenceCount = memory.items.reduce(
      (total, item) => total + countMappedPathReferences(item.text, mapping),
      0,
    );
    return { ...mapping, targetExists, referenceCount };
  }
  async openProject(
    inputRoot: string,
    options: { writeIdentityMarker?: boolean } = {},
  ): Promise<Project> {
    return this.serial(async () => {
      const root = await realpath(inputRoot);
      if (!(await lstat(root)).isDirectory())
        throw new Error("Selecione uma pasta de projeto.");
      const projects = await this.list();
      const markerDirectory = join(root, ".mikoshi");
      const marker = join(markerDirectory, "project.json");
      try {
        if ((await lstat(markerDirectory)).isSymbolicLink())
          throw new Error("A pasta .mikoshi não pode ser um link.");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const identity = await readJson<{ schemaVersion: number; id: string } | null>(
        marker,
        null,
      );
      if (identity) {
        validId(identity.id);
        if (identity.schemaVersion !== 1)
          throw new Error("Versão da identidade não suportada.");
      }
      let remote: string | undefined;
      try {
        remote = remoteIdentity(
          (
            await execute("git", ["-C", root, "config", "--get", "remote.origin.url"], {
              timeout: 4000,
              windowsHide: true,
            })
          ).stdout,
        );
      } catch {
        /* Git is optional. */
      }
      const known =
        projects.find((p) => p.root === root) ??
        (remote ? projects.find((p) => p.remote === remote) : undefined);
      const id = identity?.id ?? known?.id ?? randomUUID();
      const project: Project = {
        id,
        name: cleanText(basename(root), root).text,
        root,
        ...(remote ? { remote } : {}),
      };
      if (identity || options.writeIdentityMarker !== false) {
        await mkdir(markerDirectory, { recursive: true });
        if (!identity) await writeJson(marker, { schemaVersion: 1, id });
      }
      await mkdir(this.directory(id), { recursive: true });
      await writeJson(join(this.dataRoot, "projects.json"), [
        project,
        ...projects.filter((p) => p.id !== id),
      ]);
      const memory = await this.memory(id);
      try {
        await lstat(join(this.directory(id), "memory.json"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await writeJson(join(this.directory(id), "memory.json"), memory);
      }
      return project;
    });
  }
  async memory(id: string): Promise<ProjectMemory> {
    await this.project(id);
    const file = join(this.directory(id), "memory.json");
    const stored = await readJson<{
      schemaVersion: number;
      projectId: string;
      revision: number;
      items: ProjectMemory["items"];
      history?: MemoryEvent[];
    }>(file, {
      schemaVersion: 2,
      projectId: id,
      revision: 0,
      items: [],
      history: [],
    });
    if (
      ![1, 2].includes(stored.schemaVersion) ||
      stored.projectId !== id ||
      !Number.isSafeInteger(stored.revision) ||
      stored.revision < 0 ||
      !Array.isArray(stored.items) ||
      stored.items.length > 1000 ||
      (stored.history !== undefined && !Array.isArray(stored.history))
    )
      throw new Error("Memória inválida.");
    const items = stored.items.map((item) => ({
      ...item,
      status: item.status ?? "active",
    }));
    for (const item of items) {
      validId(item.id);
      boundedText(item.text);
      if (
        !memoryKinds.includes(item.kind) ||
        !Array.isArray(item.provenance) ||
        !["active", "obsolete", "removed"].includes(item.status)
      )
        throw new Error("Item de memória inválido.");
      if (item.replacedBy !== undefined) validId(item.replacedBy);
      validateProvenance(item.provenance);
    }
    const memory: ProjectMemory = {
      schemaVersion: 2,
      projectId: id,
      revision: stored.revision,
      items,
      history: (stored.history ?? []).slice(-1000),
    };
    for (const event of memory.history) {
      validId(event.id);
      validId(event.itemId);
      boundedText(event.source, 250);
      if (!Number.isFinite(Date.parse(event.date)))
        throw new Error("Histórico inválido.");
      if (
        !["ADD", "UPDATE", "REMOVE", "MARK_OBSOLETE", "RESTORE"].includes(event.operation)
      )
        throw new Error("Operação de histórico inválida.");
    }
    if (stored.schemaVersion !== 2) await writeJson(file, memory);
    return memory;
  }
  async propose(
    id: string,
    input: unknown,
    source: string,
    sessionId?: string,
    initialRedactions = 0,
    securitySummary?: { highConfidenceRedactions: number; heuristicCandidates: number },
    conflicts?: MemoryDraft["conflicts"],
    engramOrchestration?: OrchestrationState,
    mappingCount?: number,
    engramHistory?: MemoryEvent[],
  ): Promise<MemoryDraft> {
    return this.serial(async () => {
      const project = await this.project(id);
      const memory = await this.memory(id);
      const pathMappings = await this.pathMappings(id);
      let redactions = initialRedactions;
      const changes = validateChanges(
        input,
        source.startsWith("engram") ? 1000 : 100,
      ).map((change) => {
        const text = cleanText(remapTextPaths(change.text, pathMappings), project.root);
        const origin = cleanText(
          remapTextPaths(change.source, pathMappings),
          project.root,
        );
        redactions += text.redactions + origin.redactions;
        const provenance = change.provenance?.map((entry) => ({
          ...entry,
          source: cleanText(entry.source, project.root).text,
        }));
        return {
          ...change,
          text: text.text,
          source: origin.text,
          ...(provenance ? { provenance } : {}),
        };
      });
      const draft: MemoryDraft = {
        id: randomUUID(),
        projectId: id,
        baseRevision: memory.revision,
        source: boundedText(source, 250),
        ...(sessionId ? { sessionId } : {}),
        createdAt: new Date().toISOString(),
        status: "pending",
        changes,
        redactions,
        ...(securitySummary ? { securitySummary } : {}),
        ...(conflicts?.length ? { conflicts } : {}),
        ...(engramOrchestration ? { engramOrchestration } : {}),
        ...(engramHistory?.length ? { engramHistory } : {}),
        ...(mappingCount ? { mappingCount } : {}),
      };
      await writeJson(join(this.directory(id), "draft-" + draft.id + ".json"), draft);
      await this.review(id, draft);
      return draft;
    });
  }
  async drafts(id: string): Promise<MemoryDraft[]> {
    await this.project(id);
    const files = await readdir(this.directory(id));
    const drafts = await Promise.all(
      files
        .filter((f) => /^draft-[\da-f-]+\.json$/i.test(f))
        .map((f) => readJson<MemoryDraft>(join(this.directory(id), f))),
    );
    return drafts
      .filter((d) => d.status === "pending")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  private async draft(id: string, draftId: string): Promise<MemoryDraft> {
    validId(draftId);
    await this.project(id);
    const draft = await readJson<MemoryDraft>(
      join(this.directory(id), "draft-" + draftId + ".json"),
    );
    if (draft.projectId !== id || draft.id !== draftId || draft.status !== "pending")
      throw new Error("Revisão não está pendente.");
    return draft;
  }
  async apply(id: string, draftId: string, input: unknown): Promise<void> {
    return this.serial(async () => {
      const project = await this.project(id);
      const draft = await this.draft(id, draftId);
      const memory = await this.memory(id);
      if (memory.revision !== draft.baseRevision)
        throw new Error("Conflito de revisão: a memória mudou. Gere um novo diff.");
      const approval: Partial<MemoryApproval> | undefined = Array.isArray(input)
        ? { changes: input as Selection[] }
        : input && typeof input === "object"
          ? (input as Partial<MemoryApproval>)
          : undefined;
      const rawSelections = approval?.changes;
      const agentIds = approval?.agentIds ?? [];
      const handoffIds = approval?.handoffIds ?? [];
      const includeHistory = approval?.includeHistory === true;
      if (
        !Array.isArray(rawSelections) ||
        rawSelections.length > draft.changes.length ||
        !Array.isArray(agentIds) ||
        !Array.isArray(handoffIds) ||
        (rawSelections.length === 0 &&
          agentIds.length === 0 &&
          handoffIds.length === 0 &&
          !includeHistory)
      )
        throw new Error("Selecione as alterações a aprovar.");
      if ((agentIds.length || handoffIds.length) && !draft.engramOrchestration)
        throw new Error("Este diff não possui configurações de agente do Engram.");
      const selections = rawSelections.map((value: unknown): Selection => {
        if (!value || typeof value !== "object") throw new Error("Seleção inválida.");
        const selection = value as Partial<Selection>;
        if (
          !Number.isInteger(selection.index) ||
          (selection.text !== undefined && typeof selection.text !== "string")
        )
          throw new Error("Seleção inválida.");
        return {
          index: selection.index as number,
          ...(selection.text !== undefined ? { text: selection.text } : {}),
        };
      });
      const seen = new Set<number>();
      const targets = new Set<string>();
      const approvedChanges: MemoryChange[] = [];
      for (const selection of selections) {
        if (
          !Number.isInteger(selection.index) ||
          seen.has(selection.index) ||
          selection.index < 0 ||
          selection.index >= draft.changes.length
        )
          throw new Error("Seleção inválida.");
        seen.add(selection.index);
        const change = draft.changes[selection.index];
        const text = cleanText(
          boundedText(selection.text ?? change.text),
          project.root,
        ).text;
        const provenance: Provenance = {
          source: change.source,
          ...(draft.sessionId ? { sessionId: draft.sessionId } : {}),
          date: new Date().toISOString(),
          ...(["codex", "claude", "antigravity", "kimi"].includes(draft.source)
            ? { provider: draft.source as ProviderId }
            : {}),
        };
        const incomingOrigins =
          draft.source.startsWith("engram") && change.provenance?.length
            ? change.provenance
            : [...(change.provenance ?? []), provenance];
        approvedChanges.push({ ...change, text });
        if (change.op === "add") {
          const itemId = change.itemId ?? randomUUID();
          if (memory.items.some((item) => item.id === itemId)) {
            throw new Error("Identidade de memória duplicada no diff.");
          }
          const item: MemoryItem = {
            id: itemId,
            kind: change.kind,
            text,
            provenance: mergeProvenance(incomingOrigins),
            status: "active",
            updatedAt: new Date().toISOString(),
            ...(change.evidence ? { evidence: change.evidence } : {}),
          };
          const duplicate = memory.items.find(
            (entry) =>
              entry.status === "active" &&
              entry.kind === item.kind &&
              normalizedMemoryText(entry.text) === normalizedMemoryText(item.text),
          );
          if (duplicate)
            throw new Error(
              "Uma memória ativa equivalente já existe; edite o diff ou revise a duplicidade.",
            );
          memory.items.push(item);
          memory.history.push({
            id: randomUUID(),
            itemId,
            operation: "ADD",
            current: { kind: item.kind, text: item.text, status: item.status },
            source: change.source,
            date: new Date().toISOString(),
            provenance: item.provenance,
          });
        } else {
          if (targets.has(change.targetId!))
            throw new Error("O mesmo item foi alterado duas vezes no diff.");
          targets.add(change.targetId!);
          const index = memory.items.findIndex((item) => item.id === change.targetId);
          if (index < 0) throw new Error("Item alvo não existe.");
          const current = memory.items[index];
          if (change.op === "update" && current.status !== "active")
            throw new Error("Restaure ou atualize somente memórias ativas.");
          if (change.op === "mark_obsolete" && current.status !== "active")
            throw new Error("Somente uma memória ativa pode ficar obsoleta.");
          if (change.op === "restore" && current.status === "active")
            throw new Error("A memória já está ativa.");
          if (change.op === "delete" && current.status === "removed")
            throw new Error("A memória já foi removida.");

          const previous = {
            kind: current.kind,
            text: current.text,
            status: current.status,
          };
          let next: typeof current;
          if (change.op === "delete") {
            next = { ...current, status: "removed", updatedAt: new Date().toISOString() };
          } else if (change.op === "mark_obsolete") {
            if (
              change.replacedBy &&
              !memory.items.some(
                (item) => item.id === change.replacedBy && item.status === "active",
              )
            )
              throw new Error(
                "A referência de substituição precisa apontar para uma memória ativa.",
              );
            next = {
              ...current,
              status: "obsolete",
              ...(change.replacedBy ? { replacedBy: change.replacedBy } : {}),
              updatedAt: new Date().toISOString(),
            };
          } else if (change.op === "restore") {
            next = {
              ...current,
              status: "active",
              replacedBy: undefined,
              kind: change.kind,
              text,
              ...(change.evidence ? { evidence: change.evidence } : {}),
              provenance: mergeProvenance([...current.provenance, ...incomingOrigins]),
              updatedAt: new Date().toISOString(),
            };
          } else {
            next = {
              ...current,
              kind: change.kind,
              text,
              ...(change.evidence ? { evidence: change.evidence } : {}),
              provenance: mergeProvenance([...current.provenance, ...incomingOrigins]),
              updatedAt: new Date().toISOString(),
            };
          }
          const duplicate = memory.items.find(
            (item) =>
              item.id !== current.id &&
              item.status === "active" &&
              item.kind === next.kind &&
              normalizedMemoryText(item.text) === normalizedMemoryText(next.text),
          );
          if (next.status === "active" && duplicate)
            throw new Error(
              "Uma memória ativa equivalente já existe; edite o diff ou revise a duplicidade.",
            );
          memory.items[index] = next;
          const event: MemoryEvent = {
            id: randomUUID(),
            itemId: current.id,
            operation: memoryOperation(change.op),
            previous,
            current: { kind: next.kind, text: next.text, status: next.status },
            source: change.source,
            date: new Date().toISOString(),
            provenance: mergeProvenance(incomingOrigins),
          };
          memory.history.push(event);
        }
      }
      for (const change of approvedChanges.filter((entry) => entry.op === "add")) {
        const itemId = change.itemId!;
        const item = memory.items.find((entry) => entry.id === itemId);
        if (!item) continue;
        const duplicate = memory.items.find(
          (entry) =>
            entry.id !== item.id &&
            entry.status === "active" &&
            entry.kind === item.kind &&
            normalizedMemoryText(entry.text) === normalizedMemoryText(item.text),
        );
        if (duplicate)
          throw new Error(
            "Uma memória ativa equivalente já existe; edite o diff ou revise a duplicidade.",
          );
      }
      if (memory.items.length > 1000)
        throw new Error("Limite local de 1000 memórias atingido.");
      let importedOrchestration: OrchestrationState | undefined;
      if (draft.engramOrchestration) {
        const candidate = draft.engramOrchestration;
        const validAgentIds = new Set(candidate.agents.map((agent) => agent.id));
        const validHandoffIds = new Set(candidate.handoffs.map((handoff) => handoff.id));
        if (
          agentIds.length > candidate.agents.length ||
          handoffIds.length > candidate.handoffs.length ||
          agentIds.some((agentId) => !validAgentIds.has(agentId)) ||
          handoffIds.some((handoffId) => !validHandoffIds.has(handoffId))
        )
          throw new Error("Seleção de agentes do Engram inválida.");
        const current = await this.orchestration(id);
        const approvedAgents = candidate.agents.filter((agent) =>
          agentIds.includes(agent.id),
        );
        const mergedAgents = [...current.agents];
        for (const agent of approvedAgents) {
          const nameTaken = mergedAgents.find(
            (entry) =>
              entry.id !== agent.id &&
              entry.name.toLocaleLowerCase("pt-BR") ===
                agent.name.toLocaleLowerCase("pt-BR"),
          );
          if (nameTaken)
            throw new Error(
              "Renomeie o agente importado; esse nome já pertence a outro agente.",
            );
          const existingIndex = mergedAgents.findIndex((entry) => entry.id === agent.id);
          if (existingIndex >= 0) mergedAgents[existingIndex] = agent;
          else mergedAgents.push(agent);
        }
        const mergedAgentIds = new Set(mergedAgents.map((agent) => agent.id));
        const canvas = current.canvas
          ? {
              positions: current.canvas.positions.filter((position) =>
                mergedAgentIds.has(position.agentId),
              ),
              connections: current.canvas.connections.filter(
                (connection) =>
                  mergedAgentIds.has(connection.fromAgentId) &&
                  mergedAgentIds.has(connection.toAgentId),
              ),
              viewport: current.canvas.viewport,
            }
          : undefined;
        const approvedHandoffs = candidate.handoffs.filter((handoff) =>
          handoffIds.includes(handoff.id),
        );
        if (
          approvedHandoffs.some(
            (handoff) =>
              !mergedAgentIds.has(handoff.fromAgentId) ||
              !mergedAgentIds.has(handoff.toAgentId),
          )
        )
          throw new Error("Aprove também os dois agentes usados por cada handoff.");
        importedOrchestration = {
          schemaVersion: 1,
          agents: mergedAgents.slice(0, 30),
          agentStates: [
            ...candidate.agentStates.filter((state) => agentIds.includes(state.agentId)),
            ...current.agentStates.filter((state) => !agentIds.includes(state.agentId)),
          ],
          handoffs: [
            ...approvedHandoffs,
            ...current.handoffs.filter((handoff) => !handoffIds.includes(handoff.id)),
          ].slice(0, 500),
          ...(canvas ? { canvas } : {}),
        };
      }
      if (includeHistory && draft.engramHistory?.length) {
        const existingHistoryIds = new Set(memory.history.map((event) => event.id));
        const itemIds = new Set(memory.items.map((item) => item.id));
        memory.history.push(
          ...draft.engramHistory.filter(
            (event) => !existingHistoryIds.has(event.id) && itemIds.has(event.itemId),
          ),
        );
      }
      memory.revision++;
      memory.history = memory.history.slice(-1000);
      await writeJson(join(this.directory(id), "memory.json"), memory);
      if (importedOrchestration) await this.saveOrchestration(id, importedOrchestration);
      draft.status = "applied";
      draft.changes = approvedChanges;
      await writeJson(join(this.directory(id), "draft-" + draftId + ".json"), draft);
      await this.review(id, draft);
    });
  }
  async reject(id: string, draftId: string): Promise<void> {
    await this.serial(async () => {
      const draft = await this.draft(id, draftId);
      draft.status = "rejected";
      await writeJson(join(this.directory(id), "draft-" + draftId + ".json"), draft);
      await this.review(id, draft);
    });
  }
  private async review(id: string, draft: MemoryDraft): Promise<void> {
    const report = [
      "# REVIEW — Mikoshi",
      "",
      "Projeto: " + id,
      "Estado: " + draft.status,
      "Revisão base: " + draft.baseRevision,
      "Redações automáticas: " + draft.redactions,
      ...(draft.securitySummary
        ? [
            "Segredos confirmados removidos: " +
              draft.securitySummary.highConfidenceRedactions,
            "Candidatos de entropia para revisão: " +
              draft.securitySummary.heuristicCandidates,
          ]
        : []),
      "",
      ...draft.changes.map(
        (c, i) => `${i + 1}. ${c.op} · ${c.kind} · ${c.source}\n\n${c.text}\n`,
      ),
    ].join("\n");
    await writeFile(join(this.directory(id), "REVIEW.md"), report, { mode: 0o600 });
  }
  async runs(id: string): Promise<AgentRun[]> {
    await this.project(id);
    const currentFile = join(this.directory(id), "runs.json");
    const legacyFile = join(this.directory(id), "orchestration.json");
    const hasCurrent = await fileExists(currentFile);
    const runs = hasCurrent
      ? await readJson<AgentRun[]>(currentFile)
      : await readJson<AgentRun[]>(legacyFile, []);
    const migrated = runs.map((run) => ({
      ...run,
      provider: run.provider ?? "codex",
      contextItemIds: Array.isArray(run.contextItemIds) ? run.contextItemIds : [],
    }));
    if (runs.length && !hasCurrent) {
      await writeJson(currentFile, migrated);
    }
    return migrated;
  }
  async saveRun(run: AgentRun): Promise<void> {
    await this.serial(async () => {
      const runs = await this.runs(run.projectId);
      await writeJson(
        join(this.directory(run.projectId), "runs.json"),
        [run, ...runs.filter((r) => r.id !== run.id)].slice(0, 30),
      );
      if (run.agentId) {
        const orchestration = await this.orchestration(run.projectId);
        const status: AgentState["status"] =
          run.status === "running"
            ? "running"
            : run.status === "waiting_review"
              ? "waiting_review"
              : run.status === "completed"
                ? "waiting_handoff"
                : run.status === "failed"
                  ? "failed"
                  : "idle";
        await this.saveOrchestration(run.projectId, {
          ...orchestration,
          agentStates: [
            {
              agentId: run.agentId,
              status,
              currentTask: run.task,
              ...(status === "running" ? { runId: run.id } : {}),
              updatedAt: new Date().toISOString(),
            },
            ...orchestration.agentStates.filter((state) => state.agentId !== run.agentId),
          ],
        });
      }
    });
  }
  async orchestration(id: string): Promise<OrchestrationState> {
    await this.project(id);
    const empty: OrchestrationState = {
      schemaVersion: 1,
      agents: [],
      agentStates: [],
      handoffs: [],
    };
    const state = await readJson<OrchestrationState>(
      join(this.directory(id), "orchestration-state.json"),
      empty,
    );
    if (
      state.schemaVersion !== 1 ||
      !Array.isArray(state.agents) ||
      state.agents.length > 30 ||
      !Array.isArray(state.agentStates) ||
      !Array.isArray(state.handoffs) ||
      state.handoffs.length > 500
    )
      throw new Error("Estado de orquestração inválido.");
    for (const agent of state.agents) {
      validId(agent.id);
      boundedText(agent.name, 120);
      if (typeof agent.instructions !== "string" || agent.instructions.length > 4000)
        throw new Error("Instruções do agente inválidas.");
      if (
        !["Orchestrator", "Worker", "Architect", "Backend", "Reviewer", "Tests"].includes(
          agent.role,
        ) ||
        !["codex", "claude", "antigravity", "kimi"].includes(agent.provider)
      )
        throw new Error("Agente inválido.");
    }
    return state;
  }
  async saveAgent(projectId: string, value: unknown): Promise<OrchestrationState> {
    return this.serial(async () => {
      await this.project(projectId);
      if (!value || typeof value !== "object") throw new Error("Agente inválido.");
      const input = value as Partial<AgentDefinition>;
      const name = boundedText(input.name, 120);
      if (typeof input.instructions !== "string")
        throw new Error("Instruções do agente inválidas.");
      const instructions = input.instructions.trim();
      if (instructions.length > 4000)
        throw new Error("Instruções acima de 4000 caracteres.");
      const roles: AgentDefinition["role"][] = [
        "Orchestrator",
        "Worker",
        "Architect",
        "Backend",
        "Reviewer",
        "Tests",
      ];
      const providers: ProviderId[] = ["codex", "claude", "antigravity", "kimi"];
      if (
        !roles.includes(input.role as AgentDefinition["role"]) ||
        !providers.includes(input.provider as ProviderId)
      )
        throw new Error("Papel ou provider inválido.");
      const state = await this.orchestration(projectId);
      if (input.id) validId(input.id);
      const existing = input.id
        ? state.agents.find((agent) => agent.id === input.id)
        : undefined;
      if (input.id && !existing) throw new Error("Agente não encontrado.");
      if (
        state.agents.some(
          (agent) =>
            agent.id !== existing?.id &&
            agent.name.toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR"),
        )
      )
        throw new Error("Já existe um agente com esse nome.");
      const agent: AgentDefinition = {
        id: existing?.id ?? randomUUID(),
        name,
        role: input.role as AgentDefinition["role"],
        provider: input.provider as AgentDefinition["provider"],
        instructions,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };
      return this.saveOrchestration(projectId, {
        ...state,
        agents: [agent, ...state.agents.filter((entry) => entry.id !== agent.id)],
        agentStates: existing
          ? state.agentStates
          : [
              { agentId: agent.id, status: "idle", updatedAt: new Date().toISOString() },
              ...state.agentStates,
            ],
      });
    });
  }
  async deleteAgent(projectId: string, agentId: string): Promise<OrchestrationState> {
    return this.serial(async () => {
      await this.project(projectId);
      validId(agentId);
      const state = await this.orchestration(projectId);
      if (!state.agents.some((agent) => agent.id === agentId))
        throw new Error("Agente não encontrado.");
      return this.saveOrchestration(projectId, {
        ...state,
        agents: state.agents.filter((agent) => agent.id !== agentId),
        agentStates: state.agentStates.filter((agent) => agent.agentId !== agentId),
        ...(state.canvas
          ? {
              canvas: {
                ...state.canvas,
                positions: state.canvas.positions.filter(
                  (position) => position.agentId !== agentId,
                ),
                connections: state.canvas.connections.filter(
                  (connection) =>
                    connection.fromAgentId !== agentId &&
                    connection.toAgentId !== agentId,
                ),
              },
            }
          : {}),
      });
    });
  }
  async createCanvasAgent(
    projectId: string,
    provider: ProviderId,
    role: AgentDefinition["role"],
  ): Promise<OrchestrationState> {
    return this.serial(async () => {
      await this.project(projectId);
      const state = await this.orchestration(projectId);
      const providers: ProviderId[] = ["codex", "claude", "antigravity", "kimi"];
      const roles: AgentDefinition["role"][] = [
        "Orchestrator",
        "Worker",
        "Architect",
        "Backend",
        "Reviewer",
        "Tests",
      ];
      if (!providers.includes(provider) || !roles.includes(role))
        throw new Error("Provider ou papel inválido para criar o terminal.");
      if (state.agents.length >= 30)
        throw new Error("O workspace atingiu o limite de 30 terminais.");
      const createdAt = new Date().toISOString();
      const id = randomUUID();
      const baseName = role;
      const name = state.agents.some((agent) => agent.name === baseName)
        ? `${baseName} ${state.agents.length + 1}`
        : baseName;
      const agent: AgentDefinition = {
        id,
        name,
        role,
        provider,
        instructions:
          role === "Orchestrator"
            ? "Coordene o trabalho deste workspace. Analise as tarefas, decomponha o trabalho e explique etapas que podem ser encaminhadas a agentes Worker conectados no canvas."
            : role === "Worker"
              ? "Execute tarefas recebidas no terminal deste workspace. Respeite as convenções existentes, explique alterações e verificações no terminal e não altere a memória canônica diretamente."
              : "",
        createdAt,
      };
      const positions = state.canvas?.positions ?? [];
      const index = state.agents.length;
      const newPosition: AgentCanvasState["positions"][number] = {
        agentId: id,
        x: 100 + (index % 3) * 760,
        y: 100 + Math.floor(index / 3) * 800,
        width: 720,
        height: 760,
      };
      const connections = [...(state.canvas?.connections ?? [])];
      const orchestrator =
        role === "Orchestrator"
          ? agent
          : state.agents.find((entry) => entry.role === "Orchestrator");
      if (orchestrator) {
        const destinations =
          role === "Orchestrator"
            ? state.agents.filter((entry) => entry.role === "Worker")
            : role === "Worker"
              ? [agent]
              : [];
        for (const destination of destinations) {
          if (
            !connections.some(
              (connection) =>
                connection.fromAgentId === orchestrator.id &&
                connection.toAgentId === destination.id,
            )
          )
            connections.push({
              id: randomUUID(),
              fromAgentId: orchestrator.id,
              toAgentId: destination.id,
            });
        }
      }
      const agents = [agent, ...state.agents];
      return this.saveOrchestration(projectId, {
        ...state,
        agents,
        agentStates: [
          { agentId: agent.id, status: "idle", updatedAt: createdAt },
          ...state.agentStates,
        ],
        canvas: {
          positions: [...positions, newPosition],
          connections,
          viewport: state.canvas?.viewport ?? { x: 0, y: 0, zoom: 1 },
        },
      });
    });
  }
  async saveAgentCanvas(projectId: string, value: unknown): Promise<OrchestrationState> {
    return this.serial(async () => {
      const state = await this.orchestration(projectId);
      if (!value || typeof value !== "object")
        throw new Error("Canvas de agentes inválido.");
      const input = value as Partial<AgentCanvasState>;
      if (
        !Array.isArray(input.positions) ||
        input.positions.length > 30 ||
        !Array.isArray(input.connections) ||
        input.connections.length > 300
      )
        throw new Error("Posições ou conexões do canvas inválidas.");
      const agentIds = new Set(state.agents.map((agent) => agent.id));
      const positionedAgents = new Set<string>();
      const positions = input.positions.map((position) => {
        if (!position || typeof position !== "object")
          throw new Error("Posição de agente inválida.");
        validId(position.agentId);
        if (
          !agentIds.has(position.agentId) ||
          positionedAgents.has(position.agentId) ||
          !Number.isFinite(position.x) ||
          !Number.isFinite(position.y) ||
          !Number.isFinite(position.width) ||
          !Number.isFinite(position.height) ||
          Math.abs(position.x) > 20000 ||
          Math.abs(position.y) > 20000 ||
          position.width < 220 ||
          position.width > 1200 ||
          position.height < 120 ||
          position.height > 1000
        )
          throw new Error("Posição de agente inválida.");
        positionedAgents.add(position.agentId);
        return {
          agentId: position.agentId,
          x: position.x,
          y: position.y,
          width: position.width,
          height: position.height,
        };
      });
      const connectionIds = new Set<string>();
      const connections = input.connections.map((connection) => {
        if (!connection || typeof connection !== "object")
          throw new Error("Conexão do canvas inválida.");
        validId(connection.id);
        validId(connection.fromAgentId);
        validId(connection.toAgentId);
        if (
          connectionIds.has(connection.id) ||
          connection.fromAgentId === connection.toAgentId ||
          !agentIds.has(connection.fromAgentId) ||
          !agentIds.has(connection.toAgentId)
        )
          throw new Error("Conexão do canvas inválida.");
        connectionIds.add(connection.id);
        return {
          id: connection.id,
          fromAgentId: connection.fromAgentId,
          toAgentId: connection.toAgentId,
        };
      });
      const viewport = input.viewport;
      if (
        !viewport ||
        !Number.isFinite(viewport.x) ||
        !Number.isFinite(viewport.y) ||
        !Number.isFinite(viewport.zoom) ||
        Math.abs(viewport.x) > 20000 ||
        Math.abs(viewport.y) > 20000 ||
        viewport.zoom < 0.35 ||
        viewport.zoom > 2
      )
        throw new Error("Visualização do canvas inválida.");
      return this.saveOrchestration(projectId, {
        ...state,
        canvas: {
          positions,
          connections,
          viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom },
        },
      });
    });
  }
  async saveHandoff(
    projectId: string,
    handoff: AgentHandoff,
  ): Promise<OrchestrationState> {
    return this.serial(async () => {
      const state = await this.orchestration(projectId);
      validId(handoff.id);
      validId(handoff.fromAgentId);
      validId(handoff.toAgentId);
      if (handoff.fromRunId) validId(handoff.fromRunId);
      if (handoff.fromTerminalId) validId(handoff.fromTerminalId);
      if (handoff.toTerminalId) validId(handoff.toTerminalId);
      if (!handoff.fromRunId && !handoff.fromTerminalId)
        throw new Error("Handoff precisa identificar a sessão de origem.");
      if (
        !state.agents.some((agent) => agent.id === handoff.fromAgentId) ||
        !state.agents.some((agent) => agent.id === handoff.toAgentId) ||
        handoff.fromAgentId === handoff.toAgentId
      )
        throw new Error("Agentes de handoff inválidos.");
      boundedText(handoff.task, 3000);
      boundedText(handoff.summary, 4000);
      if (handoff.result) boundedText(handoff.result, 12000);
      if (
        handoff.returnPolicy &&
        handoff.returnPolicy !== "screen-only" &&
        handoff.returnPolicy !== "return-to-orchestrator"
      )
        throw new Error("Política de retorno do handoff inválida.");
      return this.saveOrchestration(projectId, {
        ...state,
        handoffs: [
          handoff,
          ...state.handoffs.filter((entry) => entry.id !== handoff.id),
        ].slice(0, 500),
      });
    });
  }
  async saveAgentState(
    projectId: string,
    agentState: AgentState,
  ): Promise<OrchestrationState> {
    return this.serial(async () => {
      const state = await this.orchestration(projectId);
      validId(agentState.agentId);
      if (!state.agents.some((agent) => agent.id === agentState.agentId))
        throw new Error("Agente não encontrado.");
      if (
        !["idle", "running", "waiting_handoff", "waiting_review", "failed"].includes(
          agentState.status,
        )
      )
        throw new Error("Estado operacional do agente inválido.");
      if (agentState.currentTask) boundedText(agentState.currentTask, 3000);
      if (agentState.runId) validId(agentState.runId);
      return this.saveOrchestration(projectId, {
        ...state,
        agentStates: [
          agentState,
          ...state.agentStates.filter((entry) => entry.agentId !== agentState.agentId),
        ],
      });
    });
  }
  private async saveOrchestration(
    projectId: string,
    state: OrchestrationState,
  ): Promise<OrchestrationState> {
    await writeJson(join(this.directory(projectId), "orchestration-state.json"), state);
    return state;
  }
  async recover(): Promise<void> {
    for (const project of await this.list())
      for (const run of await this.runs(project.id))
        if (run.status === "running")
          await this.saveRun({
            ...run,
            status: "interrupted",
            finishedAt: new Date().toISOString(),
            error: "Aplicativo encerrado durante a execução. Inicie uma nova tarefa.",
          });
  }
}
