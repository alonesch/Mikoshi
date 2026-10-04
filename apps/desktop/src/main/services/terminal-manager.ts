import { randomUUID } from "node:crypto";
import { spawn } from "node-pty";
import type { IPty, IPtyForkOptions, IWindowsPtyForkOptions } from "node-pty";
import type {
  AgentTerminalBuffer,
  AgentTerminalEvent,
  AgentTerminalSession,
  ProviderId,
} from "../../contracts.ts";
import type { ProviderMcpConfiguration } from "./provider-mcp.ts";
import { boundedText, validId } from "./security.ts";
import { ProjectStore } from "./store.ts";

interface ActiveTerminal {
  session: AgentTerminalSession;
  process: IPty;
  output: string;
  sequence: number;
  bridgeSession?: { endpoint: string; token?: string };
  providerMcp?: ProviderMcpConfiguration;
  cleanupPromise?: Promise<void>;
}

export interface TerminalMcpBridge {
  openSession(
    projectId: string,
    terminalId: string,
    agentId: string,
  ): Promise<{ endpoint: string; token?: string }>;
  closeSession(terminalId: string): Promise<void>;
}

export type ProviderMcpConfigurator = (
  provider: ProviderId,
  projectRoot: string,
  terminalId: string,
  session: { endpoint: string; token?: string },
) => Promise<ProviderMcpConfiguration>;

export interface TerminalMcpDependencies {
  bridge: TerminalMcpBridge;
  configureProvider: ProviderMcpConfigurator;
}

export type TerminalSpawner = (
  executable: string,
  args: string[],
  options: IPtyForkOptions | IWindowsPtyForkOptions,
) => IPty;

const maxSessionsPerProject = 8;
const maxBufferedOutput = 250_000;

export class AgentTerminalManager {
  private readonly store: ProjectStore;
  private readonly resolveExecutable: (provider: ProviderId) => Promise<string>;
  private readonly spawnPty: TerminalSpawner;
  private readonly mcp?: TerminalMcpDependencies;
  private readonly sessions = new Map<string, ActiveTerminal>();
  private readonly startingAgents = new Set<string>();
  private readonly listeners = new Set<(event: AgentTerminalEvent) => void>();

  constructor(
    store: ProjectStore,
    resolveExecutable: (provider: ProviderId) => Promise<string>,
    spawnPty: TerminalSpawner = spawn,
    mcp?: TerminalMcpDependencies,
  ) {
    this.store = store;
    this.resolveExecutable = resolveExecutable;
    this.spawnPty = spawnPty;
    this.mcp = mcp;
  }

  async start(
    projectId: string,
    agentId: string,
    cols = 100,
    rows = 30,
  ): Promise<AgentTerminalSession> {
    validId(projectId);
    validId(agentId);
    this.validateDimensions(cols, rows);
    const startKey = `${projectId}:${agentId}`;
    if (this.startingAgents.has(startKey))
      throw new Error("Este agente já está iniciando um terminal.");
    this.startingAgents.add(startKey);

    try {
      return await this.startReserved(projectId, agentId, cols, rows);
    } finally {
      this.startingAgents.delete(startKey);
    }
  }

  private async startReserved(
    projectId: string,
    agentId: string,
    cols: number,
    rows: number,
  ): Promise<AgentTerminalSession> {
    const project = await this.store.project(projectId);
    const orchestration = await this.store.orchestration(projectId);
    const agent = orchestration.agents.find((entry) => entry.id === agentId);
    if (!agent) throw new Error("Agente não configurado neste projeto.");
    if (
      [...this.sessions.values()].some(
        (entry) =>
          entry.session.projectId === projectId &&
          entry.session.agentId === agentId &&
          entry.session.status === "running",
      )
    )
      throw new Error("Este agente já tem um terminal aberto.");
    const activeCount = [...this.sessions.values()].filter(
      (entry) =>
        entry.session.projectId === projectId && entry.session.status === "running",
    ).length;
    if (activeCount >= maxSessionsPerProject)
      throw new Error("O workspace atingiu o limite de oito terminais ativos.");

    const executable = await this.resolveExecutable(agent.provider);
    const terminalId = randomUUID();
    let bridgeSession: { endpoint: string; token?: string } | undefined;
    let providerMcp: ProviderMcpConfiguration | undefined;
    let pty: IPty;
    try {
      if (this.mcp) {
        bridgeSession = await this.mcp.bridge.openSession(projectId, terminalId, agentId);
        providerMcp = await this.mcp.configureProvider(
          agent.provider,
          project.root,
          terminalId,
          bridgeSession,
        );
      }
      pty = this.spawnPty(executable, providerMcp?.args ?? [], {
        name: "xterm-256color",
        cols,
        rows,
        cwd: project.root,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
          ...providerMcp?.env,
          TERM: "xterm-256color",
          FORCE_COLOR: "1",
        },
      });
    } catch (error) {
      try {
        await this.mcp?.bridge.closeSession(terminalId);
      } finally {
        await providerMcp?.cleanup();
      }
      throw error;
    }
    const session: AgentTerminalSession = {
      id: terminalId,
      projectId,
      agentId,
      provider: agent.provider,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    const entry: ActiveTerminal = {
      session,
      process: pty,
      output: "",
      sequence: 0,
      ...(bridgeSession ? { bridgeSession } : {}),
      ...(providerMcp ? { providerMcp } : {}),
    };
    this.sessions.set(session.id, entry);
    pty.onData((data) => {
      entry.output = (entry.output + data).slice(-maxBufferedOutput);
      entry.sequence++;
      this.publish({
        terminalId: session.id,
        projectId,
        agentId,
        sequence: entry.sequence,
        type: "data",
        data,
      });
    });
    pty.onExit(({ exitCode }) => {
      session.status = "exited";
      session.exitCode = exitCode;
      entry.sequence++;
      this.publish({
        terminalId: session.id,
        projectId,
        agentId,
        sequence: entry.sequence,
        type: "exit",
        exitCode,
      });
      void this.cleanupResources(entry).catch(() => undefined);
    });
    return { ...session };
  }

  list(projectId: string): AgentTerminalSession[] {
    validId(projectId);
    return [...this.sessions.values()]
      .filter((entry) => entry.session.projectId === projectId)
      .map((entry) => ({ ...entry.session }));
  }

  read(projectId: string, terminalId: string): AgentTerminalBuffer {
    const entry = this.get(projectId, terminalId);
    return { data: entry.output, sequence: entry.sequence };
  }

  write(projectId: string, terminalId: string, data: unknown): void {
    if (typeof data !== "string" || data.length > 8192)
      throw new Error("Entrada de terminal inválida ou acima do limite permitido.");
    if (data.length === 0) return;
    const entry = this.get(projectId, terminalId);
    entry.process.write(data);
  }

  async prepareAgentPrompt(
    projectId: string,
    agentId: string,
    context: string,
  ): Promise<void> {
    validId(projectId);
    validId(agentId);
    const entry = [...this.sessions.values()].find(
      (session) =>
        session.session.projectId === projectId &&
        session.session.agentId === agentId &&
        session.session.status === "running",
    );
    if (!entry)
      throw new Error("Inicie o terminal do agente antes de preparar a tarefa.");
    entry.process.write("\x1b[200~" + this.sanitizePrompt(context) + "\x1b[201~");
  }

  async prepareHandoff(
    projectId: string,
    fromAgentId: string,
    toAgentId: string,
    context: string,
  ): Promise<void> {
    validId(projectId);
    validId(fromAgentId);
    validId(toAgentId);
    const orchestration = await this.store.orchestration(projectId);
    const source = orchestration.agents.find((agent) => agent.id === fromAgentId);
    const target = orchestration.agents.find((agent) => agent.id === toAgentId);
    const connected = orchestration.canvas?.connections.some(
      (connection) =>
        connection.fromAgentId === fromAgentId && connection.toAgentId === toAgentId,
    );
    if (source?.role !== "Orchestrator" || !target || target.role === "Orchestrator")
      throw new Error("O handoff precisa sair do Orchestrator para outro agente.");
    if (!connected)
      throw new Error("O agente de destino não está conectado ao Orchestrator.");
    const destination = [...this.sessions.values()].find(
      (session) =>
        session.session.projectId === projectId &&
        session.session.agentId === toAgentId &&
        session.session.status === "running",
    );
    if (!destination)
      throw new Error("Inicie o terminal do agente antes de preparar a tarefa.");
    destination.process.write("\x1b[200~" + this.sanitizePrompt(context) + "\x1b[201~\r");
  }

  resize(projectId: string, terminalId: string, cols: number, rows: number): void {
    this.validateDimensions(cols, rows);
    this.get(projectId, terminalId).process.resize(cols, rows);
  }

  stop(projectId: string, terminalId: string): void {
    const entry = this.get(projectId, terminalId);
    if (entry.session.status === "running") entry.process.kill();
  }

  stopAgent(projectId: string, agentId: string): void {
    validId(projectId);
    validId(agentId);
    const entry = [...this.sessions.values()].find(
      (session) =>
        session.session.projectId === projectId &&
        session.session.agentId === agentId &&
        session.session.status === "running",
    );
    if (entry) entry.process.kill();
  }

  onEvent(listener: (event: AgentTerminalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async shutdown(): Promise<void> {
    for (const entry of this.sessions.values()) {
      await this.cleanupResources(entry).catch(() => undefined);
      if (entry.session.status === "running") entry.process.kill();
    }
  }

  private cleanupResources(entry: ActiveTerminal): Promise<void> {
    if (entry.cleanupPromise) return entry.cleanupPromise;
    entry.cleanupPromise = (async () => {
      try {
        if (entry.bridgeSession) await this.mcp?.bridge.closeSession(entry.session.id);
      } finally {
        await entry.providerMcp?.cleanup();
      }
    })();
    return entry.cleanupPromise;
  }

  private sanitizePrompt(context: string): string {
    return boundedText(context, 16000)
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  }

  private get(projectId: string, terminalId: string): ActiveTerminal {
    validId(projectId);
    validId(terminalId);
    const entry = this.sessions.get(terminalId);
    if (!entry || entry.session.projectId !== projectId)
      throw new Error("Terminal não pertence a este projeto.");
    return entry;
  }

  private validateDimensions(cols: number, rows: number): void {
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 20 ||
      cols > 300 ||
      rows < 5 ||
      rows > 100
    )
      throw new Error("Dimensões do terminal inválidas.");
  }

  private publish(event: AgentTerminalEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
