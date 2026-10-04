import { contextBridge, ipcRenderer } from "electron";
import type { AgentHandoffEvent, AgentTerminalEvent, MikoshiApi } from "../contracts";

contextBridge.exposeInMainWorld("mikoshi", {
  getRuntimeInfo: () => ipcRenderer.invoke("mikoshi:get-runtime-info"),
  listProjects: () => ipcRenderer.invoke("mikoshi:list-projects"),
  selectProject: () => ipcRenderer.invoke("mikoshi:select-project"),
  getProject: (projectId) => ipcRenderer.invoke("mikoshi:get-project", projectId),
  bootstrap: (projectId) => ipcRenderer.invoke("mikoshi:bootstrap", projectId),
  proposeMemory: (projectId, changes) =>
    ipcRenderer.invoke("mikoshi:propose-memory", projectId, changes),
  applyMemory: (projectId, draftId, selections) =>
    ipcRenderer.invoke("mikoshi:apply-memory", projectId, draftId, selections),
  rejectMemory: (projectId, draftId) =>
    ipcRenderer.invoke("mikoshi:reject-memory", projectId, draftId),
  buildContext: (projectId, task) =>
    ipcRenderer.invoke("mikoshi:build-context", projectId, task),
  providerStatus: () => ipcRenderer.invoke("mikoshi:provider-status"),
  verifyProvider: (provider) => ipcRenderer.invoke("mikoshi:verify-provider", provider),
  startAgentTerminal: (projectId, agentId, cols, rows) =>
    ipcRenderer.invoke("mikoshi:start-agent-terminal", projectId, agentId, cols, rows),
  listAgentTerminals: (projectId) =>
    ipcRenderer.invoke("mikoshi:list-agent-terminals", projectId),
  readAgentTerminal: (projectId, terminalId) =>
    ipcRenderer.invoke("mikoshi:read-agent-terminal", projectId, terminalId),
  writeAgentTerminal: (projectId, terminalId, data) =>
    ipcRenderer.invoke("mikoshi:write-agent-terminal", projectId, terminalId, data),
  resizeAgentTerminal: (projectId, terminalId, cols, rows) =>
    ipcRenderer.invoke(
      "mikoshi:resize-agent-terminal",
      projectId,
      terminalId,
      cols,
      rows,
    ),
  stopAgentTerminal: (projectId, terminalId) =>
    ipcRenderer.invoke("mikoshi:stop-agent-terminal", projectId, terminalId),
  prepareAgentTerminalTask: (projectId, agentId, task) =>
    ipcRenderer.invoke("mikoshi:prepare-agent-terminal-task", projectId, agentId, task),
  delegateTerminalTask: (projectId, fromAgentId, toAgentId, task) =>
    ipcRenderer.invoke(
      "mikoshi:delegate-terminal-task",
      projectId,
      fromAgentId,
      toAgentId,
      task,
    ),
  onAgentTerminalEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AgentTerminalEvent) =>
      listener(payload);
    ipcRenderer.on("mikoshi:agent-terminal-event", handler);
    return () => ipcRenderer.removeListener("mikoshi:agent-terminal-event", handler);
  },
  onAgentHandoffEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AgentHandoffEvent) =>
      listener(payload);
    ipcRenderer.on("mikoshi:agent-handoff-event", handler);
    return () => ipcRenderer.removeListener("mikoshi:agent-handoff-event", handler);
  },
  startAgent: (projectId, task, provider) =>
    ipcRenderer.invoke("mikoshi:start-agent", projectId, task, provider),
  saveAgent: (projectId, agent) =>
    ipcRenderer.invoke("mikoshi:save-agent", projectId, agent),
  deleteAgent: (projectId, agentId) =>
    ipcRenderer.invoke("mikoshi:delete-agent", projectId, agentId),
  createCanvasAgent: (projectId, provider, role) =>
    ipcRenderer.invoke("mikoshi:create-canvas-agent", projectId, provider, role),
  saveAgentCanvas: (projectId, canvas) =>
    ipcRenderer.invoke("mikoshi:save-agent-canvas", projectId, canvas),
  savePathMapping: (projectId, sourceRoot) =>
    ipcRenderer.invoke("mikoshi:save-path-mapping", projectId, sourceRoot),
  previewPathMapping: (projectId, sourceRoot) =>
    ipcRenderer.invoke("mikoshi:preview-path-mapping", projectId, sourceRoot),
  startManagedAgent: (projectId, agentId, task, permission) =>
    ipcRenderer.invoke(
      "mikoshi:start-managed-agent",
      projectId,
      agentId,
      task,
      permission,
    ),
  handoffAgent: (projectId, fromRunId, toAgentId, task) =>
    ipcRenderer.invoke("mikoshi:handoff-agent", projectId, fromRunId, toAgentId, task),
  cancelAgent: (projectId, runId) =>
    ipcRenderer.invoke("mikoshi:cancel-agent", projectId, runId),
  exportEngram: (projectId) => ipcRenderer.invoke("mikoshi:export-engram", projectId),
  importEngram: (projectId) => ipcRenderer.invoke("mikoshi:import-engram", projectId),
} satisfies MikoshiApi);
