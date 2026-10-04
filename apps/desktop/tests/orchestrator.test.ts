import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentRun, ProviderId, TaskInput } from "../src/contracts.ts";
import { ProjectStore } from "../src/main/services/store.ts";
import { AgentOrchestrator } from "../src/main/services/orchestrator.ts";

test("Mikoshi controla handoff, muda provider e persiste estado operacional", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-handoff-"));
  const root = join(directory, "repo");
  await mkdir(root);
  const store = new ProjectStore(join(directory, "data"));
  const project = await store.openProject(root);
  const architect = await store.saveAgent(project.id, {
    name: "Architect",
    role: "Architect",
    provider: "codex",
    instructions: "Proponha opções e limites.",
  });
  const reviewer = await store.saveAgent(project.id, {
    name: "Reviewer",
    role: "Reviewer",
    provider: "claude",
    instructions: "Analise riscos e evidências.",
  });
  const sourceRun: AgentRun = {
    id: randomUUID(),
    projectId: project.id,
    provider: "codex",
    agentId: architect.agents[0].id,
    role: "Architect",
    task: "Compare abordagens",
    permission: "read-only",
    status: "completed",
    startedAt: new Date().toISOString(),
    output: "A proposta mantém os dados e limita o tamanho do histórico.",
    contextItemIds: [],
  };
  await store.saveRun(sourceRun);
  let received: { input: TaskInput; provider: ProviderId } | undefined;
  const orchestrator = new AgentOrchestrator(store, {
    start: async (_projectId, input, provider): Promise<AgentRun> => {
      received = { input: input as TaskInput, provider: provider ?? "codex" };
      return {
        ...sourceRun,
        id: randomUUID(),
        agentId: reviewer.agents[0].id,
        provider: received.provider,
        status: "running",
        output: "",
      };
    },
  });

  const run = await orchestrator.handoff(
    project.id,
    sourceRun.id,
    reviewer.agents[0].id,
    "Revise a proposta e aponte riscos.",
  );
  const state = await store.orchestration(project.id);

  assert.equal(run.agentId, reviewer.agents[0].id);
  assert.equal(received?.provider, "claude");
  assert.match(received?.input.handoff ?? "", /limita o tamanho/);
  assert.match(received?.input.agentInstructions ?? "", /riscos e evidências/);
  assert.equal(state.handoffs[0].status, "started");
  assert.equal(state.handoffs[0].toRunId, run.id);
  assert.equal(
    state.agentStates.find((agent) => agent.agentId === reviewer.agents[0].id)?.status,
    "running",
  );
});

test("handoff rejeita runs não concluídos e destino não configurado", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-handoff-invalid-"));
  const root = join(directory, "repo");
  await mkdir(root);
  const store = new ProjectStore(join(directory, "data"));
  const project = await store.openProject(root);
  const source = await store.saveAgent(project.id, {
    name: "Backend",
    role: "Backend",
    provider: "codex",
    instructions: "",
  });
  const run: AgentRun = {
    id: randomUUID(),
    projectId: project.id,
    provider: "codex",
    agentId: source.agents[0].id,
    role: "Backend",
    task: "Implementar",
    permission: "read-only",
    status: "running",
    startedAt: new Date().toISOString(),
    output: "",
    contextItemIds: [],
  };
  await store.saveRun(run);
  const orchestrator = new AgentOrchestrator(store, {
    start: async () => run,
  });

  await assert.rejects(
    orchestrator.handoff(project.id, run.id, randomUUID(), "Revisar"),
    /concluída/i,
  );
  assert.equal((await store.orchestration(project.id)).handoffs.length, 0);
});

test("handoff respeita as conexões de saída definidas no workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-handoff-route-"));
  const root = join(directory, "repo");
  await mkdir(root);
  const store = new ProjectStore(join(directory, "data"));
  const project = await store.openProject(root);
  const source = await store.saveAgent(project.id, {
    name: "Architect",
    role: "Architect",
    provider: "codex",
    instructions: "",
  });
  const allowed = await store.saveAgent(project.id, {
    name: "Reviewer",
    role: "Reviewer",
    provider: "claude",
    instructions: "",
  });
  const blocked = await store.saveAgent(project.id, {
    name: "Tests",
    role: "Tests",
    provider: "antigravity",
    instructions: "",
  });
  await store.saveAgentCanvas(project.id, {
    positions: [],
    connections: [
      {
        id: randomUUID(),
        fromAgentId: source.agents[0].id,
        toAgentId: allowed.agents[0].id,
      },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  const run: AgentRun = {
    id: randomUUID(),
    projectId: project.id,
    provider: "codex",
    agentId: source.agents[0].id,
    role: "Architect",
    task: "Propor",
    permission: "read-only",
    status: "completed",
    startedAt: new Date().toISOString(),
    output: "Proposta pronta.",
    contextItemIds: [],
  };
  await store.saveRun(run);
  const orchestrator = new AgentOrchestrator(store, {
    start: async () => ({ ...run, id: randomUUID(), status: "running" }),
  });

  await assert.rejects(
    orchestrator.handoff(project.id, run.id, blocked.agents[0].id, "Rodar testes"),
    /conectado no workspace/i,
  );
});
