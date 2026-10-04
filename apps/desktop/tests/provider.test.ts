import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderCapabilities, ProviderId } from "../src/contracts.ts";
import { parseAgentResult } from "../src/main/services/provider.ts";
import { AgentRuntime } from "../src/main/services/provider.ts";
import type { ProviderAdapter } from "../src/main/services/provider-adapters.ts";
import { ProjectStore } from "../src/main/services/store.ts";

const capabilities: ProviderCapabilities = {
  readOnly: true,
  workspaceWrite: true,
  cancellation: true,
  structuredOutput: true,
};

class TestAdapter implements ProviderAdapter {
  readonly id: ProviderId = "codex";
  readonly capabilities = capabilities;

  async findExecutable(): Promise<string> {
    return "C:/tools/codex.exe";
  }
  async version(): Promise<string> {
    return "codex 1.0";
  }
  async checkAuthentication(): Promise<boolean> {
    return true;
  }
  argumentsFor(): string[] {
    return [];
  }
  input(prompt: string): string {
    return prompt;
  }
  result(output: string): string {
    return output;
  }
}

test("valida saída estruturada do provider, sem confiar em alterações arbitrárias", () => {
  const output = JSON.stringify({
    answer: "Análise concluída",
    changes: [
      {
        op: "add",
        targetId: "",
        kind: "fact",
        text: "Electron presente",
        source: "package.json",
      },
    ],
  });
  assert.equal(parseAgentResult(output).changes.length, 1);
  assert.throws(() =>
    parseAgentResult(
      '{"answer":"ok","changes":[{"op":"execute","kind":"fact","text":"x"}]}',
    ),
  );
  assert.throws(() => parseAgentResult("not json"));
  assert.throws(() => parseAgentResult(""), /JSON inválido ou incompleto/);
});

test("providers começam vazios e só aparecem após verificação explícita", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-provider-registry-"));
  const store = new ProjectStore(directory);
  const runtime = new AgentRuntime(store, [new TestAdapter()]);

  assert.deepEqual(await runtime.statuses(), []);
  const status = await runtime.status("codex");

  assert.equal(status.installed, true);
  assert.deepEqual(await runtime.statuses(), [status]);
  assert.equal(await runtime.executable("codex"), "C:/tools/codex.exe");
});
