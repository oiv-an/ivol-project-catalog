const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { release } = require("node:os");
const { randomUUID } = require("node:crypto");
const vscode = require("vscode");

// Настройки и управление — один общий файл, независимый от реестра VS Code.
// Плагин и приложение читают один источник, а heartbeat описывает сам процесс.
class DesktopBridge {
  constructor(context, directory, report) {
    this.context = context;
    this.directory = directory;
    this.file = path.join(directory, ".menubar-control.json");
    this.report = report;
    this.preferences = { enabled: false, labelLength: 4, time: 0 };
    this.nextCheck = 0;
    this.pending = false;
    this.disposed = false;
    this.lastError = "";
    this.queue = Promise.resolve();
  }

  get enabled() {
    return process.platform === "darwin" && this.preferences.enabled;
  }

  get labelLength() {
    return this.preferences.labelLength;
  }

  normalize(data) {
    if (
      !data ||
      typeof data.enabled !== "boolean" ||
      !Number.isFinite(data.time)
    )
      throw new Error("Повреждены настройки системной панели Cataloger.");
    return {
      enabled: data.enabled,
      labelLength:
        Number.isInteger(data.labelLength) &&
        data.labelLength >= 2 &&
        data.labelLength <= 12
          ? data.labelLength
          : 4,
      time: data.time,
    };
  }

  async load() {
    if (process.platform !== "darwin") return false;
    let data;
    try {
      data = this.normalize(JSON.parse(await fs.readFile(this.file, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // Однократная миграция: старую настройку только читаем, update не вызываем.
      const config = vscode.workspace.getConfiguration("ivolCatalog");
      data = this.normalize({
        enabled: config.get("desktop.menuBar", false) === true,
        labelLength: config.get("desktop.labelLength", 4),
        time: Date.now(),
      });
      await fs.mkdir(this.directory, { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
        try {
          // Первый запуск нескольких окон не должен перезаписать чужой выбор.
          await fs.link(temporary, this.file);
        } catch (linkError) {
          if (linkError.code !== "EEXIST") throw linkError;
          data = this.normalize(
            JSON.parse(await fs.readFile(this.file, "utf8")),
          );
        }
      } finally {
        await fs.rm(temporary, { force: true });
      }
    }
    const changed = JSON.stringify(data) !== JSON.stringify(this.preferences);
    this.preferences = data;
    if (changed) this.nextCheck = 0;
    return changed;
  }

  update(patch) {
    const run = async () => {
      if (process.platform !== "darwin")
        throw new Error("Системная строка меню доступна только в macOS.");
      if (patch.enabled !== undefined && typeof patch.enabled !== "boolean")
        throw new Error("Некорректное состояние панели.");
      if (
        patch.labelLength !== undefined &&
        (!Number.isInteger(patch.labelLength) ||
          patch.labelLength < 2 ||
          patch.labelLength > 12)
      )
        throw new Error("Длина подписи должна быть от 2 до 12 букв.");
      await this.load();
      const data = this.normalize({
        ...this.preferences,
        ...patch,
        time: Math.max(Date.now(), this.preferences.time + 1),
      });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
        await fs.rename(temporary, this.file);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      this.preferences = data;
      this.lastError = "";
      this.nextCheck = 0;
    };
    this.queue = this.queue.catch(() => {}).then(run);
    return this.queue;
  }

  async heartbeat() {
    const data = await fs
      .readFile(path.join(this.directory, ".menubar-heartbeat.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (
      data?.protocol !== 1 ||
      !Number.isInteger(data.pid) ||
      data.pid <= 0 ||
      !Number.isFinite(data.time) ||
      Date.now() - data.time < 0 ||
      Date.now() - data.time >= 10000
    )
      return null;
    try {
      process.kill(data.pid, 0);
    } catch {
      return null;
    }
    return data;
  }

  async status() {
    const heartbeat = await this.heartbeat();
    let text;
    if (heartbeat) {
      const projectCount = Number(heartbeat.projects) || 0;
      text = `Помощник отвечает · проектов: ${projectCount}.`;
      if (heartbeat.screen)
        text += ` Экран по данным macOS: ${heartbeat.screen}.`;
      if (!projectCount)
        text += " Нет открытых проектов — кнопки в строке меню не нужны.";
      else if (!heartbeat.statusItemVisible || !heartbeat.buttonWindowVisible)
        text += " Кнопки проектов сейчас не отображаются.";
      else
        text +=
          " Видимость на других мониторах и за Hidden Bar не подтверждается автоматически.";
      if (!this.enabled)
        text = "Режим выключен; ожидается завершение помощника.";
    } else {
      text = this.enabled
        ? this.lastError || "Режим включён, но помощник пока не отвечает."
        : "Помощник выключен.";
    }
    return { running: !!heartbeat, text };
  }

  async sync() {
    if (
      this.disposed ||
      this.pending ||
      !this.enabled ||
      Date.now() < this.nextCheck
    )
      return;
    this.nextCheck = Date.now() + 15000;
    this.pending = true;
    try {
      if (Number.parseInt(release(), 10) < 23)
        throw new Error("Помощник требует macOS 14 или новее.");
      if (await this.heartbeat()) {
        this.lastError = "";
        return;
      }
      const app = this.context.asAbsolutePath(
        "native/macos/bin/IVOLCatalogMenu.app",
      );
      const binary = path.join(app, "Contents/MacOS/IVOLCatalogMenu");
      const cli = path.join(vscode.env.appRoot, "bin", "code");
      await fs.access(binary);
      await fs.access(cli);
      await fs.chmod(binary, 0o755);
      if (this.disposed || !this.enabled) return;
      const env = { ...process.env };
      delete env.VSCODE_IPC_HOOK_CLI;
      delete env.ELECTRON_RUN_AS_NODE;
      // Запускаем app через LaunchServices, как при проверенном ручном запуске.
      const child = spawn(
        "/usr/bin/open",
        [
          "-g",
          "-n",
          "-a",
          app,
          "--args",
          "--storage",
          this.directory,
          "--cli",
          cli,
        ],
        {
          detached: true,
          stdio: "ignore",
          env,
        },
      );
      child.on("error", (error) => this.fail(error));
      child.on("exit", (code, signal) => {
        if ((code || signal) && !this.disposed && this.enabled)
          this.fail(
            new Error(`Запуск приложения macOS завершился: ${code ?? signal}.`),
          );
      });
      child.unref();
    } catch (error) {
      this.fail(error);
    } finally {
      this.pending = false;
    }
  }

  fail(error) {
    if (this.disposed) return;
    const message = `Строка меню macOS: ${error.message}`;
    if (message !== this.lastError) {
      this.lastError = message;
      this.report(new Error(message));
    }
  }

  dispose() {
    this.disposed = true;
  }
}

module.exports = { DesktopBridge };
