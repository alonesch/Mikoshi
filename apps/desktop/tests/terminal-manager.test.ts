import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IPty, IPtyForkOptions } from "node-pty";
import type { AgentTerminalEvent, ProviderId } from "../src/contracts.ts";
import { AgentTerminalManager } from "../src/main/services/terminal-manager.ts";
import { ProjectStore } from "../src/main/services/store.ts";
import type { ProviderMcpConfiguration } from "../src/main/services/provider-mcp.ts";

class FakePty {
  pid = 321;
  input: string[] = [];
  dimensions: Array<{ cols: number; rows: number }> = [];
  killed = false;
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(event: { exitCode: number }) => void>();

  write(data: string): void {
    this.input.push(data);
  }

  resize(cols: number, rows: number): void {
    this.dimensions.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
    for (const listener of this.exitListeners) listener({ exitCode: 0 });
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void } {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
}

async function createProject(): Promise<{
  store: ProjectStore;
  projectId: string;
  agentId: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-agent-terminal-"));
  const root = join(directory, "repo");
  await mkdir(root);
  const store = new ProjectStore(join(directory, "data"));
  const project = await store.openProject(root);
  const state = await store.saveAgent(project.id, {
    name: "Architect",
    role: "Architect",
    provider: "codex",
    instructions: "",
  });
  return { store, projectId: project.id, agentId: state.agents[0].id };
}

test("terminal do agente abre a CLI interativa no projeto e encaminha entrada e tela", async () => {
  const { store, projectId, agentId } = await createProject();
  const pty = new FakePty();
  const spawned: Array<{
    command: string;
    args: string[];
    options: IPtyForkOptions;
  }> = [];
  const manager = new AgentTerminalManager(
    store,
    async (provider: ProviderId) => `C:/tools/${provider}.exe`,
    (command, args, options) => {
      spawned.push({ command, args, options });
      return pty as unknown as IPty;
    },
  );
  const events: AgentTerminalEvent[] = [];
  manager.onEvent((event) => events.push(event));

  const session = await manager.start(projectId, agentId, 96, 28);
  pty.emitData("TUI da CLI");
  manager.write(projectId, session.id, "pergunta");
  manager.write(projectId, session.id, " ");
  manager.write(projectId, session.id, "\r");
  manager.resize(projectId, session.id, 120, 36);

  assert.equal(session.agentId, agentId);
  assert.equal(session.provider, "codex");
  assert.equal(spawned[0].command, "C:/tools/codex.exe");
  assert.deepEqual(spawned[0].args, []);
  assert.equal(spawned[0].options.cwd, (await store.project(projectId)).root);
  assert.equal(spawned[0].options.cols, 96);
  assert.equal(spawned[0].options.rows, 28);
  assert.deepEqual(pty.input, ["pergunta", " ", "\r"]);
  assert.deepEqual(pty.dimensions, [{ cols: 120, rows: 36 }]);
  assert.equal(events[0].type, "data");
  assert.equal(events[0].data, "TUI da CLI");
  assert.equal(manager.read(projectId, session.id).data, "TUI da CLI");

  await manager.shutdown();
  assert.equal(pty.killed, true);
});

test("terminal configura o MCP privado do agente e limpa recursos ao encerrar", async () => {
  const { store, projectId, agentId } = await createProject();
  const pty = new FakePty();
  const opened: string[] = [];
  const closed: string[] = [];
  const configured: Array<{
    provider: ProviderId;
    projectRoot: string;
    terminalId: string;
  }> = [];
  let cleaned = false;
  let spawnedArgs: string[] = [];
  let spawnedEnv: NodeJS.ProcessEnv = {};
  const manager = new AgentTerminalManager(
    store,
    async () => "codex",
    (_command, args, options) => {
      spawnedArgs = args;
      spawnedEnv = options.env ?? {};
      return pty as unknown as IPty;
    },
    {
      bridge: {
        async openSession(projectIdValue, terminalId) {
          opened.push(terminalId);
          return {
            endpoint: "http://127.0.0.1:45678/mcp/session",
            token: "private-session-token",
          };
        },
        async closeSession(terminalId) {
          closed.push(terminalId);
        },
      },
      async configureProvider(provider, projectRoot, terminalId, bridgeSession) {
        configured.push({ provider, projectRoot, terminalId });
        assert.equal(bridgeSession.token, "private-session-token");
        return {
          args: ["--config", "mcp_servers.mikoshi.enabled=true"],
          env: { MIKOSHI_MCP_TOKEN: bridgeSession.token },
          async cleanup() {
            cleaned = true;
          },
        } satisfies ProviderMcpConfiguration;
      },
    },
  );

  const session = await manager.start(projectId, agentId);
  assert.deepEqual(opened, [session.id]);
  assert.deepEqual(spawnedArgs, ["--config", "mcp_servers.mikoshi.enabled=true"]);
  assert.equal(spawnedEnv.MIKOSHI_MCP_TOKEN, "private-session-token");
  assert.equal(configured[0].provider, "codex");
  assert.equal(configured[0].terminalId, session.id);

  await manager.shutdown();
  await manager.shutdown();
  assert.deepEqual(closed, [session.id]);
  assert.equal(cleaned, true);
  assert.equal(pty.killed, true);
});

test("terminal não abre para agente inválido nem duplica sessão do mesmo agente", async () => {
  const { store, projectId, agentId } = await createProject();
  const manager = new AgentTerminalManager(
    store,
    async () => "codex",
    () => new FakePty() as unknown as IPty,
  );

  await assert.rejects(
    manager.start(projectId, "missing-agent"),
    /identificador inválido/i,
  );
  await manager.start(projectId, agentId);
  await assert.rejects(manager.start(projectId, agentId), /já tem um terminal/i);
});

test("terminal serializa starts concorrentes antes de resolver o executável", async () => {
  const { store, projectId, agentId } = await createProject();
  let releaseResolution: (() => void) | undefined;
  let notifyFirstResolution: (() => void) | undefined;
  let notifySecondResolution: (() => void) | undefined;
  const resolutionGate = new Promise<void>((resolve) => {
    releaseResolution = resolve;
  });
  const firstResolution = new Promise<void>((resolve) => {
    notifyFirstResolution = resolve;
  });
  const secondResolution = new Promise<void>((resolve) => {
    notifySecondResolution = resolve;
  });
  const ptys: FakePty[] = [];
  let resolutionCount = 0;
  const manager = new AgentTerminalManager(
    store,
    async () => {
      resolutionCount++;
      if (resolutionCount === 1) notifyFirstResolution?.();
      if (resolutionCount === 2) notifySecondResolution?.();
      await resolutionGate;
      return "codex";
    },
    () => {
      const pty = new FakePty();
      ptys.push(pty);
      return pty as unknown as IPty;
    },
  );

  const first = manager.start(projectId, agentId);
  await firstResolution;
  const second = manager.start(projectId, agentId);
  await Promise.race([
    secondResolution,
    second.then(
      () => undefined,
      () => undefined,
    ),
  ]);
  releaseResolution?.();
  const results = await Promise.allSettled([first, second]);

  assert.equal(ptys.length, 1);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("remove o processo de terminal associado ao agente", async () => {
  const { store, projectId, agentId } = await createProject();
  const pty = new FakePty();
  const manager = new AgentTerminalManager(
    store,
    async () => "codex",
    () => pty as unknown as IPty,
  );
  await manager.start(projectId, agentId);

  manager.stopAgent(projectId, agentId);

  assert.equal(pty.killed, true);
});

test("handoff cola contexto no terminal visível e submete a tarefa", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-terminal-handoff-"));
  const root = join(directory, "repo");
  await mkdir(root);
  const store = new ProjectStore(join(directory, "data"));
  const project = await store.openProject(root);
  await store.createCanvasAgent(project.id, "codex", "Orchestrator");
  await store.createCanvasAgent(project.id, "kimi", "Worker");
  const pair = await store.orchestration(project.id);
  const orchestrator = pair.agents.find((agent) => agent.role === "Orchestrator");
  const worker = pair.agents.find((agent) => agent.role === "Worker");
  assert.ok(orchestrator && worker);
  const pty = new FakePty();
  const manager = new AgentTerminalManager(
    store,
    async () => "kimi",
    () => pty as unknown as IPty,
  );
  const session = await manager.start(project.id, worker.id);

  await manager.prepareHandoff(
    project.id,
    orchestrator.id,
    worker.id,
    "PROJECT: Relic\nCURRENT TASK: Verificar os testes existentes.",
  );

  assert.equal(pty.input.length, 1);
  assert.equal(
    pty.input[0],
    "\x1b[200~PROJECT: Relic\nCURRENT TASK: Verificar os testes existentes.\x1b[201~\r",
  );
  await manager.stop(project.id, session.id);
});

test("handoff exige conexão do Orchestrator e terminal ativo do subordinado", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-terminal-handoff-guard-"));
  const root = join(directory, "repo");
  await mkdir(root);
  const store = new ProjectStore(join(directory, "data"));
  const project = await store.openProject(root);
  await store.createCanvasAgent(project.id, "codex", "Orchestrator");
  await store.createCanvasAgent(project.id, "kimi", "Worker");
  const pair = await store.orchestration(project.id);
  const orchestrator = pair.agents.find((agent) => agent.role === "Orchestrator");
  const worker = pair.agents.find((agent) => agent.role === "Worker");
  assert.ok(orchestrator && worker);
  const manager = new AgentTerminalManager(
    store,
    async () => "kimi",
    () => new FakePty() as unknown as IPty,
  );

  await assert.rejects(
    manager.prepareHandoff(project.id, orchestrator.id, worker.id, "Tarefa"),
    /inicie o terminal/i,
  );
  await manager.start(project.id, worker.id);
  await store.saveAgentCanvas(project.id, {
    positions: [],
    connections: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  await assert.rejects(
    manager.prepareHandoff(project.id, orchestrator.id, worker.id, "Tarefa"),
    /não está conectado/i,
  );
});
