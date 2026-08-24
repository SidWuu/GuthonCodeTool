const { createHash } = require('node:crypto');

const USERNAME_ENV = 'GUTHON_NEXUS_SVN_USERNAME';
const PASSWORD_ENV = 'GUTHON_NEXUS_SVN_PASSWORD';

function secretKey(credentialScope, kind) {
  const scopeId = createHash('sha256').update(String(credentialScope)).digest('hex');
  return `guthonNexus.svn.${kind}.${scopeId}`;
}

async function credentialEnvironment(secrets, credentialScope) {
  const [username, password] = await Promise.all([
    secrets.get(secretKey(credentialScope, 'username')),
    secrets.get(secretKey(credentialScope, 'password')),
  ]);
  if (!username || !password) return {};
  return { [USERNAME_ENV]: username, [PASSWORD_ENV]: password };
}

async function promptAndStoreCredentials(window, secrets, credentialScope) {
  const currentUsername = await secrets.get(secretKey(credentialScope, 'username'));
  const username = await window.showInputBox({
    title: '设置当前本地数据工作区的 SVN 凭据',
    prompt: 'SVN 用户名',
    value: currentUsername || '',
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : '用户名不能为空',
  });
  if (!username?.trim()) return undefined;
  const password = await window.showInputBox({
    title: '设置当前本地数据工作区的 SVN 凭据',
    prompt: 'SVN 密码（安全保存到 VS Code SecretStorage）',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => value ? undefined : '密码不能为空',
  });
  if (!password) return undefined;
  await Promise.all([
    secrets.store(secretKey(credentialScope, 'username'), username.trim()),
    secrets.store(secretKey(credentialScope, 'password'), password),
  ]);
  return { [USERNAME_ENV]: username.trim(), [PASSWORD_ENV]: password };
}

async function requireCredentials(window, secrets, credentialScope) {
  const existing = await credentialEnvironment(secrets, credentialScope);
  return Object.keys(existing).length
    ? existing
    : promptAndStoreCredentials(window, secrets, credentialScope);
}

module.exports = {
  PASSWORD_ENV,
  USERNAME_ENV,
  credentialEnvironment,
  promptAndStoreCredentials,
  requireCredentials,
  secretKey,
};
