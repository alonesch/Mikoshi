import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Permission, ProviderCapabilities, ProviderId } from "../../contracts.ts";
import { boundedText } from "./security.ts";

const execute = promisify(execFile);

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  findExecutable(): Promise<string>;
  version(command: string): Promise<string>;
  checkAuthentication(command: string): Promise<boolean | undefined>;
  argumentsFor(permission: Permission, schemaFile: string, prompt?: string): string[];
  input(prompt: string): string;
  result(output: string, permission?: Permission): string;
}

const capabilities: ProviderCapabilities = {
  readOnly: true,
  workspaceWrite: true,
  cancellation: true,
  structuredOutput: true,
};

async function findCommand(name: string): Promise<string> {
  if (process.platform !== "win32") return name;
  const executableName = name === "antigravity" ? "agy" : name;
  try {
    const result = await execute("where.exe", [executableName + ".exe"], {
      windowsHide: true,
      timeout: 5000,
    });
    const first = result.stdout.trim().split(/\r?\n/)[0];
    if (first) return first;
  } catch {
    /* The desktop application may keep its CLI outside PATH. */
  }
  const localAppData = process.env.LOCALAPPDATA;
  const userProfile = process.env.USERPROFILE;
  const candidates = [
    ...(name === "antigravity" && localAppData
      ? [join(localAppData, "agy", "bin", "agy.exe")]
      : []),
    ...(name === "codex" && localAppData
      ? [
          ...(await readdir(join(localAppData, "OpenAI", "Codex", "bin")).catch(() => []))
            .reverse()
            .map((version) =>
              join(localAppData, "OpenAI", "Codex", "bin", version, name + ".exe"),
            ),
        ]
      : []),
    ...(name === "claude" && userProfile
      ? [join(userProfile, ".local", "bin", "claude.exe")]
      : []),
    ...(name === "kimi" && localAppData
      ? [
          join(localAppData, "kimi-code", "bin", "kimi.exe"),
          join(localAppData, "Programs", "Kimi Code", "kimi.exe"),
          join(localAppData, "pnpm", "bin", "kimi.exe"),
        ]
      : []),
    ...(name === "kimi" && userProfile
      ? [join(userProfile, ".kimi-code", "bin", "kimi.exe")]
      : []),
  ];
  for (const path of candidates) {
    try {
      await access(path);
      return path;
    } catch {
      /* Try the next known per-user installation path. */
    }
  }
  throw new Error(
    `${
      name === "codex"
        ? "Codex"
        : name === "claude"
          ? "Claude Code"
          : name === "antigravity"
            ? "Google Antigravity"
            : "Kimi Code"
    } CLI executável não encontrado.`,
  );
}

abstract class LocalCliAdapter implements ProviderAdapter {
  abstract readonly id: ProviderId;
  abstract findExecutable(): Promise<string>;
  abstract checkAuthentication(command: string): Promise<boolean | undefined>;
  abstract argumentsFor(
    permission: Permission,
    schemaFile: string,
    prompt?: string,
  ): string[];
  abstract result(output: string, permission?: Permission): string;
  readonly capabilities = capabilities;

  input(prompt: string): string {
    return prompt;
  }

  async version(command: string): Promise<string> {
    const result = await execute(command, ["--version"], {
      timeout: 8000,
      windowsHide: true,
    });
    return result.stdout.trim();
  }
}

export class CodexAdapter extends LocalCliAdapter {
  readonly id = "codex" as const;

  findExecutable(): Promise<string> {
    return findCommand("codex");
  }

  async checkAuthentication(command: string): Promise<boolean> {
    try {
      await execute(command, ["login", "status"], {
        timeout: 8000,
        windowsHide: true,
      });
      return true;
    } catch {
      return false;
    }
  }

  argumentsFor(permission: Permission, schemaFile: string, _prompt = ""): string[] {
    return [
      "--ask-for-approval",
      "never",
      "exec",
      "--json",
      "--ephemeral",
      "--sandbox",
      permission,
      "--skip-git-repo-check",
      "--color",
      "never",
      "--output-schema",
      schemaFile,
      "-",
    ];
  }

  result(output: string): string {
    let answer = "";
    for (const event of parseJsonLines(output)) {
      if (event.type === "turn.failed" || event.type === "error")
        throw new Error(
          boundedText(
            String(event.error?.message ?? event.message ?? "Codex encerrou com erro."),
            1500,
          ),
        );
      if (event.type === "item.completed" && event.item?.type === "agent_message")
        answer = event.item.text ?? answer;
    }
    if (!answer) throw new Error("Codex não retornou uma resposta estruturada.");
    return answer;
  }
}

export class ClaudeCodeAdapter extends LocalCliAdapter {
  readonly id = "claude" as const;

  findExecutable(): Promise<string> {
    return findCommand("claude");
  }

  async checkAuthentication(command: string): Promise<boolean> {
    try {
      const result = await execute(command, ["auth", "status"], {
        timeout: 10000,
        windowsHide: true,
      });
      const status: unknown = JSON.parse(result.stdout);
      return Boolean(
        status &&
          typeof status === "object" &&
          "loggedIn" in status &&
          status.loggedIn === true,
      );
    } catch {
      return false;
    }
  }

  argumentsFor(permission: Permission, _schemaFile: string, _prompt = ""): string[] {
    const responseSchema = {
      type: "object",
      additionalProperties: false,
      required: ["answer", "changes"],
      properties: {
        answer: { type: "string" },
        changes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["op", "kind", "text", "source"],
            properties: {
              op: { type: "string", enum: ["add", "update", "delete"] },
              targetId: { type: "string" },
              kind: {
                type: "string",
                enum: ["decision", "instruction", "fact", "task", "issue", "preference"],
              },
              text: { type: "string" },
              source: { type: "string" },
            },
          },
        },
      },
    };
    return [
      "--print",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(responseSchema),
      "--permission-mode",
      permission === "read-only" ? "plan" : "acceptEdits",
      "--permission-prompts",
      "none",
      "--safe-mode",
      "--no-session-persistence",
      "--tools",
      permission === "read-only" ? "Read,Glob,Grep" : "Read,Glob,Grep,Edit,Write,Bash",
    ];
  }

  result(output: string): string {
    let envelope: unknown;
    try {
      envelope = JSON.parse(output);
    } catch {
      throw new Error("Claude Code retornou uma resposta JSON inválida.");
    }
    if (!envelope || typeof envelope !== "object")
      throw new Error("Claude Code retornou um envelope inválido.");
    const response = envelope as Record<string, unknown>;
    if (response.is_error === true || response.subtype !== "success") {
      const detail =
        typeof response.result === "string"
          ? boundedText(response.result, 1500)
          : "Claude Code encerrou sem uma resposta bem-sucedida.";
      throw new Error("Claude Code: " + detail);
    }
    if (typeof response.result !== "string")
      throw new Error("Claude Code não retornou uma resposta estruturada.");
    return response.result;
  }
}

export class AntigravityAdapter extends LocalCliAdapter {
  readonly id = "antigravity" as const;

  findExecutable(): Promise<string> {
    return findCommand("antigravity");
  }

  async checkAuthentication(_command: string): Promise<boolean | undefined> {
    // The local CLI's /help probe does not require or validate an authenticated session.
    return undefined;
  }

  argumentsFor(permission: Permission, schemaFile: string, _prompt = ""): string[] {
    return [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--json-schema",
      schemaFile,
      permission === "read-only" ? "--mode=plan" : "--mode=accept-edits",
      "--print-timeout",
      "10m",
    ];
  }

  input(prompt: string): string {
    return JSON.stringify({ event: "user", message: { content: prompt } }) + "\n";
  }

  result(output: string, permission?: Permission): string {
    const events = parseJsonLines(output);
    const resultEvent = events
      .slice()
      .reverse()
      .find((event) => event.event === "result");
    const result = resultEvent?.result;
    if (!result) throw new Error("Antigravity não retornou um evento final.");
    if (result.status !== "SUCCESS")
      throw new Error(
        boundedText(result.error ?? "Antigravity encerrou com erro.", 1500),
      );
    if (
      (result.denied_actions?.length ?? 0) > 0 &&
      events.some(
        (event) =>
          event.step_update?.step_type === "tool" &&
          event.step_update.state === "ERROR" &&
          event.step_update.tool_name === "run_command",
      )
    ) {
      const guidance =
        permission === "read-only"
          ? " Para executar testes, selecione workspace-write e confira se as regras locais da CLI permitem comandos; esse modo também pode alterar arquivos."
          : " Confira as regras locais de permissões da CLI.";
      throw new Error(
        "Antigravity negou run_command e encerrou sem resposta." + guidance,
      );
    }
    if (
      result.structured_output &&
      typeof result.structured_output === "object" &&
      !Array.isArray(result.structured_output)
    )
      return JSON.stringify(result.structured_output);
    if (typeof result.response === "string" && result.response.trim())
      return result.response;

    const responseSteps = new Map<number, string>();
    for (const event of events) {
      const step = event.step_update;
      if (
        step?.step_type !== "agent_response" ||
        typeof step.step_index !== "number" ||
        typeof step.text_delta !== "string"
      )
        continue;
      responseSteps.set(
        step.step_index,
        (responseSteps.get(step.step_index) ?? "") + step.text_delta,
      );
    }
    const streamedResponse = [...responseSteps.entries()]
      .sort(([first], [second]) => first - second)
      .at(-1)?.[1];
    if (streamedResponse?.trim()) return streamedResponse;
    throw new Error(
      "Antigravity terminou sem structured_output, response ou texto final no stream.",
    );
  }
}

export class KimiAdapter extends LocalCliAdapter {
  readonly id = "kimi" as const;
  readonly capabilities: ProviderCapabilities = {
    ...capabilities,
    readOnly: false,
  };

  findExecutable(): Promise<string> {
    return findCommand("kimi");
  }

  async checkAuthentication(_command: string): Promise<boolean | undefined> {
    // Kimi validates OAuth credentials on the first request; avoid a billable auth probe.
    return undefined;
  }

  argumentsFor(permission: Permission, _schemaFile: string, prompt = ""): string[] {
    if (permission === "read-only") {
      throw new Error(
        "Kimi Code CLI não oferece modo read-only no print mode; use workspace-write.",
      );
    }
    return ["--prompt", prompt, "--output-format", "stream-json"];
  }

  input(_prompt: string): string {
    return "";
  }

  result(output: string): string {
    const assistantMessages = parseJsonLines(output).filter(
      (message) => message.role === "assistant" && !message.tool_calls,
    );
    const content = assistantMessages.at(-1)?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content
        .filter((block): block is { type: "text"; text: string } =>
          Boolean(
            block &&
              typeof block === "object" &&
              "type" in block &&
              block.type === "text" &&
              "text" in block &&
              typeof block.text === "string",
          ),
        )
        .map((block) => block.text)
        .join("");
      if (text) return text;
    }
    throw new Error("Kimi Code não retornou uma resposta estruturada.");
  }
}

interface AntigravityResult {
  status?: string;
  error?: string;
  response?: string;
  structured_output?: unknown;
  denied_actions?: unknown[];
}

interface JsonLine {
  type?: string;
  item?: { type?: string; text?: string };
  error?: { message?: string };
  message?: string;
  event?: string;
  result?: AntigravityResult;
  step_update?: {
    step_index?: number;
    step_type?: string;
    text_delta?: string;
    state?: string;
    tool_name?: string;
  };
  role?: string;
  tool_calls?: unknown;
  content?: unknown;
}

function parseJsonLines(output: string): JsonLine[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object")
        throw new Error("Provider retornou uma linha JSON inválida.");
      return parsed as JsonLine;
    });
}
