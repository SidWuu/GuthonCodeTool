(function initWorkspaceSelection(root) {
  const STORAGE_KEY = "guthonBridgeWorkspaceSelection";

  function guthonAddress(pageUrl) {
    try {
      return `${new URL(pageUrl).origin}/guthon`;
    } catch {
      return pageUrl;
    }
  }

  function cachedWorkspaceKey(selection, pageUrl, candidates) {
    if (!selection || selection.address !== guthonAddress(pageUrl)) {
      return "";
    }
    return candidates.some((item) => item.workspaceKey === selection.workspaceKey)
      ? selection.workspaceKey
      : "";
  }

  function showWorkspaceDialog(candidates) {
    return new Promise((resolve, reject) => {
      const dialog = document.createElement("dialog");
      const form = document.createElement("form");
      const title = document.createElement("label");
      const select = document.createElement("select");
      const actions = document.createElement("div");
      const cancel = document.createElement("button");
      const confirm = document.createElement("button");

      dialog.className = "guthon-bridge-workspace-dialog";
      form.className = "guthon-bridge-workspace-form";
      form.method = "dialog";
      title.className = "guthon-bridge-workspace-title";
      title.htmlFor = "guthon-bridge-workspace-select";
      title.textContent = "请选择本次请求的工作区";
      select.className = "guthon-bridge-workspace-select";
      select.id = "guthon-bridge-workspace-select";
      candidates.forEach((item) => {
        const option = document.createElement("option");
        option.value = item.workspaceKey;
        option.textContent = `${item.displayName} (${item.id})`;
        select.appendChild(option);
      });
      actions.className = "guthon-bridge-workspace-actions";
      cancel.className = "guthon-bridge-workspace-button guthon-bridge-workspace-cancel";
      cancel.type = "submit";
      cancel.value = "cancel";
      cancel.textContent = "取消";
      confirm.className = "guthon-bridge-workspace-button guthon-bridge-workspace-confirm";
      confirm.type = "submit";
      confirm.value = "confirm";
      confirm.textContent = "确定";
      actions.append(cancel, confirm);
      form.append(title, select, actions);
      dialog.appendChild(form);
      dialog.addEventListener("close", () => {
        const workspaceKey = dialog.returnValue === "confirm" ? select.value : "";
        dialog.remove();
        if (workspaceKey) {
          resolve(workspaceKey);
        } else {
          reject(new Error("已取消工作区选择"));
        }
      }, { once: true });
      document.body.appendChild(dialog);
      dialog.showModal();
      select.focus();
    });
  }

  async function select(candidates, pageUrl) {
    const storage = root.chrome?.storage?.local;
    const stored = storage ? await storage.get(STORAGE_KEY) : {};
    const cached = cachedWorkspaceKey(stored?.[STORAGE_KEY], pageUrl, candidates);
    if (cached) {
      return cached;
    }
    const workspaceKey = await showWorkspaceDialog(candidates);
    await storage?.set({ [STORAGE_KEY]: { address: guthonAddress(pageUrl), workspaceKey } });
    return workspaceKey;
  }

  const api = { cachedWorkspaceKey, guthonAddress, select };
  root.GuthonBridgeWorkspace = api;
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(globalThis);
