import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { readFile, writeFile, lstat } from "node:fs/promises";
import type {
  AgentHandoffEvent,
  AgentRole,
  Permission,
  ProjectSnapshot,
  ProviderId,
} from "../contracts.ts";
import { ProjectStore } from "./services/store.ts";
import { AgentRuntime } from "./services/provider.ts";
import { AgentOrchestrator } from "./services/orchestrator.ts";
import { bootstrap } from "./services/context.ts";
import { validId, sanitize, boundedText } from "./services/security.ts";
import { exportEngram, importEngram } from "./services/engram.ts";
import { AgentTerminalManager } from "./services/terminal-manager.ts";
import { AgentBridge } from "./services/agent-bridge.ts";
import { configureProviderMcp } from "./services/provider-mcp.ts";

function id(value: unknown): string {
  validId(value);
  return value;
}
function validateProviderId(value: unknown): ProviderId {
  if (
    value !== "codex" &&
    value !== "claude" &&
    value !== "antigravity" &&
    value !== "kimi"
  )
    throw new Error("Provider inválido.");
  return value;
}
function validateAgentRole(value: unknown): AgentRole {
  if (
    value !== "Orchestrator" &&
    value !== "Worker" &&
    value !== "Architect" &&
    value !== "Backend" &&
    value !== "Reviewer" &&
    value !== "Tests"
  )
    throw new Error("Papel do agente inválido.");
  return value;
}
function permission(value: unknown): Permission {
  if (value !== "read-only" && value !== "workspace-write")
    throw new Error("Permissão inválida.");
  return value;
}

export function registerIpc(store: ProjectStore, provider: AgentRuntime): void {
  const orchestrator = new AgentOrchestrator(store, provider);
  let terminals: AgentTerminalManager;
  const bridge = new AgentBridge(store, {
    isTerminalActive: (projectId, agentId) =>
      terminals
        ?.list(projectId)
        .some(
          (terminal) => terminal.agentId === agentId && terminal.status === "running",
        ) ?? false,
    prepareHandoff: async (handoff) => {
      const context = await terminalTaskContext(
        handoff.projectId,
        handoff.toAgentId,
        handoff.task,
      );
      const returnInstruction =
        handoff.returnPolicy === "return-to-orchestrator"
          ? `Após concluir, envie somente sua resposta final ao Orchestrator usando mikoshi_return_handoff_result com handoffId ${handoff.id}.`
          : "Não envie sua resposta ao Orchestrator. Mostre o resultado neste terminal para o usuário.";
      await terminals.prepareHandoff(
        handoff.projectId,
        handoff.fromAgentId,
        handoff.toAgentId,
        `${context}\n\n--- Handoff Mikoshi ---\n${returnInstruction}`,
      );
    },
    onHandoff: (projectId, handoff) => {
      const event: AgentHandoffEvent = { projectId, handoff };
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send("mikoshi:agent-handoff-event", event);
    },
  });
  terminals = new AgentTerminalManager(
    store,
    (providerId) => provider.executable(providerId),
    undefined,
    { bridge, configureProvider: configureProviderMcp },
  );
  terminals.onEvent((event) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send("mikoshi:agent-terminal-event", event);
  });
  async function snapshot(projectId: string): Promise<ProjectSnapshot> {
    return {
      project: await store.project(projectId),
      memory: await store.memory(projectId),
      drafts: await store.drafts(projectId),
      runs: await provider.runs(projectId),
      orchestration: await store.orchestration(projectId),
      pathMappings: await store.pathMappings(projectId),
    };
  }
  function handle(channel: string, handler: (...args: unknown[]) => unknown): void {
    ipcMain.handle("mikoshi:" + channel, async (event, ...args: unknown[]) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || event.senderFrame !== event.sender.mainFrame)
        throw new Error("Origem IPC não permitida.");
      const expected = process.env.ELECTRON_RENDERER_URL;
      const url = event.senderFrame?.url;
      if (
        !url ||
        (expected
          ? new URL(url).origin !== new URL(expected).origin
          : !url.startsWith("file:"))
      )
        throw new Error("Página não autorizada.");
      try {
        return await handler(...args);
      } catch (error) {
        throw new Error(
          sanitize(error instanceof Error ? error.message : "Falha no aplicativo.").text,
        );
      }
    });
  }
  handle("control-window", (action) => {
    const window = BrowserWindow.getFocusedWindow();
    if (!window) return;
    if (action === "minimize") window.minimize();
    else if (action === "maximize") {
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
    } else if (action === "close") window.close();
    else throw new Error("Ação de janela inválida.");
  });
  handle(
    "is-window-maximized",
    () => BrowserWindow.getFocusedWindow()?.isMaximized() ?? false,
  );
  handle("get-runtime-info", () => ({
    platform: process.platform,
    electronVersion: process.versions.electron,
  }));
  handle("list-projects", () => store.list());
  handle("get-project", (projectId) => snapshot(id(projectId)));
  handle("select-project", async () => {
    const selection = await dialog.showOpenDialog({
      title: "Selecionar projeto — Mikoshi",
      properties: ["openDirectory"],
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    return snapshot((await store.openProject(selection.filePaths[0])).id);
  });
  handle("bootstrap", async (projectId) => {
    const project = await store.project(id(projectId));
    const result = await bootstrap(project);
    if (!result.changes.length)
      throw new Error(
        "Nenhum candidato encontrado em README, AGENTS, docs ou package.json. Adicione memória manualmente.",
      );
    return store.propose(
      project.id,
      result.changes,
      "bootstrap",
      undefined,
      result.redactions,
      result.securitySummary,
    );
  });
  handle("propose-memory", (projectId, changes) =>
    store.propose(id(projectId), changes, "manual"),
  );
  handle("apply-memory", async (projectId, draftId, selections) => {
    const pid = id(projectId);
    const did = id(draftId);
    await store.apply(pid, did, selections as Selection[]);
    for (const run of await store.runs(pid))
      if (run.draftId === did && run.status === "waiting_review")
        await store.saveRun({ ...run, status: "completed" });
    return snapshot(pid);
  });
  handle("reject-memory", async (projectId, draftId) => {
    const pid = id(projectId);
    const did = id(draftId);
    await store.reject(pid, did);
    for (const run of await store.runs(pid))
      if (run.draftId === did && run.status === "waiting_review")
        await store.saveRun({ ...run, status: "completed" });
    return snapshot(pid);
  });
  handle("build-context", (projectId, task) => provider.context(id(projectId), task));
  handle("provider-status", () => provider.statuses());
  handle("verify-provider", (providerId) =>
    provider.status(validateProviderId(providerId)),
  );
  handle("start-agent-terminal", (projectId, agentId, cols, rows) =>
    terminals.start(id(projectId), id(agentId), Number(cols), Number(rows)),
  );
  handle("list-agent-terminals", (projectId) => terminals.list(id(projectId)));
  handle("read-agent-terminal", (projectId, terminalId) =>
    terminals.read(id(projectId), id(terminalId)),
  );
  handle("write-agent-terminal", (projectId, terminalId, data) =>
    terminals.write(id(projectId), id(terminalId), data),
  );
  handle("resize-agent-terminal", (projectId, terminalId, cols, rows) =>
    terminals.resize(id(projectId), id(terminalId), Number(cols), Number(rows)),
  );
  handle("stop-agent-terminal", (projectId, terminalId) =>
    terminals.stop(id(projectId), id(terminalId)),
  );
  async function terminalTaskContext(
    projectId: string,
    agentId: string,
    task: string,
  ): Promise<string> {
    const agent = (await store.orchestration(projectId)).agents.find(
      (entry) => entry.id === agentId,
    );
    if (!agent) throw new Error("Agente não configurado neste projeto.");
    const context = await provider.context(
      projectId,
      {
        task,
        role: agent.role,
        permission: "workspace-write",
        agentId: agent.id,
        agentName: agent.name,
        agentInstructions: agent.instructions,
      },
      "interactive",
    );
    return context.text;
  }
  handle("prepare-agent-terminal-task", async (projectId, agentId, task) => {
    const pid = id(projectId);
    const targetId = id(agentId);
    const context = await terminalTaskContext(pid, targetId, boundedText(task, 3000));
    await terminals.prepareAgentPrompt(pid, targetId, context);
  });
  handle("delegate-terminal-task", async (projectId, fromAgentId, toAgentId, task) => {
    const pid = id(projectId);
    const sourceId = id(fromAgentId);
    const targetId = id(toAgentId);
    const state = await store.orchestration(pid);
    if (!state.agents.some((agent) => agent.id === targetId))
      throw new Error("Agente subordinado não encontrado.");
    const context = await terminalTaskContext(pid, targetId, boundedText(task, 3000));
    await terminals.prepareHandoff(pid, sourceId, targetId, context);
  });
  handle("start-agent", (projectId, task, providerId) =>
    provider.start(id(projectId), task, validateProviderId(providerId)),
  );
  handle("save-agent", async (projectId, agent) => {
    const pid = id(projectId);
    await store.saveAgent(pid, agent);
    return snapshot(pid);
  });
  handle("delete-agent", async (projectId, agentId) => {
    const pid = id(projectId);
    const aid = id(agentId);
    terminals.stopAgent(pid, aid);
    await store.deleteAgent(pid, aid);
    return snapshot(pid);
  });
  handle("create-canvas-agent", async (projectId, providerId, role) => {
    const pid = id(projectId);
    const registeredProvider = validateProviderId(providerId);
    const agentRole = validateAgentRole(role);
    await provider.executable(registeredProvider);
    await store.createCanvasAgent(pid, registeredProvider, agentRole);
    return snapshot(pid);
  });
  handle("save-agent-canvas", async (projectId, canvas) => {
    const pid = id(projectId);
    await store.saveAgentCanvas(pid, canvas);
    return snapshot(pid);
  });
  handle("save-path-mapping", async (projectId, sourceRoot) => {
    const pid = id(projectId);
    await store.savePathMapping(pid, boundedText(sourceRoot, 2000));
    return snapshot(pid);
  });
  handle("preview-path-mapping", (projectId, sourceRoot) =>
    store.previewPathMapping(id(projectId), boundedText(sourceRoot, 2000)),
  );
  handle("start-managed-agent", (projectId, agentId, task, access) =>
    orchestrator.start(
      id(projectId),
      id(agentId),
      boundedText(task, 3000),
      permission(access),
    ),
  );
  handle("handoff-agent", (projectId, fromRunId, toAgentId, task) =>
    orchestrator.handoff(
      id(projectId),
      id(fromRunId),
      id(toAgentId),
      boundedText(task, 3000),
    ),
  );
  handle("cancel-agent", (projectId, runId) => provider.cancel(id(projectId), id(runId)));
  handle("export-engram", async (projectId) => {
    const project = await store.project(id(projectId));
    const memory = await store.memory(project.id);
    const selection = await dialog.showSaveDialog({
      title: "Exportar memória revisada",
      defaultPath: project.name + ".engram.json",
      filters: [{ name: "Engram", extensions: ["json"] }],
    });
    if (selection.canceled || !selection.filePath) return false;
    await writeFile(
      selection.filePath,
      exportEngram(
        project,
        memory,
        await store.orchestration(project.id),
        await store.pathMappings(project.id),
      ),
      { mode: 0o600 },
    );
    return true;
  });
  handle("import-engram", async (projectId) => {
    const project = await store.project(id(projectId));
    const selection = await dialog.showOpenDialog({
      title: "Importar Engram para revisão",
      properties: ["openFile"],
      filters: [{ name: "Engram", extensions: ["json"] }],
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const file = selection.filePaths[0];
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4_000_000)
      throw new Error("Arquivo de Engram inválido ou muito grande.");
    const choice = await dialog.showMessageBox({
      type: "question",
      title: "Estratégia de importação",
      message: "Como deseja comparar este Engram com a memória local?",
      detail:
        "Mesclar preserva itens locais. Substituir cria um diff que marca itens locais ausentes como obsoletos. Ambas as opções exigem revisão antes de aplicar.",
      buttons: ["Mesclar", "Substituir", "Cancelar"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (choice.response === 2) return null;
    const result = importEngram(
      await readFile(file, "utf8"),
      project,
      await store.memory(project.id),
      choice.response === 1 ? "replace" : "merge",
    );
    if (
      !result.changes.length &&
      !result.orchestration.agents.length &&
      !result.history.length
    )
      throw new Error("A memória já contém os itens deste Engram.");
    return store.propose(
      project.id,
      result.changes,
      "engram",
      undefined,
      result.redactions,
      undefined,
      result.conflicts,
      result.orchestration,
      result.mappingCount,
      result.history,
    );
  });
  let shuttingDown = false;
  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    void (async () => {
      try {
        await terminals.shutdown();
        await bridge.shutdown();
      } finally {
        provider.shutdown();
        app.quit();
      }
    })();
  });
}
