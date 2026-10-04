import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ProviderId } from "../src/contracts.ts";
import { AgentBridge } from "../src/main/services/agent-bridge.ts";
import { ProjectStore } from "../src/main/services/store.ts";

interface BridgeFixture {
  bridge: AgentBridge;
  store: ProjectStore;
  projectId: string;
  orchestratorId: string;
  workerId: string;
  workerTerminalId: string;
  orchestratorClient: Client;
  workerClient: Client;
  dispatched: Array<{ handoffId: string; toAgentId: string; task: string }>;
  close(): Promise<void>;
}

async function createBridgeFixture(
  orchestratorProvider: ProviderId = "kimi",
): Promise<BridgeFixture> {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-agent-bridge-"));
  const root = join(directory, "repo");
  await mkdir(root);
  const store = new ProjectStore(join(directory, "data"));
  const project = await store.openProject(root);
  await store.createCanvasAgent(project.id, orchestratorProvider, "Orchestrator");
  await store.createCanvasAgent(project.id, "antigravity", "Reviewer");
  const state = await store.orchestration(project.id);
  const orchestrator = state.agents.find((agent) => agent.role === "Orchestrator");
  const worker = state.agents.find((agent) => agent.role === "Reviewer");
  assert.ok(orchestrator && worker);
  await store.saveAgentCanvas(project.id, {
    positions: [],
    connections: [
      {
        id: randomUUID(),
        fromAgentId: orchestrator.id,
        toAgentId: worker.id,
      },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  const workerTerminalId = randomUUID();
  const activeAgents = new Set([orchestrator.id, worker.id]);
  const dispatched: BridgeFixture["dispatched"] = [];
  const bridge = new AgentBridge(store, {
    isTerminalActive: (projectId, agentId) =>
      projectId === project.id && activeAgents.has(agentId),
    prepareHandoff: async (handoff) => {
      dispatched.push({
        handoffId: handoff.id,
        toAgentId: handoff.toAgentId,
        task: handoff.task,
      });
    },
  });
  await bridge.listen();
  const orchestratorSession = await bridge.openSession(
    project.id,
    randomUUID(),
    orchestrator.id,
  );
  const workerSession = await bridge.openSession(project.id, workerTerminalId, worker.id);
  const orchestratorClient = await connectClient(
    orchestratorSession.endpoint,
    orchestratorSession.token,
  );
  const workerClient = await connectClient(workerSession.endpoint, workerSession.token);

  return {
    bridge,
    store,
    projectId: project.id,
    orchestratorId: orchestrator.id,
    workerId: worker.id,
    workerTerminalId,
    orchestratorClient,
    workerClient,
    dispatched,
    close: async () => {
      await orchestratorClient.close();
      await workerClient.close();
      await bridge.shutdown();
    },
  };
}

async function connectClient(endpoint: string, token?: string): Promise<Client> {
  const client = new Client({ name: "mikoshi-bridge-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  await client.connect(transport);
  return client;
}

test("provider configurado como Orchestrator lista somente destinos conectados ativos", async () => {
  const fixture = await createBridgeFixture();
  try {
    const tools = await fixture.orchestratorClient.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "mikoshi_list_connected_agents"));
    assert.ok(tools.tools.some((tool) => tool.name === "mikoshi_delegate_task"));
    const result = await fixture.orchestratorClient.callTool({
      name: "mikoshi_list_connected_agents",
      arguments: {},
    });
    assert.equal(result.isError, undefined);
    assert.match(JSON.stringify(result.content).toLowerCase(), /antigravity/);
  } finally {
    await fixture.close();
  }
});

test("papel Orchestrator habilita delegação para providers diferentes do Codex", async () => {
  const fixture = await createBridgeFixture("antigravity");
  try {
    const tools = await fixture.orchestratorClient.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "mikoshi_delegate_task"));
    const state = await fixture.store.orchestration(fixture.projectId);
    assert.equal(
      state.agents.find((agent) => agent.id === fixture.orchestratorId)?.provider,
      "antigravity",
    );
  } finally {
    await fixture.close();
  }
});

test("worker não recebe ferramenta de delegação", async () => {
  const fixture = await createBridgeFixture();
  try {
    const tools = await fixture.workerClient.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "mikoshi_return_handoff_result"));
    assert.equal(
      tools.tools.some((tool) => tool.name === "mikoshi_delegate_task"),
      false,
    );
  } finally {
    await fixture.close();
  }
});

test("delegação screen-only injeta tarefa e retorna apenas recibo", async () => {
  const fixture = await createBridgeFixture();
  try {
    const result = await fixture.orchestratorClient.callTool({
      name: "mikoshi_delegate_task",
      arguments: {
        targetAgentId: fixture.workerId,
        task: "Inspecione a árvore do projeto.",
        returnPolicy: "screen-only",
      },
    });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(fixture.dispatched.length, 1);
    assert.equal(fixture.dispatched[0].toAgentId, fixture.workerId);
    assert.match(JSON.stringify(result.content), /delivered/);
    assert.equal(JSON.stringify(result.content).includes("árvore do projeto"), false);
    const state = await fixture.store.orchestration(fixture.projectId);
    assert.equal(state.handoffs[0].status, "completed");
    assert.equal(state.handoffs[0].result, undefined);
  } finally {
    await fixture.close();
  }
});

test("encerrar o worker rejeita um handoff aguardando retorno", async () => {
  const fixture = await createBridgeFixture();
  try {
    const delegation = fixture.orchestratorClient.callTool({
      name: "mikoshi_delegate_task",
      arguments: {
        targetAgentId: fixture.workerId,
        task: "Rode os testes e retorne o resumo.",
        returnPolicy: "return-to-orchestrator",
      },
    });
    for (let attempt = 0; attempt < 20 && !fixture.dispatched[0]; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(fixture.dispatched.length, 1);
    await fixture.bridge.closeSession(fixture.workerTerminalId);
    const result = await delegation;
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /sessão de um dos agentes terminou/i);
    const state = await fixture.store.orchestration(fixture.projectId);
    assert.equal(state.handoffs[0].status, "failed");
  } finally {
    await fixture.close();
  }
});

test("retorno solicitado só conclui quando o worker envia resultado explícito", async () => {
  const fixture = await createBridgeFixture();
  try {
    const delegation = fixture.orchestratorClient.callTool({
      name: "mikoshi_delegate_task",
      arguments: {
        targetAgentId: fixture.workerId,
        task: "Execute os testes e retorne o resumo.",
        returnPolicy: "return-to-orchestrator",
      },
    });
    for (let attempt = 0; attempt < 20 && !fixture.dispatched[0]; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const handoffId = fixture.dispatched[0]?.handoffId;
    assert.ok(handoffId);
    const earlyState = await fixture.store.orchestration(fixture.projectId);
    assert.equal(earlyState.handoffs[0].status, "started");

    const workerResult = await fixture.workerClient.callTool({
      name: "mikoshi_return_handoff_result",
      arguments: { handoffId, result: "12/12 testes passaram." },
    });
    assert.equal(workerResult.isError, undefined, JSON.stringify(workerResult));
    const result = await delegation;
    assert.match(JSON.stringify(result.content), /12\/12 testes passaram/);
    const finalState = await fixture.store.orchestration(fixture.projectId);
    assert.equal(finalState.handoffs[0].status, "completed");
    assert.equal(finalState.handoffs[0].result, "12/12 testes passaram.");
  } finally {
    await fixture.close();
  }
});

test("ponte MCP rejeita bearer token inválido", async () => {
  const fixture = await createBridgeFixture();
  try {
    const url = fixture.bridge.endpointFor(fixture.projectId, fixture.orchestratorId);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer token-invalido",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    });
    assert.equal(response.status, 401);
  } finally {
    await fixture.close();
  }
});

test("aberturas MCP simultâneas compartilham e encerram um único servidor local", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-bridge-concurrent-"));
  const root = join(directory, "repo");
  await mkdir(root);
  const store = new ProjectStore(join(directory, "data"));
  const project = await store.openProject(root);
  await store.createCanvasAgent(project.id, "codex", "Orchestrator");
  await store.createCanvasAgent(project.id, "kimi", "Worker");
  const agents = (await store.orchestration(project.id)).agents;
  const bridge = new AgentBridge(store, {
    isTerminalActive: () => true,
    prepareHandoff: async () => undefined,
  });

  const sessions = await Promise.all(
    agents.map((agent) => bridge.openSession(project.id, randomUUID(), agent.id)),
  );
  assert.equal(
    new URL(sessions[0].endpoint).origin,
    new URL(sessions[1].endpoint).origin,
  );
  await bridge.shutdown();
  for (const session of sessions)
    await assert.rejects(fetch(session.endpoint), TypeError);
});
