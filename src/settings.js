const vscode = require("vscode");
const { randomBytes } = require("node:crypto");
const { DEFAULT_EXCLUDES } = require("./scanner");

function openSettings(context, provider) {
  const panel = vscode.window.createWebviewPanel(
    "ivolCatalog.settings",
    "Настройки проектов",
    vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [] },
  );
  const nonce = randomBytes(16).toString("hex");
  panel.webview.html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;max-width:650px}label{display:block;margin:18px 0 6px}input,textarea{box-sizing:border-box;width:100%;padding:8px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent)}button{padding:8px 12px;margin:8px 8px 0 0;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;cursor:pointer}li{margin-bottom:8px;overflow-wrap:anywhere}small{display:block;opacity:.8}#status{margin-top:16px}button:disabled{opacity:.5}
</style></head><body><h2>Каталог проектов</h2>
<button id="hidden">Скрыть / вернуть папки</button><small>Выберите галочками папки, которые не нужно показывать. Файлы на диске не удаляются.</small>
<label for="recent">Последних проектов</label><input id="recent" type="number" min="1" max="50" value="7">
<small>При запуске читается общий индекс без обхода проектов. Полная индексация — первый раз и по кнопке ↻. Действия каталога обновляют индекс адресно во всех окнах. Скрытые ветки не сканируются. Внешние изменения появятся после ↻.</small>
<label for="excludes">Исключённые папки — по одному имени в строке</label><textarea id="excludes" rows="8"></textarea>
<button id="save">Сохранить настройки</button><h3>Корневые папки</h3><small>Содержимое всех корней показывается сразу в каталоге, без дополнительных строк с названиями корней.</small><ul id="roots"></ul><button id="add">Добавить папку</button><p id="status" role="status"></p>
<script nonce="${nonce}">
const api=acquireVsCodeApi(); const el=id=>document.getElementById(id);
el('save').onclick=()=>{el('save').disabled=true;api.postMessage({type:'save',recent:Number(el('recent').value),excludes:el('excludes').value.split('\\n').map(s=>s.trim()).filter(Boolean)});};
el('add').onclick=()=>api.postMessage({type:'add'});
el('hidden').onclick=()=>api.postMessage({type:'hidden'});
window.addEventListener('message',({data})=>{
 if(data.type==='state'){
 el('recent').value=data.recent;el('excludes').value=data.excludes.join('\\n');el('roots').replaceChildren();
 for(const folder of data.roots){const li=document.createElement('li');const text=document.createElement('span');text.textContent=folder;const button=document.createElement('button');button.textContent='Отключить';button.onclick=()=>api.postMessage({type:'remove',folder});li.append(text,button);el('roots').append(li);}
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
    });
  };
  const listener = panel.webview.onDidReceiveMessage(async (message) => {
    try {
      if (!message || typeof message !== "object") return;
      if (message.type === "save") {
        if (
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
            "Проверьте поля: проектов 1–50, исключения — имена папок без путей.",
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
        await panel.webview.postMessage({
          type: "status",
          text: "Настройки сохранены. Для применения исключений нажмите ↻ в каталоге.",
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
      await panel.webview.postMessage({ type: "status", text: error.message });
    }
  });
  panel.onDidDispose(() => listener.dispose());
  context.subscriptions.push(panel);
}
module.exports = { openSettings };
