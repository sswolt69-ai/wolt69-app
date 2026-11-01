import { useEffect, useState } from 'react'
import { registerSW } from 'virtual:pwa-register'
import './UpdatePrompt.css'

// Kept outside React so StrictMode development remounts do not register twice.
let updateSW = null
let subscribed = false
const listeners = new Set()
let available = false
function notify() { listeners.forEach(fn => fn(available)) }
function startRegistration() {
  if (subscribed) return
  subscribed = true
  updateSW = registerSW({
    immediate: true,
    onNeedRefresh() { available = true; notify() },
    onRegisterError(error) { console.error('WOLT69 update registration failed:', error) },
    onRegisteredSW(_url, registration) {
      if (!registration) return
      // Check when returning to the app and at a modest interval while open.
      const check = () => { if (navigator.onLine) registration.update().catch(() => {}) }
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check()
      })
      window.addEventListener('pageshow', check)
      window.addEventListener('online', check)
      window.setInterval(() => {
        if (document.visibilityState === 'visible') check()
      }, 60 * 60 * 1000)
      check()
    },
  })
}

function editingOpen() {
  // Never forcibly reload an open job, stock, salary or other editing sheet.
  if (document.querySelector('.sheetback')) return true
  const active = document.activeElement
  return !!active?.matches?.('input, textarea, select, [contenteditable="true"]')
}

export default function UpdatePrompt() {
  const [hasUpdate, setHasUpdate] = useState(available)
  const [dismissed, setDismissed] = useState(false)
  const [editing, setEditing] = useState(false)
  const [updating, setUpdating] = useState(false)

  useEffect(() => {
    const onUpdate = v => { setHasUpdate(v); if (v) setDismissed(false) }
    listeners.add(onUpdate)
    startRegistration()
    const checkEditing = () => setEditing(editingOpen())
    const observer = new MutationObserver(checkEditing)
    observer.observe(document.body, { childList: true, subtree: true })
    document.addEventListener('focusin', checkEditing)
    document.addEventListener('focusout', checkEditing)
    checkEditing()
    return () => {
      listeners.delete(onUpdate)
      observer.disconnect()
      document.removeEventListener('focusin', checkEditing)
      document.removeEventListener('focusout', checkEditing)
    }
  }, [])

  if (!hasUpdate || dismissed) return null
  const malayalam = document.querySelector('.langsw')?.textContent?.includes('ML') &&
    document.querySelector('.langsw .active')?.textContent?.trim() === 'ML'
  return (
    <section className="wolt-update-prompt" role="status" aria-live="polite">
      <div className="wolt-update-text">
        <strong>{malayalam ? 'WOLT 69 അപ്ഡേറ്റ് ലഭ്യമാണ്' : 'WOLT 69 — Update available'}</strong>
        <p>{editing
          ? (malayalam ? 'തുറന്ന ഫോം പൂർത്തിയാക്കി അടച്ചശേഷം അപ്ഡേറ്റ് ചെയ്യുക.' : 'Save or finish your current work and close the open screen before updating.')
          : (malayalam ? 'പുതിയ പതിപ്പ് ഇൻസ്റ്റാൾ ചെയ്യാൻ അപ്ഡേറ്റ് അമർത്തുക.' : 'A new version is ready. Update when convenient.')}</p>
      </div>
      <div className="wolt-update-actions">
        <button type="button" className="wolt-update-later" disabled={updating} onClick={() => setDismissed(true)}>{malayalam ? 'പിന്നീട്' : 'Later'}</button>
        <button type="button" className="wolt-update-now" disabled={editing || updating} onClick={async () => {
          if (editingOpen() || !updateSW) return
          setUpdating(true)
          try { await updateSW(true) } catch (error) { console.error('Update failed', error); setUpdating(false) }
        }}>{updating ? 'Updating…' : (malayalam ? 'അപ്ഡേറ്റ് ചെയ്യുക' : 'Update now')}</button>
      </div>
    </section>
  )
}
