(function () {
  const storageKey = `guthonBridgeTabOrder:${location.origin}`;
  const navSelector = '.el-tabs__nav[role="tablist"]';
  const tabSelector = '.el-tabs__item[role="tab"]';
  const classes = ['guthon-tab-sortable', 'guthon-tab-dragging', 'guthon-tab-drop-before', 'guthon-tab-drop-after'];

  function start() {
    const entries = new Map();
    const orders = new Map();
    let drag = null;
    let frame = null;
    let stopped = false;
    let mainChanged = false;
    let blockedDrag = false;

    function tabs(nav) {
      return Array.from(nav.children).filter(node => node.matches(tabSelector));
    }

    function movable(tab, kind) {
      return !tab.classList.contains('is-disabled') && (kind === 'main'
        ? /^tab-gdpaas_\w+$/.test(tab.id)
        : (kind === 'procedure' ? /^tab-PR-./ : /^tab-PG-./).test(tab.id));
    }

    function restoreAttributes(attributes) {
      for (const [tab, attrs] of attributes) {
        for (const [name, value] of Object.entries(attrs)) {
          if (value === null) tab.removeAttribute(name);
          else tab.setAttribute(name, value);
        }
        tab.classList.remove(...classes);
      }
    }

    // Move only header nodes. Panels and Vue's keyed editor instances stay intact.
    // Card tabs have no active underline whose position depends on pane order.
    function arrange(nav, ids, kind) {
      const current = tabs(nav);
      const rank = new Map(ids.map((id, index) => [id, index]));
      const sorted = current.filter(tab => movable(tab, kind))
        .sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
      const desired = Array.from(nav.children).map(node => movable(node, kind) ? sorted.shift() : node);
      const focused = document.activeElement;
      desired.forEach((node, index) => {
        if (nav.children[index] !== node) nav.insertBefore(node, nav.children[index]);
      });
      if (focused && nav.contains(focused) && document.activeElement !== focused) focused.focus({preventScroll: true});
    }

    function refresh() {
      frame = null;
      if (stopped) return;
      for (const [nav, entry] of entries) {
        if (!nav.isConnected) {
          if (drag?.nav === nav) finish();
          restoreAttributes(entry.attributes);
          entries.delete(nav);
        }
      }
      for (const nav of document.querySelectorAll(`#app-main-target ${navSelector}`)) {
        const owner = nav.closest('.el-tabs');
        if (!owner?.matches('.el-tabs--card, .el-tabs--border-card')
          || nav.closest('.el-dialog__wrapper, .gd-dialog-tab-page')) continue;
        const current = tabs(nav);
        const kind = nav.closest('.pageTabs') ? 'main'
          : nav.closest('.gd-layout-content-main') && current.length && current.every(tab => /^tab-PR-/.test(tab.id)) ? 'procedure'
          : nav.closest('.gd-layout-content-main') && current.length && current.every(tab => /^tab-PG-/.test(tab.id)) ? 'page' : null;
        if (!kind) continue;
        let entry = entries.get(nav);
        if (!entry) {
          entry = {kind, nativeOrder: [], attributes: new Map()};
          entries.set(nav, entry);
        }
        for (const [tab, attrs] of entry.attributes) {
          if (tab.parentElement === nav && movable(tab, kind)) continue;
          restoreAttributes([[tab, attrs]]);
          entry.attributes.delete(tab);
        }
        for (const tab of current) {
          if (!entry.nativeOrder.includes(tab.id)) entry.nativeOrder.push(tab.id);
          if (!movable(tab, kind) || entry.attributes.has(tab)) continue;
          entry.attributes.set(tab, {draggable: tab.getAttribute('draggable'), title: tab.getAttribute('title')});
          tab.classList.add('guthon-tab-sortable');
          tab.setAttribute('draggable', 'true');
          if (!tab.hasAttribute('title')) tab.setAttribute('title', '拖动调整标签顺序');
        }
        arrange(nav, orders.get(kind) || [], kind);
      }
    }

    function schedule(mutations) {
      if (!mutations.some(mutation => mutation.target.matches?.(navSelector)
        || [...mutation.addedNodes, ...mutation.removedNodes].some(node => node.nodeType === 1
          && (node.matches?.(navSelector) || node.querySelector?.(navSelector))))) return;
      if (frame === null && !stopped) frame = requestAnimationFrame(refresh);
    }

    function clearMarker() {
      drag?.target?.classList.remove('guthon-tab-drop-before', 'guthon-tab-drop-after');
      if (drag) drag.target = null;
    }

    function finish() {
      clearMarker();
      drag?.tab.classList.remove('guthon-tab-dragging');
      drag = null;
    }

    function onDragStart(event) {
      const tab = event.target.closest?.(tabSelector);
      const entry = entries.get(tab?.parentElement);
      if (!entry) return;
      if (blockedDrag || !movable(tab, entry.kind)) {
        event.preventDefault();
        return;
      }
      finish();
      drag = {tab, nav: tab.parentElement, kind: entry.kind, target: null, after: false, scrolledAt: 0};
      event.dataTransfer.setData('application/x-guthon-tab', tab.id);
      event.dataTransfer.effectAllowed = 'move';
      tab.classList.add('guthon-tab-dragging');
    }

    function onDragOver(event) {
      if (!drag) return;
      clearMarker();
      const wrap = drag.nav.closest('.el-tabs__nav-wrap');
      if (!wrap?.contains(event.target)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const rect = wrap.getBoundingClientRect();
      const direction = event.clientX < rect.left + 32 ? 'prev' : event.clientX > rect.right - 32 ? 'next' : null;
      if (direction && Date.now() - drag.scrolledAt > 180) {
        wrap.querySelector(`.el-tabs__nav-${direction}:not(.is-disabled)`)?.click();
        drag.scrolledAt = Date.now();
      }
      const target = event.target.closest?.(tabSelector);
      if (!target || target === drag.tab || target.parentElement !== drag.nav || !movable(target, drag.kind)) return;
      const bounds = target.getBoundingClientRect();
      drag.target = target;
      drag.after = event.clientX >= (bounds.left + bounds.right) / 2;
      target.classList.add(drag.after ? 'guthon-tab-drop-after' : 'guthon-tab-drop-before');
    }

    function onDrop(event) {
      if (!drag) return;
      const {tab, nav, kind, target, after} = drag;
      if (target && target.isConnected && tab.isConnected && event.target.closest?.(tabSelector) === target
        && target.parentElement === nav && tab.parentElement === nav) {
        event.preventDefault();
        // Do not let a platform drop handler interpret a header reorder as an editor drop.
        event.stopPropagation();
        const ids = tabs(nav).filter(node => movable(node, kind) && node !== tab).map(node => node.id);
        ids.splice(ids.indexOf(target.id) + (after ? 1 : 0), 0, tab.id);
        orders.set(kind, [...ids, ...(orders.get(kind) || []).filter(id => !ids.includes(id))]);
        arrange(nav, ids, kind);
        if (kind === 'main') {
          mainChanged = true;
          globalThis.chrome?.storage?.local?.set({[storageKey]: orders.get(kind).slice(0, 128)})
            .catch(error => console.warn('谷神桥接：标签顺序未能保存', error));
        }
      }
      finish();
    }

    function onKeyDown(event) {
      if (event.key === 'Escape') finish();
    }

    function onPointerDown(event) {
      blockedDrag = Boolean(event.target.closest?.('.el-icon-close, button, a, input'));
    }

    const listeners = [['pointerdown', onPointerDown], ['dragstart', onDragStart], ['dragover', onDragOver], ['drop', onDrop],
      ['dragend', finish], ['keydown', onKeyDown]];
    for (const [type, listener] of listeners) document.addEventListener(type, listener, true);
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {subtree: true, childList: true});
    refresh();
    globalThis.chrome?.storage?.local?.get(storageKey).then(result => {
      if (stopped || mainChanged) return;
      const ids = result[storageKey];
      if (!Array.isArray(ids) || ids.length > 128 || !ids.every(id => typeof id === 'string' && /^tab-gdpaas_\w+$/.test(id))) return;
      orders.set('main', [...new Set(ids)]);
      refresh();
    }).catch(error => console.warn('谷神桥接：标签顺序未能读取', error));

    return () => {
      stopped = true;
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      finish();
      for (const [type, listener] of listeners) document.removeEventListener(type, listener, true);
      for (const [nav, entry] of entries) {
        restoreAttributes(entry.attributes);
        if (nav.isConnected) arrange(nav, entry.nativeOrder, entry.kind);
      }
      entries.clear();
    };
  }

  globalThis.GuthonBridgeTabSorter = {start};
})();
