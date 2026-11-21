const { parseDiagnosisDatabaseUrl } = require('./database-config');

function parseSourceDatabaseUrl(value) {
  const result = parseDiagnosisDatabaseUrl(value);
  if (!['mysql','postgresql'].includes(result.engine)) throw new Error('请选择 MySQL 或 PostgreSQL 主库');
  const url = new URL(value.trim().replace(/^jdbc:/i, ''));
  if (url.username || url.password || url.hash || url.search) {
    throw new Error('地址只填写主机、端口和数据库名');
  }
  return {type:result.engine,host:result.host.replace(/^\[|\]$/g,''),port:result.port,database:result.database};
}

function formatSourceDatabaseUrl(connection) {
  if (!connection?.host || !connection.database) return '';
  const host=connection.host.includes(':') && !connection.host.startsWith('[')
    ? `[${connection.host}]` : connection.host;
  return `${connection.type}://${host}${connection.port ? ':'+connection.port : ''}/${encodeURIComponent(connection.database)}`;
}

function validateRepositoryUrl(value, allowEmpty) {
  if (!value.trim() && allowEmpty) return;
  try {
    const url=new URL(value.trim());
    if (['http:','https:','svn:','svn+ssh:','file:'].includes(url.protocol)
      && (url.host || url.protocol==='file:') && !url.username && !url.password && !url.search && !url.hash
      && url.pathname.replace(/\/+$/,'')
      && !/\s/.test(value.trim())) return;
  } catch {}
  return '请输入完整 SVN 仓库地址，账号和密码单独填写';
}

async function configureSourceConnection({vscode, workspace, load, save, refreshProjects}) {
  const window=vscode.window, current=await load();
  if(current.workspaceKey!==workspace.workspaceKey || current.sourceMode!==workspace.sourceMode) {
    throw new Error('源码连接设置与当前项目不一致');
  }
  const database=workspace.sourceMode==='database';
  let connection;
  if(database) {
    const address=await window.showInputBox({title:'谷神主数据数据库连接',value:formatSourceDatabaseUrl(current.connection),ignoreFocusOut:true,
      prompt:'输入 MySQL 或 PostgreSQL 地址。此连接用于 DATABASE 源码同步。',
      placeHolder:'mysql://服务器:3306/数据库',
      validateInput:text=>{try {parseSourceDatabaseUrl(text);} catch(error) {return error.message;}}});
    if(address===undefined)return;
    connection=parseSourceDatabaseUrl(address);
  } else {
    const repositoryUrl=await window.showInputBox({title:'SVN 仓库地址',value:current.repositoryUrl,ignoreFocusOut:true,
      prompt:'填写此项目获准签出的仓库 URL',validateInput:text=>validateRepositoryUrl(text,current.scopeConfigured)});
    if(repositoryUrl===undefined)return;
    connection={repositoryUrl:repositoryUrl.trim()};
  }
  const username=await window.showInputBox({title:database?'主数据数据库只读用户名':'SVN 用户名',
    value:database?current.connection.username:current.username,ignoreFocusOut:true,
    validateInput:text=>text.trim()?undefined:'用户名不能为空'});
  if(!username?.trim())return;
  connection.username=username.trim();
  const keepPassword=database && current.passwordConfigured &&
    Object.keys(connection).every(key=>connection[key]===current.connection[key]);
  const password=await window.showInputBox({title:database?'主数据数据库密码':'SVN 密码',password:true,ignoreFocusOut:true,
    prompt:database ? (keepPassword?'留空保留现有凭据':'密码保存到系统凭据库')
      : '密码验证通过后保存到系统凭据库。留空可保留现有凭据。',
    validateInput:text=>database && !keepPassword && !text?'请输入此连接的密码':undefined});
  if(password===undefined || (database && !keepPassword && !password))return;
  if(password || database)connection.password=password;
  const saved=await save({action:'save',sourceMode:current.sourceMode,revision:current.revision,connection});
  await refreshProjects();
  if(!database && password) {
    return window.showInformationMessage('SVN 地址和用户名已保存，登录验证通过');
  }
  const pending=database && (!saved.sourceTablesConfigured || !saved.systemAliases.length);
  return window.showInformationMessage(database
    ? '主数据数据库连接已保存' + (pending ? '。同步前请检查系统范围和源码字段映射。' : '。')
    : 'SVN 地址和用户名已保存。');
}

async function configureSourceScope({vscode, workspace, request, refreshProjects}) {
  const window=vscode.window, current=await request({action:'scope-list'});
  if(current.workspaceKey!==workspace.workspaceKey || current.sourceMode!==workspace.sourceMode
      || !Array.isArray(current.options)) throw new Error('同步范围与当前项目不一致');
  if(!current.options.length) throw new Error('当前连接没有可选的源码同步范围');
  const database=workspace.sourceMode==='database';
  const existing=new Set(database?current.systemAliases:current.scopePaths);
  if(!database && current.scopeConfigured===false)existing.delete('.');
  const grouped=!database && current.options.every(option=>Array.isArray(option.paths));
  const scopes=[...existing];
  const choices=current.options.map(option=>({...option,picked:grouped
    ? scopes.includes('.') || option.paths.some(path=>scopes.some(previous=>path===previous || path.startsWith(previous+'/')))
    : existing.has(option.id)}));
  const selected=await window.showQuickPick(choices,{
    title:workspace.displayName+' · '+(database?'选择同步子系统':'选择 SVN 同步范围'),
    canPickMany:true, matchOnDescription:true,matchOnDetail:true,
  });
  if(!selected)return;
  if(!selected.length)throw new Error('请至少选择一项同步范围');
  const whole=grouped && (selected.some(option=>option.id==='.') || (existing.has('.') && selected.length===choices.length));
  await request({action:'scope-save',sourceMode:current.sourceMode,revision:current.revision,
    selected:whole?['.']:selected.map(option=>option.id),...(grouped && !whole?{grouped:true}:{})});
  await refreshProjects();
  return window.showInformationMessage('同步范围已保存。可点击“更新源码”拉取。');
}

module.exports={configureSourceConnection,configureSourceScope,formatSourceDatabaseUrl,
  parseSourceDatabaseUrl,validateRepositoryUrl};
