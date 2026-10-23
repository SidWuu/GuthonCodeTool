/* Original designer integration; online APIs and business execution stay unavailable. */
(() => {
  window.location.hash = '/dev-root';
  const api = acquireVsCodeApi(), copy = value => JSON.parse(JSON.stringify(value));
  const status = text => { document.getElementById('offline-status').textContent = text; };
  const post = message => api.postMessage(message);
  let vm, incoming, version, baseline, loading = false, waiting = false, generation = 0;
  const missingApis = new Set();
  function evidence() {
    document.getElementById('native-evidence').textContent = `${incoming?.resourceApp || '原版资源'} · 清单 ${(incoming?.resourceDigest || '').slice(0, 12)} · SVN ${incoming?.baseRevision || '未知'} · ${incoming?.resourceStatus || '平台版本未核验'} · 系统样式与运行效果未核验${missingApis.size ? ' · 缺失接口 ' + [...missingApis].join('、') : ''}`;
  }
  const context = () => vm?.$refs.workAreaPage?.page?.getPageContext(true);
  const dialogs = () => [...document.querySelectorAll('.el-dialog__wrapper')].filter(item => getComputedStyle(item).display !== 'none');
  async function load(message) {
    incoming = message;
    if (!vm) return;
    const loadId = ++generation; loading = true; waiting = false; baseline = null; version = message.version;
    document.getElementById('native-title').textContent = [message.pageName || message.data.pageName, message.data.pageId].filter(Boolean).join(' · ');
    document.getElementById('native-mode').textContent = message.before ? '上次本地保存 · 只读' : '当前草稿';
    document.getElementById('native-compare').textContent = message.before ? '返回当前草稿' : '查看修改前';
    document.getElementById('native-save').disabled = !message.editable;
    evidence();
    vm.isLoadOk = false; await vm.$nextTick();
    vm.$store.commit('putDevSystemId', message.systemId || 'offline');
    vm.$store.commit('putDevCurDataSourceId', 'offline');
    const localData = copy(message.data);
    const normalizeLists = value => {
      if (!value || typeof value !== 'object') return;
      if (value.datasource && typeof value.datasource === 'object' && value.datasource.fields === undefined)
        value.datasource.fields = []; // Absent metadata stays an empty list, never invented fields.
      Object.values(value).forEach(normalizeLists);
    };
    normalizeLists(localData);
    vm.initPage(JSON.stringify(localData));
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      if (loadId !== generation) return;
      if (vm.$refs.workAreaPage?.version && context()) {
        vm.$refs.workAreaPage.isCheckOut = message.editable !== false;
        baseline = copy(context()); loading = false;
        post({type: 'nativeBaseline', version, baseline});
        status('本地设计视图 · 仅已有属性/事件/SQL与同容器排序 · 不执行业务脚本 · Ctrl+S 保存本地'); return;
      }
    }
    loading = false; status('原版设计器初始化失败，请使用本地结构视图');
  }
  function sendEdit(save = false) {
    if (loading || waiting || !baseline || dialogs().length || incoming?.before || incoming?.editable === false) return;
    const candidate = context();
    if (JSON.stringify(candidate) === JSON.stringify(baseline)) {
      if (save) post({type: 'nativeSave', version});
      return;
    }
    waiting = true;
    post({type: 'nativeCandidate', version, candidate: copy(candidate), save});
  }
  window.GuthonOfflineDesigner = ({Vue, api: platformApi, config, script, validators}) => {
    const known = new Map([
      ['common.getCssFileList', {files: []}], ['common.login.getSystemInitVar', {cloudpath: '', debuggerUrl: '', devConstants: {}}],
      ['common.loadAllCodes', {codes: {}}], ['common.loadCodes', {codes: []}], ['common.getSetting', {value: ''}],
      ['basesetup.fieldTemplate.getAllList', {list: []}], ['common.getCodesTitles', {list: []}],
      ['systems.resourcefile.getSystemResourceFiles', {list: []}], ['develop.uicomp.getCompNames', {list: []}],
      ['debugConfig.getScriptDebugCache', {list: [], lineNumbers: []}],
    ]);
    function replace(object, prefix = '') {
      for (const key of Object.keys(object)) {
        const name = prefix ? prefix + '.' + key : key;
        if (typeof object[key] === 'function') object[key] = (...args) => {
          let value = known.get(name);
          if (name === 'develop.pages.getPageBaseInfo') value = {page: {pageId: incoming?.data.pageId,
            pageType: incoming?.data.pageType, version: 1, systemId: 'offline', checkOutUserId: 'offline'}};
          if (value === undefined) { missingApis.add(name); evidence(); status('离线接口未支持：' + name); return; }
          const callback = args.find(item => typeof item === 'function');
          if (callback) queueMicrotask(() => callback(copy(value)));
        };
        else if (object[key] && typeof object[key] === 'object') replace(object[key], name);
      }
    }
    replace(platformApi);
    for (const validator of validators) validator.checkGdpaasScript = (_, callback) => callback?.();
    script.getUserId = () => 'offline'; script.getUser = () => ({userId: 'offline', userName: '本地编辑', isAdmin: 1});
    script.checkLogin = (_, callback) => callback?.();
    script.initPageCodes = script.initListCodes = (_, __, callback) => callback?.([]);
    config.CLOUD_PATH = ''; config.WEB_SOCKET_PATH = '';
    Vue.http.interceptors.unshift((request, next) => next(request.respondWith(
      JSON.stringify({code: 1, message: '本地设计器不调用平台接口'}), {status: 200, headers: {'Content-Type': 'application/json'}})));
    const sources = JSON.parse(document.getElementById('workers').textContent);
    window.MonacoEnvironment = {getWorker(_, label) {
      const source = sources[['javascript', 'typescript'].includes(label) ? 'ts.worker.js' : 'editor.worker.js'];
      const url = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
      const worker = new Worker(url); setTimeout(() => URL.revokeObjectURL(url), 10000); return worker;
    }};
    Vue.mixin({beforeCreate() {
      const methods = {...this.$options.methods};
      if (this.$options.props?.isIframe && methods.initPage && methods.save) methods.save = () => sendEdit(true);
      if (['dev-root', 'iframe-develop-root'].includes(this.$options.name)) {
        methods.postMessage = message => { if (message.type === 'ready') { vm = this; if (incoming) void load(incoming); else post({type: 'nativeReady'}); } };
        methods.onIframeSave = () => sendEdit(true);
        methods.resize = function () {
          const shell = document.getElementById('native-stage');
          const requested = Number(document.getElementById('native-width').value);
          const width = requested >= 640 && requested <= 7680 ? requested : document.documentElement.clientWidth;
          shell.style.width = width + 'px';
          this.workAreaHeight = Math.max(200, document.documentElement.clientHeight - shell.getBoundingClientRect().top + 32);
          this.workAreaWidth = width - 500;
        };
      }
      if (methods.loadCssFile) methods.loadCssFile = () => {};
      this.$options.methods = methods;
    }});
  };
  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'nativeTitle') {
      if (incoming) incoming.pageName=message.pageName;
      document.getElementById('native-title').textContent=[message.pageName,message.pageId].filter(Boolean).join(' · ');
    }
    if (message?.type === 'nativeDocument') void load(message);
    if (message?.type === 'nativeError') { waiting = true; status(message.error + '；当前输入保留，请导出或关闭后重开'); }
  });
  // Opening a settings dialog synthesizes platform defaults. Capture the
  // initialized model before typing, so merely opening it never creates edits.
  let opened = false;
  new MutationObserver(() => {
    const visible = dialogs().length > 0;
    if(visible !== opened)post({type:'nativeEditState',version,unconfirmed:visible});
    if (visible && !opened && baseline && !loading && !waiting) {
      baseline = copy(context());
      // A field settings form can hold initialized defaults outside the live
      // page context until OK. Include those defaults before any typing.
      let owner = dialogs()[0]?.__vue__;
      while (owner && !owner.$refs?.gdInputArea) owner = owner.$parent;
      const form = owner?.$refs.gdInputArea?.form, id = owner?.field?.id;
      if (form && id) {
        const initialized = copy(form);
        if (Array.isArray(initialized.validId)) initialized.validId = initialized.validId.length ? initialized.validId.join(';') + ';' : '';
        if (owner.form?.pageEvents) initialized.pageEvents = copy(owner.form.pageEvents);
        const visit = value => {
          if (!value || typeof value !== 'object') return;
          if (Array.isArray(value.fields)) for (const field of value.fields) if (field.id === id) Object.assign(field, initialized);
          Object.values(value).forEach(child => { if (child && typeof child === 'object') visit(child); });
        };
        visit(baseline);
      }
      post({type: 'nativeBaseline', version, baseline});
    }
    opened = visible;
  }).observe(document.body, {subtree: true, attributes: true, childList: true});
  let editTimer;
  for (const event of ['click', 'change', 'dragend', 'pointerup']) document.addEventListener(event, () => {
    clearTimeout(editTimer); editTimer = setTimeout(() => sendEdit(), 30);
  }, true); // Platform controls stop bubbling; observe after their Vue updates.
  document.getElementById('native-save').addEventListener('click', () => sendEdit(true));
  document.getElementById('native-compare').addEventListener('click', () => {
    if (waiting || dialogs().length) { status('请先确认当前设置，再切换比较画面'); return; }
    if (baseline && JSON.stringify(context()) !== JSON.stringify(baseline) && !incoming?.before) {
      sendEdit(); status('正在同步修改，请完成后再次切换'); return;
    }
    post({type:'nativeCompare',version});
  });
  document.getElementById('native-manager').addEventListener('click', () => post({type:'nativeManager'}));
  document.getElementById('native-platform').addEventListener('click', () => post({type:'nativePlatform'}));
  document.getElementById('native-resources').addEventListener('click', () => {
    if(waiting || dialogs().length) {status('请先确认或取消当前设置，再管理资源');return;}
    if(baseline && JSON.stringify(context())!==JSON.stringify(baseline) && !incoming?.before) {
      sendEdit();status('正在同步修改，请完成后再次管理资源');return;
    }
    post({type:'nativeResources'});
  });
  for (const event of ['change', 'input']) document.getElementById('native-width').addEventListener(event, () => {
    const requested = Number(document.getElementById('native-width').value);
    if (requested >= 640 && requested <= 7680) document.getElementById('native-stage').style.width = requested + 'px';
    vm?.resize();
  });
  window.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); sendEdit(true); } }, true);
  window.addEventListener('error', event => status('设计器错误：' + event.message));
})();
