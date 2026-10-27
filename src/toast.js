// Tiny pub-sub so any component can fire a toast without prop drilling.
let listeners = []

// opts: { action, onAction, duration } — action is a button label (e.g. "Undo"),
// onAction runs when it's tapped, duration overrides the default auto-dismiss time.
export function showToast(message, kind = 'info', opts = {}) {
  const id = Date.now() + Math.random()
  listeners.forEach(fn => fn({ id, message, kind, action: opts.action, onAction: opts.onAction, duration: opts.duration }))
  return id
}

export function subscribeToast(fn) {
  listeners.push(fn)
  return () => { listeners = listeners.filter(l => l !== fn) }
}
