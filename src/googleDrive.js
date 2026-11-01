// Minimal client-only Google Drive uploader.
// Uses Google Identity Services (GIS) for OAuth and the Drive REST API directly —
// no backend/server needed, no Supabase or Netlify storage used. Files land in the
// shop owner's OWN Google Drive (15GB free on a normal Google account), in a folder
// called "Wolt 69 Reports" that this app creates once.
//
// Setup needed once (see SETUP-GOOGLE-DRIVE.md): create a free OAuth Client ID in
// Google Cloud Console and put it in VITE_GOOGLE_CLIENT_ID (.env file + Netlify env var).

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || ''
const SCOPE = 'https://www.googleapis.com/auth/drive.file'

let gisLoaded = false
let cachedToken = null // { access_token, expiresAt }

function loadGis() {
  return new Promise((resolve, reject) => {
    if (gisLoaded && window.google?.accounts?.oauth2) { resolve(); return }
    const existing = document.querySelector('script[data-gis]')
    if (existing) {
      existing.addEventListener('load', () => { gisLoaded = true; resolve() })
      return
    }
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.dataset.gis = '1'
    script.onload = () => { gisLoaded = true; resolve() }
    script.onerror = () => reject(new Error('Could not load Google Sign-In script (check internet connection).'))
    document.head.appendChild(script)
  })
}

export function isGoogleDriveConfigured() {
  return !!CLIENT_ID
}

export async function getDriveToken(interactive = true) {
  if (!CLIENT_ID) throw new Error('Google Drive is not set up yet. Ask Claude to walk you through SETUP-GOOGLE-DRIVE.md.')
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30000) return cachedToken.access_token
  await loadGis()
  return new Promise((resolve, reject) => {
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) { reject(new Error(resp.error)); return }
        cachedToken = { access_token: resp.access_token, expiresAt: Date.now() + (resp.expires_in || 3600) * 1000 }
        resolve(resp.access_token)
      },
      error_callback: (err) => reject(new Error(err?.message || 'Google sign-in was cancelled.')),
    })
    tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' })
  })
}

async function findOrCreateFolder(token) {
  const q = encodeURIComponent("name='Wolt 69 Reports' and mimeType='application/vnd.google-apps.folder' and trashed=false")
  const res = await fetch('https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id,name)', {
    headers: { Authorization: 'Bearer ' + token },
  })
  const json = await res.json()
  if (json.files && json.files.length) return json.files[0].id
  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Wolt 69 Reports', mimeType: 'application/vnd.google-apps.folder' }),
  })
  const created = await createRes.json()
  if (!created.id) throw new Error('Could not create the Drive folder.')
  return created.id
}

export async function uploadFileToDrive(filename, mimeType, blob) {
  const token = await getDriveToken()
  const folderId = await findOrCreateFolder(token)
  const metadata = { name: filename, parents: [folderId] }
  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
  form.append('file', blob)
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token },
    body: form,
  })
  if (!res.ok) {
    const errText = await res.text()
    throw new Error('Drive upload failed (' + res.status + '): ' + errText)
  }
  return res.json()
}
