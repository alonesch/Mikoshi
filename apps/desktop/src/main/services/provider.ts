import { spawn, execFile } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentRun,
  MemoryChange,
  ProviderStatus,
  ProviderId,
  WorkingContext,
} from "../../contracts.ts";
import { ProjectStore, validateChanges } from "./store.ts";
import { boundedText, cleanText, validId } from "./security.ts";
import { validateTask, workingContext } from "./context.ts";
import {
  AntigravityAdapter,
  ClaudeCodeAdapter,
  CodexAdapter,
  KimiAdapter,
} from "./provider-adapters.ts";
import type { ProviderAdapter } from "./provider-adapters.ts";

const execute = promisify(execFile);
const schema = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "changes"],
  properties: {
    answer: { type: "string" },
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["op", "targetId", "kind", "text", "source"],
        properties: {
          op: { type: "string", enum: ["add", "update", "delete"] },
          targetId: { type: "string" },
          kind: {
            type: "string",
            enum: ["decision", "instruction", "fact", "task", "issue", "preference"],
          },
          text: { type: "string" },
          source: { type: "string" },
        },
      },
    },
  },
};

export function parseAgentResult(raw: string): {
  answer: string;
  changes: MemoryChange[];
} {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Provider retornou JSON inválido ou incompleto.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Provider retornou uma resposta estruturada inválida.");
  const parsed = value as Record<string, unknown>;
  const answer = boundedText(parsed.answer, 40_000);
  return { answer, changes: validateChanges(parsed.changes) };
}

export class AgentRuntime {
  store: ProjectStore;
  private adapters = new Map<ProviderId, ProviderAdapter>();
  private active = new Map<
    string,
    { child: ChildProcessWithoutNullStreams; run: AgentRun; timer: NodeJS.Timeout }
  >();
  private unsavedRuns = new Map<string, AgentRun>();
  constructor(
    store: ProjectStore,
    adapters: ProviderAdapter[] = [
      new CodexAdapter(),
      new ClaudeCodeAdapter(),
      new AntigravityAdapter(),
      new KimiAdapter(),
    ],
  ) {
    this.store = store;
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }
  async statuses(): Promise<ProviderStatus[]> {
    const registrations = await this.store.providers();
    return Promise.all(
      registrations.map(({ provider, executable }) =>
        this.readStatus(provider, executable),
      ),
    );
  }
  async status(providerId: ProviderId = "codex"): Promise<ProviderStatus> {
    const adapter = this.adapters.get(providerId);
    if (!adapter) throw new Error("Provider não configurado.");
    try {
      const command = await adapter.findExecutable();
      const status = await this.readStatus(providerId, command);
      if (status.installed) {
        await this.store.saveProvider({
          provider: providerId,
          executable: command,
          registeredAt: new Date().toISOString(),
        });
      }
      return status;
    } catch (error) {
      return {
        provider: providerId,
        capabilities: adapter.capabilities,
        installed: false,
        authenticated: false,
        version: "",
        message: error instanceof Error ? error.message : `${providerId} indisponível.`,
      };
    }
  }
  async executable(providerId: ProviderId): Promise<string> {
    const registration = (await this.store.providers()).find(
      (entry) => entry.provider === providerId,
    );
    if (!registration) {
      throw new Error(
        `${providerId} ainda não foi verificado. Abra Configurações > Providers.`,
      );
    }
    return registration.executable;
  }
  private async readStatus(
    providerId: ProviderId,
    command: string,
  ): Promise<ProviderStatus> {
    const adapter = this.adapters.get(providerId);
    if (!adapter) throw new Error("Provider não configurado.");
    try {
      const version = await adapter.version(command);
      const authenticated = await adapter.checkAuthentication(command);
      return {
        provider: providerId,
        capabilities: adapter.capabilities,
        installed: true,
        authenticated,
        version,
        message:
          authenticated === undefined
            ? "Autenticação local será validada ao iniciar a execução."
            : authenticated
              ? "Autenticação local disponível. A Mikoshi não lê nem armazena credenciais."
              : `Autentique pela CLI local ${providerId} e verifique novamente.`,
      };
    } catch (error) {
      return {
        provider: providerId,
        capabilities: adapter.capabilities,
        installed: false,
        authenticated: false,
        version: "",
        message: error instanceof Error ? error.message : `${providerId} indisponível.`,
      };
    }
  }
  async context(
    projectId: string,
    input: unknown,
    mode: "structured" | "interactive" = "structured",
  ): Promise<WorkingContext> {
    const task = validateTask(input);
    const project = await this.store.project(projectId);
    const memory = await this.store.memory(projectId);
    const pathMappings = await this.store.pathMappings(projectId);
    const last = (await this.runs(projectId)).find((run) => run.status !== "running");
    return workingContext(
      project,
      memory,
      task,
      last ? `${last.role} · ${last.status}\n${last.output.slice(0, 1800)}` : "",
      pathMappings,
      mode,
    );
  }

  async runs(projectId: string): Promise<AgentRun[]> {
    const saved = await this.store.runs(projectId);
    const pending = [...this.unsavedRuns.values()].filter(
      (run) => run.projectId === projectId,
    );
    return [...pending, ...saved.filter((run) => !this.unsavedRuns.has(run.id))].sort(
      (first, second) => second.startedAt.localeCompare(first.startedAt),
    );
  }
  async start(
    projectId: string,
    input: unknown,
    providerId: ProviderId = "codex",
  ): Promise<AgentRun> {
    const task = validateTask(input);
    const project = await this.store.project(projectId);
    const adapter = this.adapters.get(providerId);
    if (!adapter) throw new Error("Provider não configurado.");
    if (task.permission === "read-only" && !adapter.capabilities.readOnly)
      throw new Error(`${providerId} não oferece execução read-only neste modo da CLI.`);
    if ([...this.active.values()].some((entry) => entry.run.projectId === projectId))
      throw new Error("Este projeto já tem um agente em execução.");
    const command = await this.executable(providerId);
    const state = await this.readStatus(providerId, command);
    if (!state.installed || state.authenticated === false) throw new Error(state.message);
    // Check again after async detection: concurrent IPC requests must not launch duplicate runs.
    if ([...this.active.values()].some((entry) => entry.run.projectId === projectId))
      throw new Error("Este projeto já tem um agente em execução.");
    const context = await this.context(projectId, task);
    const run: AgentRun = {
      id: randomUUID(),
      projectId,
      provider: providerId,
      ...(task.agentId ? { agentId: task.agentId } : {}),
      role: task.role,
      task: cleanText(task.task, project.root).text,
      permission: task.permission,
      status: "running",
      startedAt: new Date().toISOString(),
      output: "",
      contextItemIds: context.includedIds,
    };
    const schemaFile = join(this.store.directory(projectId), "response.schema.json");
    await writeFile(schemaFile, JSON.stringify(schema), { mode: 0o600 });
    if ([...this.active.values()].some((entry) => entry.run.projectId === projectId))
      throw new Error("Este projeto já tem um agente em execução.");
    const child = spawn(
      command,
      adapter.argumentsFor(task.permission, schemaFile, context.text),
      {
        cwd: project.root,
        shell: false,
        windowsHide: true,
      },
    );
    const timer = setTimeout(() => {
      run.error = "Tempo limite de 10 minutos atingido.";
      void this.cancel(projectId, run.id);
    }, 600_000);
    this.active.set(run.id, { child, run, timer });
    let output = "";
    let bytes = 0;
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2_000_000) {
        run.error = "Saída excedeu o limite local.";
        void this.cancel(projectId, run.id);
        return;
      }
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.stdin.on("error", () => {
      /* Exit/error will report provider failure. */
    });
    child.on("error", (error) => {
      run.error = cleanText(error.message, project.root).text;
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      this.active.delete(run.id);
      run.finishedAt = new Date().toISOString();
      if (run.status !== "cancelled") {
        try {
          let response = "";
          try {
            response = adapter.result(output, task.permission);
          } catch (error) {
            if (code === 0 && !run.error) throw error;
            response = cleanText(
              error instanceof Error ? error.message : "Resposta inválida do provider.",
              project.root,
            ).text;
          }
          if (code !== 0 || run.error) {
            throw new Error(
              run.error ||
                cleanText(stderr, project.root).text ||
                response ||
                `Provider encerrou sem resposta (código ${code}).`,
            );
          }
          const result = parseAgentResult(response);
          const cleaned = cleanText(result.answer, project.root);
          run.output = cleaned.text;
          if (result.changes.length) {
            const draft = await this.store.propose(
              projectId,
              result.changes,
              adapter.id,
              run.id,
            );
            run.draftId = draft.id;
            run.status = "waiting_review";
          } else run.status = "completed";
        } catch (error) {
          run.status = "failed";
          run.error = cleanText(
            error instanceof Error ? error.message : "Resposta inválida do provider.",
            project.root,
          ).text.slice(0, 4000);
        }
      }
      try {
        await this.store.saveRun(run);
      } catch (error) {
        run.status = "failed";
        run.error =
          "Não foi possível persistir a execução: " +
          cleanText(
            error instanceof Error ? error.message : "Falha de armazenamento.",
            project.root,
          ).text;
        this.unsavedRuns.set(run.id, { ...run });
        if (this.unsavedRuns.size > 30)
          this.unsavedRuns.delete(this.unsavedRuns.keys().next().value!);
      }
    });
    try {
      await this.store.saveRun(run);
    } catch (error) {
      clearTimeout(timer);
      child.kill();
      throw error;
    }
    child.stdin.end(adapter.input(context.text));
    return { ...run };
  }
  async cancel(projectId: string, runId: string): Promise<void> {
    validId(runId);
    await this.store.project(projectId);
    const entry = this.active.get(runId);
    if (!entry || entry.run.projectId !== projectId)
      throw new Error("Agente não está em execução neste projeto.");
    entry.run.status = "cancelled";
    if (entry.child.pid) {
      if (process.platform === "win32")
        try {
          await execute("taskkill.exe", ["/PID", String(entry.child.pid), "/T", "/F"], {
            windowsHide: true,
            timeout: 5000,
          });
        } catch {
          entry.child.kill();
        }
      else entry.child.kill("SIGTERM");
    }
  }
  shutdown(): void {
    for (const { child, timer } of this.active.values()) {
      clearTimeout(timer);
      if (process.platform === "win32" && child.pid)
        execFile(
          "taskkill.exe",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true },
          () => {},
        );
      else child.kill("SIGTERM");
    }
  }
}

export class CodexProvider extends AgentRuntime {}
