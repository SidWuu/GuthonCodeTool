async function openProjectWorkspace(vscode) {
  // Focus the current source view without replacing the editor window or its drafts.
  return vscode.commands.executeCommand('gushenCompletion.sourceView.focus');
}
module.exports={openProjectWorkspace};
