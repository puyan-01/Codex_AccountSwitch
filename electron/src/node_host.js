const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");

const APP_VERSION = "v1.3.17";
const PLAN_GROUPS = new Set(["personal", "business", "free", "plus", "team", "pro"]);

function nowText() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function normalizeGroup(group) {
  const value = String(group || "personal").trim().toLowerCase();
  return PLAN_GROUPS.has(value) ? value : "personal";
}

function sanitizeAccountName(name) {
  return String(name || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/g, "");
}

function clientTargetToIdeExe(target) {
  const value = String(target || "codex").toLowerCase();
  if (value === "cursor") return "Cursor.exe";
  if (value === "vscode") return "Code.exe";
  if (value === "windsurf") return "Windsurf.exe";
  return "Codex.exe";
}

function normalizeClientTarget(clientTarget, ideExe) {
  const value = String(clientTarget || "").trim().toLowerCase();
  if (["codex", "cursor", "vscode", "windsurf"].includes(value)) return value;
  const exe = String(ideExe || "").trim().toLowerCase();
  if (exe.includes("cursor")) return "cursor";
  if (exe === "code.exe" || exe.includes("visual studio code")) return "vscode";
  if (exe.includes("windsurf")) return "windsurf";
  return "codex";
}

function defaultConfig() {
  return {
    language: "zh-CN",
    languageIndex: 0,
    clientTarget: "codex",
    ideExe: "Codex.exe",
    theme: "auto",
    tabVisibility: {
      dashboard: true,
      accounts: true,
      api: true,
      traffic: true,
      token: true,
      cloud: true,
      about: true,
      settings: true
    },
    autoUpdate: false,
    enableAutoRefreshQuota: true,
    autoMarkAbnormalAccounts: true,
    autoDeleteAbnormalAccounts: false,
    autoRefreshCurrent: true,
    lowQuotaAutoPrompt: true,
    closeWindowBehavior: "tray",
    autoRefreshAllMinutes: 15,
    autoRefreshCurrentMinutes: 5,
    proxyPort: 1455,
    proxyTimeoutSec: 600,
    proxyAllowLan: false,
    proxyAutoStart: false,
    proxyStealthMode: false,
    proxyApiKey: "",
    proxyDispatchMode: "round_robin",
    proxyFixedAccount: "",
    proxyFixedGroup: "personal",
    lastSwitchedAccount: "",
    lastSwitchedGroup: "",
    lastSwitchedAt: "",
    cloudAccountUrl: "",
    cloudAccountAutoDownload: false,
    cloudAccountIntervalMinutes: 60,
    cloudAccountLastDownloadAt: "",
    cloudAccountLastDownloadStatus: "",
    cloudAccountPasswordConfigured: false,
    webdavEnabled: false,
    webdavAutoSync: true,
    webdavSyncIntervalMinutes: 15,
    webdavUrl: "",
    webdavRemotePath: "/CodexAccountSwitch",
    webdavUsername: "",
    webdavLastSyncAt: "",
    webdavLastSyncStatus: "",
    webdavPasswordConfigured: false,
    proxyDefaultModel: "",
    customModels: [],
    stealthTomlExtra: ""
  };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeRelativeAuthPath(group, name) {
  return path.join("backups", normalizeGroup(group), sanitizeAccountName(name), "auth.json");
}

function resolveAuthPath(dataRoot, item) {
  const stored = String(item.path || "");
  return path.isAbsolute(stored) ? stored : path.join(dataRoot, stored);
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureIndex(dataRoot) {
  const backupsRoot = path.join(dataRoot, "backups");
  await fsp.mkdir(backupsRoot, { recursive: true });
  for (const group of PLAN_GROUPS) {
    await fsp.mkdir(path.join(backupsRoot, group), { recursive: true });
  }

  const indexPath = path.join(backupsRoot, "index.json");
  const index = await readJson(indexPath, null);
  if (index && Array.isArray(index.accounts)) return index;

  const created = { current: { name: "", group: "personal" }, accounts: [] };
  await writeJson(indexPath, created);
  return created;
}

function accountRows(index) {
  const current = index.current || {};
  return (Array.isArray(index.accounts) ? index.accounts : []).map((item) => ({
    name: String(item.name || ""),
    group: normalizeGroup(item.group),
    updatedAt: String(item.updatedAt || ""),
    isCurrent:
      String(item.name || "").toLowerCase() === String(current.name || "").toLowerCase() &&
      normalizeGroup(item.group) === normalizeGroup(current.group),
    abnormal: item.abnormal === true,
    abnormalReason: String(item.abnormalReason || ""),
    abnormalAt: String(item.abnormalAt || ""),
    usageOk: item.usageOk === true,
    usageError: String(item.usageError || ""),
    planType: String(item.planType || ""),
    email: String(item.email || ""),
    quota5hRemainingPercent: Number.isFinite(Number(item.quota5hRemainingPercent)) ? Number(item.quota5hRemainingPercent) : -1,
    quota7dRemainingPercent: Number.isFinite(Number(item.quota7dRemainingPercent)) ? Number(item.quota7dRemainingPercent) : -1,
    quota5hResetAfterSeconds: Number.isFinite(Number(item.quota5hResetAfterSeconds)) ? Number(item.quota5hResetAfterSeconds) : -1,
    quota7dResetAfterSeconds: Number.isFinite(Number(item.quota7dResetAfterSeconds)) ? Number(item.quota7dResetAfterSeconds) : -1,
    quota5hResetAt: Number.isFinite(Number(item.quota5hResetAt)) ? Number(item.quota5hResetAt) : -1,
    quota7dResetAt: Number.isFinite(Number(item.quota7dResetAt)) ? Number(item.quota7dResetAt) : -1
  }));
}

function runDetached(command, args) {
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function execFileQuiet(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 2500 }, () => resolve());
  });
}

async function restartClient(config) {
  const target = normalizeClientTarget(config.clientTarget, config.ideExe);
  if (process.platform === "darwin") {
    const appName = target === "cursor" ? "Cursor" : target === "vscode" ? "Visual Studio Code" : target === "windsurf" ? "Windsurf" : "Codex";
    await execFileQuiet("osascript", ["-e", `quit app "${appName}"`]);
    return runDetached("open", ["-a", appName]);
  }
  if (process.platform === "win32") {
    const exe = clientTargetToIdeExe(target);
    await execFileQuiet("taskkill.exe", ["/IM", exe, "/F"]);
    if (target === "codex") {
      return runDetached("explorer.exe", ["shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App"]) || runDetached(exe, []);
    }
    return runDetached(exe, []);
  }
  const command = target === "cursor" ? "cursor" : target === "vscode" ? "code" : target === "windsurf" ? "windsurf" : "codex";
  return runDetached(command, []);
}

function createHost({ app, send, openExternal }) {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const webuiRoot = app.isPackaged
    ? path.join(process.resourcesPath, "webui")
    : path.join(projectRoot, "webui");
  const dataRoot = app.getPath("userData");
  const configPath = path.join(dataRoot, "config.json");
  const codexAuthPath = path.join(os.homedir(), ".codex", "auth.json");

  async function loadConfig() {
    const stored = await readJson(configPath, {});
    const merged = { ...defaultConfig(), ...stored };
    merged.clientTarget = normalizeClientTarget(merged.clientTarget, merged.ideExe);
    merged.ideExe = merged.ideExe || clientTargetToIdeExe(merged.clientTarget);
    merged.proxyStealthMode = merged.proxyStealthMode === true;
    return merged;
  }

  async function saveConfig(config) {
    const next = { ...defaultConfig(), ...config };
    next.clientTarget = normalizeClientTarget(next.clientTarget, next.ideExe);
    next.ideExe = next.ideExe || clientTargetToIdeExe(next.clientTarget);
    await writeJson(configPath, next);
    return next;
  }

  async function sendConfig(firstRun = false) {
    send({ type: "config", firstRun, ...(await loadConfig()) });
    const cfg = await loadConfig();
    send({
      type: "refresh_timers",
      allIntervalSec: cfg.autoRefreshAllMinutes * 60,
      currentIntervalSec: cfg.autoRefreshCurrentMinutes * 60,
      enableAutoRefreshQuota: cfg.enableAutoRefreshQuota,
      disableAutoRefreshQuota: !cfg.enableAutoRefreshQuota,
      allEnabled: cfg.enableAutoRefreshQuota,
      autoRefreshQuotaDisabled: !cfg.enableAutoRefreshQuota,
      currentEnabled: cfg.autoRefreshCurrent,
      allRemainingSec: cfg.autoRefreshAllMinutes * 60,
      currentRemainingSec: cfg.autoRefreshCurrentMinutes * 60
    });
    send({ type: "webdav_sync_status", enabled: false, autoSync: false, intervalMinutes: 15, remainingSec: 0, running: false, passwordConfigured: false });
    send({ type: "cloud_account_status", autoDownload: false, intervalMinutes: 60, remainingSec: 0, running: false, passwordConfigured: false });
  }

  async function sendAccountsList() {
    const index = await ensureIndex(dataRoot);
    send({ type: "accounts_list", accounts: accountRows(index) });
  }

  async function sendLanguageIndex(code) {
    const langDir = path.join(webuiRoot, "lang");
    const files = (await fsp.readdir(langDir)).filter((file) => file.endsWith(".json"));
    const languages = files.map((file) => {
      const langCode = path.basename(file, ".json");
      return { code: langCode, name: langCode, file };
    });
    send({ type: "language_index", languages });
    await sendLanguagePack(code || "zh-CN");
  }

  async function sendLanguagePack(code) {
    const requested = String(code || "zh-CN");
    const filePath = path.join(webuiRoot, "lang", `${requested}.json`);
    const fallback = path.join(webuiRoot, "lang", "zh-CN.json");
    const strings = await readJson((await fileExists(filePath)) ? filePath : fallback, null);
    send(strings ? { type: "language_pack", ok: true, code: requested, strings } : { type: "language_pack", ok: false });
  }

  async function rejectAccountBackup() {
    send({ type: "status", level: "warning", code: "account_backup_disabled", message: "当前版本已禁用账号备份功能" });
  }

  async function rejectCloudAccountSync() {
    send({ type: "status", level: "warning", code: "cloud_account_sync_disabled", message: "当前版本不支持云账户同步功能" });
    send({ type: "cloud_account_status", autoDownload: false, intervalMinutes: 60, remainingSec: 0, running: false, passwordConfigured: false });
  }

  async function switchAccount(account, group, payload) {
    let cfg = await loadConfig();
    if (payload.language) cfg.language = payload.language;
    if (payload.clientTarget || payload.ideExe) {
      cfg.clientTarget = normalizeClientTarget(payload.clientTarget, payload.ideExe);
      cfg.ideExe = payload.ideExe || clientTargetToIdeExe(cfg.clientTarget);
    }
    cfg = await saveConfig(cfg);

    const safeName = sanitizeAccountName(account);
    const index = await ensureIndex(dataRoot);
    const row = index.accounts.find((item) => normalizeGroup(item.group) === normalizeGroup(group) && String(item.name || "").toLowerCase() === safeName.toLowerCase()) ||
      index.accounts.find((item) => String(item.name || "").toLowerCase() === safeName.toLowerCase());
    if (!row) {
      send({ type: "status", level: "error", code: "not_found", message: "切换失败：未找到备份账号" });
      return;
    }
    const source = resolveAuthPath(dataRoot, row);
    if (!(await fileExists(source))) {
      send({ type: "status", level: "error", code: "not_found", message: "切换失败：未找到备份账号" });
      return;
    }
    await fsp.mkdir(path.dirname(codexAuthPath), { recursive: true });
    await fsp.copyFile(source, codexAuthPath);
    index.current = { name: safeName, group: normalizeGroup(row.group) };
    row.updatedAt = nowText();
    await writeJson(path.join(dataRoot, "backups", "index.json"), index);
    cfg.lastSwitchedAccount = safeName;
    cfg.lastSwitchedGroup = normalizeGroup(row.group);
    cfg.lastSwitchedAt = nowText();
    await saveConfig(cfg);

    if (cfg.proxyStealthMode) {
      send({ type: "status", level: "success", code: "switch_success_proxy_mode", message: "切换成功（反代模式）。请重启 IDE 或 CLI 以生效。" });
    } else if (await restartClient(cfg)) {
      send({ type: "status", level: "success", code: "switch_success", message: `切换成功，正在重启 ${cfg.clientTarget}` });
    } else {
      send({ type: "status", level: "error", code: "restart_failed", message: `切换成功，但重启 ${cfg.clientTarget} 失败，请手动重启` });
    }
    await sendAccountsList();
  }

  async function handle(message, windowRef) {
    const action = String(message.action || "");
    try {
      if (action === "window_minimize") return windowRef.minimize();
      if (action === "window_toggle_maximize") return windowRef.isMaximized() ? windowRef.unmaximize() : windowRef.maximize();
      if (action === "window_close") return windowRef.close();
      if (action === "window_drag") return;
      if (action === "get_app_info") return send({ type: "app_info", version: APP_VERSION, debug: false, repo: "" });
      if (action === "get_config") {
        const firstRun = !(await fileExists(configPath));
        if (firstRun) await saveConfig(defaultConfig());
        return sendConfig(firstRun);
      }
      if (action === "set_config") {
        await saveConfig({ ...(await loadConfig()), ...message });
        send({ type: "status", level: "success", code: "config_saved", message: "" });
        return sendConfig(false);
      }
      if (action === "get_languages") return sendLanguageIndex(message.code);
      if (action === "get_language_pack") return sendLanguagePack(message.code);
      if (action === "list_accounts" || action === "refresh_accounts" || action === "refresh_accounts_batch" || action === "refresh_account") return sendAccountsList();
      if (action === "backup_current" || action === "backup_current_auto") return rejectAccountBackup();
      if (action === "switch_account") return switchAccount(message.account, message.group, message);
      if (action === "open_external_url" && message.url) return openExternal(String(message.url));
      if (action === "get_proxy_status") return send({ type: "proxy_status", running: false, port: 1455, timeoutSec: 600, allowLan: false, apiKey: "", dispatchMode: "round_robin", fixedAccount: "", fixedGroup: "personal" });
      if (action === "get_traffic_logs") return send({ type: "traffic_logs", items: [] });
      if (action === "get_token_stats") return send({ type: "token_stats", inputTokens: 0, outputTokens: 0, totalTokens: 0, activeAccount: "", models: [], accounts: [], trend: {} });
      if (action === "get_api_models") return send({ type: "api_models", models: [] });
      if (action === "download_latest_cloud_account") return rejectCloudAccountSync();
      if (action === "check_update") return send({ type: "update_info", ok: false, current: APP_VERSION, latest: "", hasUpdate: false, url: "", downloadUrl: "", notes: "", error: "Electron shell does not check updates yet" });
      send({ type: "status", level: "warning", code: "electron_action_unsupported", message: "Electron 版暂未支持该功能" });
    } catch (error) {
      send({ type: "status", level: "error", code: "electron_host_error", message: error && error.message ? error.message : String(error) });
    }
  }

  return { handle };
}

module.exports = { createHost };
