const vscode = require("vscode");
const { randomBytes } = require("node:crypto");
const { DEFAULT_EXCLUDES } = require("./scanner");

async function openSettings(context, provider) {
  await provider.desktop.load();
  const panel = vscode.window.createWebviewPanel(
    "ivolCatalog.settings",
    "Настройки проектов",
    vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [] },
  );
  const nonce = randomBytes(16).toString("hex");
  const initialMac = process.platform === "darwin";
  const initialEnabled = provider.desktop.enabled;
  // Обработчик сообщений регистрируется ДО загрузки HTML: ready не теряется.
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;max-width:650px}label{display:block;margin:18px 0 6px}input,textarea{box-sizing:border-box;width:100%;padding:8px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent)}button{padding:8px 12px;margin:8px 8px 0 0;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;cursor:pointer}li{margin-bottom:8px;overflow-wrap:anywhere}small{display:block;opacity:.8}#status{margin-top:16px}button:disabled{opacity:.5}
.desktop-row{display:flex;align-items:center;gap:12px;margin:12px 0}.desktop-row button{font-size:20px;margin:0;min-width:42px}.desktop-row button[aria-pressed="false"]{background:var(--vscode-input-background);color:var(--vscode-foreground);outline:1px solid var(--vscode-input-border,var(--vscode-descriptionForeground))}.desktop-row label{margin:0}#desktop-length{max-width:100px}
</style></head><body><h2>Каталог проектов</h2>
<h3>Быстрый доступ вне VS Code</h3>
<div class="desktop-row"><button id="menubar" type="button" ${initialMac ? "" : "disabled"} aria-pressed="${initialEnabled}" aria-label="Проекты в строке меню macOS" title="Включить или выключить проекты в строке меню macOS">▤</button><label for="menubar">Проекты в строке меню macOS</label><span id="menubar-state">${initialEnabled ? "Включено" : "Выключено"}</span></div>
<small id="desktop-help">Переключатель применяется сразу — нажимать «Сохранить настройки» не нужно. Одна общая полоска открытых проектов: клик по названию переключает окно, рядом показано состояние агента. Помощник работает без значка Dock.</small>
<small id="desktop-status" role="status"></small>
<small id="desktop-runtime" role="status">Проверка связи с приложением…</small>
<label for="desktop-length">Букв в коротком названии проекта</label><input id="desktop-length" type="number" min="2" max="12" value="4">
<small>При совпадении добавляются последние буквы, затем родительская папка и номер. Полное название и путь — при наведении. Все проекты внутри одного элемента. ⌘ + перетаскивание переносит всю полоску; новые проекты добавляются в неё автоматически. Правый клик или +N открывает общий список.</small>
<hr>
<button id="hidden">Скрыть / вернуть папки</button><small>Выберите галочками папки, которые не нужно показывать. Файлы на диске не удаляются.</small>
<label for="recent">Последних проектов</label><input id="recent" type="number" min="1" max="50" value="7">
<small>При запуске читается общий индекс без обхода проектов. Полная индексация — первый раз и по кнопке ↻. Действия каталога обновляют индекс адресно во всех окнах. Скрытые ветки не сканируются. Внешние изменения появятся после ↻.</small>
<label for="excludes">Исключённые папки — по одному имени в строке</label><textarea id="excludes" rows="8"></textarea>
<button id="save">Сохранить настройки</button><h3>Корневые папки</h3><small>Содержимое всех корней показывается сразу в каталоге, без дополнительных строк с названиями корней.</small><ul id="roots"></ul><button id="add">Добавить папку</button><p id="status" role="status"></p>
<script nonce="${nonce}">
const api=acquireVsCodeApi(); const el=id=>document.getElementById(id);
let menuBar=${initialEnabled},desktopBusy=false,mac=${initialMac};const updateDesktop=()=>{el('menubar').setAttribute('aria-pressed',String(menuBar));el('menubar').disabled=!mac||desktopBusy;el('menubar-state').textContent=desktopBusy?(menuBar?'Выключаю…':'Включаю…'):(menuBar?'Включено':'Выключено');};
window.addEventListener('error',event=>{el('desktop-status').textContent='Ошибка интерфейса: '+event.message;api.postMessage({type:'clientError',error:String(event.message).slice(0,500)});});
el('menubar').onclick=()=>{if(!mac||desktopBusy)return;desktopBusy=true;updateDesktop();el('desktop-status').textContent='';api.postMessage({type:'menuBar',enabled:!menuBar});};
el('save').onclick=()=>{el('save').disabled=true;api.postMessage({type:'save',labelLength:Number(el('desktop-length').value),recent:Number(el('recent').value),excludes:el('excludes').value.split('\\n').map(s=>s.trim()).filter(Boolean)});};
el('add').onclick=()=>api.postMessage({type:'add'});
el('hidden').onclick=()=>api.postMessage({type:'hidden'});
window.addEventListener('message',({data})=>{
 if(data.type==='state'){
 el('recent').value=data.recent;el('excludes').value=data.excludes.join('\\n');el('roots').replaceChildren();
 menuBar=data.menuBar;mac=data.mac;updateDesktop();el('desktop-length').value=data.labelLength;el('desktop-length').disabled=!data.mac;
 if(!data.mac)el('desktop-help').textContent='Строка меню доступна только в macOS. На Windows используйте панель проектов внутри VS Code; плавающая панель не реализована.';
 for(const folder of data.roots){const li=document.createElement('li');const text=document.createElement('span');text.textContent=folder;const button=document.createElement('button');button.textContent='Отключить';button.onclick=()=>api.postMessage({type:'remove',folder});li.append(text,button);el('roots').append(li);}
 }else if(data.type==='desktop'){
 menuBar=data.menuBar;mac=data.mac;desktopBusy=false;updateDesktop();el('desktop-status').textContent=data.error||'Режим сохранён в Cataloger.';
 }else if(data.type==='desktopRuntime'){
 if(!desktopBusy){menuBar=data.menuBar;updateDesktop();}el('desktop-runtime').textContent=data.text;
 }else if(data.type==='status'){el('status').textContent=data.text;el('save').disabled=false;}
});api.postMessage({type:'ready'});
</script></body></html>`;
  const sendState = () => {
    const config = vscode.workspace.getConfiguration("ivolCatalog");
    return panel.webview.postMessage({
      type: "state",
      roots: provider.roots,
      recent: config.get("recentLimit", 7),
      excludes: config.get("excludedDirectories", DEFAULT_EXCLUDES),
      mac: process.platform === "darwin",
      menuBar: provider.desktop.enabled,
      labelLength: provider.desktop.labelLength,
    });
  };
  const sendDesktopState = (error = "") =>
    panel.webview.postMessage({
      type: "desktop",
      mac: process.platform === "darwin",
      menuBar: provider.desktop.enabled,
      error,
    });
  const listener = panel.webview.onDidReceiveMessage(async (message) => {
    try {
      if (!message || typeof message !== "object") return;
      if (message.type === "clientError") {
        provider.log?.(
          `Настройки: ошибка интерфейса: ${String(message.error).slice(0, 500)}`,
        );
        return;
      }
      if (message.type === "ready")
        provider.log?.("Настройки: интерфейс подключён");
      if (message.type === "menuBar") {
        provider.log?.(
          `Настройки: переключение строки меню → ${message.enabled}`,
        );
        if (
          process.platform !== "darwin" ||
          typeof message.enabled !== "boolean"
        )
          throw new Error("Строка меню доступна только в macOS.");
        await provider.updateDesktop({ enabled: message.enabled });
        // Не отправляем всю форму: не затираем несохранённые исключения и лимиты.
        await sendDesktopState();
        return;
      }
      if (message.type === "save") {
        if (
          !Number.isInteger(message.labelLength) ||
          message.labelLength < 2 ||
          message.labelLength > 12 ||
          !Number.isInteger(message.recent) ||
          message.recent < 1 ||
          message.recent > 50 ||
          !Array.isArray(message.excludes) ||
          message.excludes.length > 500 ||
          message.excludes.some(
            (name) =>
              typeof name !== "string" ||
              !name.trim() ||
              name.length > 255 ||
              /[\\/\r\n]/.test(name),
          )
        ) {
          throw new Error(
            "Проверьте поля: проектов 1–50, букв 2–12, исключения — имена папок без путей.",
          );
        }
        const config = vscode.workspace.getConfiguration("ivolCatalog");
        await config.update(
          "recentLimit",
          message.recent,
          vscode.ConfigurationTarget.Global,
        );
        await config.update(
          "excludedDirectories",
          [...new Set(message.excludes.map((name) => name.trim()))],
          vscode.ConfigurationTarget.Global,
        );
        if (process.platform === "darwin") {
          await provider.updateDesktop({ labelLength: message.labelLength });
        }
        await panel.webview.postMessage({
          type: "status",
          text: "Настройки сохранены. Строка меню обновится автоматически. Для применения исключений нажмите ↻ в каталоге.",
        });
      } else if (message.type === "hidden") {
        await vscode.commands.executeCommand("ivolCatalog.manageHidden");
      } else if (message.type === "add") {
        await vscode.commands.executeCommand("ivolCatalog.addRoot");
      } else if (message.type === "remove") {
        if (
          typeof message.folder !== "string" ||
          !provider.roots.includes(message.folder)
        )
          return;
        await vscode.commands.executeCommand("ivolCatalog.removeRoot", {
          root: true,
          folder: message.folder,
        });
      } else if (message.type !== "ready") return;
      await sendState();
    } catch (error) {
      if (message?.type === "menuBar") {
        await sendDesktopState(
          `Не удалось изменить настройку: ${error.message}`,
        );
      } else {
        await panel.webview.postMessage({
          type: "status",
          text: error.message,
        });
      }
    }
  });
  let checking = false;
  const sendRuntime = async () => {
    if (checking || !panel.visible) return;
    checking = true;
    try {
      await provider.desktop.load();
      const status = await provider.desktop.status();
      await panel.webview.postMessage({
        type: "desktopRuntime",
        menuBar: provider.desktop.enabled,
        text: status.text,
      });
    } catch (error) {
      provider.log?.(`Настройки системной панели: ${error.message}`);
    } finally {
      checking = false;
    }
  };
  const runtimeTimer = setInterval(() => void sendRuntime(), 2000);
  panel.onDidDispose(() => {
    listener.dispose();
    clearInterval(runtimeTimer);
  });
  context.subscriptions.push(panel);
  panel.webview.html = html;
}
module.exports = { openSettings };
