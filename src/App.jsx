import { useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from './supabaseClient'
import { t } from './i18n'
import { generateReportPdf } from './pdfReport'
import { generateBillPdf, billWhatsappText } from './billPdf'
import { showToast, subscribeToast } from './toast'
import { confirmDialog, alertDialog, subscribeDialog } from './dialog'
import { isGoogleDriveConfigured, uploadFileToDrive } from './googleDrive'

const money = (n) => '₹' + Math.round(Number(n || 0)).toLocaleString('en-IN')

function downloadJsonBackup(data) {
  const payload = { exportedAt: new Date().toISOString(), ...data }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'Wolt69-Backup-' + new Date().toISOString().slice(0, 10) + '.json'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function toCsvValue(v) {
  const s = v === null || v === undefined ? '' : String(v)
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

function downloadCsv(filename, rows) {
  const csv = rows.map(row => row.map(toCsvValue).join(',')).join('\r\n')
  // Leading BOM so Excel opens ₹/Malayalam text correctly instead of garbling it.
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function exportJobsCsv(data) {
  const header = ['Bill No', 'Date', 'Customer', 'Phone', 'Vehicle Reg', 'Vehicle Model', 'Status', 'Subtotal', 'Discount', 'Total', 'Paid', 'Due']
  const rows = data.jobs.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map(j => {
    const c = data.customers.find(x => x.id === j.customer_id)
    const v = data.vehicles.find(x => x.id === j.vehicle_id)
    const tt = jobTotals(j)
    return [
      billNo(j), new Date(j.created_at).toLocaleDateString('en-IN'),
      c?.name || '', c?.phone || '', v?.reg_no || '', v?.model || '', j.status,
      tt.subtotal, tt.discount, tt.grand, tt.paid, tt.due,
    ]
  })
  downloadCsv('Wolt69-Jobs-' + new Date().toISOString().slice(0, 10) + '.csv', [header, ...rows])
}

function exportStockCsv(data) {
  const header = ['Name', 'Type', 'Brands', 'Models', 'Cost', 'Sale', 'Qty in stock', 'Min qty', 'Stock value']
  const rows = data.parts.map(p => {
    const q = partQty(p.id, data.stockmoves)
    return [
      p.name, p.category === 'oil' ? 'Oil' : (p.original !== false ? 'Original' : 'Not original'),
      (p.brands || []).join('; '), (p.models || []).join('; '),
      p.cost || 0, p.sale || 0, q, p.min_qty || 0, q * Number(p.cost || 0),
    ]
  })
  downloadCsv('Wolt69-Stock-' + new Date().toISOString().slice(0, 10) + '.csv', [header, ...rows])
}

// Tables that support soft-delete (have a deleted_at column) — reload() hides rows
// where it's set, and delete actions set/clear it instead of removing the row,
// which is what makes the "Undo" toast on delete actions possible.
const SOFT_DELETE_TABLES = new Set(['customers', 'vehicles', 'jobs', 'parts', 'workers', 'vendors', 'expenses', 'notes'])

async function setDeletedAt(table, id, value) {
  await supabase.from(table).update({ deleted_at: value }).eq('id', id)
}

function oilRangeOf(sale) {
  const price = Number(sale) || 0
  if (price <= 300) return 'normal'
  if (price <= 500) return 'mid'
  return 'high'
}

// Delete children before parents (foreign keys), insert parents before children.
const RESTORE_DELETE_ORDER = ['notes', 'vendorentries', 'attendance', 'advances', 'expenses', 'stockmoves', 'jobs', 'vendors', 'workers', 'parts', 'vehicles', 'customers']
const RESTORE_INSERT_ORDER = ['customers', 'vehicles', 'parts', 'workers', 'vendors', 'jobs', 'stockmoves', 'advances', 'attendance', 'expenses', 'vendorentries', 'notes']

async function insertChunked(table, rows) {
  const CHUNK = 400
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase.from(table).insert(rows.slice(i, i + CHUNK))
    if (error) throw new Error(table + ': ' + error.message)
  }
}

async function restoreFromBackupFile(file, reload) {
  let payload
  try {
    payload = JSON.parse(await file.text())
  } catch {
    await alertDialog('That file is not a valid backup (could not read it as JSON).')
    return
  }
  const looksLikeBackup = RESTORE_INSERT_ORDER.some(tb => Array.isArray(payload[tb]))
  if (!looksLikeBackup) {
    await alertDialog('That file does not look like a Wolt 69 backup.')
    return
  }
  const when = payload.exportedAt ? new Date(payload.exportedAt).toLocaleString('en-IN') : 'an unknown date'
  if (!await confirmDialog('This will ERASE all current shop data and replace it with the backup from ' + when + '.\n\nThis cannot be undone. Continue?')) return
  if (!await confirmDialog('Are you sure? Tap OK one more time to actually restore.')) return
  try {
    for (const tb of RESTORE_DELETE_ORDER) {
      const { error } = await supabase.from(tb).delete().neq('id', '00000000-0000-0000-0000-000000000000')
      if (error) throw new Error(tb + ' (clearing): ' + error.message)
    }
    for (const tb of RESTORE_INSERT_ORDER) {
      const rows = payload[tb]
      if (Array.isArray(rows) && rows.length > 0) await insertChunked(tb, rows)
    }
    showToast('Backup restored successfully ✅', 'ok')
    await reload()
  } catch (err) {
    showToast('Restore failed: ' + (err.message || 'unknown error'), 'danger')
  }
}

export default function App() {
  const [session, setSession] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [showSplash, setShowSplash] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthLoading(false) })
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s)
      if (event === 'SIGNED_IN') setShowSplash(true)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  if (authLoading) return <div className="center">Loading…</div>
  if (!session) return <Login />
  if (showSplash) return <SplashScreen onDone={() => setShowSplash(false)} />
  return <Shell />
}

const SPLASH_LETTERS = ['W', 'O', 'L', 'T', ' ', '6', '9']
const SPLASH_TILTS = [0, 0, 0, 0, 0, 0, 0]
const SPLASH_SPARK_ANGLES = [-70, -25, 20, 65, 100, 150, -140]

function SplashScreen({ onDone }) {
  useEffect(() => {
    const timer = setTimeout(onDone, 3000)
    return () => clearTimeout(timer)
  }, [onDone])

  return (
    <div className="splash">
      <div className="splash-glow" />

      <div className="splash-bike-wrap">
        <svg className="splash-bike" viewBox="0 0 140 76" fill="none" xmlns="http://www.w3.org/2000/svg">
          <ellipse className="splash-bike-shadow" cx="69" cy="71.5" rx="56" ry="3.2" fill="currentColor" />
          <path d="M14 48 Q28 34 42 48" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity=".5" />
          <path d="M28 54 L52 30 L78 30 L96 54" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M52 30 L70 54 L96 54" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M96 54 L108 39" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          <path d="M100 27 L117 23" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" />
          <rect x="44" y="23" width="26" height="8" rx="4" stroke="currentColor" strokeWidth="2.6" />
          <circle cx="101" cy="29" r="2" fill="currentColor" />
          <path d="M66 54 L73 65" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity=".6" />
          <path d="M28 54 L13 58" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" opacity=".55" />
          <circle cx="28" cy="54" r="15" stroke="currentColor" strokeWidth="3" />
          <circle cx="28" cy="54" r="4.5" stroke="currentColor" strokeWidth="2.2" />
          <circle cx="110" cy="54" r="15" stroke="currentColor" strokeWidth="3" />
          <circle cx="110" cy="54" r="4.5" stroke="currentColor" strokeWidth="2.2" />
        </svg>
        <div className="splash-rig">
          <svg className="splash-wrench-loop" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M46 8c-7 0-13 6-13 13 0 2 .4 3.9 1.1 5.6L12 48.7a4 4 0 0 0 5.7 5.7l22-22.1A14 14 0 0 0 59 19c0-2-.4-3.9-1.1-5.6l-8 8a5 5 0 0 1-7-7l8-8A13.9 13.9 0 0 0 46 8Z" stroke="currentColor" strokeWidth="4.2" strokeLinejoin="round" strokeLinecap="round" />
          </svg>
          <div className="splash-rig-sparks"><span /><span /><span /></div>
        </div>
      </div>

      <div className="splash-stage">
        <div className="splash-weld" />
        <div className="splash-weld-sparks">
          {SPLASH_SPARK_ANGLES.map((deg, i) => (
            <span key={i} style={{ '--dx': Math.cos(deg * Math.PI / 180) * 30 + 'px', '--dy': Math.sin(deg * Math.PI / 180) * 30 + 'px', animationDelay: (0.55 + (i % 3) * 0.03) + 's' }} />
          ))}
        </div>

        <h1 className="splash-title" aria-label="WOLT 69">
          {SPLASH_LETTERS.map((ch, i) => (
            <span key={i} className="splash-letter" style={{ animationDelay: (0.85 + i * 0.08) + 's', '--tilt': SPLASH_TILTS[i] + 'deg' }}>{ch === ' ' ? '\u00A0' : ch}</span>
          ))}
        </h1>
      </div>

      <div className="splash-plate">
        <span className="splash-rivet" />
        <span className="splash-plate-text">Bike &amp; Scooter Repair Workshop</span>
        <span className="splash-rivet" />
      </div>

      <div className="splash-bar"><div className="splash-bar-fill" /></div>
    </div>
  )
}

function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setErr('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setErr(error.message)
    setBusy(false)
  }

  return (
    <div className="center">
      <form className="loginbox" onSubmit={submit}>
        <img src="/logo.png" alt="WOLT 69" className="loginlogo" />
        <input placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} autoCapitalize="none" />
        <input placeholder="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} />
        {err && <p className="err">{err}</p>}
        <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  )
}

const TAB_KEYS = ['today', 'jobs', 'customers', 'stock', 'dues', 'workers']
const TAB_ICONS = { today: '📊', jobs: '🔧', customers: '👤', stock: '📦', dues: '🧾', workers: '👷' }

function Shell() {
  const [tab, setTab] = useState('today')
  const [lang, setLang] = useState(() => localStorage.getItem('wolt69-lang') || 'en')
  const [showNotes, setShowNotes] = useState(false)
  const [subScreen, setSubScreen] = useState(null) // 'expenses' | 'vendors' | null
  const [data, setData] = useState({ customers: [], vehicles: [], jobs: [], parts: [], stockmoves: [], workers: [], advances: [], expenses: [], vendors: [], vendorentries: [], notes: [], attendance: [] })
  const [loading, setLoading] = useState(true)

  function setLangPersist(l) { setLang(l); localStorage.setItem('wolt69-lang', l) }

  const reload = useCallback(async () => {
    const tables = ['customers', 'vehicles', 'jobs', 'parts', 'stockmoves', 'workers', 'advances', 'expenses', 'vendors', 'vendorentries', 'notes', 'attendance']
    const results = await Promise.all(tables.map(tb => {
      const q = supabase.from(tb).select('*')
      return SOFT_DELETE_TABLES.has(tb) ? q.is('deleted_at', null) : q
    }))
    const next = {}
    tables.forEach((tb, i) => { next[tb] = results[i].data || [] })
    setData(next)
    setLoading(false)
  }, [])

  useEffect(() => {
    reload()
    const channel = supabase.channel('wolt69-sync')
    ;['customers', 'vehicles', 'jobs', 'parts', 'stockmoves', 'workers', 'advances', 'expenses', 'vendors', 'vendorentries', 'notes', 'attendance'].forEach(tb => {
      channel.on('postgres_changes', { event: '*', schema: 'public', table: tb }, reload)
    })
    channel.subscribe()
    return () => supabase.removeChannel(channel)
  }, [reload])

  // Auto-schedule a month-end alarm reminding to send the report to Google Drive —
  // created once per month (checked against existing notes, so it's safe across devices),
  // and only if Google Drive is set up at all.
  useEffect(() => {
    if (loading || !isGoogleDriveConfigured()) return
    const now = new Date()
    const target = new Date(now.getFullYear(), now.getMonth() + 1, 0, 16, 0, 0, 0)
    if (target.getTime() <= Date.now()) return
    const already = data.notes.some(n => n.text && n.text.startsWith('📤 Month-end') && n.remind_at && monthKeyOf(n.remind_at) === monthKeyOf(target))
    if (already) return
    supabase.from('notes').insert({
      text: '📤 Month-end — open Today and tap "Send this month\'s report to Google Drive" to back it up.',
      remind_at: target.toISOString(),
      notified: false,
      done: false,
    }).then(({ error }) => { if (!error) reload() })
  }, [loading, data.notes, reload])

  if (loading) return <div className="center">Loading shop data…</div>

  return (
    <div className="app">
      <header className="topbar">
        <img src="/logo.png" alt="WOLT 69" className="toplogo" />
        <div className="topbar-actions">
          <button className="iconbtn" onClick={() => setShowNotes(true)} title={t('notes', lang)}>
            🔔{data.notes.filter(n => !n.done).length > 0 && <span className="badge">{data.notes.filter(n => !n.done).length}</span>}
          </button>
          <div className="langsw">
            <button className={lang === 'en' ? 'on' : ''} onClick={() => setLangPersist('en')}>EN</button>
            <button className={lang === 'ml' ? 'on' : ''} onClick={() => setLangPersist('ml')}>ML</button>
          </div>
          <button className="linkbtn" onClick={() => supabase.auth.signOut()}>{t('signOut', lang)}</button>
        </div>
      </header>
      <main className="content">
        {tab === 'today' && <Today data={data} reload={reload} lang={lang} onOpen={setSubScreen} />}
        {tab === 'jobs' && <Jobs data={data} reload={reload} lang={lang} />}
        {tab === 'customers' && <Customers data={data} reload={reload} lang={lang} />}
        {tab === 'stock' && <Stock data={data} reload={reload} lang={lang} />}
        {tab === 'dues' && <Dues data={data} reload={reload} lang={lang} />}
        {tab === 'workers' && <Workers data={data} reload={reload} lang={lang} />}
      </main>
      <nav className="bottomnav">
        {TAB_KEYS.map(k => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            <span className="ico">{TAB_ICONS[k]}</span><span>{t(k, lang)}</span>
          </button>
        ))}
      </nav>
      {showNotes && <NotesSheet data={data} reload={reload} lang={lang} onClose={() => setShowNotes(false)} />}
      {subScreen === 'expenses' && <ExpensesScreen data={data} reload={reload} lang={lang} onClose={() => setSubScreen(null)} />}
      {subScreen === 'vendors' && <VendorsScreen data={data} reload={reload} lang={lang} onClose={() => setSubScreen(null)} />}
      <ReminderWatcher data={data} reload={reload} lang={lang} />
      <ToastHost />
      <DialogHost lang={lang} />
    </div>
  )
}

function DialogHost({ lang }) {
  const [dialog, setDialog] = useState(null)
  useEffect(() => subscribeDialog(d => setDialog(d)), [])
  if (!dialog) return null

  function close(result) {
    dialog.resolve(result)
    setDialog(null)
  }

  return (
    <div className="dialogback" onClick={() => close(dialog.kind === 'confirm' ? false : undefined)}>
      <div className="dialogbox" onClick={e => e.stopPropagation()}>
        <p className="dialogbox-text">{dialog.message}</p>
        <div className="dialogbox-actions">
          {dialog.kind === 'confirm' && <button onClick={() => close(false)}>{t('cancel', lang)}</button>}
          <button className="primary" onClick={() => close(dialog.kind === 'confirm' ? true : undefined)}>{t('ok', lang)}</button>
        </div>
      </div>
    </div>
  )
}

function ToastHost() {
  const [toasts, setToasts] = useState([])
  useEffect(() => {
    return subscribeToast(toast => {
      setToasts(ts => [...ts, toast])
      setTimeout(() => setToasts(ts => ts.filter(t => t.id !== toast.id)), toast.duration || 3500)
    })
  }, [])
  if (toasts.length === 0) return null
  return (
    <div className="toaststack">
      {toasts.map(t => (
        <div key={t.id} className={'toast' + (t.kind === 'warn' ? ' warn' : t.kind === 'danger' ? ' danger' : t.kind === 'ok' ? ' ok' : '')}>
          <span>{t.message}</span>
          {t.action && (
            <button
              className="toast-action"
              onClick={() => { t.onAction?.(); setToasts(ts => ts.filter(x => x.id !== t.id)) }}
            >{t.action}</button>
          )}
        </div>
      ))}
    </div>
  )
}

function checkStockToast(part, qtyAfter, lang) {
  if (!part) return
  if (qtyAfter <= 0) {
    showToast('⚠️ ' + part.name + ' is now OUT OF STOCK', 'warn')
  } else if (part.min_qty && qtyAfter <= part.min_qty) {
    showToast('⚠️ ' + part.name + ' is running low (' + qtyAfter + ' left)', 'warn')
  }
}

function jobTotals(j) {
  const lines = j.lines || []
  const subtotal = lines.reduce((s, l) => s + Number(l.amount || 0), 0)
  const discount = Number(j.discount || 0)
  const grand = Math.max(0, subtotal - discount)
  const payments = j.payments || []
  const paidFromPayments = payments.reduce((s, p) => s + Number(p.amount || 0), 0)
  const paid = payments.length > 0 ? paidFromPayments : Number(j.advance || 0)
  const due = Math.max(0, grand - paid)
  return { subtotal, discount, grand, paid, due }
}

function billNo(job) {
  return job.bill_no ? 'WOLT-' + String(job.bill_no).padStart(4, '0') : ''
}

function partQty(partId, stockmoves) {
  return stockmoves.filter(m => m.part_id === partId).reduce((s, m) => s + Number(m.qty || 0), 0)
}

function monthKeyOf(ts) {
  const d = new Date(ts)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
}
function dayKeyOf(ts) {
  const d = new Date(ts)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

function serviceDueList(data, todayStart) {
  const soon = new Date(todayStart); soon.setDate(soon.getDate() + 7)
  return data.vehicles
    .filter(v => v.next_service_due)
    .map(v => ({ v, c: data.customers.find(x => x.id === v.customer_id), due: new Date(v.next_service_due + 'T00:00:00') }))
    .filter(x => x.due <= soon)
    .sort((a, b) => a.due - b.due)
}

function prevMonthKeyOf(ts) {
  const d = new Date(ts)
  d.setDate(1)
  d.setMonth(d.getMonth() - 1)
  return monthKeyOf(d)
}

function Today({ data, reload, lang, onOpen }) {
  const [driveBusy, setDriveBusy] = useState(false)
  const [restoreBusy, setRestoreBusy] = useState(false)
  const fileInputRef = useRef(null)
  const prevMonth = prevMonthKeyOf(Date.now())
  const driveDoneKey = 'wolt69-drive-sent-' + prevMonth
  const dayOfMonth = new Date().getDate()
  const [driveNudgeDismissed, setDriveNudgeDismissed] = useState(() => !!localStorage.getItem(driveDoneKey))
  const showDriveNudge = isGoogleDriveConfigured() && dayOfMonth <= 7 && !driveNudgeDismissed

  async function sendReportToDrive(monthKey) {
    setDriveBusy(true)
    try {
      const { blob, filename } = generateReportPdf('month', { ...data, monthKey }, { returnBlob: true })
      await uploadFileToDrive(filename, 'application/pdf', blob)
      localStorage.setItem('wolt69-drive-sent-' + monthKey, '1')
      setDriveNudgeDismissed(true)
      showToast('Report sent to Google Drive ✅', 'ok')
    } catch (err) {
      showToast('Could not send to Drive: ' + (err.message || 'unknown error'), 'danger')
    } finally {
      setDriveBusy(false)
    }
  }

  async function onRestoreFileChosen(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setRestoreBusy(true)
    try { await restoreFromBackupFile(file, reload) } finally { setRestoreBusy(false) }
  }

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
  const todaysJobs = data.jobs.filter(j => new Date(j.created_at) >= todayStart)
  const todaysCollected = todaysJobs.reduce((s, j) => s + jobTotals(j).paid, 0)
  const todaysDiscount = todaysJobs.reduce((s, j) => s + jobTotals(j).discount, 0)
  const totalDue = data.jobs.reduce((s, j) => s + jobTotals(j).due, 0)
  const lowStock = data.parts.filter(p => p.min_qty && partQty(p.id, data.stockmoves) <= p.min_qty)
  const stockValue = data.parts.reduce((s, p) => s + partQty(p.id, data.stockmoves) * Number(p.cost || 0), 0)
  const dueServices = serviceDueList(data, todayStart)
  const [backupMonth, setBackupMonth] = useState(() => monthKeyOf(Date.now()))

  const thisMonth = monthKeyOf(Date.now())
  const expensesTotal = data.expenses.reduce((s, e) => s + Number(e.amount || 0), 0)
  const expensesMonth = data.expenses.filter(e => monthKeyOf(e.at) === thisMonth).reduce((s, e) => s + Number(e.amount || 0), 0)
  const vendorBalance = data.vendors.reduce((sum, v) => {
    const entries = data.vendorentries.filter(e => e.vendor_id === v.id)
    const billed = entries.reduce((s, e) => s + Number(e.bill_amount || 0), 0)
    const paid = entries.reduce((s, e) => s + Number(e.paid_amount || 0), 0)
    return sum + Number(v.opening_balance || 0) + billed - paid
  }, 0)
  const paidVendorsMonth = data.vendorentries.filter(e => monthKeyOf(e.at) === thisMonth).reduce((s, e) => s + Number(e.paid_amount || 0), 0)
  const collectedMonth = data.jobs.filter(j => monthKeyOf(j.created_at) === thisMonth).reduce((s, j) => s + jobTotals(j).paid, 0)
  const salaryPaidMonth = data.advances.filter(a => monthKeyOf(a.at) === thisMonth).reduce((s, a) => s + Number(a.amount || 0), 0)
  const netProfit = collectedMonth - expensesMonth - paidVendorsMonth - salaryPaidMonth

  return (
    <div className="screen">
      <h2>{t('today', lang)}</h2>
      {showDriveNudge && (
        <div className="card warn">
          <div className="row"><b>📤 {t('driveNudgeTitle', lang)}</b></div>
          <div className="subrow">{t('driveNudgeHint', lang)}</div>
          <div className="row2" style={{ marginTop: 8 }}>
            <button className="primary" disabled={driveBusy} onClick={() => sendReportToDrive(prevMonth)}>
              {driveBusy ? '…' : t('driveSendNow', lang)}
            </button>
            <button onClick={() => { localStorage.setItem(driveDoneKey, '1'); setDriveNudgeDismissed(true) }}>{t('dismiss', lang)}</button>
          </div>
        </div>
      )}
      <div className="card"><div className="row"><span>{t('billsMade', lang)}</span><b>{todaysJobs.length}</b></div></div>
      <div className="card"><div className="row"><span>{t('collectedToday', lang)}</span><b>{money(todaysCollected)}</b></div></div>
      <div className="card"><div className="row"><span>{t('givenDiscount', lang)}</span><b>{money(todaysDiscount)}</b></div></div>
      <div className="card"><div className="row"><span>{t('pendingOverall', lang)}</span><b className="danger">{money(totalDue)}</b></div></div>
      <button className="card tap" onClick={() => onOpen('expenses')}>
        <div className="row"><b>{t('expenses', lang)}</b><span>{money(expensesTotal)}</span></div>
        <div className="subrow">{t('expensesHint', lang)}</div>
      </button>
      <button className="card tap" onClick={() => onOpen('vendors')}>
        <div className="row"><b>{t('vendors', lang)}</b><span className={vendorBalance > 0 ? 'danger' : ''}>{money(vendorBalance)}</span></div>
        <div className="subrow">{t('vendorsHint', lang)}</div>
      </button>
      <div className={'card' + (lowStock.length > 0 ? ' warn' : '')}>
        <div className="row"><b>{t('stockValue', lang)}</b><span>{money(stockValue)}</span></div>
        {lowStock.length > 0 && <div className="subrow danger">⚠️ {lowStock.length} {t('partsLow', lang)}</div>}
      </div>

      {dueServices.length > 0 && (
        <div className="card warn">
          <div className="row"><b>🔧 {t('serviceDueTitle', lang)}</b><span>{dueServices.length}</span></div>
          {dueServices.map(({ v, c, due }) => {
            const overdue = due < todayStart
            return (
              <div key={v.id} className="row paymentrow">
                <span>
                  {v.reg_no} · {c?.name || '—'} · {overdue ? t('overdue', lang) : due.toLocaleDateString('en-IN')}
                </span>
                <span style={{ display: 'flex', gap: 10 }}>
                  {c?.phone && <a href={'tel:' + c.phone}>📞</a>}
                  {c?.phone && <a href={'https://wa.me/91' + c.phone.replace(/\D/g, '')} target="_blank" rel="noreferrer">💬</a>}
                </span>
              </div>
            )
          })}
        </div>
      )}

      <h3 style={{ marginTop: 16 }}>{t('monthProfit', lang)}</h3>
      <div className="totalblock">
        <div className="row"><span>{t('collectedMonth', lang)}</span><b>{money(collectedMonth)}</b></div>
        <div className="row"><span>– {t('expenses', lang)}</span><span>{money(expensesMonth)}</span></div>
        <div className="row"><span>– {t('paidVendorsMonth', lang)}</span><span>{money(paidVendorsMonth)}</span></div>
        <div className="row"><span>– {t('salaryPaidMonth', lang)}</span><span>{money(salaryPaidMonth)}</span></div>
        <div className="row grand"><span>{t('netProfit', lang)}</span><b className={netProfit < 0 ? 'danger' : ''}>{money(netProfit)}</b></div>
      </div>
      <div className="subrow" style={{ marginBottom: 10 }}>{t('cashBasisNote', lang)}</div>

      <div className="card">
        <div className="row"><b>Backup / Reports</b></div>
        <input type="month" value={backupMonth} onChange={e => setBackupMonth(e.target.value)} style={{ marginTop: 8 }} />
        <button className="primary" style={{ marginTop: 8 }} onClick={() => generateReportPdf('month', { ...data, monthKey: backupMonth })}>{t('backupMonth', lang)}</button>
        <button className="primary" style={{ marginTop: 8 }} onClick={() => generateReportPdf('all', data)}>{t('backupAll', lang)}</button>
        <button style={{ marginTop: 8 }} onClick={() => downloadJsonBackup(data)}>{t('backupJson', lang)}</button>
        <button style={{ marginTop: 8 }} onClick={() => exportJobsCsv(data)}>{t('exportJobsCsv', lang)}</button>
        <button style={{ marginTop: 8 }} onClick={() => exportStockCsv(data)}>{t('exportStockCsv', lang)}</button>
        {isGoogleDriveConfigured() && (
          <button style={{ marginTop: 8 }} disabled={driveBusy} onClick={() => sendReportToDrive(backupMonth)}>
            {driveBusy ? '…' : t('sendToDrive', lang)}
          </button>
        )}
        <input ref={fileInputRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={onRestoreFileChosen} />
        <button className="dangerbtn" style={{ marginTop: 8 }} disabled={restoreBusy} onClick={() => fileInputRef.current?.click()}>
          {restoreBusy ? '…' : t('restoreJson', lang)}
        </button>
      </div>
    </div>
  )
}

const EXPENSE_CATEGORIES = ['Rent', 'Electricity', 'Fuel / Petrol', 'Pickup van trip', 'Courier', 'Tea / Refreshments', 'Shop maintenance', 'Other']

function ExpensesScreen({ data, reload, lang, onClose }) {
  const [category, setCategory] = useState('')
  const [customDesc, setCustomDesc] = useState('')
  const [amt, setAmt] = useState('')
  const thisMonthKey = monthKeyOf(Date.now())
  const lastMonthKey = prevMonthKeyOf(Date.now())
  const [range, setRange] = useState('month') // 'month' | 'lastmonth' | 'pick'
  const [pickMonth, setPickMonth] = useState(thisMonthKey)
  const activeMonth = range === 'month' ? thisMonthKey : range === 'lastmonth' ? lastMonthKey : pickMonth
  const filtered = data.expenses.filter(e => monthKeyOf(e.at) === activeMonth)
  const sorted = filtered.slice().sort((a, b) => new Date(b.at) - new Date(a.at))
  const total = filtered.reduce((s, e) => s + Number(e.amount || 0), 0)

  async function save() {
    const desc = category === 'Other' ? customDesc.trim() : category
    if (!desc || !amt) { await alertDialog('Pick a category and enter an amount'); return }
    await supabase.from('expenses').insert({ description: desc, amount: Number(amt), at: new Date().toISOString() })
    setCategory(''); setCustomDesc(''); setAmt('')
    await reload()
  }
  async function del(id) {
    await setDeletedAt('expenses', id, new Date().toISOString())
    await reload()
    showToast(t('expenseDeleted', lang), 'danger', {
      action: t('undo', lang), duration: 6000,
      onAction: async () => { await setDeletedAt('expenses', id, null); await reload() },
    })
  }

  return (
    <div className="sheetback" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="sheethead"><h3>{t('expenses', lang)}</h3><button onClick={onClose}>✕</button></div>
        <div className="toggles">
          <button className={range === 'month' ? 'on' : ''} onClick={() => setRange('month')}>{t('thisMonth', lang)}</button>
          <button className={range === 'lastmonth' ? 'on' : ''} onClick={() => setRange('lastmonth')}>{t('lastMonth', lang)}</button>
          <button className={range === 'pick' ? 'on' : ''} onClick={() => setRange('pick')}>{t('pickMonth', lang)}</button>
        </div>
        {range === 'pick' && (
          <input type="month" value={pickMonth} onChange={e => setPickMonth(e.target.value)} />
        )}
        <div className="totalblock"><div className="row grand"><span>{t('total', lang)}</span><b>{money(total)}</b></div></div>
        {sorted.length === 0 && <p className="empty">—</p>}
        {sorted.map(e => (
          <div key={e.id} className="row paymentrow">
            <span>{new Date(e.at).toLocaleDateString('en-IN')} · {e.description}: {money(e.amount)}</span>
            <button onClick={() => del(e.id)}>✕</button>
          </div>
        ))}
        <h4 style={{ marginTop: 14 }}>{t('newExpense', lang)}</h4>
        <select value={category} onChange={e => setCategory(e.target.value)}>
          <option value="">{t('expenseDesc', lang)}</option>
          {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        {category === 'Other' && (
          <input placeholder={t('expenseCustom', lang)} value={customDesc} onChange={e => setCustomDesc(e.target.value)} />
        )}
        <input placeholder={t('expenseAmt', lang)} type="number" value={amt} onChange={e => setAmt(e.target.value)} />
        <button className="primary" onClick={save}>{t('saveExpense', lang)}</button>
      </div>
    </div>
  )
}

function VendorsScreen({ data, reload, lang, onClose }) {
  const [showNew, setShowNew] = useState(false)
  const [openVendorId, setOpenVendorId] = useState(null)
  const openVendor = data.vendors.find(v => v.id === openVendorId) || null
  const [name, setName] = useState(''), [phone, setPhone] = useState(''), [opening, setOpening] = useState('')

  async function save() {
    if (!name.trim()) { await alertDialog('Enter vendor name'); return }
    await supabase.from('vendors').insert({ name: name.trim(), phone: phone.trim(), opening_balance: Number(opening) || 0 })
    setName(''); setPhone(''); setOpening(''); setShowNew(false)
    await reload()
  }

  function vendorBalance(v) {
    const entries = data.vendorentries.filter(e => e.vendor_id === v.id)
    const billed = entries.reduce((s, e) => s + Number(e.bill_amount || 0), 0)
    const paid = entries.reduce((s, e) => s + Number(e.paid_amount || 0), 0)
    return Number(v.opening_balance || 0) + billed - paid
  }

  return (
    <div className="sheetback" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="sheethead"><h3>{t('vendors', lang)}</h3><button onClick={onClose}>✕</button></div>
        <button className="fab" onClick={() => setShowNew(s => !s)}>{t('newVendor', lang)}</button>
        {showNew && (
          <div className="card" style={{ marginTop: 10 }}>
            <input placeholder={t('vendorName', lang)} value={name} onChange={e => setName(e.target.value)} />
            <input placeholder={t('phone', lang)} value={phone} onChange={e => setPhone(e.target.value)} />
            <input placeholder={t('openingBalance', lang)} type="number" value={opening} onChange={e => setOpening(e.target.value)} />
            <button className="primary" onClick={save}>{t('saveVendor', lang)}</button>
          </div>
        )}
        {data.vendors.length === 0 && <p className="empty">—</p>}
        {data.vendors.map(v => {
          const bal = vendorBalance(v)
          return (
            <button key={v.id} className="card tap" style={{ marginTop: 10 }} onClick={() => setOpenVendorId(v.id)}>
              <div className="row"><b>{v.name}</b><span className={bal > 0 ? 'danger' : ''}>{money(bal)}</span></div>
            </button>
          )
        })}
      </div>
      {openVendor && <VendorDetailSheet vendor={openVendor} data={data} reload={reload} lang={lang} onClose={() => setOpenVendorId(null)} />}
    </div>
  )
}

function VendorDetailSheet({ vendor, data, reload, lang, onClose }) {
  const [billAmt, setBillAmt] = useState('')
  const [paidAmt, setPaidAmt] = useState('')
  const [note, setNote] = useState('')
  const entries = data.vendorentries.filter(e => e.vendor_id === vendor.id).sort((a, b) => new Date(b.at) - new Date(a.at))
  const billed = entries.reduce((s, e) => s + Number(e.bill_amount || 0), 0)
  const paid = entries.reduce((s, e) => s + Number(e.paid_amount || 0), 0)
  const balance = Number(vendor.opening_balance || 0) + billed - paid

  async function addEntry() {
    if (!billAmt && !paidAmt) { await alertDialog('Enter a bill amount or paid amount'); return }
    await supabase.from('vendorentries').insert({
      vendor_id: vendor.id, bill_amount: Number(billAmt) || 0, paid_amount: Number(paidAmt) || 0,
      type: Number(billAmt) > 0 ? 'purchase' : 'payment', amount: Number(billAmt) || Number(paidAmt) || 0,
      note: note.trim(), at: new Date().toISOString(),
    })
    setBillAmt(''); setPaidAmt(''); setNote('')
    await reload()
  }
  async function removeEntry(id) { await supabase.from('vendorentries').delete().eq('id', id); await reload() }
  async function delVendor() {
    if (!await confirmDialog(t('confirmDeleteVendor', lang))) return
    await setDeletedAt('vendors', vendor.id, new Date().toISOString())
    await reload()
    onClose()
    showToast(t('vendorDeleted', lang), 'danger', {
      action: t('undo', lang), duration: 6000,
      onAction: async () => { await setDeletedAt('vendors', vendor.id, null); await reload() },
    })
  }

  return (
    <div className="sheetback" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="sheethead"><h3>{vendor.name}</h3><button onClick={onClose}>✕</button></div>
        <div className="totalblock">
          <div className="row"><span>{t('openingBalance', lang)}</span><span>{money(vendor.opening_balance)}</span></div>
          <div className="row"><span>{t('totalBilled', lang)}</span><span>{money(billed)}</span></div>
          <div className="row"><span>{t('totalPaidVendor', lang)}</span><span>{money(paid)}</span></div>
          <div className="row grand"><span>{t('balanceOwed', lang)}</span><b className="danger">{money(balance)}</b></div>
        </div>
        <h4 style={{ marginTop: 14 }}>{t('purchaseHistory', lang)}</h4>
        {entries.length === 0 && <p className="empty">—</p>}
        {entries.map(e => (
          <div key={e.id} className="row paymentrow">
            <span>
              {new Date(e.at).toLocaleDateString('en-IN')}
              {Number(e.bill_amount) > 0 ? ' · Bill ' + money(e.bill_amount) : ''}
              {Number(e.paid_amount) > 0 ? ' · Paid ' + money(e.paid_amount) : ''}
            </span>
            <button onClick={() => removeEntry(e.id)}>✕</button>
          </div>
        ))}
        <div className="row2" style={{ marginTop: 10 }}>
          <input placeholder={t('billAmtNew', lang)} type="number" value={billAmt} onChange={e => setBillAmt(e.target.value)} />
          <input placeholder={t('paidNow', lang)} type="number" value={paidAmt} onChange={e => setPaidAmt(e.target.value)} />
        </div>
        <input placeholder={t('advanceNote', lang)} value={note} onChange={e => setNote(e.target.value)} />
        <button className="primary" onClick={addEntry}>{t('addEntry', lang)}</button>
        <button className="dangerbtn" onClick={delVendor}>{t('deleteVendor', lang)}</button>
      </div>
    </div>
  )
}

const STATUS_KEYS = ['received', 'in_progress', 'ready', 'delivered']
const LOGISTICS_KEYS = ['none', 'pickup', 'delivery', 'both']
const LOGISTICS_BADGE = { pickup: '🛵 Pickup', delivery: '🚚 Delivery', both: '🛵🚚 Pickup & Delivery' }

function Jobs({ data, reload, lang }) {
  const [openJobId, setOpenJobId] = useState(null)
  const openJob = data.jobs.find(j => j.id === openJobId) || null
  const [showNew, setShowNew] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')

  const filtered = data.jobs.filter(j => {
    if (statusFilter !== 'all' && j.status !== statusFilter) return false
    if (!search) return true
    const s = search.toLowerCase()
    const c = data.customers.find(x => x.id === j.customer_id)
    const v = data.vehicles.find(x => x.id === j.vehicle_id)
    return c?.name?.toLowerCase().includes(s) || c?.phone?.includes(search) || v?.reg_no?.toLowerCase().includes(s)
  })

  return (
    <div className="screen">
      <div className="screenhead"><h2>{t('jobs', lang)}</h2><button className="fab" onClick={() => setShowNew(true)}>{t('new', lang)}</button></div>
      <div className="toggles">
        <button className={statusFilter === 'all' ? 'on' : ''} onClick={() => setStatusFilter('all')}>{t('allStatus', lang)}</button>
        {STATUS_KEYS.map(s => (
          <button key={s} className={statusFilter === s ? 'on' : ''} onClick={() => setStatusFilter(s)}>{t(s === 'in_progress' ? 'inProgress' : s, lang)}</button>
        ))}
      </div>
      <input placeholder={t('searchJobs', lang)} value={search} onChange={e => setSearch(e.target.value)} />
      {filtered.length === 0 && <p className="empty">{t('noJobs', lang)}</p>}
      {filtered.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).map(j => {
        const c = data.customers.find(x => x.id === j.customer_id)
        const v = data.vehicles.find(x => x.id === j.vehicle_id)
        const tt = jobTotals(j)
        return (
          <button key={j.id} className="card tap" onClick={() => setOpenJobId(j.id)}>
            <div className="row"><b>{v?.reg_no || '—'} — {c?.name || 'Unknown'}</b><span className={'status s-' + j.status}>{t(j.status === 'in_progress' ? 'inProgress' : j.status, lang)}</span></div>
            <div className="subrow">{billNo(j) && billNo(j) + ' · '}{tt.due <= 0 ? t('fullyPaid', lang) : money(tt.due) + ' due'} · {money(tt.grand)}</div>
            {LOGISTICS_BADGE[j.logistics] && <div className="subrow">{LOGISTICS_BADGE[j.logistics]}</div>}
          </button>
        )
      })}
      {showNew && <NewJobSheet data={data} onClose={() => setShowNew(false)} reload={reload} lang={lang} />}
      {openJob && <JobDetailSheet job={openJob} data={data} onClose={() => setOpenJobId(null)} reload={reload} lang={lang} />}
    </div>
  )
}

function NewJobSheet({ data, onClose, reload, lang }) {
  const [custId, setCustId] = useState('')
  const [vehId, setVehId] = useState('')
  const [newCustName, setNewCustName] = useState('')
  const [newCustPhone, setNewCustPhone] = useState('')
  const [newVehReg, setNewVehReg] = useState('')
  const [newVehModel, setNewVehModel] = useState('')
  const [useExisting, setUseExisting] = useState(data.customers.length > 0)
  const [logistics, setLogistics] = useState('none')

  async function save() {
    let cId = custId, vId = vehId
    if (!useExisting) {
      if (!newCustName.trim()) { await alertDialog('Enter customer name'); return }
      const { data: c } = await supabase.from('customers').insert({ name: newCustName.trim(), phone: newCustPhone.trim() }).select().single()
      cId = c.id
      const { data: v } = await supabase.from('vehicles').insert({ customer_id: cId, reg_no: newVehReg.trim().toUpperCase(), model: newVehModel.trim() }).select().single()
      vId = v.id
    }
    if (!cId) { await alertDialog('Pick or add a customer'); return }
    await supabase.from('jobs').insert({ customer_id: cId, vehicle_id: vId || null, status: 'received', lines: [], discount: 0, advance: 0, logistics })
    await reload()
    onClose()
  }

  return (
    <div className="sheetback" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="sheethead"><h3>{t('newJob', lang)}</h3><button onClick={onClose}>✕</button></div>
        {data.customers.length > 0 && (
          <div className="toggles">
            <button className={useExisting ? 'on' : ''} onClick={() => setUseExisting(true)}>{t('existingCustomer', lang)}</button>
            <button className={!useExisting ? 'on' : ''} onClick={() => setUseExisting(false)}>{t('newCustomer', lang)}</button>
          </div>
        )}
        {useExisting ? (
          <>
            <select value={custId} onChange={e => { setCustId(e.target.value); setVehId('') }}>
              <option value="">{t('selectCustomer', lang)}</option>
              {data.customers.map(c => <option key={c.id} value={c.id}>{c.name} {c.phone ? '· ' + c.phone : ''}</option>)}
            </select>
            {custId && (
              <select value={vehId} onChange={e => setVehId(e.target.value)}>
                <option value="">{t('selectVehicle', lang)}</option>
                {data.vehicles.filter(v => v.customer_id === custId).map(v => <option key={v.id} value={v.id}>{v.reg_no} {v.model}</option>)}
              </select>
            )}
          </>
        ) : (
          <>
            <input placeholder={t('custName', lang)} value={newCustName} onChange={e => setNewCustName(e.target.value)} />
            <input placeholder={t('phone', lang)} value={newCustPhone} onChange={e => setNewCustPhone(e.target.value)} />
            <input placeholder={t('vehReg', lang)} value={newVehReg} onChange={e => setNewVehReg(e.target.value.toUpperCase())} />
            <input placeholder={t('vehModel', lang)} value={newVehModel} onChange={e => setNewVehModel(e.target.value)} />
          </>
        )}
        <h4 style={{ marginTop: 14, marginBottom: 6 }}>{t('logistics', lang)}</h4>
        <div className="toggles">
          {LOGISTICS_KEYS.map(k => (
            <button key={k} className={logistics === k ? 'on' : ''} onClick={() => setLogistics(k)}>{t('logistics' + k[0].toUpperCase() + k.slice(1), lang)}</button>
          ))}
        </div>
        <button className="primary" onClick={save}>{t('createJob', lang)}</button>
      </div>
    </div>
  )
}

function StockSearchPicker({ items, stockmoves, selectedId, onPick, placeholder, lang }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const selected = items.find(p => p.id === selectedId)
  const q = query.trim().toLowerCase()
  const filtered = q ? items.filter(p => p.name.toLowerCase().includes(q)) : items

  return (
    <div className="stockpicker">
      <input
        placeholder={placeholder}
        value={open ? query : (selected ? selected.name : '')}
        onChange={e => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => { setQuery(''); setOpen(true) }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && (
        <div className="stockpicker-list">
          {filtered.length === 0 && <div className="stockpicker-empty">{t('noMatches', lang)}</div>}
          {filtered.map(p => {
            const avail = partQty(p.id, stockmoves)
            return (
              <button
                key={p.id} type="button" className="stockpicker-row" disabled={avail <= 0}
                onMouseDown={e => e.preventDefault()}
                onClick={() => { onPick(p.id); setQuery(''); setOpen(false) }}
              >
                <span>{p.name}</span>
                <span>{avail <= 0 ? t('outOfStock', lang) : 'qty ' + avail + ' · ' + money(p.sale)}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

const LABOUR_QUICK_KEYS = ['chainTight', 'brakeTight', 'oilChangeLabour', 'headlightAdjust', 'headlightBulbChange', 'indicatorBulbChange']

function LabourQuickPicker({ value, onChange, lang }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="stockpicker">
      <input
        placeholder={t('description', lang)}
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && (
        <div className="stockpicker-list">
          {LABOUR_QUICK_KEYS.map(k => (
            <button
              key={k} type="button" className="stockpicker-row"
              onMouseDown={e => e.preventDefault()}
              onClick={() => { onChange(t(k, lang)); setOpen(false) }}
            >
              <span>{t(k, lang)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function JobDetailSheet({ job, data, onClose, reload, lang }) {
  const [lineType, setLineType] = useState('part')
  const [desc, setDesc] = useState('')
  const [amt, setAmt] = useState('')
  const [partId, setPartId] = useState('')
  const [qty, setQty] = useState(1)
  const [partBrandFilter, setPartBrandFilter] = useState('all')
  const [oilRange, setOilRange] = useState('')
  const [payMethod, setPayMethod] = useState('cash')
  const [payAmt, setPayAmt] = useState('')
  const [showBill, setShowBill] = useState(false)
  const tt = jobTotals(job)
  const c = data.customers.find(x => x.id === job.customer_id)
  const v = data.vehicles.find(x => x.id === job.vehicle_id)
  const payments = job.payments || []
  const nonOilParts = data.parts.filter(p => p.category !== 'oil')
  const visibleParts = partBrandFilter === 'all' ? nonOilParts : nonOilParts.filter(p => (p.brands || []).includes(partBrandFilter))
  const oilParts = data.parts.filter(p => p.category === 'oil')
  const oilsInRange = oilRange ? oilParts.filter(p => oilRangeOf(p.sale) === oilRange) : []

  function pickPart(id) {
    setPartId(id)
    const p = data.parts.find(x => x.id === id)
    if (p) { setDesc(p.name); setAmt(p.sale || p.cost || 0) }
  }

  async function addLine() {
    if (lineType === 'part' || lineType === 'oil') {
      if (!partId) { await alertDialog(lineType === 'oil' ? 'Pick an oil' : 'Pick a part from stock'); return }
      const available = partQty(partId, data.stockmoves)
      const q = Number(qty) || 1
      if (available < q) { await alertDialog('Only ' + available + ' in stock — cannot add ' + q); return }
      const unitPrice = Number(amt) || 0
      const newLine = { type: 'part', desc: desc.trim() || data.parts.find(x => x.id === partId)?.name, amount: unitPrice * q, partId, partQty: q }
      const lines = [...(job.lines || []), newLine]
      await supabase.from('jobs').update({ lines }).eq('id', job.id)
      await supabase.from('stockmoves').insert({ part_id: partId, qty: -q, note: 'Used in job' })
      const part = data.parts.find(x => x.id === partId)
      checkStockToast(part, available - q, lang)
    } else {
      if (!desc.trim() || !amt) { await alertDialog('Enter description and amount'); return }
      const newLine = { type: lineType, desc: desc.trim(), amount: Number(amt) }
      const lines = [...(job.lines || []), newLine]
      await supabase.from('jobs').update({ lines }).eq('id', job.id)
    }
    setDesc(''); setAmt(''); setPartId(''); setQty(1); setOilRange('')
    await reload()
  }

  async function removeLine(idx) {
    const line = (job.lines || [])[idx]
    if (!await confirmDialog(t('confirmDeleteLine', lang))) return
    const lines = (job.lines || []).filter((_, i) => i !== idx)
    await supabase.from('jobs').update({ lines }).eq('id', job.id)
    if (line?.type === 'part' && line.partId) {
      await supabase.from('stockmoves').insert({ part_id: line.partId, qty: Number(line.partQty) || 1, note: 'Removed from job' })
    }
    await reload()
  }

  async function setStatus(status) { await supabase.from('jobs').update({ status }).eq('id', job.id); await reload() }
  async function setLogistics(logistics) { await supabase.from('jobs').update({ logistics }).eq('id', job.id); await reload() }

  async function setServiceDue(months) {
    if (!v) return
    const d = new Date()
    d.setMonth(d.getMonth() + months)
    await supabase.from('vehicles').update({ next_service_due: d.toISOString().slice(0, 10) }).eq('id', v.id)
    await reload()
  }
  async function clearServiceDue() {
    if (!v) return
    await supabase.from('vehicles').update({ next_service_due: null }).eq('id', v.id)
    await reload()
  }

  async function addPayment() {
    if (!payAmt || Number(payAmt) <= 0) { await alertDialog('Enter a payment amount'); return }
    const newPayments = [...payments, { method: payMethod, amount: Number(payAmt) }]
    await supabase.from('jobs').update({ payments: newPayments }).eq('id', job.id)
    setPayAmt('')
    await reload()
  }
  async function removePayment(idx) {
    const newPayments = payments.filter((_, i) => i !== idx)
    await supabase.from('jobs').update({ payments: newPayments }).eq('id', job.id)
    await reload()
  }

  async function deleteJob() {
    if (!await confirmDialog(t('confirmDeleteJob', lang))) return
    const partLines = (job.lines || []).filter(l => l.type === 'part' && l.partId)
    for (const line of partLines) {
      await supabase.from('stockmoves').insert({ part_id: line.partId, qty: Number(line.partQty) || 1, note: 'Job deleted' })
    }
    await setDeletedAt('jobs', job.id, new Date().toISOString())
    await reload()
    onClose()
    showToast(t('jobDeleted', lang), 'danger', {
      action: t('undo', lang), duration: 6000,
      onAction: async () => {
        for (const line of partLines) {
          await supabase.from('stockmoves').insert({ part_id: line.partId, qty: -(Number(line.partQty) || 1), note: 'Job restored' })
        }
        await setDeletedAt('jobs', job.id, null)
        await reload()
      },
    })
  }

  return (
    <div className="sheetback" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="sheethead"><h3>{v?.reg_no || '—'} — {c?.name}{billNo(job) ? ' · ' + billNo(job) : ''}</h3><button onClick={onClose}>✕</button></div>
        <div className="toggles">
          {STATUS_KEYS.map(s => (
            <button key={s} className={job.status === s ? 'on' : ''} onClick={() => setStatus(s)}>{t(s === 'in_progress' ? 'inProgress' : s, lang)}</button>
          ))}
        </div>
        <h4 style={{ marginTop: 10, marginBottom: 6 }}>{t('logistics', lang)}</h4>
        <div className="toggles">
          {LOGISTICS_KEYS.map(k => (
            <button key={k} className={(job.logistics || 'none') === k ? 'on' : ''} onClick={() => setLogistics(k)}>{t('logistics' + k[0].toUpperCase() + k.slice(1), lang)}</button>
          ))}
        </div>
        {v && (
          <div className="card" style={{ marginTop: 10 }}>
            <div className="row"><b>{t('nextService', lang)}</b><span>{v.next_service_due ? new Date(v.next_service_due).toLocaleDateString('en-IN') : '—'}</span></div>
            <div className="toggles" style={{ marginTop: 8 }}>
              <button onClick={() => setServiceDue(1)}>{t('in1Month', lang)}</button>
              <button onClick={() => setServiceDue(3)}>{t('in3Months', lang)}</button>
              <button onClick={() => setServiceDue(6)}>{t('in6Months', lang)}</button>
              {v.next_service_due && <button onClick={clearServiceDue}>{t('clearReminder', lang)}</button>}
            </div>
          </div>
        )}
        <h4>{t('billItems', lang)}</h4>
        {(job.lines || []).length === 0 && <p className="empty">—</p>}
        {(job.lines || []).length > 0 && (
          <div className="billline" style={{ borderBottom: '1.5px solid var(--rule)', fontWeight: 600, fontSize: 11.5, color: 'var(--steel)', textTransform: 'uppercase', letterSpacing: '.03em' }}>
            <span>{t('description', lang)}</span>
            <span>{t('quantity', lang)}</span>
            <span style={{ textAlign: 'right' }}>{t('amount', lang)}</span>
          </div>
        )}
        {(job.lines || []).map((l, i) => (
          <div key={i} className="billline">
            <span>{l.desc}</span>
            <span className="qtycol">{l.partQty ? 'Qty ' + l.partQty : '—'}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, justifySelf: 'end' }}>
              {money(l.amount)}
              <button className="linedelete" onClick={() => removeLine(i)}>✕</button>
            </span>
          </div>
        ))}

        <div className="toggles" style={{ marginTop: 12 }}>
          <button className={lineType === 'part' ? 'on' : ''} onClick={() => { setLineType('part'); setPartId(''); setOilRange(''); setDesc('') }}>{t('part', lang)}</button>
          <button className={lineType === 'labour' ? 'on' : ''} onClick={() => { setLineType('labour'); setPartId(''); setOilRange(''); setDesc(t('labourCharge', lang)) }}>{t('labour', lang)}</button>
          <button className={lineType === 'other' ? 'on' : ''} onClick={() => { setLineType('other'); setPartId(''); setOilRange(''); setDesc('') }}>{t('other', lang)}</button>
          <button className={lineType === 'oil' ? 'on' : ''} onClick={() => { setLineType('oil'); setPartId(''); setOilRange(''); setDesc('') }}>{t('oil', lang)}</button>
        </div>

        {lineType === 'part' && (
          <>
            <select value={partBrandFilter} onChange={e => { setPartBrandFilter(e.target.value); setPartId(''); setDesc(''); setAmt('') }}>
              <option value="all">{t('allBrands', lang)}</option>
              {BRAND_OPTIONS.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
            <StockSearchPicker items={visibleParts} stockmoves={data.stockmoves} selectedId={partId} onPick={pickPart} placeholder={t('pickFromStock', lang)} lang={lang} />
            <div className="row2">
              <input placeholder={t('unitPrice', lang)} type="number" value={amt} onChange={e => setAmt(e.target.value)} />
              <input placeholder={t('quantity', lang)} type="number" min="1" value={qty} onChange={e => setQty(e.target.value)} />
            </div>
            {partId && amt && qty && <div className="subrow" style={{ marginBottom: 8 }}>= {money(Number(amt) * Number(qty))}</div>}
          </>
        )}
        {lineType === 'oil' && (
          <>
            <select value={oilRange} onChange={e => { setOilRange(e.target.value); setPartId(''); setDesc(''); setAmt('') }}>
              <option value="">{t('pickOilRange', lang)}</option>
              <option value="normal">{t('oilNormal', lang)}</option>
              <option value="mid">{t('oilMid', lang)}</option>
              <option value="high">{t('oilHigh', lang)}</option>
            </select>
            {oilRange && (
              oilsInRange.length === 0 ? (
                <p className="empty">{t('noOilsInRange', lang)}</p>
              ) : (
                <StockSearchPicker items={oilsInRange} stockmoves={data.stockmoves} selectedId={partId} onPick={pickPart} placeholder={t('pickOil', lang)} lang={lang} />
              )
            )}
            <div className="row2">
              <input placeholder={t('unitPrice', lang)} type="number" value={amt} onChange={e => setAmt(e.target.value)} />
              <input placeholder={t('quantity', lang)} type="number" min="1" value={qty} onChange={e => setQty(e.target.value)} />
            </div>
            {partId && amt && qty && <div className="subrow" style={{ marginBottom: 8 }}>= {money(Number(amt) * Number(qty))}</div>}
          </>
        )}
        {lineType === 'labour' && (
          <div className="row2">
            <LabourQuickPicker value={desc} onChange={setDesc} lang={lang} />
            <input placeholder={t('amount', lang)} type="number" value={amt} onChange={e => setAmt(e.target.value)} />
          </div>
        )}
        {lineType === 'other' && (
          <div className="row2">
            <input placeholder={t('description', lang)} value={desc} onChange={e => setDesc(e.target.value)} />
            <input placeholder={t('amount', lang)} type="number" value={amt} onChange={e => setAmt(e.target.value)} />
          </div>
        )}
        <button onClick={addLine}>{t('addLine', lang)}</button>

        <div className="totalblock">
          <div className="row"><span>{t('subtotal', lang)}</span><span>{money(tt.subtotal)}</span></div>
          <div className="row"><span>{t('discount', lang)}</span><input type="number" defaultValue={job.discount} onBlur={async e => { await supabase.from('jobs').update({ discount: Number(e.target.value) || 0 }).eq('id', job.id); reload() }} /></div>
          <div className="row grand"><span>{t('total', lang)}</span><b>{money(tt.grand)}</b></div>
        </div>

        <h4 style={{ marginTop: 14 }}>{t('payments', lang)}</h4>
        {payments.map((p, i) => (
          <div key={i} className="row paymentrow">
            <span>{p.method === 'gpay' ? '📱 ' + t('gpay', lang) : '💵 ' + t('cash', lang)}: {money(p.amount)}</span>
            <button onClick={() => removePayment(i)}>✕</button>
          </div>
        ))}
        <div className="toggles">
          <button className={payMethod === 'gpay' ? 'on' : ''} onClick={() => setPayMethod('gpay')}>{t('gpay', lang)}</button>
          <button className={payMethod === 'cash' ? 'on' : ''} onClick={() => setPayMethod('cash')}>{t('cash', lang)}</button>
        </div>
        <div className="row2">
          <input placeholder={t('amount', lang)} type="number" value={payAmt} onChange={e => setPayAmt(e.target.value)} />
          <button onClick={addPayment}>{t('addPayment', lang)}</button>
        </div>

        <div className="totalblock">
          <div className="row"><span>{t('totalPaid', lang)}</span><b>{money(tt.paid)}</b></div>
          <div className="row"><span>{t('balanceDue', lang)}</span><b className="danger">{money(tt.due)}</b></div>
        </div>

        <button className="primary" onClick={() => setShowBill(true)}>{t('viewBill', lang)}</button>
        <button className="dangerbtn" onClick={deleteJob}>{t('deleteJob', lang)}</button>
      </div>
      {showBill && <BillViewSheet job={job} customer={c} vehicle={v} totals={tt} lang={lang} onClose={() => setShowBill(false)} />}
    </div>
  )
}

function BillViewSheet({ job, customer, vehicle, totals, lang, onClose }) {
  const [copied, setCopied] = useState(false)
  const text = billWhatsappText(job, customer, vehicle, totals)

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      await alertDialog(text)
    }
  }

  return (
    <div className="sheetback" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="sheethead"><h3>{t('bill', lang)}{billNo(job) ? ' · ' + billNo(job) : ''}</h3><button onClick={onClose}>✕</button></div>
        <div className="billsheet">{text}</div>
        <button className="primary" onClick={copy}>{copied ? t('copied', lang) : t('copyForWhatsapp', lang)}</button>
        <button className="primary" onClick={() => generateBillPdf(job, customer, vehicle, totals)}>{t('downloadPdf', lang)}</button>
        <button onClick={onClose} style={{ marginTop: 8 }}>{t('close', lang)}</button>
      </div>
    </div>
  )
}

function custDateRangeBounds(range) {
  const now = new Date()
  const start = new Date(now); start.setHours(0, 0, 0, 0)
  const day = (start.getDay() + 6) % 7 // Monday=0
  if (range === 'week') { start.setDate(start.getDate() - day); return { start: start.getTime(), end: Date.now() } }
  if (range === 'lastweek') {
    const thisWeekStart = new Date(start); thisWeekStart.setDate(start.getDate() - day)
    const lastWeekStart = new Date(thisWeekStart); lastWeekStart.setDate(thisWeekStart.getDate() - 7)
    return { start: lastWeekStart.getTime(), end: thisWeekStart.getTime() }
  }
  if (range === 'month') { const s = new Date(now.getFullYear(), now.getMonth(), 1); return { start: s.getTime(), end: Date.now() } }
  if (range === 'lastmonth') {
    const s = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const e = new Date(now.getFullYear(), now.getMonth(), 1)
    return { start: s.getTime(), end: e.getTime() }
  }
  return null
}

function Customers({ data, reload, lang }) {
  const [search, setSearch] = useState('')
  const [range, setRange] = useState('all')
  const [openCustId, setOpenCustId] = useState(null)
  const openCust = data.customers.find(c => c.id === openCustId) || null
  const bounds = range === 'all' ? null : custDateRangeBounds(range)

  const filtered = data.customers.filter(c => {
    const vehicles = data.vehicles.filter(v => v.customer_id === c.id)
    const jobs = data.jobs.filter(j => j.customer_id === c.id)
    if (bounds) {
      const inRange = jobs.some(j => { const ts = new Date(j.created_at).getTime(); return ts >= bounds.start && ts < bounds.end })
      if (!inRange) return false
    }
    if (!search) return true
    const s = search.toLowerCase()
    return c.name?.toLowerCase().includes(s) || c.phone?.includes(search) ||
      vehicles.some(v => v.reg_no?.toLowerCase().includes(s)) ||
      jobs.some(j => String(Math.round(jobTotals(j).grand)).includes(search))
  })

  async function delCustomer(c) {
    if (!await confirmDialog(t('confirmDeleteCustomer', lang))) return
    const vehIds = data.vehicles.filter(v => v.customer_id === c.id).map(v => v.id)
    const jobIds = data.jobs.filter(j => j.customer_id === c.id).map(j => j.id)
    const now = new Date().toISOString()
    for (const jid of jobIds) await setDeletedAt('jobs', jid, now)
    for (const vid of vehIds) await setDeletedAt('vehicles', vid, now)
    await setDeletedAt('customers', c.id, now)
    await reload()
    showToast(t('customerDeleted', lang), 'danger', {
      action: t('undo', lang), duration: 6000,
      onAction: async () => {
        for (const jid of jobIds) await setDeletedAt('jobs', jid, null)
        for (const vid of vehIds) await setDeletedAt('vehicles', vid, null)
        await setDeletedAt('customers', c.id, null)
        await reload()
      },
    })
  }

  return (
    <div className="screen">
      <div className="screenhead"><h2>{t('customers', lang)}</h2></div>
      <input placeholder={t('searchCust', lang)} value={search} onChange={e => setSearch(e.target.value)} />
      <div className="toggles">
        {['all', 'week', 'lastweek', 'month', 'lastmonth'].map(r => (
          <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>{t(r === 'all' ? 'all' : r === 'week' ? 'thisWeek' : r === 'lastweek' ? 'lastWeek' : r === 'month' ? 'thisMonth' : 'lastMonth', lang)}</button>
        ))}
      </div>
      {filtered.map(c => {
        const vehicles = data.vehicles.filter(v => v.customer_id === c.id)
        const jobs = data.jobs.filter(j => j.customer_id === c.id)
        const due = jobs.reduce((s, j) => s + jobTotals(j).due, 0)
        return (
          <div key={c.id} className="card">
            <button className="row ghost-row" onClick={() => setOpenCustId(c.id)}>
              <b>{c.name}</b><span>{c.phone}</span>
            </button>
            <div className="subrow">{vehicles.map(v => v.reg_no).join(', ') || t('noVehicle', lang)}</div>
            {due > 0 && <div className="subrow danger">Due {money(due)}</div>}
            <div className="row2" style={{ marginTop: 8 }}>
              {c.phone && <a className="primary small" style={{ textAlign: 'center', textDecoration: 'none', display: 'block' }} href={'tel:' + c.phone}>📞 {t('call', lang)}</a>}
              {c.phone && <a className="primary small" style={{ textAlign: 'center', textDecoration: 'none', display: 'block', background: 'linear-gradient(135deg, #25D366, #128C7E)' }} href={'https://wa.me/91' + c.phone.replace(/\D/g, '')} target="_blank" rel="noreferrer">💬 {t('whatsapp', lang)}</a>}
            </div>
            <button className="dangerbtn small" onClick={() => delCustomer(c)}>{t('deleteCustomer', lang)}</button>
          </div>
        )
      })}
      {openCust && <CustomerDetailSheet customer={openCust} data={data} reload={reload} lang={lang} onClose={() => setOpenCustId(null)} />}
    </div>
  )
}

function CustomerDetailSheet({ customer, data, reload, lang, onClose }) {
  const [showAddVeh, setShowAddVeh] = useState(false)
  const [reg, setReg] = useState(''), [model, setModel] = useState('')
  const vehicles = data.vehicles.filter(v => v.customer_id === customer.id)
  const jobs = data.jobs.filter(j => j.customer_id === customer.id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

  async function addVehicle() {
    if (!reg.trim()) { await alertDialog('Enter a vehicle reg number'); return }
    await supabase.from('vehicles').insert({ customer_id: customer.id, reg_no: reg.trim().toUpperCase(), model: model.trim() })
    setReg(''); setModel(''); setShowAddVeh(false)
    await reload()
  }

  return (
    <div className="sheetback" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="sheethead"><h3>{customer.name}</h3><button onClick={onClose}>✕</button></div>
        <div className="subrow">{customer.phone}</div>
        <h4 style={{ marginTop: 14 }}>{t('vehicles', lang)}</h4>
        {vehicles.map(v => (
          <div key={v.id} className="card">
            <div className="row"><b>{v.reg_no}</b><span>{v.model}</span></div>
            {v.next_service_due && <div className="subrow">{t('nextService', lang)}: {new Date(v.next_service_due).toLocaleDateString('en-IN')}</div>}
          </div>
        ))}
        {showAddVeh ? (
          <div className="card">
            <input placeholder={t('vehReg', lang)} value={reg} onChange={e => setReg(e.target.value.toUpperCase())} />
            <input placeholder={t('vehModel', lang)} value={model} onChange={e => setModel(e.target.value)} />
            <button className="primary" onClick={addVehicle}>{t('addVehicle', lang)}</button>
          </div>
        ) : (
          <button onClick={() => setShowAddVeh(true)}>{t('addVehicle', lang)}</button>
        )}

        <h4 style={{ marginTop: 14 }}>{t('visitHistory', lang)}</h4>
        {jobs.length === 0 && <p className="empty">—</p>}
        {jobs.map(j => {
          const v = data.vehicles.find(x => x.id === j.vehicle_id)
          const tt = jobTotals(j)
          return (
            <div key={j.id} className="row paymentrow">
              <span>{new Date(j.created_at).toLocaleDateString('en-IN')} · {v?.reg_no || '—'} · {t(j.status === 'in_progress' ? 'inProgress' : j.status, lang)}</span>
              <b>{money(tt.grand)}</b>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const BRAND_OPTIONS = ['Hero', 'Honda', 'TVS', 'Bajaj', 'KTM', 'Yamaha', 'Royal Enfield', 'Suzuki']
const BRAND_MODELS = {
  Hero: ['Splendor', 'Splendor+', 'HF Deluxe', 'Passion Pro', 'Glamour', 'Xtreme 160R', 'Xpulse 200', 'Destini 125', 'Maestro Edge'],
  Honda: ['Activa', 'Dio', 'Shine', 'Unicorn', 'SP125', 'Hornet 2.0', 'CB350'],
  TVS: ['Apache RTR 160', 'Apache RTR 200', 'Jupiter', 'Ntorq', 'Raider 125', 'Star City', 'Sport'],
  Bajaj: ['Pulsar 150', 'Pulsar 220', 'Pulsar NS200', 'Dominar 250', 'Dominar 400', 'Avenger', 'Platina', 'CT100', 'Discover'],
  KTM: ['Duke 125', 'Duke 200', 'Duke 250', 'Duke 390', 'RC 200', 'RC 390'],
  Yamaha: ['FZ', 'FZS', 'R15', 'MT-15', 'Fascino', 'Ray ZR'],
  'Royal Enfield': ['Classic 350', 'Bullet 350', 'Meteor 350', 'Hunter 350', 'Himalayan'],
  Suzuki: ['Access 125', 'Gixxer', 'Burgman'],
}

function ModelPicker({ brands, models, setModels, lang }) {
  const [customModel, setCustomModel] = useState('')
  const available = [...new Set(brands.flatMap(b => BRAND_MODELS[b] || []))]

  function toggleModel(m) {
    setModels(s => s.includes(m) ? s.filter(x => x !== m) : [...s, m])
  }
  function addCustom() {
    const m = customModel.trim()
    if (!m) return
    if (!models.includes(m)) setModels(s => [...s, m])
    setCustomModel('')
  }

  if (brands.length === 0) return null

  return (
    <>
      <div className="subrow">{t('models', lang)}</div>
      <div className="toggles">
        {available.map(m => (
          <button key={m} className={models.includes(m) ? 'on' : ''} onClick={() => toggleModel(m)}>{m}</button>
        ))}
        {models.filter(m => !available.includes(m)).map(m => (
          <button key={m} className="on" onClick={() => toggleModel(m)}>{m}</button>
        ))}
      </div>
      <div className="row2">
        <input placeholder={t('customModel', lang)} value={customModel} onChange={e => setCustomModel(e.target.value)} />
        <button onClick={addCustom}>{t('addModel', lang)}</button>
      </div>
    </>
  )
}

function Stock({ data, reload, lang }) {
  const [section, setSection] = useState('part')
  const [showNew, setShowNew] = useState(false)
  const [showNewOil, setShowNewOil] = useState(false)
  const [openPartId, setOpenPartId] = useState(null)
  const openPart = data.parts.find(p => p.id === openPartId) || null
  const [search, setSearch] = useState('')
  const [cat, setCat] = useState('all')
  const [brandFilter, setBrandFilter] = useState('all')
  const [modelFilter, setModelFilter] = useState('all')
  const [name, setName] = useState(''), [cost, setCost] = useState(''), [sale, setSale] = useState('')
  const [minQty, setMinQty] = useState(''), [qty, setQty] = useState(''), [original, setOriginal] = useState(true)
  const [brand, setBrand] = useState('')
  const [suitsBrands, setSuitsBrands] = useState([])
  const [models, setModels] = useState([])

  const [oilName, setOilName] = useState(''), [oilCost, setOilCost] = useState(''), [oilSale, setOilSale] = useState('')
  const [oilMinQty, setOilMinQty] = useState(''), [oilQty, setOilQty] = useState('')

  function toggleSuits(b) {
    setSuitsBrands(s => s.includes(b) ? s.filter(x => x !== b) : [...s, b])
  }

  async function save() {
    if (!name.trim()) { await alertDialog('Enter a part name'); return }
    const { data: p } = await supabase.from('parts').insert({
      name: name.trim(), cost: Number(cost) || 0, sale: Number(sale) || 0, min_qty: Number(minQty) || 0, original,
      brands: original ? (brand ? [brand] : []) : suitsBrands,
      models, category: 'part',
    }).select().single()
    if (Number(qty) > 0) await supabase.from('stockmoves').insert({ part_id: p.id, qty: Number(qty), note: 'Opening stock' })
    setName(''); setCost(''); setSale(''); setMinQty(''); setQty(''); setOriginal(true); setBrand(''); setSuitsBrands([]); setModels([])
    setShowNew(false)
    await reload()
  }

  async function saveOil() {
    if (!oilName.trim()) { await alertDialog('Enter an oil name'); return }
    const { data: p } = await supabase.from('parts').insert({
      name: oilName.trim(), cost: Number(oilCost) || 0, sale: Number(oilSale) || 0, min_qty: Number(oilMinQty) || 0,
      category: 'oil', brands: [], models: [],
    }).select().single()
    if (Number(oilQty) > 0) await supabase.from('stockmoves').insert({ part_id: p.id, qty: Number(oilQty), note: 'Opening stock' })
    setOilName(''); setOilCost(''); setOilSale(''); setOilMinQty(''); setOilQty('')
    setShowNewOil(false)
    await reload()
  }

  const sectionParts = data.parts.filter(p => section === 'oil' ? p.category === 'oil' : p.category !== 'oil')
  const usedBrands = BRAND_OPTIONS.filter(b => sectionParts.some(p => (p.brands || []).includes(b)))

  const usedModels = brandFilter !== 'all'
    ? [...new Set(sectionParts.filter(p => (p.brands || []).includes(brandFilter)).flatMap(p => p.models || []))]
    : []

  const matches = sectionParts.filter(p => !search || p.name.toLowerCase().includes(search.toLowerCase()))
  let shown = matches
  if (section === 'part') {
    if (cat === 'original') shown = shown.filter(p => p.original !== false)
    if (cat === 'notoriginal') shown = shown.filter(p => p.original === false)
    if (cat === 'lowstock') shown = shown.filter(p => p.min_qty && partQty(p.id, data.stockmoves) <= p.min_qty)
    if (brandFilter !== 'all') shown = shown.filter(p => (p.brands || []).includes(brandFilter))
    if (modelFilter !== 'all') shown = shown.filter(p => (p.models || []).includes(modelFilter))
  } else {
    if (cat === 'lowstock') shown = shown.filter(p => p.min_qty && partQty(p.id, data.stockmoves) <= p.min_qty)
    if (cat === 'normal' || cat === 'mid' || cat === 'high') shown = shown.filter(p => oilRangeOf(p.sale) === cat)
  }

  return (
    <div className="screen">
      <div className="screenhead">
        <h2>{t('stock', lang)}</h2>
        <button className="fab" onClick={() => section === 'oil' ? setShowNewOil(true) : setShowNew(true)}>{t('new', lang)}</button>
      </div>
      <div className="toggles">
        <button className={section === 'part' ? 'on' : ''} onClick={() => { setSection('part'); setCat('all') }}>{t('parts', lang)}</button>
        <button className={section === 'oil' ? 'on' : ''} onClick={() => { setSection('oil'); setCat('all') }}>{t('oils', lang)}</button>
      </div>
      <input placeholder={t('searchParts', lang)} value={search} onChange={e => setSearch(e.target.value)} />
      <div className="toggles">
        <button className={cat === 'all' ? 'on' : ''} onClick={() => setCat('all')}>{t('all', lang)}</button>
        {section === 'part' && (
          <>
            <button className={cat === 'original' ? 'on' : ''} onClick={() => setCat('original')}>{t('original', lang)}</button>
            <button className={cat === 'notoriginal' ? 'on' : ''} onClick={() => setCat('notoriginal')}>{t('notOriginal', lang)}</button>
          </>
        )}
        <button className={cat === 'lowstock' ? 'on' : ''} onClick={() => setCat('lowstock')}>{t('lowStock', lang)}</button>
        {section === 'oil' && (
          <>
            <button className={cat === 'normal' ? 'on' : ''} onClick={() => setCat('normal')}>{t('oilNormal', lang)}</button>
            <button className={cat === 'mid' ? 'on' : ''} onClick={() => setCat('mid')}>{t('oilMid', lang)}</button>
            <button className={cat === 'high' ? 'on' : ''} onClick={() => setCat('high')}>{t('oilHigh', lang)}</button>
          </>
        )}
      </div>
      {section === 'part' && usedBrands.length > 0 && (
        <select value={brandFilter} onChange={e => { setBrandFilter(e.target.value); setModelFilter('all') }}>
          <option value="all">{t('allBrands', lang)}</option>
          {usedBrands.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
      )}
      {section === 'part' && brandFilter !== 'all' && usedModels.length > 0 && (
        <select value={modelFilter} onChange={e => setModelFilter(e.target.value)}>
          <option value="all">{t('allModels', lang)}</option>
          {usedModels.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      )}
      {shown.length === 0 && <p className="empty">—</p>}
      {shown.map(p => {
        const q = partQty(p.id, data.stockmoves)
        const low = p.min_qty && q <= p.min_qty
        return (
          <button key={p.id} className={'card tap' + (low ? ' warn' : '')} onClick={() => setOpenPartId(p.id)}>
            <div className="row"><b>{p.name}{low ? ' ⚠️' : ''}</b><span className={q <= 0 ? 'danger' : ''}>{q} {t('inStock', lang)}</span></div>
            <div className="subrow">{t('costPrice', lang)} {money(p.cost)} · {t('salePrice', lang)} {money(p.sale)}{p.brands?.length ? ' · ' + p.brands.join(', ') : ''}{p.models?.length ? ' · ' + p.models.join(', ') : ''}</div>
          </button>
        )
      })}
      {showNew && (
        <div className="sheetback" onClick={() => setShowNew(false)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <div className="sheethead"><h3>{t('newPart', lang)}</h3><button onClick={() => setShowNew(false)}>✕</button></div>
            <input placeholder={t('partName', lang)} value={name} onChange={e => setName(e.target.value)} />
            <div className="row2">
              <input placeholder={t('costPrice', lang)} type="number" value={cost} onChange={e => setCost(e.target.value)} />
              <input placeholder={t('salePrice', lang)} type="number" value={sale} onChange={e => setSale(e.target.value)} />
            </div>
            <input placeholder={t('lowStockBelow', lang)} type="number" value={minQty} onChange={e => setMinQty(e.target.value)} />
            <input placeholder={t('qtyNow', lang)} type="number" value={qty} onChange={e => setQty(e.target.value)} />
            <div className="toggles">
              <button className={original ? 'on' : ''} onClick={() => setOriginal(true)}>{t('original', lang)}</button>
              <button className={!original ? 'on' : ''} onClick={() => setOriginal(false)}>{t('notOriginal', lang)}</button>
            </div>
            {original ? (
              <select value={brand} onChange={e => setBrand(e.target.value)}>
                <option value="">{t('selectBrand', lang)}</option>
                {BRAND_OPTIONS.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            ) : (
              <>
                <div className="subrow">{t('suitsBrands', lang)}</div>
                <div className="toggles">
                  {BRAND_OPTIONS.map(b => (
                    <button key={b} className={suitsBrands.includes(b) ? 'on' : ''} onClick={() => toggleSuits(b)}>{b}</button>
                  ))}
                </div>
              </>
            )}
            <ModelPicker brands={original ? (brand ? [brand] : []) : suitsBrands} models={models} setModels={setModels} lang={lang} />
            <button className="primary" onClick={save}>{t('savePart', lang)}</button>
          </div>
        </div>
      )}
      {showNewOil && (
        <div className="sheetback" onClick={() => setShowNewOil(false)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <div className="sheethead"><h3>{t('newOil', lang)}</h3><button onClick={() => setShowNewOil(false)}>✕</button></div>
            <input placeholder={t('oilName', lang)} value={oilName} onChange={e => setOilName(e.target.value)} />
            <div className="row2">
              <input placeholder={t('costPrice', lang)} type="number" value={oilCost} onChange={e => setOilCost(e.target.value)} />
              <input placeholder={t('salePrice', lang)} type="number" value={oilSale} onChange={e => setOilSale(e.target.value)} />
            </div>
            <input placeholder={t('lowStockBelow', lang)} type="number" value={oilMinQty} onChange={e => setOilMinQty(e.target.value)} />
            <input placeholder={t('qtyNow', lang)} type="number" value={oilQty} onChange={e => setOilQty(e.target.value)} />
            <button className="primary" onClick={saveOil}>{t('saveOil', lang)}</button>
          </div>
        </div>
      )}
      {openPart && <PartDetailSheet part={openPart} data={data} reload={reload} lang={lang} onClose={() => setOpenPartId(null)} />}
    </div>
  )
}

function PartDetailSheet({ part, data, reload, lang, onClose }) {
  const isOil = part.category === 'oil'
  const [name, setName] = useState(part.name)
  const [cost, setCost] = useState(part.cost ?? 0)
  const [sale, setSale] = useState(part.sale ?? 0)
  const [minQty, setMinQty] = useState(part.min_qty ?? 0)
  const [original, setOriginal] = useState(part.original !== false)
  const [brand, setBrand] = useState(part.original !== false ? (part.brands?.[0] || '') : '')
  const [suitsBrands, setSuitsBrands] = useState(part.original === false ? (part.brands || []) : [])
  const [models, setModels] = useState(part.models || [])
  const [addQty, setAddQty] = useState('')
  const currentQty = partQty(part.id, data.stockmoves)

  function toggleSuits(b) {
    setSuitsBrands(s => s.includes(b) ? s.filter(x => x !== b) : [...s, b])
  }

  async function saveChanges() {
    if (!name.trim()) { await alertDialog('Enter a name'); return }
    await supabase.from('parts').update({
      name: name.trim(), cost: Number(cost) || 0, sale: Number(sale) || 0, min_qty: Number(minQty) || 0,
      ...(isOil ? {} : {
        original,
        brands: original ? (brand ? [brand] : []) : suitsBrands,
        models,
      }),
    }).eq('id', part.id)
    if (Number(addQty) > 0) {
      await supabase.from('stockmoves').insert({ part_id: part.id, qty: Number(addQty), note: 'Stock added' })
    }
    await reload()
    onClose()
  }

  async function del() {
    if (!await confirmDialog(t('confirmDeletePart', lang))) return
    await setDeletedAt('parts', part.id, new Date().toISOString())
    await reload()
    onClose()
    showToast(t('partDeleted', lang), 'danger', {
      action: t('undo', lang), duration: 6000,
      onAction: async () => { await setDeletedAt('parts', part.id, null); await reload() },
    })
  }

  return (
    <div className="sheetback" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="sheethead"><h3>{t(isOil ? 'editOil' : 'editPart', lang)}</h3><button onClick={onClose}>✕</button></div>
        <input placeholder={isOil ? t('oilName', lang) : t('partName', lang)} value={name} onChange={e => setName(e.target.value)} />
        <div className="row2">
          <input placeholder={t('costPrice', lang)} type="number" value={cost} onChange={e => setCost(e.target.value)} />
          <input placeholder={t('salePrice', lang)} type="number" value={sale} onChange={e => setSale(e.target.value)} />
        </div>
        <input placeholder={t('lowStockBelow', lang)} type="number" value={minQty} onChange={e => setMinQty(e.target.value)} />
        {!isOil && (
          <>
            <div className="toggles">
              <button className={original ? 'on' : ''} onClick={() => setOriginal(true)}>{t('original', lang)}</button>
              <button className={!original ? 'on' : ''} onClick={() => setOriginal(false)}>{t('notOriginal', lang)}</button>
            </div>
            {original ? (
              <select value={brand} onChange={e => setBrand(e.target.value)}>
                <option value="">{t('selectBrand', lang)}</option>
                {BRAND_OPTIONS.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            ) : (
              <>
                <div className="subrow">{t('suitsBrands', lang)}</div>
                <div className="toggles">
                  {BRAND_OPTIONS.map(b => (
                    <button key={b} className={suitsBrands.includes(b) ? 'on' : ''} onClick={() => toggleSuits(b)}>{b}</button>
                  ))}
                </div>
              </>
            )}
            <ModelPicker brands={original ? (brand ? [brand] : []) : suitsBrands} models={models} setModels={setModels} lang={lang} />
          </>
        )}
        <div className="totalblock">
          <div className="row"><span>{t('qtyNow', lang)}</span><b>{currentQty}</b></div>
        </div>
        <input placeholder={t('addQty', lang)} type="number" value={addQty} onChange={e => setAddQty(e.target.value)} />
        <button className="primary" onClick={saveChanges}>{t('saveChanges', lang)}</button>
        <button className="dangerbtn" onClick={del}>{t('deletePart', lang)}</button>
      </div>
    </div>
  )
}

function fmtDatetimeLocal(d) {
  const pad = n => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function Dues({ data, reload, lang }) {
  const dues = data.jobs.map(j => ({ job: j, tt: jobTotals(j) })).filter(x => x.tt.due > 0)
  const totalPending = dues.reduce((s, x) => s + x.tt.due, 0)
  const [remindJobId, setRemindJobId] = useState(null)
  const [remindWhen, setRemindWhen] = useState('')

  function openRemind(job) {
    setRemindJobId(job.id)
    setRemindWhen(fmtDatetimeLocal(new Date(Date.now() + 24 * 60 * 60 * 1000)))
  }

  function quickSet(hoursFromNow) {
    setRemindWhen(fmtDatetimeLocal(new Date(Date.now() + hoursFromNow * 60 * 60 * 1000)))
  }

  async function confirmRemind(job, c, v) {
    if (!remindWhen) { await alertDialog('Pick a date and time'); return }
    const remindAt = new Date(remindWhen).getTime()
    if (!remindAt || remindAt < Date.now() - 60000) { await alertDialog('Pick a time in the future'); return }
    const text = 'Collect ' + money(jobTotals(job).due) + ' from ' + (c?.name || 'customer') + (v?.reg_no ? ' (' + v.reg_no + ')' : '')
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission()
    const { error } = await supabase.from('notes').insert({ text, remind_at: new Date(remindAt).toISOString(), notified: false, done: false })
    if (error) { showToast('Could not set reminder: ' + error.message, 'danger'); return }
    setRemindJobId(null)
    await reload()
    showToast(t('reminderSet', lang), 'ok')
  }

  return (
    <div className="screen">
      <h2>{t('toCollect', lang)}</h2>
      <div className="totalblock"><div className="row grand"><span>{t('totalPending', lang)}</span><b className="danger">{money(totalPending)}</b></div></div>
      {dues.length === 0 && <p className="empty">{t('noDues', lang)}</p>}
      {dues.map(({ job, tt }) => {
        const c = data.customers.find(x => x.id === job.customer_id)
        const v = data.vehicles.find(x => x.id === job.vehicle_id)
        return (
          <div key={job.id} className="card">
            <div className="row"><b>{v?.reg_no || c?.name}</b><span className="danger">{money(tt.due)}</span></div>
            {v?.reg_no && <div className="subrow">{c?.name}</div>}
            {remindJobId === job.id ? (
              <div style={{ marginTop: 8 }}>
                <input type="datetime-local" value={remindWhen} onChange={e => setRemindWhen(e.target.value)} />
                <div className="toggles" style={{ marginTop: 6 }}>
                  <button onClick={() => quickSet(24)}>{t('tomorrow', lang)}</button>
                  <button onClick={() => quickSet(24 * 3)}>{t('in3Days', lang)}</button>
                  <button onClick={() => quickSet(24 * 7)}>{t('in1Week', lang)}</button>
                </div>
                <div className="row2" style={{ marginTop: 8 }}>
                  <button className="primary" onClick={() => confirmRemind(job, c, v)}>{t('setReminder', lang)}</button>
                  <button onClick={() => setRemindJobId(null)}>{t('cancel', lang)}</button>
                </div>
              </div>
            ) : (
              <button style={{ marginTop: 8 }} onClick={() => openRemind(job)}>{t('remindCollect', lang)}</button>
            )}
          </div>
        )
      })}
    </div>
  )
}

function workerAdvancesThisMonth(w, data) {
  const thisMonth = monthKeyOf(Date.now())
  return data.advances.filter(a => a.worker_id === w.id && monthKeyOf(a.at) === thisMonth)
}

function workerBalance(w, data) {
  const advTotal = workerAdvancesThisMonth(w, data).reduce((s, a) => s + Number(a.amount), 0)
  if (w.pay_type === 'daily') {
    const thisMonth = monthKeyOf(Date.now())
    const days = data.attendance.filter(a => a.worker_id === w.id && monthKeyOf(a.at) === thisMonth).length
    return Math.max(0, days * Number(w.wage_day || 0) - advTotal)
  }
  return Math.max(0, Number(w.salary || 0) - advTotal)
}

function Workers({ data, reload, lang }) {
  const [showNew, setShowNew] = useState(false)
  const [openWorkerId, setOpenWorkerId] = useState(null)
  const openWorker = data.workers.find(w => w.id === openWorkerId) || null
  const [name, setName] = useState(''), [payType, setPayType] = useState('fixed'), [salary, setSalary] = useState(''), [wageDay, setWageDay] = useState('')

  async function save() {
    if (!name.trim()) return
    await supabase.from('workers').insert({ name: name.trim(), pay_type: payType, salary: payType === 'fixed' ? Number(salary) || 0 : 0, wage_day: payType === 'daily' ? Number(wageDay) || 0 : 0 })
    setName(''); setSalary(''); setWageDay(''); setPayType('fixed'); setShowNew(false)
    await reload()
  }

  return (
    <div className="screen">
      <div className="screenhead"><h2>{t('workers', lang)}</h2><button className="fab" onClick={() => setShowNew(true)}>{t('new', lang)}</button></div>
      {data.workers.map(w => {
        const bal = workerBalance(w, data)
        return (
          <button key={w.id} className="card tap" onClick={() => setOpenWorkerId(w.id)}>
            <div className="row"><b>{w.name}</b><span>{w.pay_type === 'daily' ? money(w.wage_day) + '/day' : money(w.salary) + '/mo'}</span></div>
            <div className="subrow">{t('balance', lang)} {money(bal)}</div>
          </button>
        )
      })}
      {showNew && (
        <div className="sheetback" onClick={() => setShowNew(false)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <div className="sheethead"><h3>{t('newWorker', lang)}</h3><button onClick={() => setShowNew(false)}>✕</button></div>
            <input placeholder={t('name', lang)} value={name} onChange={e => setName(e.target.value)} />
            <div className="toggles">
              <button className={payType === 'fixed' ? 'on' : ''} onClick={() => setPayType('fixed')}>{t('fixed', lang)}</button>
              <button className={payType === 'daily' ? 'on' : ''} onClick={() => setPayType('daily')}>{t('daily', lang)}</button>
            </div>
            {payType === 'fixed'
              ? <input placeholder={t('monthlySalary', lang)} type="number" value={salary} onChange={e => setSalary(e.target.value)} />
              : <input placeholder={t('wagePerDay', lang)} type="number" value={wageDay} onChange={e => setWageDay(e.target.value)} />}
            <button className="primary" onClick={save}>{t('saveWorker', lang)}</button>
          </div>
        </div>
      )}
      {openWorker && <WorkerDetailSheet worker={openWorker} data={data} reload={reload} lang={lang} onClose={() => setOpenWorkerId(null)} />}
    </div>
  )
}

function WorkerDetailSheet({ worker, data, reload, lang, onClose }) {
  const today = dayKeyOf(Date.now())
  const markedToday = data.attendance.some(a => a.worker_id === worker.id && dayKeyOf(a.at) === today)
  const thisMonth = monthKeyOf(Date.now())
  const monthAttendance = data.attendance.filter(a => a.worker_id === worker.id && monthKeyOf(a.at) === thisMonth).sort((a, b) => new Date(b.at) - new Date(a.at))
  const monthAdvances = workerAdvancesThisMonth(worker, data).sort((a, b) => new Date(b.at) - new Date(a.at))
  const advTotal = monthAdvances.reduce((s, a) => s + Number(a.amount), 0)
  const [advAmt, setAdvAmt] = useState('')
  const [advMethod, setAdvMethod] = useState('cash')
  const [advNote, setAdvNote] = useState('')

  async function markToday() {
    if (markedToday) return
    const { error } = await supabase.from('attendance').insert({ worker_id: worker.id, at: new Date().toISOString() })
    if (error) { showToast('Could not mark attendance: ' + error.message, 'danger'); return }
    await reload()
  }
  async function removeAttendance(id) { await supabase.from('attendance').delete().eq('id', id); await reload() }

  async function addAdvance() {
    if (!advAmt || Number(advAmt) <= 0) { await alertDialog('Enter an amount'); return }
    await supabase.from('advances').insert({ worker_id: worker.id, amount: Number(advAmt), method: advMethod, note: advNote.trim(), at: new Date().toISOString() })
    setAdvAmt(''); setAdvNote('')
    await reload()
  }
  async function removeAdvance(id) { await supabase.from('advances').delete().eq('id', id); await reload() }

  async function delWorker() {
    if (!await confirmDialog(t('confirmDeleteWorker', lang))) return
    await setDeletedAt('workers', worker.id, new Date().toISOString())
    await reload()
    onClose()
    showToast(t('workerDeleted', lang), 'danger', {
      action: t('undo', lang), duration: 6000,
      onAction: async () => { await setDeletedAt('workers', worker.id, null); await reload() },
    })
  }

  return (
    <div className="sheetback" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="sheethead"><h3>{worker.name}</h3><button onClick={onClose}>✕</button></div>
        <div className="totalblock">
          <div className="row"><span>{worker.pay_type === 'daily' ? t('wagePerDay', lang) : t('monthlySalary', lang)}</span><b>{money(worker.pay_type === 'daily' ? worker.wage_day : worker.salary)}</b></div>
          <div className="row"><span>{t('totalAdvance', lang)}</span><b>{money(advTotal)}</b></div>
          <div className="row grand"><span>{t('salaryBalance', lang)}</span><b>{money(workerBalance(worker, data))}</b></div>
        </div>
        <h4 style={{ marginTop: 14 }}>{t('attendance', lang)}</h4>
        <div className="row"><span>{t('daysThisMonth', lang)}</span><b>{monthAttendance.length}</b></div>
        <button className="primary" disabled={markedToday} onClick={markToday}>{markedToday ? t('alreadyMarked', lang) : t('markToday', lang)}</button>
        {monthAttendance.length === 0 && <p className="empty">—</p>}
        {monthAttendance.map(a => (
          <div key={a.id} className="row subrow">
            <span>{new Date(a.at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} · {new Date(a.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
            <button onClick={() => removeAttendance(a.id)}>✕</button>
          </div>
        ))}

        <h4 style={{ marginTop: 14 }}>{t('advanceHistory', lang)}</h4>
        {monthAdvances.length === 0 && <p className="empty">—</p>}
        {monthAdvances.map(a => (
          <div key={a.id} className="row paymentrow">
            <span>{a.method === 'gpay' ? '📱 ' + t('gpay', lang) : '💵 ' + t('cash', lang)}: {money(a.amount)} · {new Date(a.at).toLocaleDateString('en-IN')}</span>
            <button onClick={() => removeAdvance(a.id)}>✕</button>
          </div>
        ))}
        <div className="toggles">
          <button className={advMethod === 'gpay' ? 'on' : ''} onClick={() => setAdvMethod('gpay')}>{t('gpay', lang)}</button>
          <button className={advMethod === 'cash' ? 'on' : ''} onClick={() => setAdvMethod('cash')}>{t('cash', lang)}</button>
        </div>
        <div className="row2">
          <input placeholder={t('advanceAmt', lang)} type="number" value={advAmt} onChange={e => setAdvAmt(e.target.value)} />
          <button onClick={addAdvance}>{t('addAdvance', lang)}</button>
        </div>
        <input placeholder={t('advanceNote', lang)} value={advNote} onChange={e => setAdvNote(e.target.value)} />
        <button className="dangerbtn" onClick={delWorker}>{t('deleteWorker', lang)}</button>
      </div>
    </div>
  )
}

function NotesSheet({ data, reload, lang, onClose }) {
  const [showNew, setShowNew] = useState(false)
  const [text, setText] = useState(''), [date, setDate] = useState(''), [time, setTime] = useState('')

  async function save() {
    if (!text.trim()) return
    let remindAt = null
    if (date) {
      remindAt = new Date(date + 'T' + (time || '09:00')).toISOString()
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission()
    }
    const { error } = await supabase.from('notes').insert({ text: text.trim(), remind_at: remindAt, notified: false, done: false })
    if (error) { showToast('Could not save note: ' + error.message, 'danger'); return }
    setText(''); setDate(''); setTime(''); setShowNew(false)
    await reload()
  }
  async function toggleDone(n) { await supabase.from('notes').update({ done: !n.done }).eq('id', n.id); await reload() }
  async function del(n) {
    await setDeletedAt('notes', n.id, new Date().toISOString())
    await reload()
    showToast(t('noteDeleted', lang), 'danger', {
      action: t('undo', lang), duration: 6000,
      onAction: async () => { await setDeletedAt('notes', n.id, null); await reload() },
    })
  }

  const sorted = data.notes.slice().sort((a, b) => (a.done - b.done) || new Date(b.created_at) - new Date(a.created_at))

  return (
    <div className="sheetback" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="sheethead"><h3>{t('notes', lang)}</h3><button onClick={onClose}>✕</button></div>
        <button className="fab" onClick={() => setShowNew(s => !s)}>{t('newNote', lang)}</button>
        {showNew && (
          <div className="card" style={{ marginTop: 10 }}>
            <textarea placeholder={t('noteText', lang)} value={text} onChange={e => setText(e.target.value)} rows={3} style={{ width: '100%', padding: 10, borderRadius: 10, border: '1.5px solid var(--rule)' }} />
            <div className="row2">
              <input type="date" value={date} onChange={e => setDate(e.target.value)} />
              <input type="time" value={time} onChange={e => setTime(e.target.value)} />
            </div>
            <button className="primary" onClick={save}>{t('saveNote', lang)}</button>
          </div>
        )}
        {sorted.length === 0 && <p className="empty">{t('noNotes', lang)}</p>}
        {sorted.map(n => (
          <div key={n.id} className={'card' + (n.done ? '' : '')} style={{ opacity: n.done ? 0.5 : 1, marginTop: 10 }}>
            <div className="row"><span>{n.text}</span></div>
            {n.remind_at && <div className="subrow">⏰ {new Date(n.remind_at).toLocaleString('en-IN')}</div>}
            <div className="row2" style={{ marginTop: 6 }}>
              <button onClick={() => toggleDone(n)}>{t('done', lang)}</button>
              <button onClick={() => del(n)}>{t('delete', lang)}</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function playAlarmBeep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    const ctx = new Ctx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'square'
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.04)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4)
    osc.connect(gain); gain.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.45)
    osc.onended = () => ctx.close()
  } catch {}
}

function ReminderWatcher({ data, reload, lang }) {
  const [alertNote, setAlertNote] = useState(null)
  const notifiedRef = useRef(new Set())
  const alarmIvRef = useRef(null)

  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      // request lazily on first reminder set, not on load
    }
    const iv = setInterval(() => {
      const now = Date.now()
      const due = data.notes.find(n => !n.done && !n.notified && n.remind_at && new Date(n.remind_at).getTime() <= now && !notifiedRef.current.has(n.id))
      if (due) {
        notifiedRef.current.add(due.id)
        setAlertNote(due)
        supabase.from('notes').update({ notified: true }).eq('id', due.id).then(() => reload())
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification('WOLT 69 — ' + t('reminder', lang), { body: due.text })
        }
      }
    }, 15000)
    return () => clearInterval(iv)
  }, [data.notes, lang, reload])

  // Alarm effect: keep beeping + vibrating while the popup is on screen (works as long as
  // the app tab/window is open — it can't ring if the app/browser is fully closed).
  useEffect(() => {
    if (!alertNote) return
    playAlarmBeep()
    if (navigator.vibrate) navigator.vibrate([250, 150, 250])
    alarmIvRef.current = setInterval(() => {
      playAlarmBeep()
      if (navigator.vibrate) navigator.vibrate([250, 150, 250])
    }, 1500)
    return () => { clearInterval(alarmIvRef.current); alarmIvRef.current = null }
  }, [alertNote])

  function dismiss() {
    if (alarmIvRef.current) { clearInterval(alarmIvRef.current); alarmIvRef.current = null }
    setAlertNote(null)
  }

  if (!alertNote) return null
  return (
    <div className="sheetback" onClick={dismiss}>
      <div className="sheet" style={{ maxWidth: 360, margin: 'auto', borderRadius: 16 }} onClick={e => e.stopPropagation()}>
        <div className="sheethead"><h3>⏰ {t('reminder', lang)}</h3></div>
        <p>{alertNote.text}</p>
        <button className="primary" onClick={dismiss}>{t('ok', lang)}</button>
      </div>
    </div>
  )
}
