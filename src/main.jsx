import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// iOS (especially as a home-screen/standalone app) resizes the *visual* viewport
// when the keyboard opens, but after the keyboard closes it sometimes fails to
// snap the page back to its normal size/position, leaving blank space or a
// shifted/cut-off layout. We track the real visible height ourselves via the
// visualViewport API and drive --app-vh from it, and force a scroll/layout
// reset once no input is focused any more, so the app always settles back to
// its true full size.
function setAppVh() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight
  document.documentElement.style.setProperty('--app-vh', h + 'px')
}
setAppVh()
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', setAppVh)
  window.visualViewport.addEventListener('scroll', setAppVh)
}
window.addEventListener('resize', setAppVh)
window.addEventListener('orientationchange', setAppVh)

document.addEventListener('focusout', () => {
  // Give iOS a moment to start closing the keyboard, then make sure the page
  // didn't get left scrolled/shifted from the keyboard-open layout.
  setTimeout(() => {
    const active = document.activeElement
    const stillEditing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')
    if (!stillEditing) {
      window.scrollTo(0, 0)
      if (window.visualViewport) window.scrollTo(0, 0)
      setAppVh()
    }
  }, 50)
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
