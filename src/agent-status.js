const vscode = require("vscode");

const AGENT_ID = "ivol.ivol-code-agent-5";
const POLL_INTERVAL = 60000;

// Адаптер экспортируемого объекта Agent 5 (проверен на 5.17.71).
// sidebarProvider не является стабильным публичным контрактом: при изменении
// интерфейса не угадываем состояние и не читаем историю, настройки или ключи.
class AgentStatus {
  constructor() {
    this.updatedAt = 0;
    this.value = null;
  }

  poll(interval = POLL_INTERVAL) {
    const now = Date.now();
    if (now - this.updatedAt < interval) return;
    this.updatedAt = now;
    this.value = this.read();
  }

  read() {
    try {
      const extension = vscode.extensions.getExtension(AGENT_ID);
      if (!extension) return null;
      if (!extension.isActive) return { status: "inactive" };
      const provider = extension.exports?.sidebarProvider;
      if (typeof provider?.getCurrentTask !== "function")
        return { status: "unknown" };
      const task = provider.getCurrentTask();
      if (!task) return { status: "none" };
      const folder = typeof task.cwd === "string" ? task.cwd : "";
      let status;
      if (task.abort || task.abandoned) status = "stopped";
      else if (task.taskStatus === "idle") {
        // idle включает ошибки и лимиты, а не только завершение.
        // Читаем лишь тип текущего ожидания, без текста/истории задачи.
        const ask = task.taskAsk?.ask;
        status =
          ask === "completion_result" || ask === "resume_completed_task"
            ? "completed"
            : "idle";
      } else {
        const states = {
          running: "running",
          interactive: "waiting",
          resumable: "stopped",
        };
        status = states[task.taskStatus] || "unknown";
      }
      return { status, folder };
    } catch {
      return { status: "unknown" };
    }
  }
}

module.exports = { AgentStatus };
