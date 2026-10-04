import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProviderId } from "../../contracts.ts";

const tokenEnvironmentVariable = "MIKOSHI_MCP_TOKEN";
const configWrites = new Map<string, Promise<void>>();

export interface ProviderMcpSession {
  endpoint: string;
  token?: string;
}

export interface ProviderMcpConfiguration {
  args: string[];
  env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

interface ProviderConfigDocument {
  mcpServers: Record<string, unknown>;
  [key: string]: unknown;
}

function requireBearerToken(session: ProviderMcpSession): string {
  if (!session.token) throw new Error("Sessão MCP não possui token bearer.");
  return session.token;
}

async function readConfig(path: string): Promise<ProviderConfigDocument> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mcpServers: {} };
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Configuração MCP inválida em ${path}.`);
  const document = value as Record<string, unknown>;
  const servers = document.mcpServers;
  if (
    servers !== undefined &&
    (!servers || typeof servers !== "object" || Array.isArray(servers))
  )
    throw new Error(`A lista mcpServers é inválida em ${path}.`);
  return {
    ...document,
    mcpServers: (servers as Record<string, unknown> | undefined) ?? {},
  };
}

async function updateConfig(
  path: string,
  update: (document: ProviderConfigDocument) => void,
): Promise<void> {
  const previous = configWrites.get(path) ?? Promise.resolve();
  const current = previous.then(async () => {
    const document = await readConfig(path);
    update(document);
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(document, null, 2) + "\n", {
        mode: 0o600,
      });
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  });
  const queued = current.catch(() => undefined);
  configWrites.set(path, queued);
  try {
    await current;
  } finally {
    if (configWrites.get(path) === queued) configWrites.delete(path);
  }
}

function httpServerEntry(
  provider: ProviderId,
  session: ProviderMcpSession,
): { name: string; entry: Record<string, unknown> } {
  const name = `mikoshi-${provider}-${randomUUID()}`;
  if (provider === "kimi")
    return {
      name,
      entry: {
        url: session.endpoint,
        bearerTokenEnvVar: tokenEnvironmentVariable,
      },
    };
  if (provider === "antigravity")
    return {
      name,
      entry: {
        serverUrl: session.endpoint,
      },
    };
  throw new Error("Provider não usa configuração MCP de projeto.");
}

async function configureProjectMcp(
  provider: "antigravity" | "kimi",
  projectRoot: string,
  session: ProviderMcpSession,
): Promise<ProviderMcpConfiguration> {
  const filePath =
    provider === "antigravity"
      ? join(projectRoot, ".agents", "mcp_config.json")
      : join(projectRoot, ".kimi-code", "mcp.json");
  const { name, entry } = httpServerEntry(provider, session);
  const token = provider === "kimi" ? requireBearerToken(session) : undefined;
  await updateConfig(filePath, (document) => {
    if (Object.hasOwn(document.mcpServers, name))
      throw new Error("Nome de sessão MCP já está em uso.");
    document.mcpServers[name] = entry;
  });
  return {
    args: [],
    env: token ? { [tokenEnvironmentVariable]: token } : {},
    cleanup: async () => {
      await updateConfig(filePath, (document) => {
        delete document.mcpServers[name];
      });
    },
  };
}

export async function configureProviderMcp(
  provider: ProviderId,
  projectRoot: string,
  terminalId: string,
  session: ProviderMcpSession,
): Promise<ProviderMcpConfiguration> {
  if (provider === "kimi" || provider === "antigravity")
    return configureProjectMcp(provider, projectRoot, session);

  if (provider === "claude") {
    const name = `mikoshi-${terminalId}`;
    const token = requireBearerToken(session);
    const server = {
      type: "http",
      url: session.endpoint,
      headers: { Authorization: "Bearer ${" + tokenEnvironmentVariable + "}" },
    };
    return {
      args: ["--mcp-config", JSON.stringify({ mcpServers: { [name]: server } })],
      env: { [tokenEnvironmentVariable]: token },
      cleanup: async () => undefined,
    };
  }

  const name = `mikoshi_${terminalId.replace(/-/g, "_")}`;
  const token = requireBearerToken(session);
  const key = `mcp_servers.${name}`;
  return {
    args: [
      "-c",
      `${key}.url=${JSON.stringify(session.endpoint)}`,
      "-c",
      `${key}.bearer_token_env_var=${JSON.stringify(tokenEnvironmentVariable)}`,
      "-c",
      `${key}.enabled=true`,
    ],
    env: { [tokenEnvironmentVariable]: token },
    cleanup: async () => undefined,
  };
}
