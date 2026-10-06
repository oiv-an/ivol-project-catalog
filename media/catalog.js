const api = acquireVsCodeApi();
let activityView = api.getState()?.activityView === true;
window.addEventListener("error", (event) =>
  api.postMessage({ type: "clientError", message: event.message }),
);
window.addEventListener("unhandledrejection", (event) =>
  api.postMessage({ type: "clientError", message: String(event.reason) }),
);
// Раскрытия живут только в этой панели, не восстанавливаются из webview state.
const expanded = new Set();
const searchCollapsed = new Set();
let query = "";
const searchInput = document.getElementById("catalogSearch");
const clearSearch = document.getElementById("clearSearch");
const matchesSearch = (node) => node.name.toLocaleLowerCase().includes(query);
function filterTree(nodes) {
  if (!query) return nodes;
  return nodes.flatMap((node) => {
    const children = filterTree(node.children);
    return matchesSearch(node) || children.length
      ? [{ ...node, children }]
      : [];
  });
}
let lastCurrent;
let expansionInitialized = false;
let state;
let dragged;
let deferredState;
function finishDrag() {
  dragged = undefined;
  document
    .querySelectorAll(".drop-target, .favorite-before, .favorite-after")
    .forEach((el) =>
      el.classList.remove("drop-target", "favorite-before", "favorite-after"),
    );
  if (deferredState) {
    const data = deferredState;
    deferredState = undefined;
    window.dispatchEvent(new MessageEvent("message", { data }));
  }
}
const isExpanded = (id) =>
  query ? !searchCollapsed.has(id) : expanded.has(id);
function findAncestors(nodes, current) {
  for (const node of nodes) {
    if (node.folder === current) return [];
    const ancestors = findAncestors(node.children, current);
    if (ancestors) return [node.id, ...ancestors];
  }
  return null;
}
function row(node, depth, recent) {
  const container = document.createElement("div");
  container.setAttribute("role", "listitem");
  const line = document.createElement("div");
  line.className =
    "row" +
    (node.current ? " current" : node.opened ? " opened" : "") +
    (recent ? " recent-row" : "");
  line.title = node.folder;
  if (node.project) {
    line.draggable = true;
    line.ondragstart = (event) => {
      dragged = node;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-ivol-project", node.id);
    };
    line.ondragend = finishDrag;
    if (node.id.startsWith("favorite:")) {
      const accepts = () =>
        dragged?.id.startsWith("favorite:") && dragged.folder !== node.folder;
      const after = (event) =>
        event.clientY >
        line.getBoundingClientRect().top + line.offsetHeight / 2;
      line.ondragover = (event) => {
        if (!accepts()) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        document
          .querySelectorAll(".favorite-before, .favorite-after")
          .forEach((el) =>
            el.classList.remove("favorite-before", "favorite-after"),
          );
        line.classList.add(after(event) ? "favorite-after" : "favorite-before");
      };
      line.ondragleave = (event) => {
        if (!line.contains(event.relatedTarget))
          line.classList.remove("favorite-before", "favorite-after");
      };
      line.ondrop = (event) => {
        event.preventDefault();
        if (accepts())
          api.postMessage({
            type: "reorderFavorite",
            id: dragged.id,
            targetId: node.id,
            after: after(event),
          });
        finishDrag();
      };
    }
  } else if (!recent) {
    const accepts = () =>
      dragged &&
      !dragged.id.startsWith("favorite:") &&
      dragged.folder !== node.folder &&
      !node.folder.startsWith(dragged.folder + "/") &&
      !node.folder.startsWith(dragged.folder + "\\");
    line.ondragover = (event) => {
      if (!accepts()) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      line.classList.add("drop-target");
    };
    line.ondragleave = (event) => {
      if (!line.contains(event.relatedTarget))
        line.classList.remove("drop-target");
    };
    line.ondrop = (event) => {
      event.preventDefault();
      if (accepts())
        api.postMessage({ type: "move", id: dragged.id, targetId: node.id });
      finishDrag();
    };
  }
  // Правый клик → «Создать тут новый проект» (menus.webview/context).
  if (!recent)
    line.dataset.vscodeContext = JSON.stringify({
      webviewSection: "folder",
      folder: node.folder,
      ivolExplicitProject: !!node.explicitProject,
      preventDefaultContextMenuItems: true,
    });
  const toggle = document.createElement("button");
  toggle.className = "toggle";
  if (!recent && node.children.length) {
    toggle.textContent = isExpanded(node.id) ? "▾" : "▸";
    toggle.setAttribute(
      "aria-label",
      `${isExpanded(node.id) ? "Свернуть" : "Раскрыть"} ${node.name}`,
    );
    toggle.setAttribute("aria-expanded", String(isExpanded(node.id)));
    toggle.onclick = () => {
      if (query) {
        if (searchCollapsed.has(node.id)) searchCollapsed.delete(node.id);
        else searchCollapsed.add(node.id);
      } else if (expanded.has(node.id)) expanded.delete(node.id);
      else expanded.add(node.id);
      render();
    };
  } else {
    toggle.classList.add("spacer");
    toggle.tabIndex = -1;
    toggle.setAttribute("aria-hidden", "true");
  }
  const button = document.createElement("button");
  button.className = "entry";
  if (node.current) button.setAttribute("aria-current", "true");
  button.setAttribute(
    "aria-label",
    `${node.project ? "Проект" : "Группа"} ${node.name}${node.current ? ", текущее окно" : node.opened ? ", открыт в другом окне, перейти" : ""}`,
  );
  if (!node.project && node.children.length && !recent)
    button.setAttribute("aria-expanded", String(isExpanded(node.id)));
  const heading = document.createElement("span");
  heading.className = "name-line";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = node.name;
  name.title = node.folder;
  heading.append(name);
  if (!node.project) {
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = `(${node.count})`;
    heading.append(count);
  }
  if (node.empty || node.placeholder) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = node.empty ? "Пустая" : "Папка";
    heading.append(badge);
  }
  if (node.current || node.opened) {
    const labels = {
      running: "Агент выполняет задачу",
      waiting: "Агент ждёт ответа или подтверждения",
      stopped: "Агент остановлен / ожидает возобновления",
      completed: "Выбранная задача завершена",
      idle: "Задача открыта, агент не работает; завершение не подтверждено",
      none: "Задача не выбрана",
      inactive: "Расширение агента не активировано",
      unknown: "Статус агента недоступен",
    };
    const label = labels[node.agent];
    const badge = document.createElement("span");
    badge.className = label
      ? `agent-badge agent-${node.agent}`
      : "window-badge";
    badge.textContent = label
      ? { running: "◌", completed: "●", none: "○", unknown: "?" }[node.agent] ||
        "■"
      : "●";
    const windowLabel = node.current
      ? "Проект в этом окне"
      : "Нажмите, чтобы перейти в открытое окно проекта";
    badge.title = label
      ? `${windowLabel}. IVOL Code Agent 5: ${label}.`
      : windowLabel;
    badge.setAttribute("role", "img");
    badge.setAttribute("aria-label", badge.title);
    heading.append(badge);
  }
  const date = document.createElement("span");
  date.className = "date";
  date.textContent = node.date
    ? node.date.replace(/^(\d{2}\.\d{2})\.\d{2}(\d{2}).*$/, "$1.$2")
    : "—";
  date.title = node.date
    ? `${node.activityDate !== undefined ? "Последняя активность" : "Изменён"}: ${node.date}`
    : "Нет даты изменения";
  date.setAttribute("aria-label", date.title);
  button.append(heading, date);
  button.onclick = () => {
    if (node.project) api.postMessage({ type: "open", id: node.id });
    else if (node.children.length && !recent) toggle.click();
  };
  line.append(toggle, button);
  if (node.project) {
    const favorite = document.createElement("button");
    favorite.className = "row-action favorite-action";
    favorite.textContent = node.favorite ? "★" : "☆";
    favorite.title = node.favorite
      ? "Убрать из избранного"
      : "Добавить в избранное";
    favorite.setAttribute("aria-label", `${favorite.title}: ${node.name}`);
    favorite.setAttribute("aria-pressed", String(!!node.favorite));
    favorite.onclick = () =>
      api.postMessage({ type: "toggleFavorite", id: node.id });
    line.append(favorite);
  }
  if (!node.project) {
    const open = document.createElement("button");
    open.className = "group-open";
    open.textContent = "Открыть";
    open.title = "Открыть папку в VS Code";
    open.setAttribute("aria-label", `Открыть папку ${node.name} в VS Code`);
    open.onclick = () => api.postMessage({ type: "open", id: node.id });
    line.append(open);
  }
  const action = (type, text, title) => {
    const control = document.createElement("button");
    control.className = "row-action";
    control.textContent = text;
    control.title = title;
    control.setAttribute("aria-label", `${title}: ${node.name}`);
    control.onclick = () => api.postMessage({ type, id: node.id });
    line.append(control);
  };
  if (!recent && depth > 0 && !node.project && node.count === 0)
    action(
      "markProject",
      "◎",
      "Считать эту папку проектом — без создания новой",
    );
  if (!recent)
    action("folderMenu", "＋", "Создать папку или добавить пропущенные");
  action("rename", "✎", "Изменить название в каталоге");
  action("hide", "⊘", "Скрыть папку (вернуть можно в настройках)");
  container.append(line);
  if (!recent && node.children.length && isExpanded(node.id)) {
    const children = document.createElement("div");
    children.className = "children";
    children.setAttribute("role", "list");
    children.setAttribute("aria-label", `Внутри ${node.name}`);
    for (const child of node.children)
      children.append(row(child, depth + 1, false));
    container.append(children);
  }
  return container;
}
function render() {
  if (!state) return;
  const focused = document.activeElement?.closest(".row")?.title;
  const focusedBlock = document.activeElement?.closest(".block")?.id;
  const focusedFavorite =
    document.activeElement?.classList.contains("favorite-action");
  const scroll = window.scrollY;
  const tree = activityView
    ? (state.allProjects || [])
        .filter((node) => !query || matchesSearch(node))
        .map((node) => ({
          ...node,
          date: node.activityDate,
        }))
    : filterTree(state.tree);
  document.getElementById("treeTitle").textContent = activityView
    ? "Все проекты"
    : "Дерево проектов";
  const modeButton = document.getElementById("treeMode");
  modeButton.classList.toggle("activity-view", activityView);
  modeButton.title = activityView
    ? "Вернуть дерево папок"
    : "Все проекты: последние использованные или изменённые сверху";
  modeButton.setAttribute("aria-label", modeButton.title);
  modeButton.setAttribute("aria-pressed", String(activityView));
  const opened = query ? state.opened.filter(matchesSearch) : state.opened;
  const recent = query ? state.recent.filter(matchesSearch) : state.recent;
  const favorites = query
    ? state.favorites.filter(matchesSearch)
    : state.favorites;
  const hasRows =
    state.opened.length > 0 ||
    state.recent.length > 0 ||
    state.tree.length > 0 ||
    state.favorites.length > 0;
  const noMatches =
    query &&
    !tree.length &&
    !opened.length &&
    !recent.length &&
    !favorites.length;
  document.getElementById("favoritesBlock").hidden =
    !!query && !favorites.length;
  document.getElementById("favoritesCount").textContent =
    `${state.favoritesCount}`;
  const favoritesEmpty = document.getElementById("favoritesEmpty");
  favoritesEmpty.hidden = favorites.length > 0;
  favoritesEmpty.textContent = state.favoritesCount
    ? "Избранные проекты скрыты или недоступны. Верните папку в каталог."
    : "Нажмите ☆ у проекта, чтобы добавить его сюда.";
  clearSearch.hidden = !searchInput.value;
  document.getElementById("openedBlock").hidden = !!query && !opened.length;
  document.getElementById("recentBlock").hidden = !!query && !recent.length;
  const loading =
    state.hasRoots &&
    (state.scanning || (!state.initialized && !state.scanError));
  const content = document.getElementById("catalogContent");
  content.inert = loading;
  content.classList.toggle("catalog-disabled", loading);
  content.setAttribute("aria-busy", String(loading));
  document.getElementById("catalogOverlay").hidden = !loading;
  const busyText = hasRows ? "Обновление каталога…" : "Загрузка проектов…";
  const busyLabel = document.getElementById("catalogBusyText");
  if (busyLabel.textContent !== busyText) busyLabel.textContent = busyText;
  const plural = state.rootCount > 1;
  const message = !state.hasRoots
    ? "Нажмите +, чтобы подключить папку"
    : loading
      ? hasRows
        ? "Обновляем…"
        : `${plural ? "Папки подключены" : "Папка подключена"}. Загружаем проекты…`
      : state.scanError ||
        (noMatches
          ? "Папки и проекты не найдены"
          : !hasRows
            ? `${plural ? "В подключённых папках" : "В подключённой папке"} проекты не найдены`
            : "");
  const status = document.getElementById("catalogStatus");
  // Не переобъявлять тот же live status при фоновой синхронизации активности.
  if (
    status.dataset.message !== message ||
    status.dataset.loading !== String(loading)
  ) {
    status.dataset.message = message;
    status.dataset.loading = String(loading);
    status.replaceChildren();
    if (loading) {
      const spinner = document.createElement("span");
      spinner.className = "spinner";
      spinner.setAttribute("aria-hidden", "true");
      status.append(spinner);
    }
    const text = document.createElement("span");
    text.textContent = message;
    status.append(text);
    status.hidden = loading || !message;
  }
  for (const [id, nodes] of [
    ["favorites", favorites],
    ["opened", opened],
    ["recent", recent],
    ["tree", tree],
  ]) {
    const target = document.getElementById(id);
    target.setAttribute("role", "list");
    target.setAttribute("aria-busy", String(loading));
    target.replaceChildren();
    for (const node of nodes) target.append(row(node, 0, id !== "tree"));
  }
  document.getElementById("newWindow").checked = state.newWindow;
  if (focused && !loading) {
    const rows = [...document.querySelectorAll(".row")];
    const target =
      rows.find(
        (el) =>
          el.title === focused && el.closest(".block")?.id === focusedBlock,
      ) || rows.find((el) => el.title === focused);
    target
      ?.querySelector(focusedFavorite ? ".favorite-action" : ".entry")
      ?.focus({ preventScroll: true });
  }
  window.scrollTo(0, scroll);
}
function updateSearch() {
  query = searchInput.value.trim().toLocaleLowerCase();
  searchCollapsed.clear();
  render();
}
searchInput.addEventListener("input", updateSearch);
clearSearch.onclick = () => {
  searchInput.value = "";
  updateSearch();
  searchInput.focus();
};
searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && searchInput.value) {
    event.preventDefault();
    event.stopPropagation();
    clearSearch.click();
  }
});
document.getElementById("treeMode").onclick = () => {
  activityView = !activityView;
  api.setState({ ...api.getState(), activityView });
  render();
};
document.getElementById("treeMenu").onclick = () =>
  api.postMessage({ type: "command", command: "treeMenu" });
document
  .querySelectorAll("[data-command]")
  .forEach(
    (button) =>
      (button.onclick = () =>
        api.postMessage({ type: "command", command: button.dataset.command })),
  );
document.getElementById("newWindow").onchange = () =>
  api.postMessage({ type: "command", command: "toggleNewWindow" });
window.addEventListener("message", ({ data }) => {
  if (data.type === "expandFolder") {
    const visit = (nodes, folder) => {
      for (const node of nodes) {
        if (node.folder === folder) return node.id;
        const found = visit(node.children, folder);
        if (found) return found;
      }
    };
    const id = visit(state?.tree || [], data.folder);
    if (id) expanded.add(id);
    render();
    return;
  }
  if (data.type !== "state") return;
  if (dragged) {
    if (data.scanning) {
      deferredState = undefined;
      finishDrag();
    } else {
      deferredState = data;
      return;
    }
  }
  state = data;
  if (
    state.current &&
    (!expansionInitialized || state.current !== lastCurrent)
  ) {
    const ancestors = findAncestors(state.tree, state.current);
    // Не завершать инициализацию до появления активного пути в данных.
    if (ancestors) {
      expanded.clear();
      for (const id of ancestors) expanded.add(id);
      lastCurrent = state.current;
      expansionInitialized = true;
    }
  } else if (
    !state.current &&
    !state.scanning &&
    (state.initialized || !state.hasRoots) &&
    (!expansionInitialized || lastCurrent !== undefined)
  ) {
    expanded.clear();
    lastCurrent = undefined;
    expansionInitialized = true;
  }
  render();
});
api.postMessage({ type: "ready" });
