(function () {
  // Runs in the page's main world (manifest `world: "MAIN"`) so it can read
  // React's internal fiber tree and Redux's store — both invisible to the
  // isolated-world content script.
  //
  // Two cross-world bridges, both via CustomEvent:
  //   `haloplus:navigate`     → React Router `history.push()` (replaces active tab, keeps SPA alive)
  //   `haloplus:open-new-tab` → Redux `ADD_NEW_TAB` (Halo Multi-Tab "open in new Halo tab")
  // See issue #3.
  //
  // Each request carries a `nonce`. We answer on `haloplus:nav-result` with
  // `{ nonce, ok }` so the content script can tell whether SPA navigation
  // actually happened and hard-navigate when it didn't. Without that signal a
  // failed lookup was a silent no-op — see issue #4.

  const MAX_FIBER_NODES = 20000;

  let cachedHistory = null;
  let cachedStore = null;

  // React 16/17 exposed `_reactRootContainer` on the host element. React 18
  // dropped it for per-element expandos: `__reactContainer$<hash>` on the root
  // node and `__reactFiber$<hash>` on every rendered element. Halo ships
  // React 18 on current builds, so checking only the legacy property found
  // nothing and palette navigation became a no-op (issue #4).
  function fiberFromElement(el) {
    if (!el) return null;
    const legacy = el._reactRootContainer;
    if (legacy) {
      const f = (legacy._internalRoot && legacy._internalRoot.current) || legacy.current;
      if (f) return f;
    }
    let keys;
    try { keys = Object.keys(el); } catch (_) { return null; }
    for (const key of keys) {
      if (key.charCodeAt(0) !== 95) continue;
      if (key.lastIndexOf('__reactContainer$', 0) === 0 || key.lastIndexOf('__reactFiber$', 0) === 0) {
        const f = el[key];
        if (f) return f;
      }
    }
    return null;
  }

  // `__reactFiber$` on an arbitrary element lands us mid-tree. Climb to the
  // host root so the search below covers the whole app, not just one subtree.
  function rootOf(fiber) {
    let f = fiber;
    let guard = 0;
    while (f && f.return && guard < MAX_FIBER_NODES) {
      f = f.return;
      guard++;
    }
    return f;
  }

  // Full depth-first walk over child *and* sibling links. The previous version
  // followed `fiber.child` only, 25 levels deep, so anything held on a sibling
  // branch or below a deep provider stack was unreachable.
  function searchFiber(rootFiber) {
    let history = null;
    let store = null;
    const stack = [rootFiber];
    let visited = 0;
    while (stack.length && visited < MAX_FIBER_NODES && (!history || !store)) {
      const fiber = stack.pop();
      if (!fiber) continue;
      visited++;
      const props = fiber.memoizedProps;
      if (props) {
        if (!history) {
          // `history` is React Router v5; `navigator` is the v6 equivalent.
          // Context providers hang the same objects off `value`.
          const h = props.history || props.navigator ||
                    (props.value && (props.value.history || props.value.navigator));
          if (h && typeof h.push === 'function') history = h;
        }
        if (!store) {
          const s = props.store || (props.value && props.value.store);
          if (s && typeof s.dispatch === 'function') store = s;
        }
      }
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }
    return { history, store };
  }

  function absorb(fiber) {
    if (!fiber) return;
    const r = searchFiber(rootOf(fiber));
    cachedHistory = cachedHistory || r.history;
    cachedStore = cachedStore || r.store;
  }

  function ensureHaloInternals() {
    if (cachedHistory && cachedStore) return;
    const appContainer = document.getElementById('app-container');
    if (appContainer) {
      absorb(fiberFromElement(appContainer));
      if (cachedHistory && cachedStore) return;
    }
    for (const el of document.querySelectorAll('#root, [id*="app"], main')) {
      absorb(fiberFromElement(el));
      if (cachedHistory && cachedStore) return;
    }
    // Last resort: any element carrying a React expando gets us into the tree,
    // and rootOf() climbs to the host root before searching. One hit therefore
    // covers the entire app — no point scanning further elements.
    for (const el of document.querySelectorAll('body *')) {
      const fiber = fiberFromElement(el);
      if (!fiber) continue;
      absorb(fiber);
      return;
    }
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

  function respond(nonce, ok) {
    if (!nonce) return;
    try {
      window.dispatchEvent(new CustomEvent('haloplus:nav-result', {
        detail: { nonce: nonce, ok: !!ok }
      }));
    } catch (_) {}
  }

  window.addEventListener('haloplus:navigate', function (e) {
    const detail = (e && e.detail) || {};
    const nonce = detail.nonce;
    try {
      const path = detail.path;
      if (!path) { respond(nonce, false); return; }
      ensureHaloInternals();
      if (!cachedHistory) {
        // No router reachable. Report failure rather than attempting the old
        // pushState + popstate dance, which Halo's router ignores and which
        // left the URL rewritten but the view unchanged. The content script
        // does a hard navigation instead, as v1.3.0 did.
        respond(nonce, false);
        return;
      }
      cachedHistory.push(path);
      respond(nonce, true);
    } catch (_) {
      respond(nonce, false);
    }
  });

  window.addEventListener('haloplus:open-new-tab', function (e) {
    const detail = (e && e.detail) || {};
    const nonce = detail.nonce;
    try {
      const path = detail.path;
      if (!path) { respond(nonce, false); return; }
      ensureHaloInternals();
      if (cachedStore) {
        cachedStore.dispatch({
          type: 'ADD_NEW_TAB',
          data: normalisePathForNewTab(path)
        });
        respond(nonce, true);
      } else if (cachedHistory) {
        cachedHistory.push(path);
        respond(nonce, true);
      } else {
        respond(nonce, false);
      }
    } catch (_) {
      respond(nonce, false);
    }
  });
})();
