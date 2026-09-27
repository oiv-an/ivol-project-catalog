const api = acquireVsCodeApi();
window.addEventListener("error", (event) =>
  api.postMessage({ type: "clientError", message: event.message }),
);
window.addEventListener("unhandledrejection", (event) =>
  api.postMessage({ type: "clientError", message: String(event.reason) }),
);
// Раскрытия живут только в этой панели, не восстанавливаются из webview state.
const expanded = new Set();
let lastCurrent;
let expansionInitialized = false;
let state;
let dragged;
let deferredState;
function finishDrag() {
  dragged = undefined;
  document.querySelectorAll(".drop-target").forEach((el) => el.classList.remove("drop-target"));
  if (deferredState) {
    const data = deferredState;
    deferredState = undefined;
    window.dispatchEvent(new MessageEvent("message", { data }));
  }
}
const isExpanded = (id) => expanded.has(id);
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
    "row" + (node.current ? " current" : "") + (recent ? " recent-row" : "");
  line.title = node.folder;
  if (node.project) {
    line.draggable = true;
    line.ondragstart = (event) => {
      dragged = node;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-ivol-project", node.id);
    };
    line.ondragend = finishDrag;
  } else if (!recent) {
    const accepts = () => dragged && dragged.folder !== node.folder &&
      !node.folder.startsWith(dragged.folder + "/") &&
      !node.folder.startsWith(dragged.folder + "\\");
    line.ondragover = (event) => {
      if (!accepts()) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      line.classList.add("drop-target");
    };
    line.ondragleave = (event) => {
      if (!line.contains(event.relatedTarget)) line.classList.remove("drop-target");
    };
    line.ondrop = (event) => {
      event.preventDefault();
      if (accepts()) api.postMessage({ type: "move", id: dragged.id, targetId: node.id });
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
      if (isExpanded(node.id)) expanded.delete(node.id);
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
    `${node.project ? "Проект" : "Группа"} ${node.name}${node.current ? ", активный проект" : ""}`,
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
  if (node.current) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "Активный";
    heading.append(badge);
  }
  const date = document.createElement("span");
  date.className = "date";
  date.textContent = node.date
    ? node.date.replace(/^(\d{2}\.\d{2})\.\d{2}(\d{2}).*$/, "$1.$2")
    : "—";
  date.title = node.date ? `Изменён: ${node.date}` : "Нет даты изменения";
  date.setAttribute("aria-label", date.title);
  button.append(heading, date);
  button.onclick = () => {
    if (node.project) api.postMessage({ type: "open", id: node.id });
    else if (node.children.length && !recent) toggle.click();
  };
  line.append(toggle, button);
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
    action("markProject", "◎", "Считать эту папку проектом — без создания новой");
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
  const scroll = window.scrollY;
  const hasRows = state.recent.length > 0 || state.tree.length > 0;
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
        (!hasRows
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
    ["recent", state.recent],
    ["tree", state.tree],
  ]) {
    const target = document.getElementById(id);
    target.setAttribute("role", "list");
    target.setAttribute("aria-busy", String(loading));
    target.replaceChildren();
    for (const node of nodes) target.append(row(node, 0, id === "recent"));
  }
  document.getElementById("newWindow").checked = state.newWindow;
  if (focused && !loading)
    [...document.querySelectorAll(".row")]
      .find((el) => el.title === focused)
      ?.querySelector(".entry")
      ?.focus({ preventScroll: true });
  window.scrollTo(0, scroll);
}
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
