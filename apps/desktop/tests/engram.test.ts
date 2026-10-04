import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ProjectStore } from "../src/main/services/store.ts";
import { exportEngram, importEngram } from "../src/main/services/engram.ts";

test("Engram mantém identidade e proveniência entre máquinas sem exportar paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-engram-"));
  const firstRoot = join(directory, "machine-a");
  const secondRoot = join(directory, "machine-b");
  await mkdir(firstRoot);
  const first = new ProjectStore(join(directory, "data-a"));
  const project = await first.openProject(firstRoot);
  const draft = await first.propose(
    project.id,
    [
      {
        op: "add",
        kind: "decision",
        text: "Use " + firstRoot + "/src para módulos. password=do-not-export",
        source: "manual",
      },
    ],
    "manual",
  );
  await first.apply(project.id, draft.id, [{ index: 0 }]);
  const exported = exportEngram(project, await first.memory(project.id));
  assert.ok(!exported.includes("do-not-export"));
  assert.ok(!exported.includes(firstRoot));
  assert.match(exported, /<PROJECT_ROOT>/);
  await cp(firstRoot, secondRoot, { recursive: true });
  const second = new ProjectStore(join(directory, "data-b"));
  const mapped = await second.openProject(secondRoot);
  assert.equal(mapped.id, project.id);
  const imported = importEngram(exported, mapped, await second.memory(mapped.id));
  assert.equal(imported.history.length, 1);
  const review = await second.propose(
    mapped.id,
    imported.changes,
    "engram",
    undefined,
    imported.redactions,
    undefined,
    imported.conflicts,
    imported.orchestration,
    imported.mappingCount,
    imported.history,
  );
  assert.equal((await second.memory(mapped.id)).items.length, 0);
  await second.apply(mapped.id, review.id, {
    changes: [{ index: 0 }],
    includeHistory: true,
  });
  const memory = await second.memory(mapped.id);
  assert.equal(memory.items[0].provenance[0].source, "manual");
  assert.equal(memory.history.length, 2);
  assert.equal(memory.items[0].id, (await first.memory(project.id)).items[0].id);
  const back = exportEngram(mapped, memory);
  assert.equal(
    importEngram(back, project, await first.memory(project.id)).changes.length,
    0,
  );
  assert.equal(importEngram(exported, mapped, memory).changes.length, 0);
  assert.throws(() => importEngram(exported, { ...mapped, id: "different" }, memory));
});

test("Engram restaura mais de 100 itens e incorpora proveniência adicional", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-bulk-"));
  const root = join(directory, "repo");
  await mkdir(root);
  const store = new ProjectStore(join(directory, "data"));
  const project = await store.openProject(root);
  const envelope = {
    schemaVersion: 1,
    format: "mikoshi-engram",
    project: { id: project.id },
    items: Array.from({ length: 101 }, (_, index) => ({
      id: randomUUID(),
      kind: "fact",
      text: "Fato " + index,
      provenance: [{ source: "original", date: "2026-10-03T00:00:00.000Z" }],
    })),
  };
  const imported = importEngram(
    JSON.stringify(envelope),
    project,
    await store.memory(project.id),
  );
  assert.equal(imported.changes.length, 101);
  const draft = await store.propose(project.id, imported.changes, "engram");
  await store.apply(
    project.id,
    draft.id,
    draft.changes.map((_, index) => ({ index })),
  );
  assert.equal((await store.memory(project.id)).items.length, 101);
  envelope.items[0].provenance.push({
    source: "additional-evidence",
    date: "2026-10-04T00:00:00.000Z",
  });
  const update = importEngram(
    JSON.stringify(envelope),
    project,
    await store.memory(project.id),
  );
  assert.equal(update.changes.length, 1);
  const review = await store.propose(project.id, update.changes, "engram");
  await store.apply(project.id, review.id, [{ index: 0 }]);
  assert.equal((await store.memory(project.id)).items[0].provenance.length, 2);
  assert.equal(
    importEngram(JSON.stringify(envelope), project, await store.memory(project.id))
      .changes.length,
    0,
  );
});

test("Engram v2 exporta agentes e handoffs sem segredos ou raízes locais", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-engram-v2-"));
  const root = join(directory, "repo");
  await mkdir(root);
  const store = new ProjectStore(join(directory, "data"));
  const project = await store.openProject(root);
  await store.savePathMapping(project.id, "F:\\OldMachine\\Repo");
  const configured = await store.saveAgent(project.id, {
    name: "Reviewer",
    role: "Reviewer",
    provider: "claude",
    instructions: "Use password=hidden-agent-secret e revise regressões.",
  });
  await store.saveAgentCanvas(project.id, {
    positions: [
      {
        agentId: configured.agents[0].id,
        x: 420,
        y: 260,
        width: 300,
        height: 180,
      },
    ],
    connections: [],
    viewport: { x: -80, y: 25, zoom: 1.2 },
  });
  const sessionId = randomUUID();
  const runMemory = await store.propose(
    project.id,
    [
      {
        op: "add",
        kind: "fact",
        text: "Confirmação temporária",
        source: "claude",
      },
    ],
    "claude",
    sessionId,
  );
  await store.apply(project.id, runMemory.id, [{ index: 0 }]);
  const orchestration = await store.orchestration(project.id);

  const exported = exportEngram(
    project,
    await store.memory(project.id),
    orchestration,
    await store.pathMappings(project.id),
  );

  assert.equal(JSON.parse(exported).schemaVersion, 2);
  assert.equal("canvas" in JSON.parse(exported).orchestration, false);
  assert.ok(exported.includes("claude"));
  assert.ok(exported.includes("<PROJECT_ROOT>"));
  assert.ok(!exported.includes(root));
  assert.ok(!exported.includes("OldMachine"));
  assert.ok(!exported.includes("hidden-agent-secret"));
  assert.ok(!exported.includes(sessionId));
});

test("Engram preview explicita conflitos e replace obsoleta itens ausentes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-engram-conflict-"));
  const root = join(directory, "repo");
  await mkdir(root);
  const store = new ProjectStore(join(directory, "data"));
  const project = await store.openProject(root);
  const existing = await store.propose(
    project.id,
    [
      {
        op: "add",
        itemId: randomUUID(),
        kind: "decision",
        text: "Política antiga",
        source: "manual",
      },
      {
        op: "add",
        kind: "task",
        text: "Tarefa local que será obsoleta",
        source: "manual",
      },
    ],
    "manual",
  );
  await store.apply(
    project.id,
    existing.id,
    existing.changes.map((_, index) => ({ index })),
  );
  const memory = await store.memory(project.id);
  const item = memory.items.find((entry) => entry.kind === "decision");
  assert.ok(item);
  const exported = JSON.stringify({
    schemaVersion: 2,
    format: "mikoshi-engram",
    project: { id: project.id, name: project.name },
    items: [
      {
        id: item.id,
        kind: item.kind,
        text: "Política nova incompatível",
        status: "active",
        provenance: [{ source: "engram-source", date: "2026-10-04T00:00:00.000Z" }],
      },
    ],
    history: [],
    orchestration: { schemaVersion: 1, agents: [], agentStates: [], handoffs: [] },
  });

  const result = importEngram(exported, project, memory, "replace");

  assert.equal(result.conflicts.length, 1);
  assert.ok(
    result.changes.some(
      (change) => change.op === "update" && change.targetId === item.id,
    ),
  );
  assert.ok(result.changes.some((change) => change.op === "mark_obsolete"));
});

test("importação Engram só restaura agentes e handoffs selecionados na revisão", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-engram-agents-"));
  const sourceRoot = join(directory, "source");
  const targetRoot = join(directory, "target");
  await mkdir(sourceRoot);
  const source = new ProjectStore(join(directory, "source-data"));
  const sourceProject = await source.openProject(sourceRoot);
  const first = await source.saveAgent(sourceProject.id, {
    name: "Architect",
    role: "Architect",
    provider: "codex",
    instructions: "Leia as decisões.",
  });
  const second = await source.saveAgent(sourceProject.id, {
    name: "Reviewer",
    role: "Reviewer",
    provider: "claude",
    instructions: "Revise o diff.",
  });
  await source.saveHandoff(sourceProject.id, {
    id: randomUUID(),
    fromAgentId: first.agents[0].id,
    toAgentId: second.agents[0].id,
    fromRunId: randomUUID(),
    task: "Revisar decisões",
    summary: "A arquitetura está descrita.",
    createdAt: new Date().toISOString(),
    status: "completed",
  });
  const exported = exportEngram(
    sourceProject,
    await source.memory(sourceProject.id),
    await source.orchestration(sourceProject.id),
  );
  await cp(sourceRoot, targetRoot, { recursive: true });
  const target = new ProjectStore(join(directory, "target-data"));
  const targetProject = await target.openProject(targetRoot);
  const localAgent = await target.saveAgent(targetProject.id, {
    name: "Local Layout Agent",
    role: "Backend",
    provider: "kimi",
    instructions: "Configuração que fica nesta máquina.",
  });
  await target.saveAgentCanvas(targetProject.id, {
    positions: [
      {
        agentId: localAgent.agents[0].id,
        x: 720,
        y: 340,
        width: 320,
        height: 210,
      },
    ],
    connections: [],
    viewport: { x: -120, y: 35, zoom: 0.9 },
  });
  const result = importEngram(
    exported,
    targetProject,
    await target.memory(targetProject.id),
  );
  const draft = await target.propose(
    targetProject.id,
    result.changes,
    "engram",
    undefined,
    result.redactions,
    undefined,
    result.conflicts,
    result.orchestration,
  );

  await target.apply(targetProject.id, draft.id, {
    changes: [],
    agentIds: [result.orchestration.agents[0].id],
    handoffIds: [],
  });

  const imported = await target.orchestration(targetProject.id);
  assert.equal(imported.agents.length, 2);
  assert.ok(
    imported.agents.some((agent) => agent.id === result.orchestration.agents[0].id),
  );
  assert.ok(imported.agents.some((agent) => agent.id === localAgent.agents[0].id));
  assert.equal(imported.handoffs.length, 0);
  assert.deepEqual(imported.canvas?.positions, [
    {
      agentId: localAgent.agents[0].id,
      x: 720,
      y: 340,
      width: 320,
      height: 210,
    },
  ]);
  assert.deepEqual(imported.canvas?.viewport, { x: -120, y: 35, zoom: 0.9 });
});

test("operações concorrentes rejeitam revisão obsoleta sem perder memória", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-concurrent-"));
  const root = join(directory, "repo");
  await mkdir(root);
  const store = new ProjectStore(join(directory, "data"));
  const project = await store.openProject(root);
  const drafts = await Promise.all(
    ["First", "Second"].map((text) =>
      store.propose(
        project.id,
        [{ op: "add", kind: "fact", text, source: "manual" }],
        "manual",
      ),
    ),
  );
  const results = await Promise.allSettled(
    drafts.map((draft) => store.apply(project.id, draft.id, [{ index: 0 }])),
  );
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await store.memory(project.id)).items.length, 1);
  assert.equal((await store.memory(project.id)).revision, 1);
});

test("dados corrompidos e identidade inválida não são silenciosamente sobrescritos", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-corruption-"));
  const root = join(directory, "repo");
  await mkdir(join(root, ".mikoshi"), { recursive: true });
  await writeFile(
    join(root, ".mikoshi", "project.json"),
    '{"schemaVersion":1,"id":"../../outside"}',
  );
  const store = new ProjectStore(join(directory, "data"));
  await assert.rejects(store.openProject(root), /Identificador inválido/);
});

test("validação temporária pode registrar um projeto sem escrever nele", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-readonly-project-"));
  const root = join(directory, "repo");
  await mkdir(root);
  const store = new ProjectStore(join(directory, "data"));
  const project = await store.openProject(root, { writeIdentityMarker: false });

  assert.equal((await store.project(project.id)).root, root);
  await assert.rejects(access(join(root, ".mikoshi")), { code: "ENOENT" });
});

test("execução ativa vira interrompida após reinício, sem reexecutar provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-recovery-"));
  const root = join(directory, "repo");
  await mkdir(root);
  const store = new ProjectStore(join(directory, "data"));
  const project = await store.openProject(root);
  await store.saveRun({
    id: randomUUID(),
    projectId: project.id,
    provider: "codex",
    role: "Backend",
    task: "Tarefa interrompida",
    permission: "read-only",
    status: "running",
    startedAt: new Date().toISOString(),
    output: "",
    contextItemIds: [],
  });
  await new ProjectStore(join(directory, "data")).recover();
  assert.equal((await store.runs(project.id))[0].status, "interrupted");
  assert.ok((await store.runs(project.id))[0].finishedAt);
});
