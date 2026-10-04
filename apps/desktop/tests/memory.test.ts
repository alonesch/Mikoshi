import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  sanitize,
  portableText,
  isSensitiveFile,
} from "../src/main/services/security.ts";
import { ProjectStore } from "../src/main/services/store.ts";
import { bootstrap, workingContext } from "../src/main/services/context.ts";

test("sanitiza segredos e normaliza apenas paths do projeto", () => {
  const sample =
    'password="private-value"\nAuthorization: Bearer abcdefghijk\n{"api_key":"sensitive-value"}\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';
  const result = sanitize(sample);
  for (const secret of ["private-value", "abcdefghijk", "sensitive-value", "\nabc\n"])
    assert.ok(!result.text.includes(secret));
  assert.ok(result.redactions >= 4);
  assert.equal(
    portableText("F:\\Repos\\Relic\\src\\main.ts", "F:\\Repos\\Relic"),
    "<PROJECT_ROOT>/src/main.ts",
  );
  assert.equal(
    portableText("F:\\Repos\\RelicOther\\file", "F:\\Repos\\Relic"),
    "F:\\Repos\\RelicOther\\file",
  );
});

test("sanitizador identifica credenciais conhecidas, connection strings e candidatos de entropia", () => {
  const sample = [
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
    "postgres://user:password@db.example.com/app",
    "-----BEGIN RSA PRIVATE KEY-----\nprivate-key-content\n-----END RSA PRIVATE KEY-----",
    "possible-token=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/==",
    "unclassified-value AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/==",
  ].join("\n");
  const result = sanitize(sample);

  assert.ok(!result.text.includes("abcdefghijklmnopqrstuvwxyz0123456789"));
  assert.ok(!result.text.includes("user:password"));
  assert.ok(!result.text.includes("private-key-content"));
  assert.ok(result.redactions >= 4);
  assert.ok(result.highConfidenceRedactions >= 3);
  assert.ok(result.heuristicCandidates >= 1);
  assert.equal(isSensitiveFile(".env.local"), true);
  assert.equal(isSensitiveFile(".claude/projects/session.jsonl"), true);
  assert.equal(isSensitiveFile("docs/architecture.md"), false);
});

test("identidade persiste e diff é incremental, revisado e detecta conflito", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-test-"));
  const root = join(directory, "repo");
  await mkdir(root);
  const store = new ProjectStore(join(directory, "data"));
  const project = await store.openProject(root);
  const reopened = await new ProjectStore(join(directory, "data")).openProject(root);
  assert.equal(project.id, reopened.id);
  const initial = await store.memory(project.id);
  const draft = await store.propose(
    project.id,
    [{ op: "add", kind: "decision", text: "TURN adiado", source: "manual" }],
    "manual",
  );
  assert.equal((await store.memory(project.id)).items.length, 0);
  await store.apply(project.id, draft.id, [{ index: 0, text: "TURN fora do MVP" }]);
  const after = await store.memory(project.id);
  assert.equal(after.revision, initial.revision + 1);
  assert.equal(after.items[0].text, "TURN fora do MVP");
  assert.equal(after.items[0].provenance[0].source, "manual");
  const old = await store.propose(
    project.id,
    [{ op: "add", kind: "fact", text: "Old", source: "manual" }],
    "manual",
  );
  const fresh = await store.propose(
    project.id,
    [
      {
        op: "update",
        targetId: after.items[0].id,
        kind: "decision",
        text: "TURN futuro",
        source: "manual",
      },
    ],
    "manual",
  );
  await store.apply(project.id, fresh.id, [{ index: 0 }]);
  await assert.rejects(
    store.apply(project.id, old.id, [{ index: 0 }]),
    /revisão|conflito/i,
  );
  assert.equal((await store.memory(project.id)).items.length, 1);
  assert.match(
    await readFile(join(directory, "data", "projects", project.id, "REVIEW.md"), "utf8"),
    /TURN futuro/,
  );
});

test("ciclo de memória preserva histórico em update, obsolescência, remoção e restore", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-lifecycle-"));
  const root = join(directory, "repo");
  await mkdir(root);
  const store = new ProjectStore(join(directory, "data"));
  const project = await store.openProject(root);
  const original = await store.propose(
    project.id,
    [{ op: "add", kind: "decision", text: "Usar JSON", source: "manual" }],
    "manual",
  );
  await store.apply(project.id, original.id, [{ index: 0 }]);
  const oldItem = (await store.memory(project.id)).items[0];
  const replacementId = randomUUID();
  const replacement = await store.propose(
    project.id,
    [
      {
        op: "add",
        itemId: replacementId,
        kind: "decision",
        text: "Usar SQLite",
        source: "manual",
      },
      {
        op: "mark_obsolete",
        targetId: oldItem.id,
        replacedBy: replacementId,
        kind: "decision",
        text: "Migrado pela decisão aprovada",
        source: "manual",
      },
    ],
    "manual",
  );
  await store.apply(
    project.id,
    replacement.id,
    replacement.changes.map((_, index) => ({ index })),
  );

  const afterReplacement = await store.memory(project.id);
  const obsolete = afterReplacement.items.find((item) => item.id === oldItem.id);
  assert.equal(obsolete?.status, "obsolete");
  assert.equal(
    obsolete?.replacedBy,
    afterReplacement.items.find((item) => item.id !== oldItem.id)?.id,
  );
  assert.ok(
    afterReplacement.history.some((event) => event.operation === "MARK_OBSOLETE"),
  );
  assert.equal(
    workingContext(project, afterReplacement, {
      task: "Decisão atual de armazenamento",
      role: "Architect",
      permission: "read-only",
    }).text.includes("Usar JSON"),
    false,
  );

  const remove = await store.propose(
    project.id,
    [
      {
        op: "delete",
        targetId: oldItem.id,
        kind: oldItem.kind,
        text: "Remover decisão obsoleta",
        source: "manual",
      },
    ],
    "manual",
  );
  await store.apply(project.id, remove.id, [{ index: 0 }]);
  const afterRemove = await store.memory(project.id);
  assert.equal(
    afterRemove.items.find((item) => item.id === oldItem.id)?.status,
    "removed",
  );

  const restore = await store.propose(
    project.id,
    [
      {
        op: "restore",
        targetId: oldItem.id,
        kind: oldItem.kind,
        text: oldItem.text,
        source: "manual",
      },
    ],
    "manual",
  );
  await store.apply(project.id, restore.id, [{ index: 0 }]);
  const restored = await store.memory(project.id);
  assert.equal(restored.items.find((item) => item.id === oldItem.id)?.status, "active");
  assert.deepEqual(
    restored.history.map((event) => event.operation),
    ["ADD", "ADD", "MARK_OBSOLETE", "REMOVE", "RESTORE"],
  );
});

test("bootstrap usa allowlist e working context usa somente memória relevante", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-context-"));
  const root = join(directory, "repo");
  await mkdir(join(root, "src"), { recursive: true });
  await promisify(execFile)("git", ["-C", root, "init", "--quiet"], {
    windowsHide: true,
  });
  await writeFile(
    join(root, "README.md"),
    "# Demo\n- PostgreSQL escolhido.\n- password=super-secret-value\n\n# Convenções\n- Sempre prefira consultas parametrizadas no banco.\n\n# Decisões inferidas\n- Provavelmente o histórico fica no PostgreSQL primário.\n\n# Problemas conhecidos\n- FIXME falha quando o banco fica indisponível.",
  );
  await writeFile(join(root, ".env"), "TOKEN=must-never-be-read");
  await writeFile(join(root, "credentials.md"), "- password=never-read-this either");
  await writeFile(join(root, "AGENTS.md"), "- Sempre valide transições de memória.");
  await writeFile(join(root, "TODO.md"), "- TODO revisar a estratégia PostgreSQL.");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ dependencies: { react: "19" } }),
  );
  const store = new ProjectStore(join(directory, "data"));
  const project = await store.openProject(root);
  const candidates = await bootstrap(project);
  assert.ok(candidates.changes.length > 0);
  assert.ok(!JSON.stringify(candidates).includes("super-secret-value"));
  assert.ok(!JSON.stringify(candidates).includes("must-never-be-read"));
  assert.ok(!JSON.stringify(candidates).includes("never-read-this"));
  assert.ok(candidates.changes.some((change) => change.evidence === "instruction"));
  assert.ok(candidates.changes.some((change) => change.evidence === "task"));
  assert.ok(
    candidates.changes.some(
      (change) => change.kind === "decision" && change.evidence === "explicit",
    ),
  );
  assert.ok(
    candidates.changes.some(
      (change) => change.kind === "decision" && change.evidence === "inferred",
    ),
  );
  assert.ok(candidates.changes.some((change) => change.evidence === "convention"));
  assert.ok(candidates.changes.some((change) => change.evidence === "issue"));
  assert.ok(candidates.changes.some((change) => change.source === "git:branch"));
  assert.ok(candidates.structure.includes("src"));
  const draft = await store.propose(project.id, candidates.changes, "bootstrap");
  await store.apply(
    project.id,
    draft.id,
    draft.changes.map((_, index) => ({ index })),
  );
  const memory = await store.memory(project.id);
  const context = workingContext(project, memory, {
    task: "Revisar PostgreSQL",
    role: "Reviewer",
    permission: "read-only",
  });
  assert.match(context.text, /PostgreSQL/);
  assert.match(context.text, /Reviewer/);
  assert.ok(!context.text.includes(root));
});

test("working context prioriza memórias diferentes por papel e tarefa sem copiar tudo", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-role-context-"));
  const root = join(directory, "repo");
  await mkdir(root);
  const store = new ProjectStore(join(directory, "data"));
  const project = await store.openProject(root);
  const draft = await store.propose(
    project.id,
    Array.from({ length: 18 }, (_, index) => ({
      op: "add" as const,
      kind: index < 9 ? ("decision" as const) : ("issue" as const),
      text: `${index < 9 ? "Arquitetura" : "Falha"} caso-${index} do processamento de eventos`,
      source: "manual",
    })),
    "manual",
  );
  await store.apply(
    project.id,
    draft.id,
    draft.changes.map((_, index) => ({ index })),
  );
  const memory = await store.memory(project.id);
  const architect = workingContext(project, memory, {
    task: "Trabalhar no serviço",
    role: "Architect",
    permission: "read-only",
  });
  const reviewer = workingContext(project, memory, {
    task: "Trabalhar no serviço",
    role: "Reviewer",
    permission: "read-only",
  });
  const interactiveWorker = workingContext(
    project,
    memory,
    {
      task: "Investigar o processamento de eventos",
      role: "Worker",
      permission: "workspace-write",
      agentName: "Worker",
      agentInstructions: "Explique cada alteração no terminal.",
    },
    "",
    [],
    "interactive",
  );

  assert.notDeepEqual(architect.includedIds, reviewer.includedIds);
  assert.ok(architect.includedIds.length < memory.items.length);
  assert.ok(reviewer.includedIds.length < memory.items.length);
  assert.match(interactiveWorker.text, /CURRENT TASK: Investigar/);
  assert.match(interactiveWorker.text, /diretamente nesta sessão interativa/);
  assert.doesNotMatch(interactiveWorker.text, /Retorne JSON no formato exigido/);
});

test("agentes e handoffs persistem separados da memória canônica e dos runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-orchestration-"));
  const root = join(directory, "repo");
  await mkdir(root);
  const store = new ProjectStore(join(directory, "data"));
  const project = await store.openProject(root);
  const architect = await store.saveAgent(project.id, {
    name: "Arquiteto",
    role: "Architect",
    provider: "antigravity",
    instructions: "Compare decisões aprovadas.",
  });
  const reviewer = await store.saveAgent(project.id, {
    name: "Reviewer",
    role: "Reviewer",
    provider: "kimi",
    instructions: "Encontre regressões e reporte evidências.",
  });
  await store.saveHandoff(project.id, {
    id: randomUUID(),
    fromAgentId: architect.agents[0].id,
    toAgentId: reviewer.agents[0].id,
    fromRunId: randomUUID(),
    task: "Revisar o plano de arquitetura",
    summary: "As opções e os trade-offs foram registrados.",
    createdAt: new Date().toISOString(),
    status: "pending",
  });

  const reopened = await new ProjectStore(join(directory, "data")).orchestration(
    project.id,
  );
  assert.deepEqual(reopened.agents.map((agent) => agent.provider).sort(), [
    "antigravity",
    "kimi",
  ]);
  assert.equal(reopened.handoffs[0].status, "pending");
  assert.equal((await store.memory(project.id)).items.length, 0);
  assert.equal((await store.runs(project.id)).length, 0);
});

test("path mapping persiste localmente e só remapeia o path antigo da raiz", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-path-store-"));
  const root = join(directory, "repo");
  await mkdir(root);
  const dataRoot = join(directory, "data");
  const store = new ProjectStore(dataRoot);
  const project = await store.openProject(root);
  await store.savePathMapping(project.id, "F:\\Repos\\Legacy");
  const draft = await store.propose(
    project.id,
    [
      {
        op: "add",
        kind: "fact",
        text: "F:\\Repos\\Legacy\\src\\main.ts e C:\\Users\\someone\\private.txt",
        source: "manual",
      },
    ],
    "manual",
  );

  assert.match(draft.changes[0].text, /<PROJECT_ROOT>\/src\/main\.ts/);
  assert.match(draft.changes[0].text, /<EXTERNAL_PATH>/);
  assert.equal(
    (await new ProjectStore(dataRoot).pathMappings(project.id))[0].targetRoot,
    root,
  );
  await assert.rejects(store.savePathMapping(project.id, "relative\\old"), /absoluto/i);
  await rm(root, { recursive: true });
  await assert.rejects(store.savePathMapping(project.id, "F:\\Other"), /exist/i);
});
