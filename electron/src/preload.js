const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexHost", {
  postMessage(message) {
    ipcRenderer.send("codex-host-message", message || {});
  },
  addEventListener(eventName, callback) {
    if (eventName !== "message" || typeof callback !== "function") return;
    const listener = (_event, payload) => callback({ data: payload });
    ipcRenderer.on("codex-host-reply", listener);
  }
});
