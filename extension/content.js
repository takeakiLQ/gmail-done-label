(() => {
  "use strict";
  if (globalThis.__gmailDoneLoaded) return;
  globalThis.__gmailDoneLoaded = true;
  const actions = globalThis.GmailDoneConfig.actions;
  let busy = false;
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
        const button = document.createElement("button");
        button.type = "button";
        button.className = "gd-button";
        button.textContent = action.label;
        button.title = `開いているスレッド／選択メールに「${action.label}」を追加`;
        button.disabled = busy;
        button.addEventListener("click", event => {
          event.preventDefault();
          event.stopPropagation();
          void applyLabel(control, action.label);
        });
        group.append(button);
      }
      control.insertAdjacentElement("afterend", group);
    }
  }
  // Compare route, native control and selected row objects before every write.
  // No subject, sender or message body is extracted or persisted.
  function targetSnapshot(control) {
    const rows = all('[role="row"], tr.zA').filter(row => visible(row) &&
      (row.getAttribute("aria-selected") === "true" ||
       row.querySelector('[role="checkbox"][aria-checked="true"], input[type="checkbox"]:checked')));
    const main = control.closest('[role="main"]') || document.querySelector('[role="main"]');
    const thread = main?.querySelector('[data-thread-id], [data-legacy-thread-id], h2.hP');
    if (!rows.length && !thread) throw new Error("メールを開くか、一覧でチェックを付けてから操作してください。プレビュー画面は一覧の選択が対象です。");
    const route = location.href;
    return () => {
      const currentRows = all('[role="row"], tr.zA').filter(row => visible(row) &&
        (row.getAttribute("aria-selected") === "true" ||
         row.querySelector('[role="checkbox"][aria-checked="true"], input[type="checkbox"]:checked')));
      if (location.href !== route || !enabled(control) || rows.length !== currentRows.length ||
          rows.some((row, i) => row !== currentRows[i]) ||
          (!rows.length && (!thread.isConnected || !visible(thread)))) {
        throw new Error("操作中に対象が変わったため中止しました。対象を選び直してください。");
      }
    };
  }
  async function waitFor(check, timeout = 2500) {
    const until = Date.now() + timeout;
    do {
      const value = check();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < until);
    throw new Error("Gmailの表示を確認できませんでした。ラベルが付いたか確認し、画面を再読み込みしてください。");
  }
  const menuRoots = () => all('[role="menu"], .J-M').filter(visible);
  const rowsIn = menu => all('[role="menuitemcheckbox"], [role="checkbox"], .J-LC', menu)
    .filter(el => visible(el) && !el.parentElement.closest('[role="menuitemcheckbox"], .J-LC'));
  const state = row => row.getAttribute("aria-checked") ??
    row.querySelector('[aria-checked]')?.getAttribute("aria-checked") ??
    (row.classList.contains("J-Ks-KO") ? "true" : "unknown");
  const rowName = row => row.getAttribute("title") || row.getAttribute("aria-label") || text(row);
  function applyControl(menu) {
    return all('[role="menuitem"], [role="button"], button, .J-N', menu)
      .find(el => enabled(el) && /^(適用|Apply)$/i.test(text(el)));
  }
  function closeMenu(menu) {
    if (!visible(menu)) return;
    // Native Escape discards pending label-checkbox changes; never click Apply on failure.
    const target = menu.querySelector("input") || menu;
    for (const type of ["keydown", "keyup"]) {
      target.dispatchEvent(new KeyboardEvent(type, {
        key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true
      }));
    }
  }
  async function applyLabel(control, label) {
    if (busy) return;
    busy = true;
    all(".gd-button").forEach(button => { button.disabled = true; });
    let menu;
    let committed = false;
    try {
      if (menuRoots().length || all('[role="dialog"]').some(visible)) {
        throw new Error("開いているメニューやダイアログを閉じてから操作してください。");
      }
      const guard = targetSnapshot(control);
      guard();
      control.click();
      menu = await waitFor(() => menuRoots().find(root =>
        (rowsIn(root).length || root.querySelector('input[type="text"], input:not([type])')) && applyControl(root)));
      guard();
      const row = await waitFor(() => rowsIn(menu).find(item => rowName(item) === label), 1500)
        .catch(() => { throw new Error(`Gmailに「${label}」ラベルを作成してください（末尾の空白なし）。作成後はワンクリックで使えます。`); });
      const before = rowsIn(menu).map(item => ({ item, state: state(item) }));
      const original = state(row);
      if (!["true", "false", "mixed"].includes(original)) {
        throw new Error("ラベルのチェック状態を判別できないため中止しました。Gmail標準のラベル操作を使ってください。");
      }
      guard();
      if (original === "true") {
        closeMenu(menu);
        notice(`「${label}」は既に付いています。`);
        return;
      }
      row.click();
      await waitFor(() => state(row) === "true", 1000);
      guard();
      if (before.some(entry => entry.item !== row &&
          (!entry.item.isConnected || state(entry.item) !== entry.state))) {
        throw new Error("他のラベルの状態が変わったため中止しました。メニューを閉じ、選び直してください。");
      }
      const apply = applyControl(menu);
      if (!apply || !visible(row) || state(row) !== "true") {
        throw new Error("適用ボタンを特定できないため中止しました。Gmail標準のラベル操作を使ってください。");
      }
      guard();
      apply.click();
      committed = true;
      await waitFor(() => !visible(menu));
      notice(`「${label}」の適用操作を実行しました。Gmailのラベル表示をご確認ください。`);
    } catch (error) {
      if (!committed) closeMenu(menu);
      notice(error.message || "操作できませんでした。Gmail標準のラベル操作を使ってください。", true);
    } finally {
      busy = false;
      all(".gd-button").forEach(button => { button.disabled = false; });
      refresh();
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
