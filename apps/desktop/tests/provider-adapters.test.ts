import test from "node:test";
import assert from "node:assert/strict";
import {
  AntigravityAdapter,
  ClaudeCodeAdapter,
  CodexAdapter,
  KimiAdapter,
} from "../src/main/services/provider-adapters.ts";

test("providers isolam comandos, formatos e controles de permissão", () => {
  const codex = new CodexAdapter();
  const claude = new ClaudeCodeAdapter();
  const schemaPath = "C:\\Mikoshi\\response.schema.json";
  const claudeArgs = claude.argumentsFor("read-only", schemaPath);

  assert.equal(codex.id, "codex");
  assert.equal(claude.id, "claude");
  assert.ok(codex.argumentsFor("read-only", schemaPath).includes("--sandbox"));
  assert.ok(claudeArgs.includes("--permission-mode"));
  assert.ok(claudeArgs.includes("plan"));
  assert.ok(claudeArgs.includes("--safe-mode"));
  assert.ok(claudeArgs.includes("--no-session-persistence"));
  assert.ok(!claudeArgs.some((argument) => argument.includes("dangerously")));
});

test("Antigravity usa stream-json, schema estruturado e modos compatíveis com a permissão", () => {
  const adapter = new AntigravityAdapter();
  const schemaPath = "C:\\Mikoshi\\response.schema.json";
  const readOnlyArgs = adapter.argumentsFor("read-only", schemaPath);
  const writeArgs = adapter.argumentsFor("workspace-write", schemaPath);

  assert.equal(adapter.id, "antigravity");
  assert.deepEqual(JSON.parse(adapter.input("contexto de teste")), {
    event: "user",
    message: { content: "contexto de teste" },
  });
  assert.ok(readOnlyArgs.includes("stream-json"));
  assert.ok(readOnlyArgs.includes(schemaPath));
  assert.ok(readOnlyArgs.includes("--mode=plan"));
  assert.ok(writeArgs.includes("--mode=accept-edits"));
  assert.ok(!writeArgs.some((argument) => argument.includes("dangerously")));
});

test("Antigravity extrai a resposta estruturada do evento terminal", () => {
  const adapter = new AntigravityAdapter();
  const expected = JSON.stringify({ answer: "Memória recebida", changes: [] });
  const output = JSON.stringify({
    event: "result",
    result: {
      status: "SUCCESS",
      response: expected,
      structured_output: { answer: "Memória recebida", changes: [] },
    },
  });

  assert.equal(adapter.result(output), expected);
  assert.throws(
    () =>
      adapter.result(
        JSON.stringify({
          event: "result",
          result: { status: "ERROR", error: "sem login" },
        }),
      ),
    /sem login/,
  );
});

test("Antigravity recupera a resposta do stream quando o evento final vem vazio", () => {
  const adapter = new AntigravityAdapter();
  const expected = JSON.stringify({ answer: "Testes identificados", changes: [] });
  const output = [
    JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 2,
        step_type: "agent_response",
        text_delta: '{"answer":"Testes ',
      },
    }),
    JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 2,
        step_type: "agent_response",
        text_delta: 'identificados","changes":[]}',
      },
    }),
    JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "" } }),
  ].join("\n");

  assert.equal(adapter.result(output), expected);
});

test("Antigravity explica quando a CLI nega run_command sem emitir resposta", () => {
  const adapter = new AntigravityAdapter();
  const output = [
    JSON.stringify({
      event: "step_update",
      step_update: {
        step_type: "tool",
        tool_name: "run_command",
        state: "ERROR",
      },
    }),
    JSON.stringify({
      event: "result",
      result: { status: "SUCCESS", response: "", denied_actions: [{}] },
    }),
  ].join("\n");

  assert.throws(
    () => adapter.result(output, "read-only"),
    /run_command.*workspace-write/i,
  );
});

test("Kimi usa prompt no print mode e informa que não garante execução read-only", () => {
  const adapter = new KimiAdapter();
  const schemaPath = "C:\\Mikoshi\\response.schema.json";
  const prompt = "contexto de teste";
  const args = adapter.argumentsFor("workspace-write", schemaPath, prompt);
  const expected = JSON.stringify({ answer: "Memória recebida", changes: [] });

  assert.equal(adapter.id, "kimi");
  assert.equal(adapter.capabilities.readOnly, false);
  assert.equal(adapter.input(prompt), "");
  assert.ok(args.includes("--prompt"));
  assert.ok(args.includes(prompt));
  assert.ok(args.includes("stream-json"));
  assert.throws(() => adapter.argumentsFor("read-only", schemaPath, prompt), /read-only/);
  assert.equal(
    adapter.result(JSON.stringify({ role: "assistant", content: expected }) + "\n"),
    expected,
  );
  assert.equal(
    adapter.result(JSON.stringify({ role: "assistant", content: "not json" })),
    "not json",
  );
});

test("adapter Claude transforma envelope JSON em resposta e rejeita falha do CLI", () => {
  const adapter = new ClaudeCodeAdapter();
  const answer = JSON.stringify({ answer: "Revisão concluída", changes: [] });

  assert.equal(
    adapter.result(
      JSON.stringify({ type: "result", subtype: "success", result: answer }),
    ),
    answer,
  );
  assert.throws(
    () =>
      adapter.result(JSON.stringify({ type: "result", is_error: true, result: "falha" })),
    /Claude Code/i,
  );
});
