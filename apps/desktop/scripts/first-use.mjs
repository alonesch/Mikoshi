import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const localAppData = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
const userDataDirectory = resolve(
  process.env["MIKOSHI_USER_DATA_DIR"] ??
    join(localAppData, "Mikoshi", "First Use - 2026-10-04"),
);
const npmCli = process.env["npm_execpath"];

if (!npmCli) {
  console.error("Execute este launcher usando `npm run dev:first-use`.");
  process.exitCode = 1;
} else {
  const child = spawn(
    process.execPath,
    [npmCli, "run", "dev", "--workspace=@mikoshi/desktop"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        MIKOSHI_USER_DATA_DIR: userDataDirectory,
      },
    },
  );

  child.on("error", (error) => {
    console.error("Não foi possível iniciar a Mikoshi:", error.message);
    process.exitCode = 1;
  });

  child.on("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
}
