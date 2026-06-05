const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const { createHost } = require("./node_host");

let mainWindow = null;
let host = null;

function sendToRenderer(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("codex-host-reply", message);
}

function createWindow() {
  host = createHost({
    app,
    send: sendToRenderer,
    openExternal: (url) => shell.openExternal(url)
  });

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 620,
    title: "Codex Account Switch",
    frame: false,
    backgroundColor: "#101418",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const webuiRoot = app.isPackaged
    ? path.join(process.resourcesPath, "webui")
    : path.resolve(__dirname, "..", "..", "webui");
  mainWindow.loadFile(path.join(webuiRoot, "index.html"));
}

ipcMain.on("codex-host-message", async (_event, message) => {
  if (!host) return;
  await host.handle(message || {}, mainWindow);
});

app.whenReady().then(createWindow);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
