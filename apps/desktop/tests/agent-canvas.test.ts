import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { OrchestrationState } from "../src/contracts.ts";
import { buildAgentCanvasModel } from "../src/renderer/src/agent-canvas-model.ts";
import { ProjectStore } from "../src/main/services/store.ts";

test("canvas reflete agentes, estado operacional e conexões persistidas", () => {
  const orchestration: OrchestrationState = {
    schemaVersion: 1,
    agents: [
      {
        id: "architect",
        name: "Architect",
        role: "Architect",
        provider: "codex",
        instructions: "",
        createdAt: "2026-10-04T00:00:00.000Z",
      },
      {
        id: "tests",
        name: "Tests",
        role: "Tests",
        provider: "antigravity",
        instructions: "",
        createdAt: "2026-10-04T00:00:00.000Z",
      },
    ],
    agentStates: [
      {
        agentId: "tests",
        status: "waiting_review",
        currentTask: "Validar a suíte",
        updatedAt: "2026-10-04T00:00:00.000Z",
      },
    ],
    handoffs: [
      {
        id: "handoff-1",
        fromAgentId: "architect",
        toAgentId: "tests",
        fromRunId: "run-1",
        task: "Validar a suíte",
        summary: "Implementação concluída",
        createdAt: "2026-10-04T00:00:00.000Z",
        status: "pending",
      },
      {
        id: "orphan-handoff",
        fromAgentId: "missing",
        toAgentId: "tests",
        fromRunId: "run-2",
        task: "Não renderizar",
        summary: "Agente inexistente",
        createdAt: "2026-10-04T00:00:00.000Z",
        status: "failed",
      },
    ],
    canvas: {
      positions: [{ agentId: "tests", x: 510, y: 220, width: 300, height: 190 }],
      connections: [
        {
          id: "wire-1",
          fromAgentId: "architect",
          toAgentId: "tests",
        },
      ],
      viewport: { x: -20, y: 10, zoom: 1.1 },
    },
  };

  const model = buildAgentCanvasModel(orchestration);

  assert.deepEqual(
    model.nodes.map(({ agentId, status, currentTask }) => ({
      agentId,
      status,
      currentTask,
    })),
    [
      { agentId: "architect", status: "idle", currentTask: undefined },
      {
        agentId: "tests",
        status: "waiting_review",
        currentTask: "Validar a suíte",
      },
    ],
  );
  assert.deepEqual(model.nodes[1], {
    agentId: "tests",
    x: 510,
    y: 220,
    width: 300,
    height: 190,
    name: "Tests",
    role: "Tests",
    provider: "antigravity",
    status: "waiting_review",
    currentTask: "Validar a suíte",
  });
  assert.deepEqual(model.connections, [
    { id: "wire-1", fromAgentId: "architect", toAgentId: "tests" },
  ]);
  assert.deepEqual(model.viewport, { x: -20, y: 10, zoom: 1.1 });
});

test("canvas persiste posições, zoom e conexões entre agentes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-canvas-layout-"));
  const root = join(directory, "repo");
  await mkdir(root);
  const data = join(directory, "data");
  const store = new ProjectStore(data);
  const project = await store.openProject(root);
  const architect = await store.saveAgent(project.id, {
    name: "Architect",
    role: "Architect",
    provider: "codex",
    instructions: "",
  });
  const reviewer = await store.saveAgent(project.id, {
    name: "Reviewer",
    role: "Reviewer",
    provider: "claude",
    instructions: "",
  });
  const fromId = architect.agents[0].id;
  const toId = reviewer.agents[0].id;
  const connectionId = randomUUID();

  const saved = await store.saveAgentCanvas(project.id, {
    positions: [
      { agentId: fromId, x: 180, y: 220, width: 280, height: 170 },
      { agentId: toId, x: 640, y: 220, width: 280, height: 170 },
    ],
    connections: [{ id: connectionId, fromAgentId: fromId, toAgentId: toId }],
    viewport: { x: -40, y: 30, zoom: 1.25 },
  });

  const reopened = await new ProjectStore(data).orchestration(project.id);

  assert.deepEqual(saved.canvas, reopened.canvas);
  assert.equal(reopened.canvas?.connections[0].fromAgentId, fromId);
  assert.equal(reopened.canvas?.connections[0].toAgentId, toId);
  assert.equal(reopened.canvas?.viewport.zoom, 1.25);
});

test("canvas cria terminais Orchestrator e Worker e os conecta", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-agent-pair-"));
  const root = join(directory, "repo");
  await mkdir(root);
  const store = new ProjectStore(join(directory, "data"));
  const project = await store.openProject(root);

  await store.createCanvasAgent(project.id, "codex", "Orchestrator");
  await store.createCanvasAgent(project.id, "antigravity", "Worker");
  const reopened = await new ProjectStore(join(directory, "data")).orchestration(
    project.id,
  );

  assert.deepEqual(
    reopened.agents.map(({ name, role, provider }) => ({ name, role, provider })),
    [
      { name: "Worker", role: "Worker", provider: "antigravity" },
      { name: "Orchestrator", role: "Orchestrator", provider: "codex" },
    ],
  );
  assert.equal(reopened.canvas?.connections.length, 1);
  assert.equal(
    reopened.canvas?.connections[0].fromAgentId,
    reopened.agents.find((agent) => agent.role === "Orchestrator")?.id,
  );
  assert.equal(
    reopened.canvas?.connections[0].toAgentId,
    reopened.agents.find((agent) => agent.role === "Worker")?.id,
  );
  assert.equal(reopened.canvas?.positions.length, 2);
});

test("canvas rejeita conexões com agentes inexistentes e coordenadas inválidas", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-canvas-validation-"));
  const root = join(directory, "repo");
  await mkdir(root);
  const store = new ProjectStore(join(directory, "data"));
  const project = await store.openProject(root);
  const agent = await store.saveAgent(project.id, {
    name: "Architect",
    role: "Architect",
    provider: "codex",
    instructions: "",
  });

  await assert.rejects(
    store.saveAgentCanvas(project.id, {
      positions: [{ agentId: agent.agents[0].id, x: Number.NaN, y: 0 }],
      connections: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    }),
    /posição/i,
  );
  await assert.rejects(
    store.saveAgentCanvas(project.id, {
      positions: [],
      connections: [
        {
          id: randomUUID(),
          fromAgentId: agent.agents[0].id,
          toAgentId: randomUUID(),
        },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    }),
    /conexão/i,
  );
});

test("excluir terminal remove agente, posição e conexões do canvas", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-delete-terminal-"));
  const root = join(directory, "repo");
  await mkdir(root);
  const store = new ProjectStore(join(directory, "data"));
  const project = await store.openProject(root);
  await store.createCanvasAgent(project.id, "codex", "Orchestrator");
  await store.createCanvasAgent(project.id, "antigravity", "Worker");
  const before = await store.orchestration(project.id);
  const worker = before.agents.find((agent) => agent.role === "Worker");
  assert.ok(worker);

  const after = await store.deleteAgent(project.id, worker.id);

  assert.equal(
    after.agents.some((agent) => agent.id === worker.id),
    false,
  );
  assert.equal(
    after.agentStates.some((state) => state.agentId === worker.id),
    false,
  );
  assert.equal(
    after.canvas?.positions.some((position) => position.agentId === worker.id),
    false,
  );
  assert.equal(
    after.canvas?.connections.some(
      (connection) =>
        connection.fromAgentId === worker.id || connection.toAgentId === worker.id,
    ),
    false,
  );
});
