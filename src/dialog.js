// Promise-based pub-sub for an in-app confirm/alert modal, so popups match the
// app's own glass UI instead of the browser's native alert()/confirm() chrome.
let listeners = []

function request(kind, message) {
  return new Promise(resolve => {
    const id = Date.now() + Math.random()
    listeners.forEach(fn => fn({ id, kind, message, resolve }))
  })
}

// Resolves to true/false (OK/Cancel).
export function confirmDialog(message) { return request('confirm', message) }
// Resolves once OK is tapped.
export function alertDialog(message) { return request('alert', message) }

export function subscribeDialog(fn) {
  listeners.push(fn)
  return () => { listeners = listeners.filter(l => l !== fn) }
}
