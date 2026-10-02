const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// Только присутствие окон, не история активности и не обход проектов.
class WindowStore {
  constructor(directory) {
    this.directory = directory;
    this.id = randomUUID();
    this.file = path.join(directory, `${this.id}.json`);
    this.entries = [];
    this.signature = "";
    this.queue = Promise.resolve();
    this.disposed = false;
  }

  sync(state) {
    const run = async () => {
      if (this.disposed) return false;
      await fs.mkdir(this.directory, { recursive: true });
      const own = { ...state, id: this.id, pid: process.pid, time: Date.now() };
      const temporary = `${this.file}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(own), { mode: 0o600 });
      await fs.rename(temporary, this.file);
      const entries = [];
      for (const name of await fs.readdir(this.directory)) {
        if (!/^[a-f0-9-]+\.json$/.test(name)) continue;
        const file = path.join(this.directory, name);
        try {
          const data = JSON.parse(await fs.readFile(file, "utf8"));
          if (
            !Number.isInteger(data.pid) ||
            data.pid <= 0 ||
            !Number.isFinite(data.time) ||
            !Array.isArray(data.folders) ||
            typeof data.target !== "string"
          )
            continue;
          let alive = Date.now() - data.time < 30000;
          try {
            process.kill(data.pid, 0);
          } catch (error) {
            if (error.code === "ESRCH") alive = false;
          }
          if (!alive) continue;
          entries.push({
            id: data.id,
            target: data.target,
            agent:
              data.agent &&
              [
                "running",
                "waiting",
                "stopped",
                "idle",
                "inactive",
                "unknown",
              ].includes(data.agent.status)
                ? {
                    status: data.agent.status,
                    folder:
                      typeof data.agent.folder === "string" &&
                      path.isAbsolute(data.agent.folder)
                        ? data.agent.folder
                        : "",
                  }
                : null,
            folders: data.folders.filter(
              (folder) => typeof folder === "string" && path.isAbsolute(folder),
            ),
          });
        } catch (error) {
          if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
            throw error;
        }
      }
      entries.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const signature = JSON.stringify(entries);
      const changed = signature !== this.signature;
      this.entries = entries;
      this.signature = signature;
      return changed;
    };
    this.queue = this.queue.catch(() => {}).then(run);
    return this.queue;
  }

  find(folder) {
    return (
      this.entries.find(
        (entry) => entry.id === this.id && entry.folders.includes(folder),
      ) || this.entries.find((entry) => entry.folders.includes(folder))
    );
  }

  dispose() {
    this.disposed = true;
    // Дожидаемся своей записи, чтобы она не воскресила закрытое окно.
    void this.queue
      .catch(() => {})
      .then(() => fs.rm(this.file, { force: true }))
      .catch(() => {});
  }
}

module.exports = { WindowStore };
