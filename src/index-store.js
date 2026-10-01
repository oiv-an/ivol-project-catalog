const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// Общий индекс и одна очередь записи для всех окон данного профиля.
class IndexStore {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, "catalog-index.json");
    this.lock = path.join(directory, "catalog-index.lock");
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, "utf8"));
      const paths = (items) =>
        Array.isArray(items) &&
        items.every((f) => typeof f === "string" && path.isAbsolute(f));
      const nodesValid = (nodes, depth = 0) =>
        depth < 100 &&
        Array.isArray(nodes) &&
        nodes.every(
          (n) =>
            n &&
            typeof n.folder === "string" &&
            path.isAbsolute(n.folder) &&
            Number.isFinite(n.modified) &&
            nodesValid(n.children, depth + 1),
        );
      if (
        !data ||
        !nodesValid(data.nodes) ||
        !paths(data.roots) ||
        !paths(data.created) ||
        !paths(data.favorites) ||
        data.version !== 1 ||
        !Array.isArray(data.nodes) ||
        !Array.isArray(data.roots) ||
        !Array.isArray(data.created) ||
        !Array.isArray(data.favorites) ||
        !data.preferences ||
        typeof data.preferences !== "object" ||
        Array.isArray(data.preferences) ||
        Object.entries(data.preferences).some(
          ([f, p]) => !path.isAbsolute(f) || !p || typeof p !== "object",
        ) ||
        typeof data.revision !== "string"
      )
        throw new Error(
          "Повреждён индекс каталога. Нажмите ↻ Переиндексировать.",
        );
      return data;
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      if (error instanceof SyntaxError)
        throw new Error(
          "Повреждён индекс каталога. Нажмите ↻ Переиндексировать.",
        );
      throw error;
    }
  }

  transaction(work, cancelled = () => false) {
    const run = async () => {
      await fs.mkdir(this.directory, { recursive: true });
      const owner = `${process.pid}-${randomUUID()}`;
      // Готовый owner-файл публикуется hard link атомарно: нет пустого lock.
      const ownerFile = path.join(this.directory, `${owner}.lock-owner`);
      await fs.writeFile(
        ownerFile,
        JSON.stringify({ pid: process.pid, owner }),
        { mode: 0o600 },
      );
      let acquired = false;
      try {
        while (!acquired) {
          if (cancelled()) throw new Error("Индексация отменена.");
          try {
            await fs.link(ownerFile, this.lock);
            acquired = true;
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
            try {
              const text = await fs.readFile(this.lock, "utf8");
              const holder = JSON.parse(text);
              if (!Number.isInteger(holder.pid) || holder.pid <= 0)
                throw new Error("Некорректная блокировка индекса.");
              try {
                process.kill(holder.pid, 0);
              } catch (checkError) {
                if (checkError.code === "ESRCH") {
                  // Все претенденты используют один атомарный recovery-link:
                  // два окна не могут одновременно удалить старый lock.
                  const recovery = `${this.lock}.recovery`;
                  let recovering = false;
                  try {
                    await fs.link(ownerFile, recovery);
                    recovering = true;
                    if ((await fs.readFile(this.lock, "utf8")) === text)
                      await fs.unlink(this.lock);
                  } catch (recoveryError) {
                    if (!["EEXIST", "ENOENT"].includes(recoveryError.code))
                      throw recoveryError;
                    if (recoveryError.code === "EEXIST")
                      throw new Error(
                        "Восстановление блокировки уже выполняется. Повторите ↻; если ошибка сохраняется, перезапустите окна.",
                      );
                  } finally {
                    if (recovering) await fs.unlink(recovery);
                  }
                }
              }
            } catch (readError) {
              if (readError.code !== "ENOENT") throw readError;
            }
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
        }
        const result = await work();
        if (cancelled()) throw new Error("Индексация отменена.");
        if (result) {
          result.version = 1;
          result.revision = randomUUID();
          const temporary = `${this.file}.${owner}.tmp`;
          try {
            await fs.writeFile(temporary, JSON.stringify(result), {
              mode: 0o600,
            });
            await fs.rename(temporary, this.file);
          } finally {
            await fs.rm(temporary, { force: true });
          }
        }
        return result;
      } finally {
        if (acquired) await fs.unlink(this.lock);
        await fs.rm(ownerFile, { force: true });
      }
    };
    this.queue = this.queue.catch(() => {}).then(run);
    return this.queue;
  }
}

module.exports = { IndexStore };
