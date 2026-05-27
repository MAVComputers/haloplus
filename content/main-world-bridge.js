(function () {
  // Runs in the page's main world (manifest `world: "MAIN"`) so it can read
  // React's `_reactRootContainer` expando and Redux's store — both invisible
  // to the isolated-world content script.
  //
  // Two cross-world bridges, both via CustomEvent:
  //   `haloplus:navigate`     → React Router `history.push()` (replaces active tab, keeps SPA alive)
  //   `haloplus:open-new-tab` → Redux `ADD_NEW_TAB` (Halo Multi-Tab "open in new Halo tab")
  // See issue #3.

  let cachedHistory = null;
  let cachedStore = null;

  function walkFiber(rootEl) {
    const c = rootEl && rootEl._reactRootContainer;
    if (!c) return { history: null, store: null };
    let fiber = (c._internalRoot && c._internalRoot.current) || c.current;
    let depth = 0;
    let history = null;
    let store = null;
    while (fiber && depth < 25 && (!history || !store)) {
      const props = fiber.memoizedProps || {};
      if (!history && props.history && typeof props.history.push === 'function') {
        history = props.history;
      }
      if (!store && props.store && typeof props.store.dispatch === 'function') {
        store = props.store;
      }
      fiber = fiber.child;
      depth++;
    }
    return { history, store };
  }

  function ensureHaloInternals() {
    if (cachedHistory && cachedStore) return;
    const appContainer = document.getElementById('app-container');
    if (appContainer) {
      const r = walkFiber(appContainer);
      cachedHistory = cachedHistory || r.history;
      cachedStore = cachedStore || r.store;
      if (cachedHistory && cachedStore) return;
    }
    for (const el of document.querySelectorAll('#root, [id*="app"], main')) {
      const r = walkFiber(el);
      cachedHistory = cachedHistory || r.history;
      cachedStore = cachedStore || r.store;
      if (cachedHistory && cachedStore) return;
    }
    for (const el of document.querySelectorAll('*')) {
      if (!el._reactRootContainer) continue;
      const r = walkFiber(el);
      cachedHistory = cachedHistory || r.history;
      cachedStore = cachedStore || r.store;
      if (cachedHistory && cachedStore) return;
    }
  }

  function softNavigateFallback(path) {
    try {
      history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    } catch (_) {}
  }

  // HaloPlus generates list-view URLs like `/tickets?id=N`, but Halo's
  // ADD_NEW_TAB expects detail-view URLs like `/ticket?id=N&showmenu=true`
  // (singular, with showmenu). When dispatching to open a new tab we need
  // to translate plural → singular, otherwise the new tab is stuck loading
  // because it doesn't resolve to a detail route. Mirrors what Halo's own
  // right-click "Open in new Halo tab" does internally.
  function normalisePathForNewTab(rawPath) {
    let u;
    try { u = new URL(rawPath, window.location.origin); }
    catch (_) { return { pathname: rawPath, search: '' }; }
    const PLURAL_TO_SINGULAR = {
      '/tickets': '/ticket',
      '/assets': '/asset',
      '/customers': '/customer',
      '/sites': '/site',
      '/users': '/user',
      '/suppliers': '/supplier'
    };
    let pathname = u.pathname;
    const singular = PLURAL_TO_SINGULAR[pathname];
    if (singular && [...u.searchParams.keys()].some(k => /id$/i.test(k))) {
      pathname = singular;
    }
    if (!u.searchParams.has('showmenu')) {
      u.searchParams.set('showmenu', 'true');
    }
    return { pathname, search: u.search };
  }

  window.addEventListener('haloplus:navigate', function (e) {
    try {
      const path = e && e.detail && e.detail.path;
      if (!path) return;
      ensureHaloInternals();
      if (cachedHistory) {
        cachedHistory.push(path);
      } else {
        softNavigateFallback(path);
      }
    } catch (_) {}
  });

  window.addEventListener('haloplus:open-new-tab', function (e) {
    try {
      const path = e && e.detail && e.detail.path;
      if (!path) return;
      ensureHaloInternals();
      if (cachedStore) {
        cachedStore.dispatch({
          type: 'ADD_NEW_TAB',
          data: normalisePathForNewTab(path)
        });
      } else if (cachedHistory) {
        cachedHistory.push(path);
      } else {
        softNavigateFallback(path);
      }
    } catch (_) {}
  });
})();
