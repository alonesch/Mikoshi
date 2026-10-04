import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { AgentHandoff, AgentRole, ProviderId } from "../../contracts.ts";
import { boundedText, validId } from "./security.ts";
import { ProjectStore } from "./store.ts";

export type HandoffReturnPolicy = "screen-only" | "return-to-orchestrator";

export interface AgentBridgeSession {
  id: string;
  projectId: string;
  agentId: string;
  terminalId: string;
  role: AgentRole;
  endpoint: string;
  authMode: "bearer" | "capability-url";
  token?: string;
}

export interface ConnectedAgent {
  id: string;
  name: string;
  provider: ProviderId;
  role: AgentRole;
}

export interface AgentBridgeHandoff extends AgentHandoff {
  projectId: string;
  fromTerminalId: string;
  toTerminalId: string;
  returnPolicy: HandoffReturnPolicy;
}

export interface AgentBridgeHost {
  isTerminalActive(projectId: string, agentId: string): boolean;
  prepareHandoff(handoff: AgentBridgeHandoff): Promise<void>;
  onHandoff?(projectId: string, handoff: AgentHandoff): void;
}

interface ActiveBridgeSession {
  session: AgentBridgeSession;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

interface PendingHandoff {
  handoff: AgentBridgeHandoff;
  resolve(result: string): void;
  reject(error: Error): void;
}

interface BridgeToolRegistrar {
  registerTool(
    name: string,
    config: { title?: string; description?: string; inputSchema?: unknown },
    handler: (input: Record<string, unknown>) => Promise<unknown>,
  ): unknown;
}

const maximumTaskLength = 3000;
const maximumResultLength = 12000;
export class AgentBridge {
  private readonly store: ProjectStore;
  private readonly host: AgentBridgeHost;
  private readonly sessions = new Map<string, ActiveBridgeSession>();
  private readonly pendingHandoffs = new Map<string, PendingHandoff>();
  private server: Server | null = null;
  private startingServer: Promise<void> | null = null;
  private baseUrl = "";
  private stopped = false;

  constructor(store: ProjectStore, host: AgentBridgeHost) {
    this.store = store;
    this.host = host;
  }

  async listen(): Promise<void> {
    if (this.stopped) throw new Error("A ponte da Mikoshi já foi encerrada.");
    if (this.server) return;
    if (this.startingServer) return this.startingServer;

    const starting = this.startServer();
    this.startingServer = starting;
    try {
      await starting;
    } finally {
      if (this.startingServer === starting) this.startingServer = null;
    }
  }

  private async startServer(): Promise<void> {
    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Não foi possível iniciar a ponte MCP local."));
          return;
        }
        this.baseUrl = `http://127.0.0.1:${address.port}`;
        this.server = server;
        resolve();
      });
    });
  }

  async openSession(
    projectId: string,
    terminalId: string,
    agentId: string,
  ): Promise<AgentBridgeSession> {
    validId(projectId);
    validId(terminalId);
    validId(agentId);
    await this.listen();
    if (this.stopped) throw new Error("A ponte da Mikoshi já foi encerrada.");
    const orchestration = await this.store.orchestration(projectId);
    if (this.stopped) throw new Error("A ponte da Mikoshi já foi encerrada.");
    const agent = orchestration.agents.find((entry) => entry.id === agentId);
    if (!agent) throw new Error("Agente não configurado neste projeto.");
    if (this.sessions.has(terminalId))
      throw new Error("A sessão MCP deste terminal já está ativa.");

    const authMode = agent.provider === "antigravity" ? "capability-url" : "bearer";
    const endpointKey =
      authMode === "capability-url"
        ? randomBytes(32).toString("base64url")
        : randomUUID();
    const session: AgentBridgeSession = {
      id: randomUUID(),
      projectId,
      agentId,
      terminalId,
      role: agent.role,
      endpoint: `${this.baseUrl}/mcp/${endpointKey}`,
      authMode,
      ...(authMode === "bearer" ? { token: randomBytes(32).toString("base64url") } : {}),
    };
    const server = this.createMcpServer(session);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });
    await server.connect(transport);
    if (this.stopped) {
      await server.close();
      throw new Error("A ponte da Mikoshi já foi encerrada.");
    }
    this.sessions.set(session.id, { session, server, transport });
    return { ...session };
  }

  endpointFor(projectId: string, agentId: string): string {
    const entry = [...this.sessions.values()].find(
      ({ session }) => session.projectId === projectId && session.agentId === agentId,
    );
    if (!entry) throw new Error("Sessão MCP não está ativa.");
    return entry.session.endpoint;
  }

  async closeSession(terminalId: string): Promise<void> {
    const entry = [...this.sessions.values()].find(
      ({ session }) => session.terminalId === terminalId,
    );
    if (!entry) return;
    this.sessions.delete(entry.session.id);
    const interrupted = [...this.pendingHandoffs.values()].filter(
      ({ handoff }) =>
        handoff.fromTerminalId === terminalId || handoff.toTerminalId === terminalId,
    );
    let closeError: unknown;
    for (const pending of interrupted) {
      this.pendingHandoffs.delete(pending.handoff.id);
      const failed: AgentBridgeHandoff = {
        ...pending.handoff,
        status: "failed",
        summary: "A sessão de um dos agentes terminou antes da conclusão do handoff.",
      };
      try {
        await this.persistHandoff(failed);
      } catch (error) {
        closeError ??= error;
      } finally {
        pending.reject(new Error(failed.summary));
      }
    }
    await entry.server.close();
    if (closeError) throw closeError;
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.startingServer?.catch(() => undefined);
    const terminalIds = [...this.sessions.values()].map(
      ({ session }) => session.terminalId,
    );
    let closeError: unknown;
    for (const terminalId of terminalIds)
      try {
        await this.closeSession(terminalId);
      } catch (error) {
        closeError ??= error;
      }
    const server = this.server;
    this.server = null;
    this.baseUrl = "";
    if (server?.listening)
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      } catch (error) {
        closeError ??= error;
      }
    if (closeError) throw closeError;
  }

  private createMcpServer(session: AgentBridgeSession): McpServer {
    const instructions =
      session.role === "Orchestrator"
        ? "Use os agentes conectados no canvas como destinos de trabalho reais. Antes de delegar, confirme qual agente deve receber a tarefa. A política de retorno é obrigatória: escolha somente na tela quando o usuário quiser acompanhar o resultado no terminal do worker, ou retornar resultado ao Orchestrator quando o usuário pedir o resumo de volta. Se a intenção de retorno não estiver clara, pergunte ao usuário antes de chamar a delegação. O papel Orchestrator, e não o provider, concede estas ferramentas."
        : "Este é um terminal de agente do canvas Mikoshi. Quando uma tarefa recebida trouxer um handoffId e pedir retorno ao Orchestrator, use mikoshi_return_handoff_result com sua conclusão final. Caso contrário, responda ao usuário neste terminal e não envie resultados a outros agentes.";
    const server = new McpServer(
      { name: "mikoshi", version: "1.0.0" },
      { instructions, maxToolInputElements: 8 },
    );
    // The SDK's recursive Zod callback types exceed TypeScript's inference depth here; runtime schemas remain validated by MCP.
    const tools = server as unknown as BridgeToolRegistrar;
    if (session.role === "Orchestrator") {
      tools.registerTool(
        "mikoshi_list_connected_agents",
        {
          title: "Listar agentes conectados",
          description:
            "Lista os destinos ativos conectados por uma seta de saída a este Orchestrator no canvas.",
          inputSchema: {},
        },
        async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify(await this.listTargets(session)),
            },
          ],
        }),
      );
      tools.registerTool(
        "mikoshi_delegate_task",
        {
          title: "Delegar tarefa a um terminal conectado",
          description:
            "Envia uma tarefa para o terminal interativo visível de um agente conectado. returnPolicy é obrigatório. Use screen-only para deixar a resposta somente na tela do agente; use return-to-orchestrator somente quando o usuário pedir para receber o resultado de volta. Se não souber qual modo o usuário quer, pergunte antes de chamar esta ferramenta.",
          inputSchema: {
            targetAgentId: z.string().uuid(),
            task: z.string().min(1).max(maximumTaskLength),
            returnPolicy: z.enum(["screen-only", "return-to-orchestrator"]),
          },
        },
        async (input) => ({
          content: [
            {
              type: "text",
              text: JSON.stringify(
                await this.delegate(session, {
                  targetAgentId: String(input.targetAgentId ?? ""),
                  task: String(input.task ?? ""),
                  returnPolicy: this.parseReturnPolicy(input.returnPolicy),
                }),
              ),
            },
          ],
        }),
      );
    } else {
      tools.registerTool(
        "mikoshi_return_handoff_result",
        {
          title: "Retornar resultado ao Orchestrator",
          description:
            "Envia ao Orchestrator somente o resultado final escrito por você para um handoff que solicitou explicitamente retorno.",
          inputSchema: {
            handoffId: z.string().uuid(),
            result: z.string().min(1).max(maximumResultLength),
          },
        },
        async (input) => ({
          content: [
            {
              type: "text",
              text: JSON.stringify(
                await this.receiveResult(
                  session,
                  String(input.handoffId ?? ""),
                  String(input.result ?? ""),
                ),
              ),
            },
          ],
        }),
      );
    }
    return server;
  }

  private async listTargets(session: AgentBridgeSession): Promise<ConnectedAgent[]> {
    await this.assertCurrentOrchestrator(session);
    const orchestration = await this.store.orchestration(session.projectId);
    return (orchestration.canvas?.connections ?? [])
      .filter((connection) => connection.fromAgentId === session.agentId)
      .map((connection) =>
        orchestration.agents.find((agent) => agent.id === connection.toAgentId),
      )
      .filter(
        (agent): agent is NonNullable<typeof agent> =>
          agent !== undefined && this.host.isTerminalActive(session.projectId, agent.id),
      )
      .map(({ id, name, provider, role }) => ({ id, name, provider, role }));
  }

  private async delegate(
    session: AgentBridgeSession,
    input: {
      targetAgentId: string;
      task: string;
      returnPolicy: HandoffReturnPolicy;
    },
  ): Promise<{ handoffId: string; status: string; result?: string }> {
    await this.assertCurrentOrchestrator(session);
    validId(input.targetAgentId);
    const task = boundedText(input.task, maximumTaskLength);
    if (!task.trim()) throw new Error("A tarefa do handoff não pode ficar vazia.");
    if (
      input.returnPolicy !== "screen-only" &&
      input.returnPolicy !== "return-to-orchestrator"
    )
      throw new Error("Escolha a política de retorno explicitamente.");

    const orchestration = await this.store.orchestration(session.projectId);
    const target = orchestration.agents.find((agent) => agent.id === input.targetAgentId);
    const connected = orchestration.canvas?.connections.some(
      (connection) =>
        connection.fromAgentId === session.agentId &&
        connection.toAgentId === input.targetAgentId,
    );
    if (!target || target.role === "Orchestrator")
      throw new Error("Agente de destino não encontrado ou não delegável.");
    if (!connected)
      throw new Error("O agente de destino não está conectado ao Orchestrator.");
    if (!this.host.isTerminalActive(session.projectId, target.id))
      throw new Error("Inicie o terminal do agente de destino no canvas.");
    const destinationSession = [...this.sessions.values()].find(
      ({ session: active }) =>
        active.projectId === session.projectId && active.agentId === target.id,
    );
    if (!destinationSession)
      throw new Error("A sessão MCP do agente de destino não está ativa.");

    const handoff: AgentBridgeHandoff = {
      id: randomUUID(),
      projectId: session.projectId,
      fromAgentId: session.agentId,
      toAgentId: target.id,
      fromTerminalId: session.terminalId,
      toTerminalId: destinationSession.session.terminalId,
      task,
      summary: "Tarefa sendo encaminhada ao terminal do agente.",
      createdAt: new Date().toISOString(),
      status: "pending",
      returnPolicy: input.returnPolicy,
    };
    let resolveResult: ((result: string) => void) | undefined;
    let rejectResult: ((error: Error) => void) | undefined;
    const result =
      input.returnPolicy === "return-to-orchestrator"
        ? new Promise<string>((resolve, reject) => {
            resolveResult = resolve;
            rejectResult = reject;
          })
        : undefined;
    if (result && resolveResult && rejectResult)
      this.pendingHandoffs.set(handoff.id, {
        handoff,
        resolve: resolveResult,
        reject: rejectResult,
      });
    try {
      await this.persistHandoff({ ...handoff, status: "started" });
      await this.host.prepareHandoff({ ...handoff, status: "started" });
      if (input.returnPolicy === "screen-only")
        await this.persistHandoff({
          ...handoff,
          status: "completed",
          summary: "Tarefa entregue. O resultado permanece no terminal do agente.",
        });
    } catch (error) {
      this.pendingHandoffs.delete(handoff.id);
      const failed = {
        ...handoff,
        status: "failed" as const,
        summary: error instanceof Error ? error.message : "Falha ao entregar o handoff.",
      };
      await this.persistHandoff(failed);
      throw error;
    }

    if (!result) return { handoffId: handoff.id, status: "delivered" };
    const returnedResult = await result;
    return { handoffId: handoff.id, status: "completed", result: returnedResult };
  }

  private async receiveResult(
    session: AgentBridgeSession,
    handoffId: string,
    value: string,
  ): Promise<{ handoffId: string; status: string }> {
    validId(handoffId);
    const result = boundedText(value, maximumResultLength).trim();
    if (!result) throw new Error("O resultado final não pode ficar vazio.");
    const pending = this.pendingHandoffs.get(handoffId);
    if (!pending || pending.handoff.returnPolicy !== "return-to-orchestrator")
      throw new Error("Este handoff não está aguardando um resultado de retorno.");
    if (
      pending.handoff.toAgentId !== session.agentId ||
      pending.handoff.toTerminalId !== session.terminalId ||
      pending.handoff.fromTerminalId === session.terminalId
    )
      throw new Error("Esta sessão não é o destino autorizado para esse handoff.");
    const completed = {
      ...pending.handoff,
      status: "completed" as const,
      summary: "Resultado final recebido do terminal do agente.",
      result,
    };
    await this.persistHandoff(completed);
    this.pendingHandoffs.delete(handoffId);
    pending.resolve(result);
    return { handoffId, status: "accepted" };
  }

  private async assertCurrentOrchestrator(session: AgentBridgeSession): Promise<void> {
    const active = this.sessions.get(session.id);
    if (!active || active.session.terminalId !== session.terminalId)
      throw new Error("A sessão MCP do Orchestrator foi encerrada.");
    const state = await this.store.orchestration(session.projectId);
    const agent = state.agents.find((entry) => entry.id === session.agentId);
    if (!agent || agent.role !== "Orchestrator")
      throw new Error("Somente um agente com papel Orchestrator pode delegar.");
  }

  private parseReturnPolicy(value: unknown): HandoffReturnPolicy {
    if (value === "screen-only" || value === "return-to-orchestrator") return value;
    throw new Error("Escolha a política de retorno explicitamente.");
  }

  private async persistHandoff(handoff: AgentBridgeHandoff): Promise<void> {
    const { projectId, ...stored } = handoff;
    await this.store.saveHandoff(projectId, stored);
    this.host.onHandoff?.(projectId, stored);
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const remoteAddress = request.socket.remoteAddress ?? "";
    if (
      remoteAddress !== "127.0.0.1" &&
      remoteAddress !== "::1" &&
      remoteAddress !== "::ffff:127.0.0.1"
    ) {
      response.writeHead(403).end();
      return;
    }
    const url = new URL(request.url ?? "/", this.baseUrl || "http://127.0.0.1");
    const pathMatch = /^\/mcp\/([A-Za-z0-9_-]{36,43})$/.exec(url.pathname);
    const entry = pathMatch
      ? [...this.sessions.values()].find(({ session }) =>
          session.endpoint.endsWith(`/mcp/${pathMatch[1]}`),
        )
      : undefined;
    if (
      !entry ||
      (entry.session.authMode === "bearer" &&
        (!entry.session.token || !this.hasValidBearer(request, entry.session.token)))
    ) {
      response
        .writeHead(401, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: "Não autorizado." }));
      return;
    }
    try {
      await entry.transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent)
        response
          .writeHead(400, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "Requisição MCP inválida." }));
      else response.destroy();
    }
  }

  private hasValidBearer(request: IncomingMessage, token: string): boolean {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) return false;
    const candidate = Buffer.from(authorization.slice(7));
    const expected = Buffer.from(token);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }
}
