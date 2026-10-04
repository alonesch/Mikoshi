import { app, BrowserWindow, dialog } from "electron";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ProjectStore } from "./services/store.ts";
import { AgentRuntime } from "./services/provider.ts";
import { registerIpc } from "./ipc.ts";

app.setName("Mikoshi");

const userDataOverride = process.env["MIKOSHI_USER_DATA_DIR"];
if (userDataOverride) {
  const userDataPath = resolve(userDataOverride);
  mkdirSync(userDataPath, { recursive: true });
  app.setPath("userData", userDataPath);
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());

  const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
  if (rendererUrl) {
    void window.loadURL(rendererUrl);
    return;
  }
  void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

async function initialize(): Promise<void> {
  const store = new ProjectStore(app.getPath("userData"));
  const provider = new AgentRuntime(store);
  await store.recover();
  registerIpc(store, provider);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  void app
    .whenReady()
    .then(initialize)
    .catch((error: unknown) => {
      dialog.showErrorBox(
        "Falha ao iniciar Mikoshi",
        error instanceof Error ? error.message : "Dados locais inválidos.",
      );
      app.quit();
    });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
