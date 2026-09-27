const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_EXCLUDES = [
  "ключи",
  "keys",
  "secrets",
  ".ssh",
  ".gnupg",
  "credentials",
  "node_modules",
  "vendor",
  ".git",
  ".svn",
  ".hg",
  ".lh",
  ".history",
  ".cache",
  "cache",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  "target",
  "bin",
  "obj",
  "logs",
  ".build",
  ".kilo",
  ".tools",
  ".gradle",
  ".dart_tool",
  ".swiftpm",
  "Pods",
  "DerivedData",
  "site-packages",
  "bower_components",
];
const EDITOR_DIRS = new Set([
  ".vscode",
  ".idea",
  ".fleet",
  ".zed",
  ".settings",
]);
const MARKERS = new Set([
  "package.json",
  "composer.json",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "pipfile",
  "cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "androidmanifest.xml",
  "gemfile",
  "mix.exs",
  "pubspec.yaml",
  "cmakelists.txt",
  "makefile",
  "docker-compose.yml",
  "compose.yaml",
  "deno.json",
  "deno.jsonc",
  "project.godot",
  "package.swift",
  ".project",
]);
const compareNames = new Intl.Collator("ru", {
  numeric: true,
  sensitivity: "base",
});
const sortNodes = (nodes) =>
  nodes.sort(
    (a, b) =>
      b.modified - a.modified || compareNames.compare(a.folder, b.folder),
  );
const isMarker = (entry) => {
  const name = entry.name.toLowerCase();
  if (entry.isSymbolicLink()) return false;
  if (entry.isDirectory())
    return (
      EDITOR_DIRS.has(name) ||
      [".git", ".hg", ".svn"].includes(name) ||
      name.endsWith(".xcodeproj")
    );
  return (
    entry.isFile() &&
    (MARKERS.has(name) ||
      name === ".git" ||
      /\.(js|mjs|cjs|jsx|ts|tsx|php|py|java|kt|kts|dart|swift|go|rs|c|cpp|h|cs|rb|vue|svelte|html)$/.test(
        name,
      ) ||
      /\.(code-workspace|sublime-project|sln|slnx|csproj|fsproj|vbproj|xcodeproj|iml|ipr)$/.test(
        name,
      ))
  );
};
const ignoredFile = (name) =>
  /^(\.env(?:\..*)?|\.ds_store|current_task\.md)$/i.test(name) ||
  /\.(pem|key|p12|pfx|vsix|log|pyc)$/i.test(name);

// Отдельные границы и бюджеты: поиск проектов не зависит от размера их исходников.
async function scanRoots(roots, options = {}) {
  const excludes = new Set(
    (options.excludes || DEFAULT_EXCLUDES).map((n) => n.toLowerCase()),
  );
  const maxEntries = options.maxEntries || 200000;
  const dateBudget = options.maxProjectEntries || 10000;
  const detectFiles = options.detectBuildFiles !== false;
  const relaxed = new Set(options.relaxedFolders || []);
  const explicitProjects = new Set(options.projectFolders || []);
  const pinned = new Set([
    ...(options.pinnedFolders || []),
    ...explicitProjects,
  ]);
  const pinnedParents = new Set();
  for (const folder of pinned) {
    for (
      let parent = path.dirname(folder);
      parent !== path.dirname(parent);
      parent = path.dirname(parent)
    )
      pinnedParents.add(parent);
  }
  const hidden = options.hiddenFolders || [];
  const isHidden = (folder) =>
    hidden.some(
      (parent) => folder === parent || folder.startsWith(parent + path.sep),
    );
  const discoveryEntries = new Map();
  let visited = 0,
    errors = 0,
    limited = false,
    datesLimited = 0;
  const found = new Map();
  const check = () => {
    if (options.cancelled?.()) throw new Error("SCAN_CANCELLED");
  };
  const skip = (entry) =>
    entry.isSymbolicLink() ||
    excludes.has(entry.name.toLowerCase()) ||
    EDITOR_DIRS.has(entry.name.toLowerCase());
  const strongMarker = (entry) => {
    const name = entry.name.toLowerCase();
    if (entry.isSymbolicLink()) return false;
    if (entry.isDirectory())
      return (
        EDITOR_DIRS.has(name) ||
        [".git", ".hg", ".svn"].includes(name) ||
        name.endsWith(".xcodeproj")
      );
    return (
      entry.isFile() &&
      (name === ".git" ||
        name === ".project" ||
        /\.(code-workspace|sublime-project|sln|slnx)$/.test(name))
    );
  };
  async function read(folder) {
    check();
    try {
      return await fs.readdir(folder, { withFileTypes: true });
    } catch {
      errors++;
      return [];
    }
  }
  async function readDiscovery(folder) {
    check();
    if (discoveryEntries.has(folder)) return discoveryEntries.get(folder);
    if (visited >= maxEntries) {
      limited = true;
      return [];
    }
    const entries = await read(folder);
    visited += entries.length;
    if (visited > maxEntries) limited = true;
    discoveryEntries.set(folder, entries);
    return entries;
  }
  async function hasAndroidApp(folder, entries, depth) {
    if (depth >= 40) return false;
    const android = entries.find(
      (entry) =>
        entry.name.toLowerCase() === "android" &&
        entry.isDirectory() &&
        !skip(entry),
    );
    if (!android) return false;
    const files = await readDiscovery(path.join(folder, android.name));
    // Проверяем только стандартный вложенный Android, не произвольных потомков.
    return (
      files.some(
        (entry) =>
          entry.isFile() &&
          !entry.isSymbolicLink() &&
          /^(settings|build)\.gradle(\.kts)?$/i.test(entry.name),
      ) &&
      files.some(
        (entry) =>
          entry.name.toLowerCase() === "app" &&
          entry.isDirectory() &&
          !skip(entry),
      )
    );
  }
  async function discover(
    folder,
    id,
    root = false,
    depth = 0,
    include = false,
  ) {
    check();
    if (isHidden(folder)) return null;
    if (depth > 40 || visited >= maxEntries) {
      limited = true;
      return null;
    }
    const entries = await readDiscovery(folder);
    // Корень — выбранный контейнер, даже если в нём лежат настройки IDE.
    const project =
      !root &&
      (explicitProjects.has(folder) ||
        entries.some(detectFiles ? isMarker : strongMarker) ||
        (detectFiles && (await hasAndroidApp(folder, entries, depth))));
    const node = {
      folder,
      id,
      root,
      project,
      empty: entries.length === 0,
      modified: 0,
      children: [],
    };
    if (project) found.set(folder, node);
    if (project && !pinnedParents.has(folder)) return node;
    // Внутри проектов ищем только явно созданные папки и пути к ним, не модули.
    if (visited > maxEntries) limited = true;
    for (const entry of entries.sort((a, b) =>
      compareNames.compare(a.name, b.name),
    )) {
      if (!entry.isDirectory() || skip(entry)) continue;
      const childFolder = path.join(folder, entry.name);
      if (
        project &&
        !pinned.has(childFolder) &&
        !pinnedParents.has(childFolder)
      )
        continue;
      if (visited >= maxEntries) {
        limited = true;
        break;
      }
      const child = await discover(
        childFolder,
        `${id}/${entry.name}`,
        false,
        depth + 1,
        relaxed.has(folder) || pinned.has(childFolder),
      );
      if (child) node.children.push(child);
    }
    if (include && !pinned.has(folder) && !project && !node.children.length) {
      node.project = true;
      node.placeholder = true;
      found.set(folder, node);
    }
    return root ||
      project ||
      pinned.has(folder) ||
      node.children.length ||
      include
      ? node
      : null;
  }
  async function modification(folder) {
    let count = 0,
      truncated = false,
      latest = 0;
    async function walk(dir, depth = 0) {
      check();
      if (depth > 80 || count >= dateBudget) {
        truncated = true;
        return;
      }
      const entries = await read(dir);
      const directories = [],
        files = [];
      for (const entry of entries) {
        if (skip(entry)) continue;
        if (++count > dateBudget) {
          truncated = true;
          break;
        }
        if (entry.isDirectory()) directories.push(path.join(dir, entry.name));
        else if (entry.isFile() && !ignoredFile(entry.name))
          files.push(path.join(dir, entry.name));
      }
      for (let i = 0; i < files.length; i += 32) {
        check();
        const times = await Promise.all(
          files.slice(i, i + 32).map(async (file) => {
            try {
              return (await fs.stat(file)).mtimeMs;
            } catch {
              errors++;
              return 0;
            }
          }),
        );
        for (const time of times) latest = Math.max(latest, time);
      }
      for (const child of directories) {
        if (count >= dateBudget) {
          truncated = true;
          break;
        }
        await walk(child, depth + 1);
      }
    }
    await walk(folder);
    if (truncated) datesLimited++;
    return latest;
  }
  const nodes = [];
  for (const folder of [...new Set(roots)]) {
    if (
      path
        .resolve(folder)
        .split(path.sep)
        .some((part) => excludes.has(part.toLowerCase()))
    )
      continue;
    const node = await discover(folder, JSON.stringify([folder]), true);
    if (node) nodes.push(node);
  }
  const dates = new Map();
  for (const folder of found.keys())
    dates.set(folder, await modification(folder));
  const finish = (list) => {
    for (const node of list) {
      finish(node.children);
      node.modified = Math.max(
        node.project ? dates.get(node.folder) || 0 : 0,
        ...node.children.map((child) => child.modified),
      );
    }
    sortNodes(list);
  };
  finish(nodes);
  return {
    nodes,
    projects: found.size,
    errors,
    limited,
    datesLimited,
    visited,
  };
}
module.exports = { scanRoots, DEFAULT_EXCLUDES };
