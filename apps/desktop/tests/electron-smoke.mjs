import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function connect(port, type) {
  const targets = await (await fetch("http://127.0.0.1:" + port + "/json")).json();
  const target = type ? targets.find((entry) => entry.type === type) : targets[0];
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => {
    ws.onopen = resolve;
  });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (
      message.method === "Runtime.exceptionThrown" ||
      (message.method === "Log.entryAdded" && message.params.entry.level === "error")
    )
      errors.push(message);
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      message.error ? request.reject(message.error) : request.resolve(message.result);
    }
  };
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const response = await call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    assert.equal(response.exceptionDetails, undefined, JSON.stringify(response));
    return response.result.value;
  }
  return { ws, call, evaluate, errors };
}

const directory = await mkdtemp(join(tmpdir(), "mikoshi-electron-"));
const root = join(directory, "fixture");
await mkdir(root);
await writeFile(
  join(root, "README.md"),
  "# Demo\n- O identificador de validação é MIKOSHI_ELECTRON_OK.\n- password=do-not-export-me",
);
await writeFile(
  join(root, "AGENTS.md"),
  "# Instruções\n- Não executar comandos durante o teste de comunicação.",
);
await writeFile(
  join(root, "package.json"),
  JSON.stringify({ name: "fixture", dependencies: { react: "19.3.0" } }),
);
await writeFile(join(root, ".env"), "API_KEY=never-read-this-file");
const exported = join(directory, "fixture.engram.json");
const main = await connect(Number(process.argv[2] ?? 9242));
const page = await connect(Number(process.argv[3] ?? 9241), "page");
await main.evaluate(
  'globalThis.testElectron = process.getBuiltinModule("module").createRequire(process.cwd() + "/package.json")("electron")',
);
await main.evaluate(
  "testElectron.dialog.showOpenDialog = async () => ({canceled:false,filePaths:[" +
    JSON.stringify(root) +
    "]});testElectron.dialog.showSaveDialog = async () => ({canceled:false,filePath:" +
    JSON.stringify(exported) +
    "})",
);
await page.call("Runtime.enable");
await page.call("Log.enable");
await page.call("Page.enable");
async function waitFor(expression, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await page.evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    "Timeout: " + expression + "\n" + (await page.evaluate("document.body.innerText")),
  );
}
async function click(text) {
  await waitFor(
    'Boolean([...document.querySelectorAll("button")].find(button=>button.textContent.trim()===' +
      JSON.stringify(text) +
      "&&!button.disabled))",
  );
  await page.evaluate(
    '(()=>{const element=[...document.querySelectorAll("button")].find(button=>button.textContent.trim()===' +
      JSON.stringify(text) +
      ');if(!element||element.disabled)throw new Error("Button unavailable: "+' +
      JSON.stringify(text) +
      ");element.click();})()",
  );
}
async function setLabelValue(labelText, value, controlType = "input") {
  await page.evaluate(
    '(()=>{const label=[...document.querySelectorAll("label")].find(entry=>entry.innerText.startsWith(' +
      JSON.stringify(labelText) +
      "));const control=label?.querySelector(" +
      JSON.stringify(controlType) +
      ');if(!control)throw new Error("Control not found: "+' +
      JSON.stringify(labelText) +
      ');const prototype=control instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:control instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,"value").set.call(control,' +
      JSON.stringify(value) +
      ');control.dispatchEvent(new Event(control instanceof HTMLSelectElement?"change":"input",{bubbles:true}));})()',
  );
}
await waitFor(
  'Boolean([...document.querySelectorAll("button")].find(button=>button.textContent.trim()==="Selecionar pasta"&&!button.disabled))',
);
await click("Selecionar pasta");
await waitFor(
  'document.body.innerText.includes("fixture") && document.body.innerText.includes("Bootstrap para revisão")',
);
await click("Bootstrap para revisão");
await waitFor('document.body.innerText.includes("Revisar diff")');
assert.ok(!(await page.evaluate("document.body.innerText")).includes("do-not-export-me"));
assert.ok(
  !(await page.evaluate("document.body.innerText")).includes("never-read-this-file"),
);
await click("Aprovar selecionadas");
await waitFor(
  'document.body.innerText.includes("revisão da memória 1") && !document.body.innerText.includes("Revisar diff")',
);
const project = (await page.evaluate("window.mikoshi.listProjects()")).find(
  (entry) => entry.root === root,
);
assert.ok(project);
const snapshot = await page.evaluate(
  "window.mikoshi.getProject(" + JSON.stringify(project.id) + ")",
);
assert.ok(snapshot.memory.items.length >= 2);
assert.equal(await page.evaluate("typeof window.require"), "undefined");
assert.equal(await page.evaluate("typeof window.process"), "undefined");
const knownProviders = await page.evaluate("window.mikoshi.providerStatus()");
await click("Configurações");
await click(
  knownProviders.some((entry) => entry.provider === "codex")
    ? "Verificar novamente"
    : "Verificar e adicionar",
);
await waitFor('document.body.innerText.includes("Codex encontrado e adicionado")');
await click("Fechar");
await click("Novo agente");
await setLabelValue("Nome", "Smoke Architect");
await setLabelValue("Instruções do agente", "Responda de forma objetiva.", "textarea");
await click("Salvar agente");
await waitFor('document.body.innerText.includes("Smoke Architect · Architect · codex")');
await click("Iniciar agente");
await waitFor('document.body.innerText.includes("Terminal interativo ativo")');
const terminalSessions = await page.evaluate(
  "window.mikoshi.listAgentTerminals(" + JSON.stringify(project.id) + ")",
);
assert.equal(terminalSessions.length, 1);
assert.equal(terminalSessions[0].status, "running");
await page.evaluate(
  "window.mikoshi.stopAgentTerminal(" +
    JSON.stringify(project.id) +
    "," +
    JSON.stringify(terminalSessions[0].id) +
    ")",
);
await click("Execução estruturada e handoffs (gera diffs revisáveis)");
await click("Exportar Engram");
await waitFor('document.body.innerText.includes("Engram exportado")');
const envelope = JSON.parse(await readFile(exported, "utf8"));
assert.equal(envelope.project.id, project.id);
assert.ok(!JSON.stringify(envelope).includes(root));
assert.ok(!JSON.stringify(envelope).includes("do-not-export-me"));
await setLabelValue(
  "Tarefa",
  "Sem executar comandos nem ler arquivos, responda com o identificador de validação presente na memória e o papel atual. Não proponha alterações de memória.",
  "textarea",
);
await click("Preparar contexto");
await waitFor('document.body.innerText.includes("Working context")');
assert.ok(
  (await page.evaluate("document.querySelector('details pre').textContent")).includes(
    "MIKOSHI_ELECTRON_OK",
  ),
);
await waitFor(
  'Boolean([...document.querySelectorAll("button")].find(button=>button.textContent.trim()==="Executar agente"&&!button.disabled))',
);
await click("Executar agente");
await waitFor('document.body.innerText.includes("Em execução")');
await waitFor('document.body.innerText.includes("Concluído")', 90000);
const completed = (
  await page.evaluate("window.mikoshi.getProject(" + JSON.stringify(project.id) + ")")
).runs[0];
assert.equal(completed.status, "completed");
assert.match(completed.output, /MIKOSHI_ELECTRON_OK/);

async function enterTask(text) {
  await setLabelValue("Tarefa", text, "textarea");
}

await enterTask(
  "Sem executar comandos nem ler arquivos, proponha exatamente uma nova memória do tipo fact com o texto MIKOSHI_MEMORY_DIFF_OK e source tarefa-do-usuario. Isso é um pedido explícito do usuário nesta tarefa. Responda confirmando e use changes para propor o fato.",
);
await click("Preparar contexto");
await click("Executar agente");
await waitFor('document.body.innerText.includes("Aguardando revisão da memória")', 90000);
const beforeApproval = await page.evaluate(
  "window.mikoshi.getProject(" + JSON.stringify(project.id) + ")",
);
assert.equal(beforeApproval.memory.revision, 1);
assert.equal(beforeApproval.runs[0].status, "waiting_review");
assert.ok(
  beforeApproval.drafts[0].changes.some((change) =>
    change.text.includes("MIKOSHI_MEMORY_DIFF_OK"),
  ),
);
await click("Aprovar selecionadas");
await waitFor('document.body.innerText.includes("revisão da memória 2")');
const afterApproval = await page.evaluate(
  "window.mikoshi.getProject(" + JSON.stringify(project.id) + ")",
);
assert.equal(afterApproval.runs[0].status, "completed");
assert.ok(
  afterApproval.memory.items.some(
    (item) =>
      item.text.includes("MIKOSHI_MEMORY_DIFF_OK") &&
      item.provenance.some((origin) => origin.provider === "codex"),
  ),
);

await enterTask(
  "Sem comandos ou leitura de arquivos, explique brevemente o papel atual. Não proponha memória.",
);
await click("Preparar contexto");
await click("Executar agente");
await click("Cancelar agente");
await waitFor('document.body.innerText.includes("Cancelado")');
assert.equal(
  (await page.evaluate("window.mikoshi.getProject(" + JSON.stringify(project.id) + ")"))
    .runs[0].status,
  "cancelled",
);

const claudeStatus = await page.evaluate('window.mikoshi.verifyProvider("claude")');
/* The verification call intentionally registers Claude only when it is installed. */
assert.ok(claudeStatus.installed === false || claudeStatus.provider === "claude");
const registeredClaudeStatus = (
  await page.evaluate("window.mikoshi.providerStatus()")
).find((entry) => entry.provider === "claude");
if (registeredClaudeStatus) assert.ok(registeredClaudeStatus.installed);
let claudeRun = null;
let claudeProviderSmoke;
if (registeredClaudeStatus?.authenticated) {
  const claudeStarted = await page.evaluate(
    "window.mikoshi.startAgent(" +
      JSON.stringify(project.id) +
      ',{task:"Sem comandos ou leitura de arquivos, responda exatamente CLAUDE_PROVIDER_OK e não proponha alterações de memória.",role:"Reviewer",permission:"read-only"},"claude")',
  );
  assert.equal(claudeStarted.provider, "claude");
  assert.equal(claudeStarted.status, "running");
  const claudeDeadline = Date.now() + 90000;
  while (Date.now() < claudeDeadline) {
    claudeRun = (
      await page.evaluate("window.mikoshi.getProject(" + JSON.stringify(project.id) + ")")
    ).runs.find((run) => run.id === claudeStarted.id);
    if (claudeRun?.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (claudeRun?.status === "completed") {
    assert.match(claudeRun.output, /CLAUDE_PROVIDER_OK/);
    claudeProviderSmoke = "passed";
  } else {
    assert.match(claudeRun?.error ?? "", /OAuth session expired/);
    claudeProviderSmoke = "blocked: OAuth session expired in the local Claude CLI";
  }
} else {
  claudeProviderSmoke = "blocked: Claude CLI reports no active local login";
}

await page.call("Page.reload", { ignoreCache: true });
await new Promise((resolve) => setTimeout(resolve, 500));
await waitFor('document.body.innerText.includes("revisão da memória 2")');
await click("Testar IPC");
await waitFor('document.body.innerText.includes("win32")');
const browserWindow = await main.evaluate(
  "(()=>{const window=testElectron.BrowserWindow.getAllWindows()[0];return {visible:window.isVisible(),preferences:window.webContents.getLastWebPreferences(),userData:testElectron.app.getPath('userData')};})()",
);
assert.equal(browserWindow.visible, true);
assert.equal(browserWindow.preferences.sandbox, true);
assert.equal(browserWindow.preferences.contextIsolation, true);
assert.equal(browserWindow.preferences.nodeIntegration, false);
const screenshot = await page.call("Page.captureScreenshot");
await writeFile(join(directory, "electron.png"), Buffer.from(screenshot.data, "base64"));
assert.equal(page.errors.length, 0, JSON.stringify(page.errors));
console.log(
  JSON.stringify(
    {
      directory,
      projectId: project.id,
      memories: snapshot.memory.items.length,
      run: completed,
      claudeRun,
      claudeProviderSmoke,
      browserWindow: { visible: browserWindow.visible, userData: browserWindow.userData },
      errors: page.errors,
    },
    null,
    2,
  ),
);
main.ws.close();
page.ws.close();
