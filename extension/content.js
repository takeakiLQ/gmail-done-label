(() => {
  "use strict";
  if (globalThis.__gmailDoneLoaded) return;
  globalThis.__gmailDoneLoaded = true;
  const actions = globalThis.GmailDoneConfig.actions;
  let busy = false;
  let firstMenu = true;
  let noticeTimer;
  let refreshTimer;
  const visible = el => !!el && el.isConnected && el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== "hidden" && !el.closest('[aria-hidden="true"]');
  const text = el => (el?.textContent || "").trim();
  const enabled = el => visible(el) && el.getAttribute("aria-disabled") !== "true" && !el.disabled;
  const all = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const name = el => el.getAttribute("aria-label") || el.getAttribute("data-tooltip") || el.title || "";
  const labelControl = el => /^(ラベル(?:を付ける|を付ける：|を付ける:)?|ラベルを適用|Labels?|Label as)(?:\s*[:：]?\s*(?:\([^)]*\))?)?$/i.test(name(el).trim());
  function controls() {
    return all('[role="button"], button').filter(el => labelControl(el) && enabled(el) &&
      !el.closest('.gd-actions, [role="dialog"], [role="menu"], .AD, .M9'));
  }
  function notice(message, error = false) {
    document.getElementById("gd-notice")?.remove();
    clearTimeout(noticeTimer);
    const box = document.createElement("div");
    box.id = "gd-notice";
    box.setAttribute("role", error ? "alert" : "status");
    box.dataset.error = String(error);
    const body = document.createElement("span");
    body.textContent = message;
    const close = document.createElement("button");
    close.textContent = "×";
    close.setAttribute("aria-label", "通知を閉じる");
    close.addEventListener("click", () => box.remove());
    box.append(body, close);
    document.body.append(box);
    noticeTimer = setTimeout(() => box.remove(), error ? 20000 : 8000);
  }
  function hideCancelMenus() {
    all('.gd-cancel-menu').forEach(menu => { menu.hidden = true; });
    all('.gd-toggle').forEach(toggle => toggle.setAttribute('aria-expanded', 'false'));
  }
  document.addEventListener('pointerdown', event => {
    if (!event.target.closest?.('.gd-pair')) hideCancelMenus();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && event.target.closest?.('.gd-pair')) {
      const toggle = event.target.closest('.gd-pair').querySelector('.gd-toggle');
      hideCancelMenus(); toggle?.focus();
      event.stopPropagation();
    }
  });
  function refresh() {
    for (const group of all(".gd-actions")) {
      if (!group._control?.isConnected || !enabled(group._control)) group.remove();
    }
    for (const control of controls()) {
      if (all(".gd-actions").some(group => group._control === control)) continue;
      const group = document.createElement("span");
      group.className = "gd-actions";
      group._control = control;
      for (const action of actions) {
        const pair = document.createElement("span");
        pair.className = "gd-pair";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "gd-button";
        button.dataset.action = action.id;
        button.textContent = action.label;
        button.title = `開いているスレッド／選択メールに「${action.label}」を付ける`;
        button.disabled = busy;
        button.addEventListener("click", event => {
          event.preventDefault(); event.stopPropagation();
          hideCancelMenus();
          void applyLabel(control, action, false);
        });
        pair.append(button);
        if (action.undo) {
          const toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "gd-toggle";
          toggle.dataset.action = action.id;
          toggle.textContent = "▾";
          toggle.setAttribute("aria-label", `${action.label}の操作メニュー`);
          toggle.setAttribute("aria-haspopup", "menu");
          toggle.setAttribute("aria-expanded", "false");
          toggle.disabled = busy;
          const menu = document.createElement("span");
          menu.className = "gd-cancel-menu";
          menu.setAttribute("role", "menu");
          menu.hidden = true;
          const cancel = document.createElement("button");
          cancel.type = "button";
          cancel.className = "gd-undo";
          cancel.setAttribute("role", "menuitem");
          cancel.textContent = "このラベルを外す";
          cancel.setAttribute("aria-label", `${action.label}を外す`);
          cancel.addEventListener("click", event => {
            event.preventDefault(); event.stopPropagation();
            hideCancelMenus();
            void applyLabel(control, action, true);
          });
          menu.append(cancel);
          toggle.addEventListener("click", event => {
            event.preventDefault(); event.stopPropagation();
            const opening = menu.hidden;
            hideCancelMenus();
            menu.hidden = !opening;
            toggle.setAttribute("aria-expanded", String(opening));
            if (opening) {
              const rect = toggle.getBoundingClientRect();
              menu.style.left = `${Math.max(8, Math.min(rect.right - 170, innerWidth - 178))}px`;
              menu.style.top = `${Math.min(rect.bottom + 5, innerHeight - 60)}px`;
              cancel.focus();
            }
          });
          pair.append(toggle, menu);
        }
        group.append(pair);
      }
      control.insertAdjacentElement("afterend", group);
    }
  }
  // Compare route and target identities before every write. Gmail may replace
  // row elements during redraw; use its stable IDs when available.
  // No subject, sender or message body is extracted or persisted.
  function targetSnapshot(control) {
    const selectedRows = () => all('[role="row"], tr.zA').filter(row => visible(row) &&
      !row.closest('[role="menu"], .J-M, [role="dialog"]') &&
      (row.getAttribute("aria-selected") === "true" ||
       row.querySelector('[role="checkbox"][aria-checked="true"], input[type="checkbox"]:checked')));
    const identity = row => {
      for (const attr of ['data-legacy-thread-id', 'data-thread-id', 'data-legacy-message-id', 'data-message-id']) {
        const value = row.getAttribute(attr) || row.querySelector(`[${attr}]`)?.getAttribute(attr);
        if (value) return `${attr}:${value}`;
      }
      return row;
    };
    const rows = selectedRows();
    const keys = rows.map(identity);
    const main = control.closest('[role="main"]') || document.querySelector('[role="main"]');
    const findThread = () => main && all('[data-thread-id], [data-legacy-thread-id], h2.hP', main)
      .find(visible);
    const thread = findThread();
    const threadKey = thread && identity(thread);
    if (!rows.length && !thread) throw new Error("メールを開くか、一覧でチェックを付けてから操作してください。プレビュー画面は一覧の選択が対象です。");
    const route = location.href;
    return () => {
      const currentKeys = selectedRows().map(identity);
      const currentThread = !rows.length && findThread();
      // A heading is display content, not a durable target identity. If Gmail
      // supplied a stable ID compare it; otherwise use unchanged route and a
      // current visible thread, rather than the old heading DOM object.
      const threadChanged = !rows.length && (!currentThread ||
        (typeof threadKey === 'string' && identity(currentThread) !== threadKey));
      const reason = location.href !== route ? '画面移動' :
        !control.isConnected || !visible(control) ? 'ツールバー更新' :
        keys.length !== currentKeys.length || keys.some(key => !currentKeys.includes(key)) ? 'メール選択変更' :
        threadChanged ? 'スレッド対象変更' : '';
      if (reason) {
        throw new Error(`操作中に対象の変更を検出したため中止しました（${reason}）。Gmailのラベル表示を確認してください。`);
      }
    };
  }
  async function waitFor(check, timeout = 2500, message = "Gmailの表示を確認できませんでした。ラベルが付いたか確認し、画面を再読み込みしてください。") {
    const until = Date.now() + timeout;
    do {
      const value = check();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < until);
    throw new Error(message);
  }
  // Gmail controls can react to mouse down/up rather than a click event alone.
  // Emit one normal mouse sequence, without retrying an action that may have applied.
  function activate(el) {
    const rect = el.getBoundingClientRect();
    el.focus({ preventScroll: true });
    for (const type of ["mousedown", "mouseup", "click"]) {
      el.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window, button: 0,
        buttons: type === "mousedown" ? 1 : 0,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
      }));
    }
  }
  const menuRoots = () => all('[role="menu"], .J-M').filter(visible);
  const rowsIn = menu => all('[role="menuitemcheckbox"], [role="checkbox"], .J-LC', menu)
    .filter(el => visible(el) && !el.parentElement.closest('[role="menuitemcheckbox"], .J-LC'));
  const state = row => row.getAttribute("aria-checked") ??
    row.querySelector('[aria-checked]')?.getAttribute("aria-checked") ??
    (row.classList.contains("J-Ks-KO") ? "true" : "unknown");
  const rowName = row => row.getAttribute("title") || row.getAttribute("aria-label") || text(row);
  // Click the label text, rather than its checkbox/container. Some menus only
  // commit and dismiss when the label name is the actual event target.
  function labelTarget(row, label) {
    const candidates = all('.J-LC-Jz, span, div', row).filter(el =>
      visible(el) && text(el) === label && !el.matches('[role="checkbox"], input') &&
      !el.closest('.J-LC-Jo'));
    return candidates.find(el => !candidates.some(child => child !== el && el.contains(child))) || row;
  }
  function applyControl(menu, requireEnabled = true) {
    return all('[role="menuitem"], [role="button"], button, .J-N', menu)
      .find(el => (requireEnabled ? enabled(el) : visible(el)) && /^(適用|Apply)$/i.test(text(el)));
  }
  async function dismissWithControl(menu, control, route) {
    if (location.href !== route || !enabled(control)) return false;
    // Return focus to the native toggle. If blur/focus already dismisses the
    // menu, stop before sending a mouse event that could reopen it.
    control.focus({ preventScroll: true });
    if (await waitFor(() => !visible(menu), 200).then(() => true, () => false)) return true;
    for (const type of ['mousedown', 'mouseup', 'click']) {
      if (!visible(menu)) return true;
      if (location.href !== route || !enabled(control)) return false;
      const rect = control.getBoundingClientRect();
      control.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window, button: 0,
        buttons: type === 'mousedown' ? 1 : 0,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
      }));
      if (await waitFor(() => !visible(menu), firstMenu ? 600 : 200).then(() => true, () => false)) return true;
    }
    return !visible(menu);
  }
  async function closeMenu(menu, control, route, discard = false) {
    if (!visible(menu)) return true;
    // Successful operations close with the same native toggle that opened it.
    // Failed, uncommitted operations must discard pending changes first.
    if (!discard && location.href === route && enabled(control)) {
      if (await dismissWithControl(menu, control, route)) return true;
    }
    // Escape can discard pending changes in an Apply-based menu, but cannot undo
    // changes already saved by an immediate-apply menu.
    const target = menu.querySelector("input") || menu;
    target.focus({ preventScroll: true });
    for (const type of ["keydown", "keyup"]) {
      target.dispatchEvent(new KeyboardEvent(type, {
        key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true
      }));
    }
    await new Promise(resolve => setTimeout(resolve, 80));
    // Never click a label again to dismiss: that can reverse the saved change.
    if (discard && visible(menu) && location.href === route && enabled(control)) {
      await dismissWithControl(menu, control, route);
    }
    return waitFor(() => !visible(menu), 1000).then(() => true, () => false);
  }
  async function applyLabel(control, action, remove = false) {
    if (busy) return;
    busy = true;
    document.getElementById("gd-notice")?.remove();
    clearTimeout(noticeTimer);
    all(".gd-button, .gd-toggle, .gd-undo").forEach(button => { button.disabled = true; });
    let completed = 0;
    try {
      const guard = targetSnapshot(control);
      const clears = remove ? [] : [...new Set(action.clears || [])].filter(label => label !== action.label);
      const required = [action.label, ...clears];
      for (const label of clears) {
        if (!await applyOne(control, label, true, guard, required, true)) return;
        completed++;
      }
      if (!await applyOne(control, action.label, remove, guard, required) && completed) {
        const errorText = document.querySelector('#gd-notice span')?.textContent || '';
        notice(`状態の切替が途中で止まりました。前のラベルは外す操作済みです。${errorText}`, true);
      }
    } catch (error) {
      notice(error.message, true);
    } finally {
      busy = false;
      all(".gd-button, .gd-toggle, .gd-undo").forEach(button => { button.disabled = false; });
      refresh();
    }
  }
  async function applyOne(control, label, remove, guard, required, silent = false) {
    const desired = remove ? "false" : "true";
    const operation = remove ? "取り消し" : "追加";
    let menu;
    let committed = false;
    const menuRoute = location.href;
    async function finish(message) {
      const closed = await closeMenu(menu, control, menuRoute);
      if (!silent) notice(closed ? message : `${message} メニューが残る場合はGmail標準のラベルボタンで閉じてください。`);
    }
    try {
      if (menuRoots().length || all('[role="dialog"]').some(visible)) {
        throw new Error("開いているメニューやダイアログを閉じてから操作してください。");
      }
      guard();
      activate(control);
      menu = await waitFor(() => menuRoots().find(root =>
        rowsIn(root).length > 0),
        4000, "ラベル選択メニューを認識できませんでした（メニュー検出）。Gmail標準のラベルボタンでメニューが開くか確認してください。");
      // The first menu after a page load may install handlers and autofocus
      // after its rows appear. Give that initialization time before any write.
      if (firstMenu) await new Promise(resolve => setTimeout(resolve, 350));
      guard();
      for (const needed of required) {
        if (!rowsIn(menu).some(item => rowName(item) === needed)) {
          throw new Error(`Gmailに「${needed}」ラベルを作成してください（空白なし・名前を完全一致）。ラベルは変更していません。`);
        }
      }
      const row = await waitFor(() => rowsIn(menu).find(item => rowName(item) === label), 1500)
        .catch(() => { throw new Error(`Gmailに「${label}」ラベルを作成してください（末尾の空白なし）。作成後はワンクリックで使えます。`); });
      const before = rowsIn(menu).map(item => ({ item, state: state(item) }));
      const original = state(row);
      if (!["true", "false", "mixed"].includes(original)) {
        throw new Error("ラベルのチェック状態を判別できないため中止しました。Gmail標準のラベル操作を使ってください。");
      }
      guard();
      if (original === desired) {
        await finish(remove ? `「${label}」は付いていません。` : `「${label}」は既に付いています。`);
        return true;
      }
      activate(labelTarget(row, label));
      await waitFor(() => state(row) === desired || (original === "mixed" && ["true", "false"].includes(state(row))), 1500,
        "「処理済」のチェック状態を確認できませんでした（チェック確認）。Gmailのラベル表示を確認してください。");
      if (original === "mixed" && state(row) !== desired) {
        guard();
        if (!visible(menu)) throw new Error("メニューが閉じたため追加操作は中止しました。Gmailのラベル表示をご確認ください。");
        activate(labelTarget(row, label));
        await waitFor(() => state(row) === desired, 1500,
          "ラベルの取り消し状態を確認できませんでした。Gmailのラベル表示を確認してください。");
      }
      // The label click can commit, close the menu, clear selection and redraw
      // the toolbar at once. No further write follows, so do not interpret this
      // post-commit redraw as a pre-write target change or retry the label.
      if (!visible(menu)) {
        committed = true;
        if (!silent) notice(`「${label}」の${operation}操作を実行しました。Gmailのラベル表示をご確認ください。`);
        return true;
      }
      guard();
      if (before.some(entry => entry.item !== row &&
          (!entry.item.isConnected || state(entry.item) !== entry.state))) {
        throw new Error("他のラベルの状態が変わったため中止しました。メニューを閉じ、選び直してください。");
      }
      // Some Gmail layouts only render Apply after changing a checkbox.
      // Do not require it to exist when identifying the initial label menu.
      const apply = await waitFor(() => applyControl(menu) || (!visible(menu) && "closed"), 1000)
        .catch(() => null);
      if (apply === "closed") {
        committed = true;
        if (!silent) notice(`「${label}」の${operation}操作を実行しました。Gmailのラベル表示をご確認ください。`);
        return true;
      }
      if (!apply && !applyControl(menu, false) && state(row) === desired) {
        // Current Gmail can save each checkbox change immediately, keep the
        // menu open and never show Apply. Close it after confirming the check.
        guard();
        committed = true;
        await finish(`「${label}」の${operation}操作を実行しました。Gmailのラベル表示をご確認ください。`);
        return true;
      }
      if (!apply || !visible(row) || state(row) !== desired) {
        throw new Error("適用ボタンを特定できないため中止しました。Gmail標準のラベル操作を使ってください。");
      }
      guard();
      activate(apply);
      committed = true;
      await finish(`「${label}」の${operation}操作を実行しました。Gmailのラベル表示をご確認ください。`);
      return true;
    } catch (error) {
      if (!committed) await closeMenu(menu, control, menuRoute, true);
      notice(error.message || "操作できませんでした。Gmail標準のラベル操作を使ってください。", true);
      return false;
    } finally {
      if (menu && !visible(menu)) firstMenu = false;
    }
  }
  const observer = new MutationObserver(records => {
    if (records.every(record => record.target.closest?.('.gd-actions, #gd-notice'))) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 120);
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true,
    attributeFilter: ["aria-disabled", "aria-checked", "aria-selected", "style", "class", "aria-label"] });
  window.addEventListener("hashchange", refresh);
  refresh();
})();
