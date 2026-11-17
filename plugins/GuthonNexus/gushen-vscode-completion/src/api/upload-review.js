function selectUploadFiles(vscode, entries, openDiff) {
  const picker = vscode.window.createQuickPick();
  picker.title = '审阅并选择要上传的源码';
  picker.placeholder = '勾选本次文件；点击右侧差异按钮核对内容，回车后确认上传';
  picker.canSelectMany = true;
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  picker.items = entries.map(entry => ({
    label: entry.name || entry.path,
    description: `${entry.type} · ${entry.state}`,
    detail: entry.path,
    path: entry.path,
    buttons: [{iconPath: new vscode.ThemeIcon('diff'), tooltip: '查看本地差异'}],
  }));
  picker.selectedItems = picker.items;
  return new Promise(resolve => {
    let finished = false;
    const subscriptions = [];
    const finish = value => {
      if (finished) return;
      finished = true;
      subscriptions.forEach(item => item.dispose());
      picker.dispose();
      resolve(value);
    };
    subscriptions.push(picker.onDidHide(() => finish(undefined)));
    subscriptions.push(picker.onDidAccept(() => {
      if (!picker.selectedItems.length) {
        void vscode.window.showInformationMessage('请至少选择一个源码文件');
        return;
      }
      finish(picker.selectedItems.map(item => item.path));
    }));
    subscriptions.push(picker.onDidTriggerItemButton(async ({item}) => {
      try { await openDiff(item.path); }
      catch (error) { await vscode.window.showErrorMessage(`无法查看源码差异：${error.message}`); }
    }));
    picker.show();
  });
}
module.exports = {selectUploadFiles};
