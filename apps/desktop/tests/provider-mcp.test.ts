import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderId } from "../src/contracts.ts";
import { configureProviderMcp } from "../src/main/services/provider-mcp.ts";

const credentials = {
  endpoint: "http://127.0.0.1:41234/mcp/3db41f5a-6265-4f9c-a4d2-5d9c7238358d",
  token: "session-secret-value",
};

async function createRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mikoshi-provider-mcp-"));
  const root = join(directory, "repo");
  await mkdir(root);
  return root;
}

test("configuração Codex usa MCP HTTP e variável efêmera, sem token nos argumentos", async () => {
  const root = await createRoot();
  const config = await configureProviderMcp("codex", root, "terminal-a", credentials);

  assert.ok(config.args.includes("-c"));
  assert.ok(config.args.some((argument) => argument.includes(credentials.endpoint)));
  assert.ok(config.args.some((argument) => argument.includes("bearer_token_env_var")));
  assert.equal(config.env.MIKOSHI_MCP_TOKEN, credentials.token);
  assert.equal(config.args.join(" ").includes(credentials.token), false);
  await config.cleanup();
});

test("configurações Kimi e Antigravity preservam MCPs existentes e limpam somente sua sessão", async () => {
  const root = await createRoot();
  const kimiPath = join(root, ".kimi-code", "mcp.json");
  const agyPath = join(root, ".agents", "mcp_config.json");
  await mkdir(join(root, ".kimi-code"));
  await mkdir(join(root, ".agents"));
  await Promise.all([
    writeFile(
      kimiPath,
      JSON.stringify({ mcpServers: { existing: { url: "http://example.test" } } }),
    ),
    writeFile(
      agyPath,
      JSON.stringify({ mcpServers: { existing: { serverUrl: "http://example.test" } } }),
    ),
  ]);

  const kimi = await configureProviderMcp("kimi", root, "terminal-kimi", credentials);
  const agy = await configureProviderMcp(
    "antigravity",
    root,
    "terminal-agy",
    credentials,
  );
  const kimiDuring = JSON.parse(await readFile(kimiPath, "utf8")) as {
    mcpServers: Record<string, Record<string, string>>;
  };
  const agyDuring = JSON.parse(await readFile(agyPath, "utf8")) as {
    mcpServers: Record<string, Record<string, string>>;
  };

  assert.ok(kimiDuring.mcpServers.existing);
  const kimiSessionName = Object.keys(kimiDuring.mcpServers).find((name) =>
    name.startsWith("mikoshi-kimi-"),
  );
  const agySessionName = Object.keys(agyDuring.mcpServers).find((name) =>
    name.startsWith("mikoshi-antigravity-"),
  );
  assert.ok(kimiSessionName);
  assert.ok(agySessionName);
  assert.equal(
    kimiDuring.mcpServers[kimiSessionName].bearerTokenEnvVar,
    "MIKOSHI_MCP_TOKEN",
  );
  assert.ok(agyDuring.mcpServers.existing);
  assert.equal(agyDuring.mcpServers[agySessionName].serverUrl, credentials.endpoint);
  assert.equal("headers" in agyDuring.mcpServers[agySessionName], false);
  assert.equal(JSON.stringify(agyDuring).includes(credentials.token), false);
  assert.equal(kimi.env.MIKOSHI_MCP_TOKEN, credentials.token);
  assert.equal(agy.env.MIKOSHI_MCP_TOKEN, undefined);

  await Promise.all([kimi.cleanup(), agy.cleanup()]);
  const kimiAfter = JSON.parse(await readFile(kimiPath, "utf8")) as {
    mcpServers: Record<string, unknown>;
  };
  const agyAfter = JSON.parse(await readFile(agyPath, "utf8")) as {
    mcpServers: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(kimiAfter.mcpServers), ["existing"]);
  assert.deepEqual(Object.keys(agyAfter.mcpServers), ["existing"]);
});

test("configuração Claude é inline e referencia bearer token do ambiente", async () => {
  const root = await createRoot();
  const config = await configureProviderMcp(
    "claude",
    root,
    "terminal-claude",
    credentials,
  );
  const jsonArgument = config.args[config.args.indexOf("--mcp-config") + 1];
  const parsed = JSON.parse(jsonArgument) as {
    mcpServers: Record<
      string,
      { type: string; url: string; headers: Record<string, string> }
    >;
  };
  const server = parsed.mcpServers["mikoshi-terminal-claude"];

  assert.equal(server.type, "http");
  assert.equal(server.url, credentials.endpoint);
  assert.match(server.headers.Authorization, /MIKOSHI_MCP_TOKEN/);
  assert.equal(config.args.join(" ").includes(credentials.token), false);
  await config.cleanup();
});

test("cada provider expõe uma configuração isolada por terminal", async () => {
  const root = await createRoot();
  const providers: ProviderId[] = ["codex", "claude", "antigravity", "kimi"];
  const configurations = await Promise.all(
    providers.map((provider) =>
      configureProviderMcp(provider, root, provider, credentials),
    ),
  );

  assert.equal(configurations.length, providers.length);
  await Promise.all(configurations.map((configuration) => configuration.cleanup()));
});
