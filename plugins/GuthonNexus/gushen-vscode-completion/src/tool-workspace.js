const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { workspaceRoot } = require('./workspace-root');

const LEGACY_CONFIG_FILES = ['products.yaml','projects.yaml','sync.yaml','datasource.yaml','source-tables.yaml'];
const WORKSPACE_CONFIG_FILES = ['guthon.json', ...LEGACY_CONFIG_FILES, 'database-testing.yaml'];

function hasWorkspaceConfigFiles(home) {
  return Boolean(home) && WORKSPACE_CONFIG_FILES.some(name => fs.existsSync(path.join(home, 'config', name)));
}

function hasWorkspaceConfiguration(toolHome) {
  if(!toolHome)return false;
  try {return fs.statSync(path.join(toolHome,'config','guthon.json')).isFile();}
  catch {}
  try {return LEGACY_CONFIG_FILES
    .every(name=>fs.statSync(path.join(toolHome,'config',name)).isFile());}
  catch {return false;}
}

function existingWorkspaceConfig(toolHome) {
  if(!hasWorkspaceConfiguration(toolHome)) throw new Error('所选目录缺少已有工作空间配置：需要 guthon.json 或完整旧 YAML。请选择包含配置的本地数据目录');
}

function windowToolHome(config, folders = []) {
  const home = config.get('toolHome', '');
  if (typeof home !== 'string' || !path.isAbsolute(home)) return '';
  const setting = config.inspect?.('toolHome');
  if (setting?.workspaceFolderValue !== undefined || setting?.workspaceValue !== undefined) return home;
  const canonical = value => {
    try { return fs.realpathSync(value); }
    catch { return path.resolve(value); }
  };
  if (!folders?.length) return '';
  const root = canonical(home);
  const directories = folders.map(canonical);
  if (directories.every(directory => path.relative(root, directory) === '')) return home;
  let space;
  try { space = canonical(workspaceRoot(home)); }
  catch { return ''; }
  const belongs = directory => {
    const relative = path.relative(space, directory);
    return path.relative(root, directory) === '' ||
      (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  };
  return directories.every(belongs) ? home : '';
}

function workspaceSetupCard(folders, attachedHome) {
  if (hasWorkspaceConfigFiles(attachedHome)) {
    return { title: '工具入口不可用', message: '请为这个工作区选择可用的 GuthonCodeTool 后端。',
      directory: attachedHome, action: '检查工具入口' };
  }
  if (folders?.length !== 1) {
    return { title: '还未连接谷神工作区', message: '选择一个已有数据目录，或选择新目录进行初始化。' };
  }
  const folder = folders[0];
  const parent = path.dirname(folder);
  let directory;
  if (hasWorkspaceConfigFiles(folder)) directory = folder;
  else if (hasWorkspaceConfigFiles(parent)) {
    try { if (path.relative(workspaceRoot(parent), folder) === '') directory = parent; }
    catch { if (path.basename(folder) === 'var') directory = parent; }
  }
  if (directory) {
    return { title: '当前目录尚未连接', message: '连接后即可查看这个目录下的谷神项目。',
      directory, action: '连接此目录' };
  }
  return { title: '当前开发目录尚未初始化', message: '配置保存在上一级目录，当前文件夹用于开发。',
    directory: parent, workspaceDirectory: path.basename(folder), workspaceRoot: folder, action: '初始化此文件夹' };
}

async function prepareWorkspaceSetup(config, window, { toolHome = config.get('toolHome', ''), directory, workspaceDirectory, browse = false } = {}) {
  const initialized = hasWorkspaceConfiguration(toolHome);
  if (directory && workspaceDirectory) {
    if (hasWorkspaceConfigFiles(directory)) {
      throw new Error(`上一级已有谷神配置，请打开已绑定的开发目录：${workspaceRoot(directory)}`);
    }
    return { mode: 'setup', toolHome: directory, workspaceDirectory };
  }
  if (directory) return workspaceSetupTarget(directory);
  if (initialized && !browse) {
    const confirmed = await window.showWarningMessage(
      `当前工作空间已设置：${toolHome}\n请选择刷新当前状态或切换工作空间。`,
      { modal: true },
      '刷新当前状态',
      '切换工作空间'
    );
    if (confirmed === '刷新当前状态') return { mode: 'refresh', toolHome };
    if (confirmed !== '切换工作空间') return undefined;
  }

  const selected = await window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    title: initialized
      ? '选择新的 GuthonCodeTool 本地数据工作空间'
      : '选择 GuthonCodeTool 本地数据工作空间',
  });
  if (!selected?.length) return undefined;

  return workspaceSetupTarget(selected[0].fsPath);
}

function workspaceSetupTarget(selectedHome) {
  if (hasWorkspaceConfiguration(selectedHome)) {
    existingWorkspaceConfig(selectedHome);
    return { mode: 'switch', toolHome: selectedHome };
  }
  if (hasWorkspaceConfigFiles(selectedHome)) {
    throw new Error('旧配置不完整，请核对 products/projects、sync、datasource 和 source-tables；不会创建或转换配置');
  }
  return { mode: 'setup', toolHome: selectedHome };
}

function workspaceActions() {
  return {source:[
    ['配置 API 项目地址','gushenCompletion.configureApiSource','settings-gear'],
    ['登录 API 项目','gushenCompletion.loginApiSource','key'],
    ['选择拉取的子系统','gushenCompletion.selectApiSystems','list-selection'],
    ['通过 API 拉取源码','gushenCompletion.pullApiSource','cloud-download'],
    ['搜索当前项目源码','gushenCompletion.searchWorkspace','search'],
    ['查看源码树','gushenCompletion.focusApiSource','list-tree'],
    ['重建源码索引','gushenCompletion.reindexCalls','refresh'],
    ['重试待更新索引','gushenCompletion.retryApiIndexFailures','refresh'],
    ['查看工作区源码','gushenCompletion.openApiCheckout','folder-opened'],
    ['查看 API 源码状态','gushenCompletion.showApiStatus','info'],
    ['查看 API 操作历史','gushenCompletion.showApiHistory','history'],
    ['导出本地修改包','gushenCompletion.exportApiChanges','export'],
    ['预览并导入本地修改包','gushenCompletion.importApiChanges','import'],
    ['检查系统菜单结构','gushenCompletion.showApiSystemMenu','list-tree'],
  ],metadata:[
    ['配置数据库只读目标','gushenCompletion.configureDatabaseDiagnosis','database'],
    ['导出表结构','gushenCompletion.exportSchema','table'],
    ['导出单据类型','gushenCompletion.exportBillTypes','list-tree'],
    ['导出系统脚本','gushenCompletion.exportSystemScripts','file-code'],
    ['导出视图源码','gushenCompletion.exportViews','eye'],
    ['导出源码索引文档','gushenCompletion.exportMarkdown','book'],
  ],diagnose:true,syncAll:undefined};
}

const WORKSPACE_SOURCE_MODES = [
  { label: 'API', sourceMode: 'api', description: '推荐 · 通过谷神开发平台拉取和上传源码' },
  { label: 'SVN', sourceMode: 'svn', description: '通过授权 SVN 工作副本同步' },
  { label: 'DATABASE', sourceMode: 'database', description: '使用已配置的数据库来源与 Workcopy' },
];

async function pickWorkspaceSourceMode(window, allowedModes, currentMode) {
  const options = WORKSPACE_SOURCE_MODES.filter(item => allowedModes.includes(item.sourceMode) && item.sourceMode !== currentMode);
  const selected = await window.showQuickPick(options, {
    title: currentMode ? '选择新的同步方式' : '选择项目同步方式',
  });
  return selected?.sourceMode;
}

async function promptWorkspaceCreation(window, configuration) {
  if (configuration?.ok !== true || configuration.initialized !== true) {
    throw new Error('请先设置可用的 GuthonCodeTool 本地数据目录');
  }
  const classified = configuration.schemaVersion === undefined
    && typeof configuration.migrationAvailable === 'boolean'
    && ['legacy', 'unified'].includes(configuration.mode);
  if (!classified && configuration.mode === 'legacy') {
    throw new Error('此后端读取旧配置时支持浏览和同步。请先按配置升级流程转换为统一配置，再添加项目');
  }
  if (!classified && (configuration.mode !== 'unified' || ![2, 3].includes(configuration.schemaVersion))) {
    throw new Error('当前后端的工作区登记格式无法识别，请检查运行入口和本地数据目录');
  }

  const name = await window.showInputBox({
    title: '输入项目名称',
    prompt: '该名称用于 Nexus 显示和本地工作区目录',
    validateInput: value => String(value || '').trim() ? undefined : '名称不能为空',
  });
  if (name === undefined) return undefined;
  const modes = Array.isArray(configuration.workspaceSourceModes) ? configuration.workspaceSourceModes : ['api'];
  const sourceMode = await pickWorkspaceSourceMode(window, modes);
  if (!sourceMode) return undefined;
  if (!classified) return { name: name.trim(), sourceMode };

  const type = await window.showQuickPick([
    { label: '项目', kind: 'project' },
    { label: '产品', kind: 'product' },
  ], { title: '选择当前后端使用的工作区类型' });
  if (!type) return undefined;
  return { name: name.trim(), id: 'ws_' + randomUUID().replaceAll('-', ''), kind: type.kind, sourceMode };
}

// Keep the running window independent; workspaceState only seeds its next session.
class WindowWorkspaceSelection {
  constructor({getWorkspaces, getFolders, window, onChange, state, getScope=()=>''}) {
    Object.assign(this,{getWorkspaces,getFolders,window,onChange,state,getScope});
    this.key='';this.diagnosticKey='';this.inferredKey='';this.skipFolderSelection=false;
    this.revision=0;this.scope=undefined;this.pendingState=Promise.resolve();
  }
  syncScope() {
    const home=this.getScope();
    let scope=home ? path.resolve(home) : '';
    if(process.platform==='win32')scope=scope.toLowerCase();
    if(scope!==this.scope) {
      this.scope=scope;this.revision++;
      this.diagnosticKey='';
      this.inferredKey='';this.skipFolderSelection=false;
      this.key=scope && this.state ? this.state.get('guthon.windowWorkspace.'+Buffer.from(scope).toString('base64url'),'') : '';
    }
    return scope;
  }
  save(scope,key,expected) {
    if(!scope || !this.state)return Promise.resolve();
    const storageKey='guthon.windowWorkspace.'+Buffer.from(scope).toString('base64url');
    const update=this.pendingState.catch(()=>{}).then(()=>{
      if(expected!==undefined && this.state.get(storageKey,'')!==expected)return;
      return this.state.update(storageKey,key || undefined);
    });
    this.pendingState=update;
    return update;
  }
  async current() {
    const scope=this.syncScope(),revision=this.revision,workspaces=await this.getWorkspaces();
    if(scope!==this.syncScope() || revision!==this.revision)return this.current();
    if(this.key) {
      const selected=workspaces.find(item=>item.workspaceKey===this.key);
      if(selected)return selected;
      const removed=this.key;this.key='';this.diagnosticKey=removed;
      await this.save(scope,'',removed);
      if(scope!==this.syncScope() || revision!==this.revision)return this.current();
    }
    if(this.diagnosticKey || this.skipFolderSelection)return undefined;
    const folders=this.getFolders().map(folder=>path.resolve(folder));
    const matched=workspaces.filter(item=>[item.root,item.checkoutPath].filter(Boolean).some(root=>folders.some(folder=>{
      const relative=path.relative(path.resolve(root),folder);
      return relative==='' || (relative!=='..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative));
    })));
    const selected=matched.length===1 ? matched[0] : undefined;
    this.inferredKey=selected?.workspaceKey || '';
    return selected;
  }
  async select(key='', {switchWindow=false}={}) {
    const scope=this.syncScope(),revision=++this.revision,workspaces=await this.getWorkspaces();
    if(scope!==this.syncScope() || revision!==this.revision)return undefined;
    let selected;
    if(key) {
      selected=workspaces.find(item=>item.workspaceKey===key);
      if(!selected)throw new Error(`找不到工作区：${key}`);
      if(!switchWindow)return selected;
    } else {
      if(!switchWindow) {
        const current=await this.current();
        if(scope!==this.syncScope() || revision!==this.revision)return undefined;
        if(current)return current;
      }
      const choice=await this.window.showQuickPick(workspaces.map(item=>({label:item.displayName || item.name || item.workspaceKey,description:item.workspaceKey,workspace:item})),{title:'选择当前窗口的工作区'});
      if(scope!==this.syncScope() || revision!==this.revision || !choice)return undefined;
      selected=choice.workspace;
    }
    this.key=selected.workspaceKey;this.diagnosticKey='';this.inferredKey='';this.skipFolderSelection=false;
    this.onChange?.();
    await this.save(scope,this.key);
    return selected;
  }
  async inspectDiagnostic(key) {
    const scope=this.syncScope();this.revision++;this.key='';this.diagnosticKey=key;this.inferredKey='';
    this.onChange?.();await this.save(scope,'');
  }
  forgetDeleted(key) {
    const scope=this.syncScope();
    if(!key || key!==(this.key || this.diagnosticKey || this.inferredKey))return undefined;
    this.revision++;
    // Keep this window empty until the user selects another project.
    this.key='';this.diagnosticKey='';this.inferredKey='';this.skipFolderSelection=true;
    return this.save(scope,'',key);
  }
  clear() {this.revision++;this.key='';this.diagnosticKey='';this.inferredKey='';this.skipFolderSelection=false;this.scope=undefined;}
}

module.exports = {
  hasWorkspaceConfiguration,
  hasWorkspaceConfigFiles,
  existingWorkspaceConfig,
  prepareWorkspaceSetup,
  windowToolHome,
  workspaceSetupCard,
  promptWorkspaceCreation,
  pickWorkspaceSourceMode,
  WindowWorkspaceSelection,
  workspaceActions,
};
