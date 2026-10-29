import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasTerminalInput,
  hasTerminalOutput,
} from "../src/renderer/src/terminal-activity.ts";

test("foco, mouse, cursor e limpeza do terminal não contam como atividade", () => {
  for (const sequence of [
    "\x1b[I",
    "\x1b[O",
    "\x1b[<0;12;8M",
    "\x1b[2J\x1b[H",
    "\x1b]0;Codex\x07",
    "\r\n",
  ]) {
    assert.equal(hasTerminalOutput(sequence), false, sequence);
  }
  assert.equal(hasTerminalInput("\x1b[<0;12;8M"), false);
});

test("texto de saída e digitação no terminal contam como atividade", () => {
  assert.equal(hasTerminalOutput("\x1b[32mResposta pronta\x1b[0m"), true);
  assert.equal(hasTerminalInput("olá"), true);
  assert.equal(hasTerminalInput("\r"), true);
});
