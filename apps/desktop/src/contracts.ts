export const memoryKinds = [
  "decision",
  "instruction",
  "fact",
  "task",
  "issue",
  "preference",
] as const;
export type MemoryKind = (typeof memoryKinds)[number];
export type AgentRole =
  | "Orchestrator"
  | "Worker"
  | "Architect"
  | "Backend"
  | "Reviewer"
  | "Tests";
export type Permission = "read-only" | "workspace-write";
export type ProviderId = "codex" | "claude" | "antigravity" | "kimi";
export type MemoryStatus = "active" | "obsolete" | "removed";
export type MemoryOperation = "ADD" | "UPDATE" | "REMOVE" | "MARK_OBSOLETE" | "RESTORE";
export type MemoryEvidence =
  | "observed"
  | "explicit"
  | "inferred"
  | "convention"
  | "task"
  | "issue"
  | "instruction";
export interface ProviderCapabilities {
  readOnly: boolean;
  workspaceWrite: boolean;
  cancellation: boolean;
  structuredOutput: boolean;
}
export interface RuntimeInfo {
  platform: string;
  electronVersion: string;
}
export interface Project {
  id: string;
  name: string;
  root: string;
  remote?: string;
}
export interface PathMapping {
  sourceRoot: string;
  targetRoot: string;
  targetExists: boolean;
}
export interface PathMappingPreview extends PathMapping {
  referenceCount: number;
}
export interface Provenance {
  source: string;
  sessionId?: string;
  date: string;
  provider?: ProviderId;
}
export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  text: string;
  provenance: Provenance[];
  status: MemoryStatus;
  replacedBy?: string;
  updatedAt?: string;
  evidence?: MemoryEvidence;
}
export interface MemoryEvent {
  id: string;
  itemId: string;
  operation: MemoryOperation;
  previous?: { kind: MemoryKind; text: string; status: MemoryStatus };
  current?: { kind: MemoryKind; text: string; status: MemoryStatus };
  source: string;
  date: string;
  provenance: Provenance[];
}
export interface ProjectMemory {
  schemaVersion: 2;
  projectId: string;
  revision: number;
  items: MemoryItem[];
  history: MemoryEvent[];
}
export interface MemoryChange {
  op: "add" | "update" | "delete" | "mark_obsolete" | "restore";
  targetId?: string;
  itemId?: string;
  kind: MemoryKind;
  text: string;
  source: string;
  provenance?: Provenance[];
  replacedBy?: string;
  evidence?: MemoryEvidence;
}
export interface MemoryDraft {
  id: string;
  projectId: string;
  baseRevision: number;
  source: string;
  sessionId?: string;
  createdAt: string;
  status: "pending" | "applied" | "rejected";
  changes: MemoryChange[];
  redactions: number;
  securitySummary?: { highConfidenceRedactions: number; heuristicCandidates: number };
  conflicts?: Array<{
    itemId: string;
    reason: string;
    current: string;
    incoming: string;
  }>;
  engramOrchestration?: OrchestrationState;
  engramHistory?: MemoryEvent[];
  mappingCount?: number;
}
export interface MemoryApproval {
  changes: Selection[];
  agentIds?: string[];
  handoffIds?: string[];
  includeHistory?: boolean;
}
export interface Selection {
  index: number;
  text?: string;
}
export interface TaskInput {
  task: string;
  role: AgentRole;
  permission: Permission;
  agentId?: string;
  agentName?: string;
  agentInstructions?: string;
  handoff?: string;
  workflowId?: string;
}
export interface WorkingContext {
  text: string;
  includedIds: string[];
  omitted: number;
  redactions: number;
}
export interface ProviderStatus {
  provider: ProviderId;
  capabilities: ProviderCapabilities;
  installed: boolean;
  authenticated: boolean | undefined;
  version: string;
  message: string;
}
export interface ProviderRegistration {
  provider: ProviderId;
  executable: string;
  registeredAt: string;
}
export interface AgentTerminalSession {
  id: string;
  projectId: string;
  agentId: string;
  provider: ProviderId;
  status: "running" | "exited";
  startedAt: string;
  exitCode?: number;
}
export interface AgentTerminalEvent {
  terminalId: string;
  projectId: string;
  agentId: string;
  sequence: number;
  type: "data" | "exit";
  data?: string;
  exitCode?: number;
}
export interface AgentTerminalBuffer {
  data: string;
  sequence: number;
}
export interface AgentRun {
  id: string;
  projectId: string;
  provider: ProviderId;
  agentId?: string;
  role: AgentRole;
  task: string;
  permission: Permission;
  status:
    | "running"
    | "waiting_review"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  startedAt: string;
  finishedAt?: string;
  output: string;
  error?: string;
  draftId?: string;
  contextItemIds: string[];
}
export interface AgentDefinition {
  id: string;
  name: string;
  role: AgentRole;
  provider: ProviderId;
  instructions: string;
  createdAt: string;
}
export interface AgentState {
  agentId: string;
  status: "idle" | "running" | "waiting_handoff" | "waiting_review" | "failed";
  currentTask?: string;
  runId?: string;
  updatedAt: string;
}
export interface AgentExecutor {
  start(projectId: string, input: unknown, provider?: ProviderId): Promise<AgentRun>;
}
export interface AgentHandoff {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  fromRunId?: string;
  fromTerminalId?: string;
  toTerminalId?: string;
  task: string;
  summary: string;
  createdAt: string;
  status: "pending" | "started" | "completed" | "failed";
  returnPolicy?: "screen-only" | "return-to-orchestrator";
  result?: string;
  toRunId?: string;
}
export interface AgentHandoffEvent {
  projectId: string;
  handoff: AgentHandoff;
}
export interface AgentCanvasPosition {
  agentId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface AgentCanvasConnection {
  id: string;
  fromAgentId: string;
  toAgentId: string;
}
export interface AgentCanvasViewport {
  x: number;
  y: number;
  zoom: number;
}
export interface AgentCanvasState {
  positions: AgentCanvasPosition[];
  connections: AgentCanvasConnection[];
  viewport: AgentCanvasViewport;
}
export interface OrchestrationState {
  schemaVersion: 1;
  agents: AgentDefinition[];
  agentStates: AgentState[];
  handoffs: AgentHandoff[];
  canvas?: AgentCanvasState;
}
export interface ProjectSnapshot {
  project: Project;
  memory: ProjectMemory;
  drafts: MemoryDraft[];
  runs: AgentRun[];
  orchestration: OrchestrationState;
  pathMappings: PathMapping[];
}
export interface MikoshiApi {
  controlWindow(action: "minimize" | "maximize" | "close"): Promise<void>;
  isWindowMaximized(): Promise<boolean>;
  onWindowMaximized(listener: (maximized: boolean) => void): () => void;
  getRuntimeInfo(): Promise<RuntimeInfo>;
  listProjects(): Promise<Project[]>;
  selectProject(): Promise<ProjectSnapshot | null>;
  getProject(projectId: string): Promise<ProjectSnapshot>;
  bootstrap(projectId: string): Promise<MemoryDraft>;
  proposeMemory(projectId: string, changes: MemoryChange[]): Promise<MemoryDraft>;
  applyMemory(
    projectId: string,
    draftId: string,
    selections: Selection[] | MemoryApproval,
  ): Promise<ProjectSnapshot>;
  rejectMemory(projectId: string, draftId: string): Promise<ProjectSnapshot>;
  buildContext(projectId: string, task: TaskInput): Promise<WorkingContext>;
  providerStatus(): Promise<ProviderStatus[]>;
  verifyProvider(provider: ProviderId): Promise<ProviderStatus>;
  startAgentTerminal(
    projectId: string,
    agentId: string,
    cols: number,
    rows: number,
  ): Promise<AgentTerminalSession>;
  listAgentTerminals(projectId: string): Promise<AgentTerminalSession[]>;
  readAgentTerminal(projectId: string, terminalId: string): Promise<AgentTerminalBuffer>;
  writeAgentTerminal(projectId: string, terminalId: string, data: string): Promise<void>;
  resizeAgentTerminal(
    projectId: string,
    terminalId: string,
    cols: number,
    rows: number,
  ): Promise<void>;
  stopAgentTerminal(projectId: string, terminalId: string): Promise<void>;
  prepareAgentTerminalTask(
    projectId: string,
    agentId: string,
    task: string,
  ): Promise<void>;
  delegateTerminalTask(
    projectId: string,
    fromAgentId: string,
    toAgentId: string,
    task: string,
  ): Promise<void>;
  onAgentTerminalEvent(listener: (event: AgentTerminalEvent) => void): () => void;
  onAgentHandoffEvent(listener: (event: AgentHandoffEvent) => void): () => void;
  startAgent(
    projectId: string,
    task: TaskInput,
    provider?: ProviderId,
  ): Promise<AgentRun>;
  saveAgent(
    projectId: string,
    agent: Omit<AgentDefinition, "id" | "createdAt"> & { id?: string },
  ): Promise<ProjectSnapshot>;
  deleteAgent(projectId: string, agentId: string): Promise<ProjectSnapshot>;
  createCanvasAgent(
    projectId: string,
    provider: ProviderId,
    role: AgentRole,
  ): Promise<ProjectSnapshot>;
  saveAgentCanvas(projectId: string, canvas: AgentCanvasState): Promise<ProjectSnapshot>;
  startManagedAgent(
    projectId: string,
    agentId: string,
    task: string,
    permission: Permission,
  ): Promise<AgentRun>;
  handoffAgent(
    projectId: string,
    fromRunId: string,
    toAgentId: string,
    task: string,
  ): Promise<AgentRun>;
  savePathMapping(projectId: string, sourceRoot: string): Promise<ProjectSnapshot>;
  previewPathMapping(projectId: string, sourceRoot: string): Promise<PathMappingPreview>;
  cancelAgent(projectId: string, runId: string): Promise<void>;
  exportEngram(projectId: string): Promise<boolean>;
  importEngram(projectId: string): Promise<MemoryDraft | null>;
}
