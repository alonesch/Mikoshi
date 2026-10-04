import { randomUUID } from "node:crypto";
import type {
  AgentExecutor,
  AgentHandoff,
  AgentRun,
  Permission,
} from "../../contracts.ts";
import { ProjectStore } from "./store.ts";
import { boundedText, cleanText, validId } from "./security.ts";

export class AgentOrchestrator {
  private store: ProjectStore;
  private executor: AgentExecutor;

  constructor(store: ProjectStore, executor: AgentExecutor) {
    this.store = store;
    this.executor = executor;
  }

  async start(
    projectId: string,
    agentId: string,
    task: string,
    permission: Permission,
    handoff = "",
    workflowId?: string,
  ): Promise<AgentRun> {
    validId(agentId);
    const project = await this.store.project(projectId);
    const state = await this.store.orchestration(projectId);
    const agent = state.agents.find((entry) => entry.id === agentId);
    if (!agent) throw new Error("Agente não configurado neste projeto.");
    const agentState = state.agentStates.find((entry) => entry.agentId === agentId);
    if (agentState?.status === "running")
      throw new Error("Este agente já está em execução.");
    const run = await this.executor.start(
      projectId,
      {
        task: boundedText(task, 3000),
        role: agent.role,
        permission,
        agentId: agent.id,
        agentName: agent.name,
        agentInstructions: agent.instructions,
        ...(handoff
          ? { handoff: cleanText(handoff, project.root).text.slice(0, 4000) }
          : {}),
        ...(workflowId ? { workflowId } : {}),
      },
      agent.provider,
    );
    const status =
      run.status === "running"
        ? "running"
        : run.status === "waiting_review"
          ? "waiting_review"
          : run.status === "failed"
            ? "failed"
            : run.status === "completed"
              ? "waiting_handoff"
              : "idle";
    await this.store.saveAgentState(projectId, {
      agentId: agent.id,
      status,
      currentTask: run.task,
      ...(status === "running" ? { runId: run.id } : {}),
      updatedAt: new Date().toISOString(),
    });
    return run;
  }

  async handoff(
    projectId: string,
    fromRunId: string,
    toAgentId: string,
    task: string,
  ): Promise<AgentRun> {
    validId(fromRunId);
    validId(toAgentId);
    const project = await this.store.project(projectId);
    const runs = await this.store.runs(projectId);
    const previousRun = runs.find((run) => run.id === fromRunId);
    if (!previousRun || previousRun.status !== "completed")
      throw new Error("O handoff só pode sair de uma execução concluída e revisada.");
    if (!previousRun.agentId)
      throw new Error("A execução de origem não pertence a um agente configurado.");

    const state = await this.store.orchestration(projectId);
    const source = state.agents.find((agent) => agent.id === previousRun.agentId);
    const target = state.agents.find((agent) => agent.id === toAgentId);
    if (!source || !target) throw new Error("Agente de origem ou destino não existe.");
    if (source.id === target.id) throw new Error("Escolha outro agente para o handoff.");
    const outgoingConnections =
      state.canvas?.connections.filter(
        (connection) => connection.fromAgentId === source.id,
      ) ?? [];
    if (
      outgoingConnections.length > 0 &&
      !outgoingConnections.some((connection) => connection.toAgentId === target.id)
    )
      throw new Error("O agente de destino não está conectado no workspace.");
    if (
      state.agentStates.find((agent) => agent.agentId === target.id)?.status === "running"
    )
      throw new Error("O agente de destino já está em execução.");

    const handoff: AgentHandoff = {
      id: randomUUID(),
      fromAgentId: source.id,
      toAgentId: target.id,
      fromRunId: previousRun.id,
      task: boundedText(task, 3000),
      summary: cleanText(previousRun.output, project.root).text.slice(0, 4000),
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    await this.store.saveHandoff(projectId, handoff);
    await this.store.saveAgentState(projectId, {
      agentId: source.id,
      status: "waiting_handoff",
      currentTask: previousRun.task,
      updatedAt: new Date().toISOString(),
    });

    try {
      const run = await this.start(
        projectId,
        target.id,
        handoff.task,
        previousRun.permission,
        `HANDOFF ${source.name} → ${target.name}\n\n${handoff.summary}`,
        handoff.id,
      );
      await this.store.saveHandoff(projectId, {
        ...handoff,
        status: "started",
        toRunId: run.id,
      });
      return run;
    } catch (error) {
      await this.store.saveHandoff(projectId, { ...handoff, status: "failed" });
      throw error;
    }
  }
}
