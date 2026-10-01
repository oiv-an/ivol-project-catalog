const vscode = require("vscode");
const fs = require("node:fs/promises");
const path = require("node:path");
const { realpathSync } = require("node:fs");
const { DEFAULT_EXCLUDES } = require("./scanner");
const {
  ActivityStore,
  closestProject,
  sortByActivity,
  recentProjects,
} = require("./activity");
const { openSettings } = require("./settings");
const { CatalogPanel } = require("./panel");
const { WindowStore } = require("./windows");
const { installIndex } = require("./catalog-index");

const ROOTS_KEY = "catalog.roots";
const WINDOW_KEY = "catalog.newWindow";
const CREATED_KEY = "catalog.createdFolders";
const PREFS_KEY = "catalog.folderPreferences";
const FAVORITES_KEY = "catalog.favorites";

class ProjectTree {
  constructor(context) {
    this.context = context;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    this.nodes = [];
    this.generation = 0;
    this.scanning = false;
    this.initialized = false;
    this.scannedRoots = "";
    this.scanError = "";
    this.status = "";
    this.disposed = false;
  }

  get roots() {
    return (
      this.sharedIndex?.roots || this.context.globalState.get(ROOTS_KEY, [])
    );
  }

  get createdFolders() {
    const saved =
      this.sharedIndex?.created ||
      this.context.globalState.get(CREATED_KEY, []);
    return Array.isArray(saved)
      ? saved.filter(
          (folder) => typeof folder === "string" && path.isAbsolute(folder),
        )
      : [];
  }

  get favorites() {
    const saved =
      this.sharedIndex?.favorites ||
      this.context.globalState.get(FAVORITES_KEY, []);
    return Array.isArray(saved)
      ? [
          ...new Set(
            saved.filter(
              (folder) => typeof folder === "string" && path.isAbsolute(folder),
            ),
          ),
        ]
      : [];
  }

  get favoriteProjects() {
    if (!this.roots.length) return [];
    const projects = new Map();
    const visit = (nodes) => {
      for (const node of nodes) {
        if (node.project) projects.set(node.folder, node);
        visit(node.children);
      }
    };
    visit(this.nodes);
    return this.favorites.flatMap((folder) => {
      const node = projects.get(folder);
      return node ? [{ ...node, id: `favorite:${folder}`, children: [] }] : [];
    });
  }

  get preferences() {
    if (this.sharedIndex) return this.sharedIndex.preferences;
    const clean = (value) =>
      value && typeof value === "object" && !Array.isArray(value) ? value : {};
    // Старые значения из настроек + globalState (не зависит от реестра настроек).
    let legacy = {};
    try {
      legacy = clean(
        vscode.workspace
          .getConfiguration("ivolCatalog")
          .get("folderPreferences", {}),
      );
    } catch {}
    const stored = {
      ...legacy,
      ...clean(this.context.globalState.get(PREFS_KEY, {})),
    };
    return Object.fromEntries(
      Object.entries(stored)
        .filter(
          ([folder, value]) =>
            path.isAbsolute(folder) &&
            value &&
            typeof value === "object" &&
            !Array.isArray(value),
        )
        .map(([folder, value]) => [
          folder,
          {
            name:
              typeof value.name === "string" ? value.name.slice(0, 120) : "",
            hidden: value.hidden === true,
            relaxed: value.relaxed === true,
            project: value.project === true,
          },
        ]),
    );
  }

  name(node) {
    return (
      this.preferences[node.folder]?.name ||
      path.basename(node.folder) ||
      node.folder
    );
  }

  async setPreference(folder, patch) {
    const preferences = { ...this.preferences };
    preferences[folder] = { ...preferences[folder], ...patch };
    await this.savePreferences(preferences);
  }

  countProjects(node) {
    const paths = new Set();
    const visit = (current) => {
      if (current.project) paths.add(current.folder);
      for (const child of current.children) visit(child);
    };
    visit(node);
    return paths.size;
  }

  getTreeItem(node) {
    if (node.section) {
      const heading = new vscode.TreeItem(
        node.label,
        vscode.TreeItemCollapsibleState.None,
      );
      heading.id = node.id;
      heading.contextValue = "catalogSection";
      heading.iconPath = new vscode.ThemeIcon(
        node.section === "recent" ? "history" : "list-tree",
      );
      heading.accessibilityInformation = { label: node.label, role: "heading" };
      return heading;
    }
    const item = new vscode.TreeItem(
      this.name(node),
      node.children.length
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = node.id;
    item.resourceUri = vscode.Uri.file(node.folder);
    item.iconPath = new vscode.ThemeIcon(node.project ? "project" : "folder");
    const time = node.modified;
    const date = time
      ? new Date(time).toLocaleString("ru-RU")
      : "нет данных об активности";
    const shortDate = time
      ? new Date(time).toLocaleString("ru-RU", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";
    item.description = [
      node.project && node.folder === this.currentFolder ? "Текущий" : "",
      !node.project ? `(${this.countProjects(node)})` : "",
      shortDate,
    ]
      .filter(Boolean)
      .join(" · ");
    item.tooltip = `${node.folder}\nПоследнее изменение файлов: ${date}`;
    item.contextValue = node.root
      ? "catalogRoot"
      : node.project
        ? "catalogProject"
        : "catalogGroup";
    if (node.project) {
      item.command = {
        command: "ivolCatalog.openFolder",
        title: "Открыть проект",
        arguments: [node],
      };
    }
    return item;
  }

  getChildren(node) {
    if (node) return node.children;
    const contents = this.nodes.flatMap((root) => root.children);
    const groups = [
      ...new Map(contents.map((child) => [child.folder, child])).values(),
    ].sort(
      (a, b) =>
        (b.activity || b.modified) - (a.activity || a.modified) ||
        a.folder.localeCompare(b.folder),
    );
    if (!this.roots.length) return [];
    return [
      {
        id: "section:recent",
        section: "recent",
        label: "Последние активные проекты",
        children: [],
      },
      ...(this.topProjects || []),
      {
        id: "section:tree",
        section: "tree",
        label: "Дерево проектов",
        children: [],
      },
      ...groups,
    ];
  }

  getParent(node) {
    if (node.recent || node.section) return undefined;
    const find = (nodes) => {
      for (const parent of nodes) {
        if (parent.children.some((child) => child.id === node.id))
          return parent;
        const match = find(parent.children);
        if (match) return match;
      }
    };
    const parent = find(this.nodes);
    return parent?.root ? undefined : parent;
  }

  dispose() {
    this.disposed = true;
    this.generation++;
    this.changed.dispose();
  }
}

async function activate(context) {
  const provider = new ProjectTree(context);
  installIndex(provider, context, vscode);
  const view = new CatalogPanel(context, provider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("ivolCatalog.panel", view),
  );
  context.subscriptions.push(provider, view);
  const output = vscode.window.createOutputChannel("Каталог проектов");
  context.subscriptions.push(output);
  provider.log = (message) => {
    if (!provider.disposed) output.appendLine(message);
  };
  const activity = new ActivityStore(
    path.join(context.globalStorageUri.fsPath, "activity"),
  );
  const windows = new WindowStore(
    path.join(context.globalStorageUri.fsPath, "windows"),
  );
  context.subscriptions.push(windows);
  let selectedProject;
  let lastWorkspace;
  const canonicalPath = (file) => {
    try {
      return realpathSync.native(file);
    } catch {
      return file;
    }
  };
  const windowState = () => {
    const folders = (vscode.workspace.workspaceFolders || []).filter(
      (folder) => folder.uri.scheme === "file" && !vscode.env.remoteName,
    );
    const workspace = vscode.workspace.workspaceFile;
    const target = workspace || folders[0]?.uri;
    return {
      target: target?.toString() || "",
      folders: [
        ...new Set(
          folders.flatMap((folder) => {
            const canonical = canonicalPath(folder.uri.fsPath);
            const project = closestProject(provider.nodes, canonical);
            return project ? [canonical, project.folder] : [canonical];
          }),
        ),
      ],
    };
  };
  provider.windowStatus = (folder) => {
    const entry = windows.find(folder);
    if (entry?.id === windows.id) return "current";
    return entry ? "open" : "";
  };
  const currentProject = () => {
    const editor = vscode.window.activeTextEditor?.document.uri;
    const folders = vscode.workspace.workspaceFolders || [];
    const workspace = editor
      ? vscode.workspace.getWorkspaceFolder(editor)
      : undefined;
    if (workspace) lastWorkspace = workspace.uri.fsPath;
    // Фокус панели/настроек не должен переключать multi-root на первую папку.
    const uri =
      workspace?.uri ||
      folders.find((folder) => folder.uri.fsPath === lastWorkspace)?.uri ||
      folders[0]?.uri;
    if (uri?.scheme !== "file") return undefined;
    // Корни сканера уже realpath; workspace может иметь другое написание/ссылку.
    return (
      (editor?.scheme === "file" && workspace
        ? closestProject(provider.nodes, canonicalPath(editor.fsPath))
        : undefined) ||
      closestProject(provider.nodes, canonicalPath(uri.fsPath))
    );
  };
  const redraw = () => {
    if (provider.disposed) return;
    sortByActivity(provider.nodes, activity.times);
    const current = currentProject();
    provider.currentFolder = current?.folder;
    const times = { ...activity.times };
    if (current)
      times[current.folder] = Math.max(Date.now(), times[current.folder] || 0);
    const limit = vscode.workspace
      .getConfiguration("ivolCatalog")
      .get("recentLimit", 7);
    const favorites = new Set(provider.favorites);
    provider.topProjects = recentProjects(
      provider.nodes,
      times,
      limit,
      favorites,
    );
    if (current && !favorites.has(current.folder)) {
      const active = {
        ...current,
        root: false,
        children: [],
        recent: true,
        id: `recent:${current.folder}`,
      };
      provider.topProjects = [
        active,
        ...provider.topProjects.filter(
          (node) => node.folder !== current.folder,
        ),
      ].slice(0, limit);
    }
    provider.changed.fire();
    if (current && view.visible && selectedProject !== current.folder) {
      selectedProject = current.folder;
      void view
        .reveal(
          favorites.has(current.folder)
            ? provider.favoriteProjects.find(
                (node) => node.folder === current.folder,
              )
            : provider.topProjects[0],
          {
            select: true,
            focus: false,
            expand: false,
          },
        )
        .catch((error) => {
          selectedProject = undefined;
          output.appendLine(
            `Не удалось выделить текущий проект: ${error.message}`,
          );
        });
    }
  };
  context.subscriptions.push(
    view.onDidChangeVisibility((event) => {
      if (event.visible) redraw();
    }),
  );
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => redraw()),
  );
  const report = (error) => console.warn("Каталог проектов: активность", error);
  const record = async (file, time = Date.now()) => {
    const project = closestProject(provider.nodes, file);
    if (!project) return;
    const excluded = vscode.workspace
      .getConfiguration("ivolCatalog")
      .get("excludedDirectories", DEFAULT_EXCLUDES);
    if (
      path
        .relative(project.folder, file)
        .split(path.sep)
        .some((part) =>
          excluded.some((name) => name.toLowerCase() === part.toLowerCase()),
        )
    )
      return;
    const saving = activity.touch(project.folder, time);
    redraw();
    await saving;
  };
  const pending = new Map();
  const remember = (uri, time = Date.now()) => {
    if (uri?.scheme !== "file") return;
    if (provider.scanning || !provider.nodes.length)
      pending.set(uri.fsPath, time);
    void record(uri.fsPath, time).catch(report);
  };
  for (const folder of vscode.workspace.workspaceFolders || [])
    remember(folder.uri);
  const initialEditor = vscode.window.activeTextEditor;
  if (initialEditor) remember(initialEditor.document.uri);
  provider.afterScan = async (generation) => {
    const started = Date.now();
    const valid = () =>
      !provider.disposed && generation === provider.generation;
    try {
      redraw();
      const timed = async (label, work) => {
        const start = Date.now();
        try {
          await work();
        } finally {
          provider.log(`${label}: ${Date.now() - start} мс`);
        }
      };
      const results = await Promise.allSettled([
        timed("Синхронизация активности", () => activity.sync()),
        timed("Синхронизация окон", () => windows.sync(windowState())),
      ]);
      for (const result of results)
        if (result.status === "rejected") {
          report(result.reason);
          provider.log(
            `Ошибка фоновой синхронизации: ${result.reason?.message || result.reason}`,
          );
        }
      if (!valid()) return;
      // Удаляем только записанное событие: новое событие/сканирование
      // во время await не должно потерять свою запись в pending.
      for (const [file, time] of [...pending]) {
        if (!valid()) return;
        await record(file, time);
        if (pending.get(file) === time) pending.delete(file);
      }
      if (valid()) redraw();
    } catch (error) {
      report(error);
      provider.log(`Ошибка обновления активности: ${error.message}`);
    } finally {
      provider.log(
        `Фоновое обновление после сканирования: ${Date.now() - started} мс`,
      );
    }
  };
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) =>
      remember(document.uri),
    ),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const folder of event.added) remember(folder.uri);
      selectedProject = undefined;
      void windows
        .sync(windowState())
        .then(() => redraw())
        .catch(report);
      redraw();
    }),
  );
  let syncing = false;
  const syncTimer = setInterval(async () => {
    if (syncing || provider.disposed) return;
    syncing = true;
    try {
      const indexChanged = await provider.syncIndex();
      const activityChanged = await activity.sync();
      const windowsChanged = await windows.sync(windowState());
      if (indexChanged || activityChanged || windowsChanged) redraw();
    } catch (error) {
      report(error);
    } finally {
      syncing = false;
    }
  }, 2000);
  context.subscriptions.push({ dispose: () => clearInterval(syncTimer) });

  const newWindow = () => context.globalState.get(WINDOW_KEY, true);
  const updateMessage = () => {
    view.render();
    if (provider.status) output.appendLine(provider.status);
  };
  provider.onStatus = updateMessage;
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      // Настройки сканера применяются при следующем обновлении по кнопке.
      // Лимит последних проектов можно применить без обхода диска.
      if (event.affectsConfiguration("ivolCatalog")) redraw();
    }),
  );
  const updateMode = async () => {
    await vscode.commands.executeCommand(
      "setContext",
      "ivolCatalog.newWindow",
      newWindow(),
    );
    updateMessage();
  };
  const updateRoots = async () => {
    await vscode.commands.executeCommand(
      "setContext",
      "ivolCatalog.hasRoots",
      provider.roots.length > 0,
    );
    void provider.refresh();
  };

  // Единая обработка ошибок команд, включая сбои сохранения настроек.
  const register = (name, handler) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(name, async (...args) => {
        try {
          await handler(...args);
        } catch (error) {
          vscode.window.showErrorMessage(`Каталог проектов: ${error.message}`);
        }
      }),
    );
  };

  register("ivolCatalog.addRoot", async () => {
    const selected = await vscode.window.showOpenDialog({
      title: "Выберите папку с проектами",
      openLabel: "Подключить папку",
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: true,
    });
    if (!selected || selected.length === 0) return;
    if (selected.some((uri) => uri.scheme !== "file")) {
      throw new Error("В первой версии поддерживаются только локальные папки.");
    }
    const added = await Promise.all(
      selected.map((uri) => fs.realpath(uri.fsPath)),
    );
    await provider.addRoots(added);
  });

  register("ivolCatalog.removeRoot", async (node) => {
    if (!node || !node.root) return;
    await provider.removeRoot(node.folder);
  });

  const findNode = (folder) => {
    const walk = (nodes) => {
      for (const node of nodes) {
        if (node.folder === folder) return node;
        const match = walk(node.children);
        if (match) return match;
      }
    };
    return walk(provider.nodes);
  };
  let moving = false;
  let updatingFavorites = false;
  register("ivolCatalog.toggleFavorite", async (input) => {
    if (moving || updatingFavorites || provider.scanning) return;
    const node = findNode(input?.folder);
    if (!node?.project) return;
    updatingFavorites = true;
    try {
      const beforeFavorites = provider.favorites;
      let favorites = [...beforeFavorites];
      if (favorites.includes(node.folder)) {
        favorites = favorites.filter((folder) => folder !== node.folder);
      } else {
        favorites.push(node.folder);
      }
      await provider.setFavorites(favorites, beforeFavorites);
      redraw();
    } finally {
      updatingFavorites = false;
    }
  });
  register("ivolCatalog.trashFolder", async (input) => {
    if (moving) return;
    moving = true;
    let trashed = false;
    try {
      const folder = input?.folder;
      const within = (base, file) => {
        const relative = path.relative(base, file);
        return (
          relative === "" ||
          (!path.isAbsolute(relative) &&
            relative !== ".." &&
            !relative.startsWith(".." + path.sep))
        );
      };
      const validate = async () => {
        const node = typeof folder === "string" ? findNode(folder) : undefined;
        if (
          !node ||
          node.root ||
          !path.isAbsolute(folder) ||
          !provider.roots.some((root) => within(root, folder)) ||
          provider.roots.some((root) => within(folder, root))
        )
          throw new Error(
            "Нельзя удалить корень каталога или папку вне видимого дерева.",
          );
        const info = await fs.lstat(folder);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          (await fs.realpath(folder)) !== folder
        )
          throw new Error("Папка недоступна или путь изменился.");
        if (
          vscode.workspace.textDocuments.some(
            (doc) =>
              doc.isDirty &&
              doc.uri.scheme === "file" &&
              within(folder, doc.uri.fsPath),
          )
        )
          throw new Error("Сначала сохраните несохранённые файлы этой папки.");
        return info;
      };
      const before = await validate();
      const choice = await vscode.window.showWarningMessage(
        "Переместить папку со всем содержимым в корзину?",
        {
          modal: true,
          detail: `${folder}\n\nСохраните файлы и остановите процессы во всех окнах. Файлы и процессы других окон проверить невозможно. Открытые окна автоматически не закрываются. При недоступной корзине удаление будет отменено.`,
        },
        "В корзину",
      );
      if (choice !== "В корзину") return;
      const after = await validate();
      if (before.dev !== after.dev || before.ino !== after.ino)
        throw new Error(
          "Папка была заменена во время подтверждения. Повторите действие.",
        );
      await vscode.workspace.fs.delete(vscode.Uri.file(folder), {
        recursive: true,
        useTrash: true,
      });
      trashed = true;
      await provider.removeFolder(folder);
      vscode.window.showInformationMessage(
        `Папка перемещена в корзину: ${folder}`,
      );
    } catch (error) {
      if (trashed)
        throw new Error(
          `Папка уже в корзине, но каталог не обновлён: ${error.message}`,
        );
      throw error;
    } finally {
      moving = false;
    }
  });
  register("ivolCatalog.moveProject", async (input, targetInput) => {
    if (moving || updatingFavorites) return;
    moving = true;
    let destination;
    let moved = false;
    try {
      const source = findNode(input?.folder);
      const target = findNode(targetInput?.folder);
      if (
        !source?.project ||
        source.root ||
        !target ||
        target.root ||
        target.project
      )
        throw new Error(
          "Переносите проект на каталог дерева, не на другой проект.",
        );
      const from = source.folder;
      const within = (base, file) => {
        const relative = path.relative(base, file);
        return (
          relative === "" ||
          (!relative.startsWith(".." + path.sep) &&
            relative !== ".." &&
            !path.isAbsolute(relative))
        );
      };
      destination = path.join(target.folder, path.basename(from));
      if (within(from, target.folder) || destination === from)
        throw new Error(
          "Нельзя переносить проект в себя, свои подпапки или в прежний каталог.",
        );
      if (provider.roots.some((root) => within(from, root)))
        throw new Error(
          "Проект содержит подключённый корень каталога; сначала отключите этот корень.",
        );
      const validate = async () => {
        if (
          !findNode(from)?.project ||
          findNode(target.folder)?.project ||
          !findNode(target.folder)
        )
          throw new Error("Дерево изменилось. Повторите перенос.");
        for (const folder of [from, target.folder]) {
          if (
            (await fs.realpath(folder)) !== folder ||
            !(await fs.lstat(folder)).isDirectory()
          )
            throw new Error(
              "Путь изменился или является символической ссылкой.",
            );
        }
        if ((await fs.stat(from)).dev !== (await fs.stat(target.folder)).dev)
          throw new Error(
            "Перенос между разными дисками не поддерживается. Используйте файловый менеджер.",
          );
        try {
          await fs.lstat(destination);
          throw new Error(
            `Папка уже существует: ${destination}. Перезапись запрещена.`,
          );
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (
          vscode.workspace.textDocuments.some(
            (doc) =>
              doc.isDirty &&
              doc.uri.scheme === "file" &&
              within(from, doc.uri.fsPath),
          )
        )
          throw new Error("Сначала сохраните несохранённые файлы проекта.");
      };
      await validate();
      const choice = await vscode.window.showWarningMessage(
        "Переместить папку проекта на диске?",
        {
          modal: true,
          detail: `Откуда: ${from}\nКуда: ${destination}\n\nСохраните файлы и остановите процессы проекта во всех окнах. Открытые окна останутся на старом пути — после переноса откройте проект из каталога заново. Окна автоматически не закрываются.`,
        },
        "Переместить",
      );
      if (choice !== "Переместить") return;
      await validate();
      await vscode.workspace.fs.rename(
        vscode.Uri.file(from),
        vscode.Uri.file(destination),
        { overwrite: false },
      );
      moved = true;
      const remap = (folder) =>
        within(from, folder)
          ? path.join(destination, path.relative(from, folder))
          : folder;
      await provider.moveFolder(from, destination);
      await activity.sync();
      for (const [folder, time] of Object.entries(activity.times))
        if (within(from, folder)) await activity.touch(remap(folder), time);
      await activity.touch(destination);
      view.expandFolder(target.folder);
      vscode.window.showInformationMessage(
        `Проект перенесён: ${destination}. Откройте его из каталога по новому пути.`,
      );
    } catch (error) {
      if (moved) {
        await provider.refresh();
        throw new Error(
          `Папка уже перенесена в ${destination}, но обновление каталога завершилось ошибкой: ${error.message}. Повторно переносить её не нужно.`,
        );
      }
      throw error;
    } finally {
      moving = false;
    }
  });
  const badFolderName = (text) => {
    const excluded = [
      ...vscode.workspace
        .getConfiguration("ivolCatalog")
        .get("excludedDirectories", DEFAULT_EXCLUDES),
      ".vscode",
      ".idea",
      ".fleet",
      ".zed",
      ".settings",
    ];
    return (
      !text ||
      text === "." ||
      text === ".." ||
      /[/\\\x00-\x1f]/.test(text) ||
      text.length > 120 ||
      excluded.some((entry) => entry.toLowerCase() === text.toLowerCase())
    );
  };
  const insideRoots = (folder) =>
    provider.roots.some(
      (root) => folder === root || folder.startsWith(root + path.sep),
    );
  const createFolder = async (parent, options = {}) => {
    if (
      !parent ||
      (!options.anyParent &&
        !provider.roots.some(
          (root) =>
            parent === root ||
            (parent.startsWith(root + path.sep) && findNode(parent)),
        ))
    )
      throw new Error("Папка не принадлежит видимому дереву каталога.");
    // Не разрешаем подменять подключённый путь символической ссылкой.
    const actual = await fs.realpath(parent);
    if (actual !== parent || !(await fs.stat(parent)).isDirectory())
      throw new Error("Папка-родитель недоступна или является ссылкой.");
    const name =
      options.name ??
      (await vscode.window.showInputBox({
        title: options.title || `Создать папку внутри ${parent}`,
        prompt: options.prompt,
        placeHolder: options.placeHolder || "Название новой папки",
        validateInput: (value) =>
          badFolderName(value.trim())
            ? "Укажите одно имя до 120 символов, без / и запрещённых имён"
            : undefined,
      }));
    if (name === undefined) return;
    const text = name.trim();
    if (badFolderName(text)) throw new Error("Недопустимое имя папки.");
    // Повторно проверяем родителя после ввода, до записи на диск.
    if (
      (await fs.realpath(parent)) !== parent ||
      !(await fs.stat(parent)).isDirectory()
    )
      throw new Error("Папка-родитель изменилась.");
    let folder = path.join(parent, text);
    if (folder === parent || path.dirname(folder) !== parent)
      throw new Error("Некорректное имя папки.");
    try {
      await fs.mkdir(folder); // Без recursive: существующий файл/папка не перезаписывается.
    } catch (error) {
      // Категория могла существовать на диске, но не показываться (пустая).
      if (error.code !== "EEXIST" || !options.reuseExisting) throw error;
      const info = await fs.lstat(folder);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(`«${text}» уже существует и не является папкой.`);
      folder = await fs.realpath(folder);
      if (path.dirname(folder) !== parent)
        throw new Error("Папка-категория указывает за пределы родителя.");
    }
    if (insideRoots(folder)) {
      try {
        await provider.addFolder(folder, options.project);
      } catch (error) {
        throw new Error(
          `Папка создана на диске (${folder}), но не удалось сохранить её в каталоге: ${error.message}`,
        );
      }
      view.expandFolder?.(parent);
    }
    return folder;
  };
  // Пошаговый выбор: показываем только один уровень групп, внутрь — по нажатию.
  const pickProjectParent = () =>
    new Promise((resolve) => {
      const quick = vscode.window.createQuickPick();
      quick.title = "Новый проект: где создать?";
      quick.matchOnDescription = true;
      const stack = [];
      const groups = (nodes) =>
        [
          ...new Map(
            nodes
              .filter((node) => !node.project)
              .map((node) => [node.folder, node]),
          ).values(),
        ].sort((a, b) =>
          provider.name(a).localeCompare(provider.name(b), "ru"),
        );
      const createHere = {
        iconPath: new vscode.ThemeIcon("new-folder"),
        tooltip: "Создать проект прямо в этой папке",
      };
      let finished = false;
      const done = (value) => {
        if (finished) return;
        finished = true;
        resolve(value);
        quick.dispose();
      };
      const show = () => {
        const current = stack[stack.length - 1];
        const items = [];
        if (current) {
          items.push(
            {
              label: `$(check) Создать здесь: ${provider.name(current)}`,
              description: current.folder,
              action: "here",
              folder: current.folder,
              alwaysShow: true,
            },
            { label: "$(arrow-left) Назад", action: "back", alwaysShow: true },
          );
        } else {
          items.push({
            label: "$(new-folder) Создать каталог первого уровня…",
            action: "category",
            alwaysShow: true,
          });
          items.push({
            label: "$(folder-opened) Выбрать другую папку на диске…",
            action: "browse",
            alwaysShow: true,
          });
        }
        const children = groups(
          current
            ? current.children
            : provider.nodes.flatMap((root) => root.children),
        );
        if (children.length)
          items.push({
            label: "Папки",
            kind: vscode.QuickPickItemKind.Separator,
          });
        for (const node of children) {
          const inner = groups(node.children).length;
          items.push({
            label: `$(folder) ${provider.name(node)}`,
            description: inner ? `${inner} ›` : "создать здесь",
            action: inner ? "enter" : "here",
            folder: node.folder,
            node,
            buttons: inner ? [createHere] : [],
          });
        }
        quick.buttons = current ? [vscode.QuickInputButtons.Back] : [];
        quick.placeholder = current
          ? `${current.folder} — выберите подпапку или «Создать здесь»`
          : "Поиск существующего каталога; новый каталог — отдельным пунктом";
        quick.value = "";
        quick.items = items;
      };
      const back = () => {
        stack.pop();
        show();
      };
      quick.onDidAccept(() => {
        const item = quick.selectedItems[0];
        if (!item) return;
        if (item.action === "back") return back();
        if (item.action === "enter") {
          stack.push(item.node);
          return show();
        }
        done({ action: item.action, folder: item.folder });
      });
      quick.onDidTriggerButton(() => back());
      quick.onDidTriggerItemButton(({ item }) =>
        done({ action: "here", folder: item.folder }),
      );
      quick.onDidHide(() => done(undefined));
      show();
      quick.show();
    });
  const createProject = async (parent, anyParent = false) => {
    if (provider.roots.includes(parent))
      throw new Error(
        "Выберите каталог внутри корня. На первом уровне создаются только каталоги, не проекты.",
      );
    const folder = await createFolder(parent, {
      anyParent,
      project: true,
      title: `Новый проект в ${parent}`,
      placeHolder: "Название проекта (папки)",
    });
    if (!folder) return;
    await vscode.commands.executeCommand(
      "vscode.openFolder",
      vscode.Uri.file(folder),
      { forceNewWindow: true },
    );
  };
  const setProjectMode = async (input, explicit) => {
    const node = findNode(input?.folder);
    if (!node || node.root || provider.roots.includes(node.folder)) return;
    const info = await fs.lstat(node.folder);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await fs.realpath(node.folder)) !== node.folder
    )
      throw new Error("Папка недоступна или является ссылкой.");
    await provider.setPreference(node.folder, { project: explicit });
  };
  register("ivolCatalog.markProject", (input) => setProjectMode(input, true));
  register("ivolCatalog.autoProject", (input) => setProjectMode(input, false));
  // Правый клик по строке дерева: webview/context передаёт data-vscode-context.
  register("ivolCatalog.newProjectHere", async (input) => {
    const node = findNode(input?.folder);
    if (!node || node.root) return;
    await createProject(node.folder);
  });
  register("ivolCatalog.newProject", async () => {
    const choice = await pickProjectParent();
    if (!choice) return;
    if (choice.action === "category")
      return vscode.commands.executeCommand("ivolCatalog.treeMenu");
    let parent = choice.folder;
    if (choice.action === "browse") {
      const selected = await vscode.window.showOpenDialog({
        title: "Папка, в которой создать новый проект",
        openLabel: "Создать здесь",
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        defaultUri: provider.roots[0]
          ? vscode.Uri.file(provider.roots[0])
          : undefined,
      });
      if (!selected?.[0]) return;
      if (selected[0].scheme !== "file")
        throw new Error("Поддерживаются только локальные папки.");
      parent = await fs.realpath(selected[0].fsPath);
    }
    await createProject(parent, choice.action === "browse");
  });
  register("ivolCatalog.folderMenu", async (input) => {
    const node = findNode(input?.folder);
    if (!node || node.root || input?.recent) return;
    const choices = [
      { label: "$(new-folder) Создать новую папку", value: "create" },
    ];
    if (!node.project)
      choices.push({
        label: "$(refresh) Добавить пропущенные папки",
        value: "include",
        description: "Показать существующие подпапки, включая пустые",
      });
    const choice = await vscode.window.showQuickPick(choices, {
      title: `Папка: ${provider.name(node)}`,
    });
    if (choice?.value === "create") await createFolder(node.folder);
    if (choice?.value === "include")
      await vscode.commands.executeCommand("ivolCatalog.includeFolders", node);
  });
  register("ivolCatalog.treeMenu", async () => {
    // Верхний плюс создаёт только каталог, без запуска создания проекта.
    const roots = provider.roots;
    if (!roots.length)
      return vscode.window.showInformationMessage(
        "Сначала подключите корневую папку.",
      );
    const selected =
      roots.length === 1
        ? roots[0]
        : (
            await vscode.window.showQuickPick(
              roots.map((folder) => ({
                label: path.basename(folder),
                description: folder,
                folder,
              })),
              { title: "Выберите корневую папку" },
            )
          )?.folder;
    if (selected)
      await createFolder(selected, {
        title: "Создать каталог первого уровня",
        placeHolder: "Название каталога, например JOB",
        prompt: `Каталог будет создан внутри ${selected}. Проекты добавляются в него отдельно.`,
      });
  });
  register("ivolCatalog.rename", async (input) => {
    const node = findNode(input?.folder);
    if (!node) return;
    const value = await vscode.window.showInputBox({
      title: "Название в каталоге — папка на диске не изменится",
      prompt: "Очистите поле, чтобы вернуть исходное название",
      value: provider.name(node),
      validateInput: (value) =>
        value.length > 120 || /[\r\n\x00-\x1f]/.test(value)
          ? "Не более 120 символов, без переносов строк"
          : undefined,
    });
    if (value !== undefined)
      await provider.setPreference(node.folder, { name: value.trim() });
  });
  register("ivolCatalog.includeFolders", async (input) => {
    const node = findNode(input?.folder);
    if (!node || node.project) return;
    await provider.setPreference(node.folder, { relaxed: true });
    view.expandFolder?.(node.folder);
  });
  register("ivolCatalog.hide", async (input) => {
    const node = findNode(input?.folder);
    if (!node || node.root) return;
    const choice = await vscode.window.showWarningMessage(
      "Точно скрыть папку?",
      {
        modal: true,
        detail: `${provider.name(node)}\n${node.folder}\n\nПапка и её вложенные проекты исчезнут из каталога. Файлы останутся на диске. Вернуть папку можно в настройках → «Скрыть / вернуть папки».`,
      },
      "Скрыть",
    );
    if (choice !== "Скрыть") return;
    const current = findNode(node.folder);
    if (!current || current.root) return;
    await provider.setPreference(current.folder, { hidden: true });
  });
  register("ivolCatalog.manageHidden", async () => {
    const folders = new Map();
    const walk = (nodes) => {
      for (const node of nodes) {
        if (!node.root) folders.set(node.folder, provider.name(node));
        walk(node.children);
      }
    };
    walk(provider.nodes);
    for (const [folder, value] of Object.entries(provider.preferences)) {
      if (value.hidden)
        folders.set(folder, value.name || path.basename(folder));
    }
    const items = [...folders].map(([folder, label]) => ({
      label,
      description: folder,
      folder,
      picked: !!provider.preferences[folder]?.hidden,
    }));
    const selected = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: "Скрытые папки",
      matchOnDescription: true,
      placeHolder:
        "Отмеченные папки скрыты. Снимите галочку, чтобы вернуть папку. Скрытие группы скрывает всю ветку.",
    });
    if (!selected) return;
    const hidden = new Set(selected.map((item) => item.folder));
    const preferences = { ...provider.preferences };
    for (const item of items)
      preferences[item.folder] = {
        ...preferences[item.folder],
        hidden: hidden.has(item.folder),
      };
    await provider.savePreferences(preferences);
  });

  register("ivolCatalog.settings", () => openSettings(context, provider));
  register("ivolCatalog.refresh", () => provider.refresh(true));
  register("ivolCatalog.toggleNewWindow", async () => {
    await context.globalState.update(WINDOW_KEY, !newWindow());
    await updateMode();
  });

  register("ivolCatalog.openFolder", async (node) => {
    if (!node || typeof node.folder !== "string") return;
    const info = await fs.stat(node.folder);
    if (!info.isDirectory())
      throw new Error("Выбранный путь больше не является папкой.");
    if (node.project) await record(node.folder).catch(report);
    // Освежаем реестр непосредственно перед кликом: окно могло закрыться.
    await windows.sync(windowState()).catch(report);
    const opened = windows.find(canonicalPath(node.folder));
    if (opened?.id === windows.id) return;
    if (opened) {
      const target = vscode.Uri.parse(opened.target);
      if (target.scheme !== "file") {
        vscode.window.showInformationMessage(
          "Проект открыт в несохранённой рабочей области. Сохраните её в файл для переключения из каталога.",
        );
        return;
      }
      // VS Code сначала ищет точное совпадение папки/workspace и фокусирует
      // существующее окно. forceNewWindow защищает исходное окно при гонке закрытия.
      await vscode.commands.executeCommand("vscode.openFolder", target, {
        forceNewWindow: true,
      });
      return;
    }
    await vscode.commands.executeCommand(
      "vscode.openFolder",
      vscode.Uri.file(node.folder),
      {
        forceNewWindow: node.recent || newWindow(),
        forceReuseWindow: !node.recent && !newWindow(),
      },
    );
  });

  await updateMode();
  await updateRoots();

  // Показываем панель один раз, в том числе после обновления с версии 0.1.0.
  // Не меняем глобальные настройки интерфейса и не крадём фокус каждый запуск.
  const welcomeKey = "catalog.webviewReveal.v2";
  if (!context.globalState.get(welcomeKey, false)) {
    // Завершаем activate до focus: webview ждёт окончания активации.
    const timer = setTimeout(() => {
      if (provider.disposed) return;
      void vscode.commands
        .executeCommand("ivolCatalog.panel.focus")
        .then(async () => {
          if (view.visible) await context.globalState.update(welcomeKey, true);
        })
        .catch((error) =>
          output.appendLine(`Не удалось показать панель: ${error.message}`),
        );
    }, 0);
    context.subscriptions.push({ dispose: () => clearTimeout(timer) });
  }
}

module.exports = { activate };
