(function () {
  const pageIds = new Set([
    'gdpaas_sys_tables', 'gdpaas_dev_devLogsList', 'gdpaas_dev_partUpgrade',
    'gdpaas_dev_moduleConfigList', 'gdpaas_dev_systemscript',
    'gdpaas_sys_views', 'gdpaas_basesetup_scheduler', 'gdpaas_basesetup_billcode', 'gdpaas_basesetup_codes'
  ]);
  const prefix = 'guthon-layout-';

  function start() {
    const marked = new Map();
    let frame = null;
    let stopped = false;
    function visible(element) {
      // Vue v-show can hide an ancestor previously marked display:flex !important.
      for (let node = element; node; node = node.parentElement) {
        if (node.style.display === 'none') return false;
      }
      return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
    }
    function refresh() {
      frame = null;
      if (stopped) return;
      const desired = new Map();
      const mark = (element, role) => {
        if (!desired.has(element)) desired.set(element, new Set());
        desired.get(element).add(prefix + role);
      };
      const active = Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]'))
        .find(tab => visible(tab) && pageIds.has(tab.id.replace(/^tab-/, '')));
      // Version metadata may remain empty after reload; validate the known shell as well.
      const shell = document.querySelector('#app-main-target.gd-main-layout');
      const versionInfo = shell?.querySelector('.gs-version-info');
      const version = versionInfo?.textContent.match(/版本号\s*[:：]\s*(\d+)\.(\d+)/);
      const supportedVersion = version
        ? version[1] === '2' || (version[1] === '1' && version[2] === '5')
        : Boolean(shell?.querySelector(':scope > .menu-root')
          || (versionInfo && shell?.querySelector('.gd-template-menubar')
            && shell.querySelector('.layout-ceiling')));
      const supported = supportedVersion && shell?.querySelector('.pageTabs');
      const root = supported ? shell.querySelector('.gd-layout-content-main') : null;
      if (active && root && visible(root)) {
        const selector = active.id === 'tab-gdpaas_sys_tables'
          ? '.gd-page-data-table, .table-free-view' : '.gd-page-data-table';
        const lists = Array.from(root.querySelectorAll(selector))
          .filter(list => visible(list) && !list.closest('.el-dialog__wrapper, .gd-dialog-tab-page'))
          .filter(list => Array.from(list.children).some(child => list.matches('.table-free-view')
            ? child.matches('.table-context')
            : child.matches('.el-table') && child.querySelector('.el-table__header-wrapper')
              && child.querySelector('.el-table__body-wrapper')));
        for (const list of lists) {
          const cards = list.matches('.table-free-view');
          mark(list, cards ? 'column' : 'grid');
          if (!cards && ['tab-gdpaas_sys_views', 'tab-gdpaas_basesetup_scheduler', 'tab-gdpaas_basesetup_billcode', 'tab-gdpaas_basesetup_codes'].includes(active.id)) {
            mark(list, 'wide-grid');
          }
          for (let node = list.parentElement; node && root.contains(node); node = node.parentElement) {
            // Only a tree beside the list branch establishes a horizontal split.
            // A tree inside that branch must not turn its query/instructions parent into a row.
            const row = Array.from(node.children).some(child => !child.contains(list)
              && (child.matches('.tree-box, .system-tree, .datasource-tree')
                || Array.from(child.children).some(n => n.matches('.tree-box, .system-tree, .datasource-tree'))));
            mark(node, row ? 'row' : 'column');
            if (node === root) break;
          }
          for (const child of list.children) {
            if (cards && child.matches('.table-context')) mark(child, 'scroller');
            else if (child.matches('.el-table')) mark(child, 'table');
          }
        }
        if (lists.length) {
          mark(root, 'viewport');
          const height = `${Math.max(0, window.innerHeight - root.getBoundingClientRect().top)}px`;
          if (root.style.getPropertyValue('--guthon-layout-height') !== height) {
            root.style.setProperty('--guthon-layout-height', height);
          }
        }
      }
      for (const [element, classes] of marked) {
        for (const cls of classes) if (!desired.get(element)?.has(cls)) element.classList.remove(cls);
        if (classes.has(prefix + 'viewport') && !desired.get(element)?.has(prefix + 'viewport')) {
          element.style.removeProperty('--guthon-layout-height');
        }
      }
      for (const [element, classes] of desired) {
        for (const cls of classes) if (!element.classList.contains(cls)) element.classList.add(cls);
        if (classes.has(prefix + 'viewport') && !marked.has(element)) element.scrollTop = 0;
      }
      marked.clear();
      for (const entry of desired) marked.set(...entry);
    }
    function schedule() {
      if (frame === null && !stopped) frame = requestAnimationFrame(refresh);
    }
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['aria-selected', 'style']
    });
    window.addEventListener('resize', schedule);
    window.addEventListener('hashchange', schedule);
    window.addEventListener('popstate', schedule);
    refresh();
    return () => {
      stopped = true;
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('hashchange', schedule);
      window.removeEventListener('popstate', schedule);
      for (const [element, classes] of marked) {
        for (const cls of classes) element.classList.remove(cls);
        if (classes.has(prefix + 'viewport')) element.style.removeProperty('--guthon-layout-height');
      }
      marked.clear();
    };
  }
  globalThis.GuthonBridgePlatformLayout = { start };
})();
