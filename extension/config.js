/* Add entries here to add independent label buttons. No OAuth or build required. */
globalThis.GmailDoneConfig = Object.freeze({
  actions: Object.freeze([
    Object.freeze({ id: "reply", label: "✉️要返信", undo: true, clears: Object.freeze(["✅処理済"]) }),
    Object.freeze({ id: "done", label: "✅処理済", undo: true, clears: Object.freeze(["✉️要返信"]) })
    // , Object.freeze({ id: "pending", label: "⏳保留" })
    // , Object.freeze({ id: "waiting", label: "👤相手待ち" })
  ])
});
