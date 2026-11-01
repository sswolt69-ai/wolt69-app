import { jsPDF } from 'jspdf'
import { LOGO_DATA_URI } from './logo'

const money = (n) => 'Rs ' + Math.round(Number(n || 0)).toLocaleString('en-IN')
const ACCENT = [11, 110, 110], INK = [24, 31, 29], STEEL = [91, 102, 99], RULE = [203, 209, 201]
const LOGO_ASPECT = 223 / 892

function monthKey(ts) {
  const d = new Date(ts)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
}

export function generateReportPdf(mode, data, opts = {}) {
  const mk = mode === 'month' ? data.monthKey : null
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' })
  const pageW = pdf.internal.pageSize.getWidth()
  const pageH = pdf.internal.pageSize.getHeight()
  const margin = 40
  let y = margin

  function ensureSpace(h) { if (y + h > pageH - margin) { pdf.addPage(); y = margin } }
  function setColor(rgb) { pdf.setTextColor(rgb[0], rgb[1], rgb[2]) }
  function addText(text, bold, size, color) {
    pdf.setFont('helvetica', bold ? 'bold' : 'normal')
    pdf.setFontSize(size || 10)
    setColor(color || INK)
    const wrapped = pdf.splitTextToSize(String(text), pageW - margin * 2)
    wrapped.forEach((line) => { ensureSpace(14); pdf.text(line, margin, y); y += 14 })
    setColor(INK)
  }
  function heading(text) {
    y += 10; ensureSpace(22)
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(12.5); setColor(ACCENT)
    pdf.text(String(text), margin, y)
    y += 4
    pdf.setDrawColor(ACCENT[0], ACCENT[1], ACCENT[2]); pdf.setLineWidth(1.2)
    pdf.line(margin, y, pageW - margin, y)
    y += 14
    setColor(INK)
  }
  function inPeriod(ts) { return !mk || monthKey(ts) === mk }

  const periodLabel = mk ? new Date(mk + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) : 'All data'

  const logoW = 140, logoH = logoW * LOGO_ASPECT
  try { pdf.addImage(LOGO_DATA_URI, 'PNG', margin, y, logoW, logoH) } catch {}
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9.5); setColor(STEEL)
  pdf.text('Manikandeswaram, Vadakkekad, Thrissur, Keralam', margin, y + logoH + 13)
  pdf.text('Ph: 7034594064, 8921210656', margin, y + logoH + 25)
  y += logoH + 32
  setColor(INK)
  pdf.setDrawColor(ACCENT[0], ACCENT[1], ACCENT[2]); pdf.setLineWidth(2)
  pdf.line(margin, y, pageW - margin, y)
  y += 18
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(14); setColor(INK)
  pdf.text('Report: ' + periodLabel, margin, y)
  y += 16
  addText('Generated ' + new Date().toLocaleString('en-IN'), false, 9, STEEL)
  y += 4

  // Jobs / bills
  const jobsInPeriod = data.jobs.filter((j) => inPeriod(j.created_at))
  heading('Job Cards / Bills (' + jobsInPeriod.length + ')')
  let jobsTotal = 0, jobsDue = 0
  jobsInPeriod.forEach((j) => {
    const c = data.customers.find((x) => x.id === j.customer_id)
    const v = data.vehicles.find((x) => x.id === j.vehicle_id)
    const lines = j.lines || []
    const subtotal = lines.reduce((s, l) => s + Number(l.amount || 0), 0)
    const grand = Math.max(0, subtotal - Number(j.discount || 0))
    const due = Math.max(0, grand - Number(j.advance || 0))
    jobsTotal += grand; jobsDue += due
    const billNoStr = j.bill_no ? 'WOLT-' + String(j.bill_no).padStart(4, '0') + '  ' : ''
    addText(billNoStr + new Date(j.created_at).toLocaleDateString('en-IN') + '  ' + (v?.reg_no || '-') + '  ' + (c?.name || 'Unknown') + '  Total ' + money(grand) + '  Due ' + money(due), false, 9.5)
  })
  addText('Total billed: ' + money(jobsTotal) + '   Total due: ' + money(jobsDue), true, 10.5)

  // Expenses
  const expensesInPeriod = data.expenses.filter((e) => inPeriod(e.at))
  heading('Expenses (' + expensesInPeriod.length + ')')
  let expTotal = 0
  expensesInPeriod.forEach((e) => { expTotal += Number(e.amount); addText(new Date(e.at).toLocaleDateString('en-IN') + '  ' + (e.description || '-') + '  ' + money(e.amount), false, 9.5) })
  addText('Total expenses: ' + money(expTotal), true, 10.5)

  // Vendor entries
  const vendorEntriesInPeriod = data.vendorentries.filter((v) => inPeriod(v.at))
  heading('Vendor Purchases / Payments (' + vendorEntriesInPeriod.length + ')')
  vendorEntriesInPeriod.forEach((v) => {
    const vend = data.vendors.find((x) => x.id === v.vendor_id)
    addText(new Date(v.at).toLocaleDateString('en-IN') + '  ' + (vend?.name || '-') + '  ' + v.type + '  ' + money(v.amount), false, 9.5)
  })

  // Advances
  const advancesInPeriod = data.advances.filter((a) => inPeriod(a.at))
  heading('Worker Advances (' + advancesInPeriod.length + ')')
  let advTotal = 0
  advancesInPeriod.forEach((a) => {
    const w = data.workers.find((x) => x.id === a.worker_id)
    advTotal += Number(a.amount)
    addText(new Date(a.at).toLocaleDateString('en-IN') + '  ' + (w?.name || '-') + '  ' + money(a.amount), false, 9.5)
  })
  addText('Total advances: ' + money(advTotal), true, 10.5)

  // Attendance
  const attendanceInPeriod = data.attendance.filter((a) => inPeriod(a.at))
  if (attendanceInPeriod.length) {
    heading('Attendance (' + attendanceInPeriod.length + ' entries)')
    data.workers.filter((w) => w.pay_type === 'daily').forEach((w) => {
      const days = attendanceInPeriod.filter((a) => a.worker_id === w.id).length
      if (days) addText(w.name + ': ' + days + ' days x ' + money(w.wage_day) + ' = ' + money(days * w.wage_day), false, 9.5)
    })
  }

  // Stock snapshot
  heading('Current Stock Snapshot')
  let stockValue = 0
  data.parts.forEach((p) => {
    const q = data.stockmoves.filter((m) => m.part_id === p.id).reduce((s, m) => s + Number(m.qty || 0), 0)
    stockValue += q * Number(p.cost || 0)
    addText(p.name + '  qty ' + q + '  value ' + money(q * Number(p.cost || 0)), false, 9.5)
  })
  addText('Total stock value: ' + money(stockValue), true, 10.5)

  // Summary
  heading('Summary')
  addText('Customers: ' + data.customers.length + '   Vehicles: ' + data.vehicles.length, false, 10)

  const pageCount = pdf.internal.getNumberOfPages()
  for (let pi = 1; pi <= pageCount; pi++) {
    pdf.setPage(pi)
    pdf.setDrawColor(RULE[0], RULE[1], RULE[2]); pdf.setLineWidth(0.75)
    pdf.line(margin, pageH - 30, pageW - margin, pageH - 30)
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5); setColor(STEEL)
    pdf.text('WOLT 69 - internal report', margin, pageH - 18)
    pdf.text('Page ' + pi + ' of ' + pageCount, pageW - margin, pageH - 18, { align: 'right' })
  }

  const filename = 'Wolt69-Report-' + (mk || 'all-data') + '.pdf'
  if (opts.returnBlob) return { blob: pdf.output('blob'), filename }
  pdf.save(filename)
}
