import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { AgentTerminalSession } from "../../contracts";
import { hasTerminalInput } from "./terminal-activity";
import "@xterm/xterm/css/xterm.css";

interface AgentTerminalProps {
  projectId: string;
  agentId: string;
  disabled: boolean;
  onInput?: () => void;
}

export function AgentTerminal({
  projectId,
  agentId,
  disabled,
  onInput,
}: AgentTerminalProps): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const session = useRef<AgentTerminalSession | null>(null);
  const [currentSession, setCurrentSession] = useState<AgentTerminalSession | null>(null);
  const [error, setError] = useState("");
  const onInputRef = useRef(onInput);
  onInputRef.current = onInput;

  useEffect(() => {
    if (!host.current) return;
    const instance = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: "Cascadia Code, Consolas, monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: { background: "#070d16" },
    });
    const fit = new FitAddon();
    instance.loadAddon(fit);
    instance.open(host.current);
    terminal.current = instance;
    fitAddon.current = fit;
    fit.fit();

    let active = true;
    let disposed = false;
    const unsubscribe = window.mikoshi.onAgentTerminalEvent((event) => {
      if (event.projectId !== projectId || event.agentId !== agentId) return;
      if (event.type === "data") instance.write(event.data ?? "");
      if (event.type === "exit") {
        session.current = null;
        setCurrentSession(null);
        instance.write(
          `\r\n\x1b[90m[processo finalizado: ${event.exitCode ?? "?"}]\x1b[0m\r\n`,
        );
      }
    });
    const resizeObserver = new ResizeObserver(() => {
      if (!active) return;
      fit.fit();
      const running = session.current;
      if (running) {
        void window.mikoshi.resizeAgentTerminal(
          projectId,
          running.id,
          instance.cols,
          instance.rows,
        );
      }
    });
    resizeObserver.observe(host.current);
    const input = instance.onData((data) => {
      const running = session.current;
      if (running) {
        if (hasTerminalInput(data)) onInputRef.current?.();
        void window.mikoshi.writeAgentTerminal(projectId, running.id, data);
      }
    });
    void window.mikoshi
      .listAgentTerminals(projectId)
      .then(async (sessions) => {
        if (!active) return;
        const running = sessions.find(
          (entry) => entry.agentId === agentId && entry.status === "running",
        );
        if (!running) return;
        session.current = running;
        setCurrentSession(running);
        const buffer = await window.mikoshi.readAgentTerminal(projectId, running.id);
        if (active && !disposed) instance.write(buffer.data);
        fit.fit();
        await window.mikoshi.resizeAgentTerminal(
          projectId,
          running.id,
          instance.cols,
          instance.rows,
        );
        instance.focus();
      })
      .catch((failure: unknown) => {
        if (active)
          setError(failure instanceof Error ? failure.message : "Falha ao ler terminal.");
      });

    return () => {
      active = false;
      disposed = true;
      unsubscribe();
      resizeObserver.disconnect();
      input.dispose();
      instance.dispose();
      terminal.current = null;
      fitAddon.current = null;
    };
  }, [projectId, agentId]);

  async function startTerminal(): Promise<void> {
    if (disabled) return;
    setError("");
    try {
      const fit = fitAddon.current;
      fit?.fit();
      const opened = await window.mikoshi.startAgentTerminal(
        projectId,
        agentId,
        terminal.current?.cols ?? 100,
        terminal.current?.rows ?? 28,
      );
      session.current = opened;
      setCurrentSession(opened);
      terminal.current?.focus();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Não foi possível abrir a CLI.",
      );
    }
  }

  async function stopTerminal(): Promise<void> {
    const running = session.current;
    if (!running) return;
    await window.mikoshi.stopAgentTerminal(projectId, running.id);
  }

  function focusTerminal(): void {
    if (disabled) return;
    if (session.current) {
      terminal.current?.focus();
      return;
    }
    void startTerminal();
  }

  return (
    <div
      className="agent-terminal-panel"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="agent-terminal-toolbar">
        <span>
          {currentSession
            ? "Terminal interativo ativo · digite aqui"
            : "Clique no terminal para iniciar"}
        </span>
        {currentSession ? (
          <button
            className="secondary"
            disabled={disabled}
            onClick={() => void stopTerminal()}
          >
            Encerrar
          </button>
        ) : null}
      </div>
      <div
        aria-label="Terminal interativo do agente. Clique para iniciar e digitar."
        className="agent-terminal"
        onClick={focusTerminal}
        ref={host}
      />
      {error && <small className="alert">{error}</small>}
    </div>
  );
}
