(function (root) {
  const PAGE_ID = /^PG-[A-Za-z0-9-]{1,96}$/;
  const PROCEDURE_ALIAS = /^[A-Za-z_$][A-Za-z0-9_.$]{0,255}$/;
  const FUNCTION_ID = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
  const EXTENSION_URI = 'vscode://gushen-local.guthon-nexus-vscode';

  function build(target) {
    if (target?.mode === 'page-source') {
      const pageId = String(target.pageId || '').trim();
      if (!PAGE_ID.test(pageId)) throw new Error('当前页面没有有效的 PAGE ID');
      return {
        type: 'page',
        uri: `${EXTENSION_URI}/locate-page?pageId=${encodeURIComponent(pageId)}`,
        description: `PAGE ${pageId}`,
      };
    }
    if (!target?.mode || target.mode === 'procedure') {
      const alias = String(target?.procedureKeyword || '').trim();
      const funId = String(target?.funId || '').trim();
      if (!PROCEDURE_ALIAS.test(alias) || !FUNCTION_ID.test(funId)) {
        throw new Error('当前过程函数缺少有效的包名或函数名');
      }
      return {
        type: 'procedure',
        uri: `${EXTENSION_URI}/locate-procedure?alias=${encodeURIComponent(alias)}&funId=${encodeURIComponent(funId)}`,
        description: `${alias}.${funId}`,
      };
    }
    throw new Error('当前对象暂不支持在 Nexus 中定位');
  }

  function isSupported(target) {
    try {
      build(target);
      return true;
    } catch {
      return false;
    }
  }

  const locator = { build, isSupported };
  root.GuthonBridgeNexusLocator = locator;
  if (typeof module === 'object' && module.exports) module.exports = locator;
})(globalThis);
