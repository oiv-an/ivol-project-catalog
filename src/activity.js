const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// У каждого окна свой файл: параллельные записи не теряют события других окон.
class ActivityStore {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, `${randomUUID()}.json`);
    this.own = {};
    this.times = {};
    this.queue = Promise.resolve();
    this.cache = new Map();
  }

  async sync() {
    let changed = false;
    await fs.mkdir(this.directory, { recursive: true });
    for (const name of await fs.readdir(this.directory)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(this.directory, name);
      try {
        const stat = await fs.stat(file);
        const signature = `${stat.mtimeMs}:${stat.size}`;
        if (this.cache.get(name) === signature) continue;
        const data = JSON.parse(await fs.readFile(file, "utf8"));
        for (const [folder, time] of Object.entries(data)) {
          if (path.isAbsolute(folder) && Number.isFinite(time) && time > 0) {
            if (time > (this.times[folder] || 0)) {
              this.times[folder] = time;
              changed = true;
            }
          }
        }
        this.cache.set(name, signature);
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
          throw error;
      }
    }
    return changed;
  }

  touch(folder, time = Date.now()) {
    this.own[folder] = Math.max(this.own[folder] || 0, time);
    this.times[folder] = Math.max(this.times[folder] || 0, time);
    const save = async () => {
      await fs.mkdir(this.directory, { recursive: true });
      const temporary = `${this.file}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(this.own), { mode: 0o600 });
      await fs.rename(temporary, this.file);
    };
    this.queue = this.queue.catch(() => {}).then(save);
    return this.queue;
  }
}

function projectsIn(nodes) {
  const projects = new Map();
  const walk = (list) => {
    for (const node of list) {
      if (node.project) projects.set(node.folder, node);
      walk(node.children);
    }
  };
  walk(nodes);
  return [...projects.values()];
}

function closestProject(nodes, file) {
  return projectsIn(nodes)
    .filter((node) => {
      const relative = path.relative(node.folder, file);
      return (
        relative === "" ||
        (relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative))
      );
    })
    .sort((a, b) => b.folder.length - a.folder.length)[0];
}

function sortByActivity(nodes, times) {
  for (const node of nodes) {
    sortByActivity(node.children, times);
    node.activity = node.children.reduce(
      (latest, child) => Math.max(latest, child.activity),
      Math.max(node.modified || 0, node.project ? times[node.folder] || 0 : 0),
    );
  }
  nodes.sort(
    (a, b) =>
      b.activity - a.activity ||
      a.folder.localeCompare(b.folder, "ru", { numeric: true }),
  );
}

function recentProjects(nodes, times, limit, excluded = new Set()) {
  const score = (node) => Math.max(node.modified || 0, times[node.folder] || 0);
  return projectsIn(nodes)
    .filter(
      (node) =>
        !excluded.has(node.folder) &&
        (!node.placeholder || (times[node.folder] || 0) > 0),
    )
    .sort((a, b) => score(b) - score(a) || a.folder.localeCompare(b.folder))
    .slice(0, limit)
    .map((node) => ({
      ...node,
      root: false,
      children: [],
      id: `recent:${node.folder}`,
      recent: true,
      activity: score(node),
    }));
}

module.exports = {
  ActivityStore,
  closestProject,
  sortByActivity,
  recentProjects,
};
