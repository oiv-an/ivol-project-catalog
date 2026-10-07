const path = require("node:path");
const { scanRoots, DEFAULT_EXCLUDES } = require("./scanner");
const { IndexStore } = require("./index-store");
const within = (base, folder) =>
  folder === base || folder.startsWith(base + path.sep);

function installIndex(provider, context, vscode) {
  const store = new IndexStore(context.globalStorageUri.fsPath);
  provider.indexStore = store;
  const seed = () => ({
    roots: provider.roots,
    created: provider.createdFolders,
    preferences: provider.preferences,
    favorites: provider.favorites,
    nodes: [],
  });
  const scanSettings = () => {
    const config = vscode.workspace.getConfiguration("ivolCatalog");
    return {
      excludes: config.get("excludedDirectories", DEFAULT_EXCLUDES),
      maxEntries: config.get("maxScanEntries", 200000),
      maxProjectEntries: config.get("maxProjectEntries", 10000),
      detectBuildFiles: config.get("detectBuildFiles", true),
    };
  };
  const options = (data) => {
    return {
      pinnedFolders: data.created,
      projectFolders: Object.keys(data.preferences).filter(
        (f) => data.preferences[f].project,
      ),
      relaxedFolders: Object.keys(data.preferences).filter(
        (f) => data.preferences[f].relaxed,
      ),
      hiddenFolders: Object.keys(data.preferences).filter(
        (f) => data.preferences[f].hidden,
      ),
      ...(data.settings || scanSettings()),
      cancelled: () => provider.disposed,
    };
  };
  const normalize = (data) => {
    const hidden = Object.keys(data.preferences).filter(
      (f) => data.preferences[f].hidden,
    );
    const visit = (nodes, parent) =>
      nodes
        .filter((n) => !hidden.some((f) => within(f, n.folder)))
        .map((n) => {
          n.id = parent
            ? `${parent}/${path.basename(n.folder)}`
            : JSON.stringify([n.folder]);
          if (!n.root && data.preferences[n.folder]?.project) {
            // Явное назначение задаёт границу проекта для всех операций индекса.
            n.project = true;
            n.placeholder = false;
            n.modified = Math.max(n.modified || 0, ...n.children.map((c) => c.modified || 0));
            n.children = [];
          } else {
            n.children = visit(n.children, n.id);
            if (!n.project)
              n.modified = Math.max(0, ...n.children.map((c) => c.modified || 0));
          }
          return n;
        });
    data.nodes = visit(data.nodes.filter((n) => data.roots.includes(n.folder)));
    return data;
  };
  const apply = (data) => {
    provider.sharedIndex = data;
    provider.nodes = structuredClone(data.nodes);
    provider.initialized = true;
    provider.scannedRoots = JSON.stringify(data.roots);
    provider.scanError = data.warning || "";
    provider.status = "Общий индекс загружен";
    void vscode.commands.executeCommand(
      "setContext",
      "ivolCatalog.hasRoots",
      data.roots.length > 0,
    );
    provider.changed.fire();
  };
  provider.syncIndex = async () => {
    if (provider.scanning) return false;
    const data = await store.read();
    if (
      !data ||
      data.revision === provider.sharedIndex?.revision ||
      provider.scanning ||
      provider.disposed
    )
      return false;
    apply(data);
    return true;
  };
  provider.refresh = async (force = false) => {
    if (provider.scanning) return;
    provider.scanning = true;
    const generation = ++provider.generation;
    provider.scanError = "";
    provider.onStatus?.();
    const start = Date.now();
    try {
      let data = await store.read().catch((error) => {
        if (!force) throw error;
      });
      if (!data || force) {
        data =
          (await store.transaction(
            async () => {
              const latest = await store.read().catch((error) => {
                if (!force) throw error;
              });
              if (latest && !force) return undefined;
              const next = latest || structuredClone(seed());
              next.settings = scanSettings();
              const result = await scanRoots(next.roots, options(next));
              next.nodes = result.nodes;
              next.warning =
                result.errors || result.limited
                  ? "Индекс неполный: проверьте доступ/лимиты и нажмите ↻."
                  : "";
              return normalize(next);
            },
            () => provider.disposed,
          )) || (await store.read());
      }
      if (provider.disposed) return;
      apply(data);
      provider.scanning = false;
      provider.log?.(
        `Загрузка общего индекса${force ? " с переиндексацией" : ""}: ${Date.now() - start} мс`,
      );
      void provider.afterScan?.(generation);
    } catch (error) {
      provider.scanError = error.message;
      provider.status = error.message;
    } finally {
      provider.scanning = false;
      if (!provider.disposed) provider.onStatus?.();
    }
  };
  const find = (nodes, folder) => {
    for (const node of nodes) {
      if (node.folder === folder) return node;
      const child = find(node.children, folder);
      if (child) return child;
    }
  };
  const remove = (nodes, folder) =>
    nodes
      .filter((n) => !within(folder, n.folder))
      .map((n) => ({ ...n, children: remove(n.children, folder) }));
  const insert = (data, node) => {
    for (const root of data.nodes) {
      if (!within(root.folder, node.folder)) continue;
      if (root.folder === node.folder) {
        Object.assign(root, structuredClone(node), { root: true });
        continue;
      }
      let parent = root;
      const parts = path
        .relative(root.folder, path.dirname(node.folder))
        .split(path.sep)
        .filter(Boolean);
      if (parts.includes("..")) continue;
      for (const part of parts) {
        const folder = path.join(parent.folder, part);
        let child = parent.children.find((n) => n.folder === folder);
        if (!child) {
          child = {
            folder,
            project: false,
            children: [],
            modified: 0,
            empty: false,
          };
          parent.children.push(child);
        }
        parent = child;
      }
      parent.children = parent.children.filter((n) => n.folder !== node.folder);
      parent.children.push(structuredClone(node));
      parent.empty = false;
    }
  };
  const rescanBranch = async (data, folder) => {
    if (!data.roots.some((r) => within(r, folder))) return;
    if (
      Object.entries(data.preferences).some(
        ([f, p]) => p.hidden && within(f, folder),
      )
    )
      return;
    const result = await scanRoots([folder], {
      ...options(data),
      branch: true,
    });
    data.nodes = remove(data.nodes, folder);
    for (const node of result.nodes) insert(data, node);
  };
  provider.changeIndex = async (work) => {
    if (provider.scanning) throw new Error("Дождитесь завершения индексации.");
    provider.scanning = true;
    const generation = ++provider.generation;
    provider.onStatus?.();
    try {
      const data = await store.transaction(
        async () => {
          const latest = await store.read();
          if (!latest) throw new Error("Индекс не загружен. Нажмите ↻.");
          await work(latest);
          return normalize(latest);
        },
        () => provider.disposed,
      );
      if (provider.disposed) return;
      apply(data);
      provider.scanning = false;
      void provider.afterScan?.(generation);
    } finally {
      provider.scanning = false;
      if (!provider.disposed) provider.onStatus?.();
    }
  };
  provider.savePreferences = async (preferences) => {
    const before = provider.preferences;
    const changes = Object.entries(preferences).filter(
      ([f, p]) => JSON.stringify(p) !== JSON.stringify(before[f]),
    );
    await provider.changeIndex(async (data) => {
      const previous = structuredClone(data.preferences);
      // Сначала все правила скрытия: возврат родителя не обходит скрываемого потомка.
      for (const [folder, value] of changes) {
        if (value.hidden !== before[folder]?.hidden)
          data.preferences[folder] = {
            ...data.preferences[folder],
            hidden: value.hidden,
          };
      }
      for (const [folder, value] of changes) {
        const old = previous[folder] || {};
        // Только изменённые поля, чтобы не затереть параллельное скрытие.
        const patch = Object.fromEntries(
          Object.entries(value).filter(([k, v]) => v !== before[folder]?.[k]),
        );
        data.preferences[folder] = { ...old, ...patch };
        if ("project" in patch && !data.created.includes(folder))
          data.created.push(folder);
        if (patch.hidden === true) data.nodes = remove(data.nodes, folder);
        else if (
          (patch.hidden === false && old.hidden === true) ||
          ("relaxed" in patch && patch.relaxed !== !!old.relaxed) ||
          (patch.project === false && old.project === true)
        )
          await rescanBranch(data, folder);
        else if (patch.project === true) {
          const node = find(data.nodes, folder);
          if (node) {
            node.project = true;
            node.placeholder = false;
          }
          if (!data.created.includes(folder)) data.created.push(folder);
        }
      }
    });
  };
  provider.addRoots = (folders) =>
    provider.changeIndex(async (data) => {
      const added = folders.filter((f) => !data.roots.includes(f));
      const result = await scanRoots(added, options(data));
      data.roots.push(...added);
      data.nodes.push(...result.nodes);
    });
  provider.removeRoot = (folder) =>
    provider.changeIndex((data) => {
      data.roots = data.roots.filter((f) => f !== folder);
    });
  provider.addFolder = (folder, project) =>
    provider.changeIndex((data) => {
      if (!data.created.includes(folder)) data.created.push(folder);
      if (project)
        data.preferences[folder] = {
          ...data.preferences[folder],
          project: true,
        };
      if (find(data.nodes, folder)) return;
      insert(data, {
        folder,
        project: !!project,
        empty: true,
        children: [],
        modified: 0,
      });
    });
  provider.removeFolder = (folder) =>
    provider.changeIndex((data) => {
      data.nodes = remove(data.nodes, folder);
    });
  provider.moveFolder = (from, destination) =>
    provider.changeIndex((data) => {
      const node = find(data.nodes, from);
      if (!node)
        throw new Error(
          "Проект отсутствует в индексе; выполните переиндексацию.",
        );
      const moved = structuredClone(node);
      const remap = (f) =>
        within(from, f) ? path.join(destination, path.relative(from, f)) : f;
      const walk = (n) => {
        n.folder = remap(n.folder);
        n.children.forEach(walk);
      };
      walk(moved);
      data.nodes = remove(data.nodes, from);
      data.preferences = Object.fromEntries(
        Object.entries(data.preferences).map(([f, p]) => [remap(f), p]),
      );
      data.created = [...new Set([...data.created.map(remap), destination])];
      data.favorites = data.favorites.map(remap);
      insert(data, moved);
    });
  provider.reorderFavorite = (source, target, after) =>
    provider.changeIndex((data) => {
      if (
        source === target ||
        !data.favorites.includes(source) ||
        !data.favorites.includes(target)
      )
        return;
      const next = data.favorites.filter((folder) => folder !== source);
      next.splice(next.indexOf(target) + (after ? 1 : 0), 0, source);
      data.favorites = next;
    });
  provider.setFavorites = (favorites, before) =>
    provider.changeIndex((data) => {
      const removed = before.filter((f) => !favorites.includes(f));
      const added = favorites.filter((f) => !before.includes(f));
      const next = [
        ...new Set([
          ...data.favorites.filter((f) => !removed.includes(f)),
          ...added,
        ]),
      ];
      data.favorites = next;
    });
}
module.exports = { installIndex };
