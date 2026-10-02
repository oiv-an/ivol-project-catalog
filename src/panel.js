const vscode = require("vscode");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs/promises");

class CatalogPanel {
  constructor(context, model) {
    this.context = context;
    this.model = model;
    this.events = new vscode.EventEmitter();
    this.onDidChangeVisibility = this.events.event;
    this.subscription = model.onDidChangeTreeData(() => this.render());
    this.allowed = new Map();
  }
  get visible() {
    return this.view?.visible || false;
  }
  async reveal() {
    this.render();
  }
  expandFolder(folder) {
    void this.view?.webview.postMessage({ type: "expandFolder", folder });
  }
  async resolveWebviewView(view) {
    this.view = view;
    const root = vscode.Uri.joinPath(this.context.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    console.info(
      "Каталог проектов: создание панели",
      this.context.extension.packageJSON.version,
    );
    let css, js;
    try {
      [css, js] = await Promise.all([
        fs.readFile(vscode.Uri.joinPath(root, "catalog.css").fsPath, "utf8"),
        fs.readFile(vscode.Uri.joinPath(root, "catalog.js").fsPath, "utf8"),
      ]);
    } catch (error) {
      view.webview.html =
        "<html><body>Не удалось загрузить панель каталога. Подробности в журнале Extension Host.</body></html>";
      console.error("Каталог проектов: ресурсы панели", error);
      return;
    }
    const nonce = randomBytes(16).toString("hex");
    const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">${css}</style></head><body>
      <div id="catalogContent">
      <section id="openedBlock" class="block recent"><header><h2>Открытые проекты</h2></header><div id="opened"></div></section>
      <section id="favoritesBlock" class="block favorites"><header><h2>⭐ Избранное</h2><span id="favoritesCount" class="count"></span></header><div id="favorites"></div><p id="favoritesEmpty" class="empty">Нажмите ☆ у проекта, чтобы добавить его сюда.</p></section>
      <nav aria-label="Управление каталогом"><button data-command="addRoot" title="Подключить папку">＋</button><button data-command="refresh" title="Переиндексировать все проекты">↻</button><button data-command="settings" title="Настройки">⚙</button><label><input id="newWindow" type="checkbox">Новое окно</label></nav>
      <button class="new-project" data-command="newProject" type="button" title="Создать папку нового проекта и открыть её в новом окне"><span class="new-project-icon" aria-hidden="true">＋</span>Новый проект</button>
      <div class="catalog-search" role="search" aria-label="Поиск в каталоге"><input id="catalogSearch" type="search" placeholder="Поиск папок и проектов…" aria-label="Поиск папок и проектов по названию" aria-controls="tree opened recent favorites" autocomplete="off" spellcheck="false"><button id="clearSearch" type="button" title="Очистить поиск (Escape)" aria-label="Очистить поиск" hidden>×</button></div>
      <div id="catalogStatus" class="catalog-status" role="status" aria-live="polite" aria-atomic="true"></div>
      <section id="recentBlock" class="block recent"><header><h2>Последние активные проекты</h2></header><div id="recent"></div></section>
      <section id="treeBlock" class="block tree"><header><h2 id="treeTitle">Дерево проектов</h2><button id="treeMode" type="button" title="Показать все проекты по последней активности" aria-label="Показать все проекты по последней активности" aria-pressed="false"><svg class="mode-clock" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6"/><path d="M8 4v4l3 2"/></svg><svg class="mode-folder" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2 4V3h4l2 2h6v8H2V4Z"/></svg></button><button id="treeMenu" type="button" title="Создать каталог первого уровня" aria-label="Создать каталог первого уровня">＋</button></header><div id="tree"></div></section>
      </div>
      <div id="catalogOverlay" class="catalog-overlay" hidden><div class="catalog-busy" role="status" aria-live="polite" aria-atomic="true"><span class="spinner" aria-hidden="true"></span><span id="catalogBusyText">Обновление каталога…</span></div></div>
      <script nonce="${nonce}">${js}</script></body></html>`;
    const subscriptions = [
      view.onDidChangeVisibility(() => {
        this.events.fire({ visible: view.visible });
        this.render();
      }),
      view.webview.onDidReceiveMessage(async (message) => {
        try {
          if (!message || typeof message !== "object") return;
          if (message.type === "ready") {
            console.info(
              "Каталог проектов: интерфейс готов",
              this.context.extension.packageJSON.version,
            );
            return this.render();
          }
          if (message.type === "clientError") {
            console.error(
              "Каталог проектов: ошибка интерфейса",
              String(message.message).slice(0, 1000),
            );
            return;
          }
          if (message.type === "reorderFavorite") {
            const source = this.allowed.get(message.id);
            const target = this.allowed.get(message.targetId);
            if (
              !this.model.scanning &&
              source?.project &&
              target?.project &&
              source.id.startsWith("favorite:") &&
              target.id.startsWith("favorite:") &&
              typeof message.after === "boolean"
            ) {
              await this.model.reorderFavorite(
                source.folder,
                target.folder,
                message.after,
              );
            }
            return this.render();
          }
          if (
            message.type === "move" &&
            typeof message.id === "string" &&
            typeof message.targetId === "string"
          ) {
            const source = this.allowed.get(message.id);
            const target = this.allowed.get(message.targetId);
            if (source?.project && target && !target.project && !target.recent)
              await vscode.commands.executeCommand(
                "ivolCatalog.moveProject",
                source,
                target,
              );
            return this.render();
          }
          if (
            [
              "open",
              "rename",
              "hide",
              "includeFolders",
              "folderMenu",
              "markProject",
              "toggleFavorite",
            ].includes(message.type) &&
            typeof message.id === "string"
          ) {
            const node = this.allowed.get(message.id);
            if (node)
              await vscode.commands.executeCommand(
                `ivolCatalog.${message.type === "open" ? "openFolder" : message.type}`,
                node,
              );
          } else if (
            message.type === "command" &&
            [
              "addRoot",
              "refresh",
              "settings",
              "toggleNewWindow",
              "manageHidden",
              "treeMenu",
              "newProject",
            ].includes(message.command)
          ) {
            await vscode.commands.executeCommand(
              `ivolCatalog.${message.command}`,
            );
          }
          this.render();
        } catch (error) {
          vscode.window.showErrorMessage(`Каталог проектов: ${error.message}`);
        }
      }),
    ];
    view.onDidDispose(() => {
      subscriptions.forEach((s) => s.dispose());
      if (this.view === view) this.view = undefined;
    });
    view.webview.html = html;
    this.render();
  }
  render() {
    if (!this.view) return;
    this.allowed.clear();
    const favorites = new Set(this.model.favorites);
    const convert = (node) => {
      this.allowed.set(node.id, node);
      const windowStatus = node.project
        ? this.model.windowStatus?.(node.folder) || ""
        : "";
      return {
        id: node.id,
        name: this.model.name(node),
        empty: !!node.empty,
        placeholder: !!node.placeholder,
        relaxed: !!this.model.preferences[node.folder]?.relaxed,
        explicitProject: !!this.model.preferences[node.folder]?.project,
        folder: node.folder,
        project: !!node.project,
        favorite: favorites.has(node.folder),
        current: windowStatus === "current",
        opened: windowStatus === "open",
        agent: windowStatus ? this.model.agentStatus?.(node.folder) || "" : "",
        date: node.modified
          ? new Date(node.modified).toLocaleString("ru-RU", {
              day: "2-digit",
              month: "2-digit",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })
          : "",
        count: node.project ? null : this.model.countProjects(node),
        children: node.children.map(convert),
      };
    };
    const rows = this.model.getChildren();
    void this.view.webview.postMessage({
      type: "state",
      current: this.model.currentFolder,
      scanning: this.model.scanning,
      initialized:
        this.model.initialized &&
        this.model.scannedRoots === JSON.stringify(this.model.roots),
      scanError: this.model.scanError,
      rootCount: this.model.roots.length,
      favorites: this.model.favoriteProjects.map(convert),
      favoritesCount: favorites.size,
      opened: (this.model.roots.length
        ? this.model.openProjects || []
        : []
      ).map(convert),
      recent: (this.model.roots.length ? this.model.topProjects || [] : []).map(
        convert,
      ),
      tree: rows.filter((n) => !n.section && !n.recent).map(convert),
      allProjects: (this.model.roots.length
        ? this.model.allProjects || []
        : []
      ).map((node) => ({
        ...convert(node),
        activityDate: node.activity
          ? new Date(node.activity).toLocaleString("ru-RU", {
              day: "2-digit",
              month: "2-digit",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })
          : "",
      })),
      newWindow: this.context.globalState.get("catalog.newWindow", true),
      hasRoots: this.model.roots.length > 0,
    });
  }
  dispose() {
    this.subscription.dispose();
    this.events.dispose();
  }
}
module.exports = { CatalogPanel };
