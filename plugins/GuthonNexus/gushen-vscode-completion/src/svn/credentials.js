const { createHash } = require('node:crypto');

async function clearLegacyCredentials(secrets, credentialScope) {
  if (typeof secrets.delete !== 'function') return;
  const scopeId = createHash('sha256').update(String(credentialScope)).digest('hex');
  await Promise.all([
    secrets.delete(`guthonNexus.svn.username.${scopeId}`),
    secrets.delete(`guthonNexus.svn.password.${scopeId}`),
  ]);
}

async function promptForPassword(window) {
  const password = await window.showInputBox({
    title: '设置当前本地数据工作区的 SVN 登录',
    prompt: 'SVN 密码（仅本次通过 stdin 交给 SVN 系统保存，Nexus 不存储）',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => value ? undefined : '密码不能为空',
  });
  return password || undefined;
}

module.exports = { clearLegacyCredentials, promptForPassword };
