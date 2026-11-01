import { jsPDF } from 'jspdf'
import { LOGO_DATA_URI } from './logo'

const money = (n) => 'Rs ' + Math.round(Number(n || 0)).toLocaleString('en-IN')
const ACCENT = [11, 110, 110], INK = [24, 31, 29], STEEL = [91, 102, 99], RULE = [203, 209, 201]
const LOGO_ASPECT = 223 / 892

function billNoStr(job) {
  return job.bill_no ? 'WOLT-' + String(job.bill_no).padStart(4, '0') : ''
}

export function generateBillPdf(job, customer, vehicle, totals) {
  const pdf = new jsPDF({ unit: 'pt', format: 'a5' })
  const pageW = pdf.internal.pageSize.getWidth()
  const pageH = pdf.internal.pageSize.getHeight()
  const margin = 30
  let y = margin

  function setColor(rgb) { pdf.setTextColor(rgb[0], rgb[1], rgb[2]) }

  const logoW = 100, logoH = logoW * LOGO_ASPECT
  const bandPad = 16
  const bandH = logoH + bandPad * 2
  pdf.setFillColor(0, 0, 0)
  pdf.rect(0, 0, pageW, bandH, 'F')
  const logoY = (bandH - logoH) / 2
  try { pdf.addImage(LOGO_DATA_URI, 'PNG', margin, logoY, logoW, logoH) } catch {}
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5); pdf.setTextColor(225, 228, 224)
  const infoX = pageW - margin
  const infoLineH = 11
  const infoY0 = (bandH - infoLineH * 3) / 2 + 7
  pdf.text('Bike & Scooter Repair/Spare parts shop', infoX, infoY0, { align: 'right' })
  pdf.text('Manikandeswaram, Vadakkekad, Thrissur, Keralam', infoX, infoY0 + infoLineH, { align: 'right' })
  pdf.text('Ph: 7034594064, 8921210656', infoX, infoY0 + infoLineH * 2, { align: 'right' })
  y = bandH + 18
  setColor(INK)
  pdf.setDrawColor(ACCENT[0], ACCENT[1], ACCENT[2]); pdf.setLineWidth(1.5)
  pdf.line(margin, y, pageW - margin, y)
  y += 18

  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(11); setColor(INK)
  pdf.text((customer?.name || 'Customer') + '  —  ' + (vehicle?.reg_no || ''), margin, y)
  if (billNoStr(job)) { setColor(ACCENT); pdf.setFontSize(9.5); pdf.text(billNoStr(job), pageW - margin, y, { align: 'right' }); setColor(INK); pdf.setFontSize(11) }
  y += 14
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9); setColor(STEEL)
  pdf.text(new Date(job.created_at).toLocaleDateString('en-IN') + (customer?.phone ? '   Ph: ' + customer.phone : ''), margin, y)
  y += 16

  pdf.setDrawColor(RULE[0], RULE[1], RULE[2]); pdf.setLineWidth(0.75)
  pdf.line(margin, y, pageW - margin, y)
  y += 14

  if ((job.lines || []).length) {
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8); setColor(STEEL)
    pdf.text('DESCRIPTION', margin, y)
    pdf.text('QTY', pageW - margin - 70, y, { align: 'right' })
    pdf.text('AMOUNT', pageW - margin, y, { align: 'right' })
    y += 12
  }
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9.5); setColor(INK)
  ;(job.lines || []).forEach((l) => {
    pdf.text(l.desc, margin, y)
    pdf.text(l.partQty ? String(l.partQty) : '-', pageW - margin - 70, y, { align: 'right' })
    pdf.text(money(l.amount), pageW - margin, y, { align: 'right' })
    y += 15
  })

  y += 4
  pdf.setDrawColor(RULE[0], RULE[1], RULE[2])
  pdf.line(margin, y, pageW - margin, y)
  y += 14

  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9.5); setColor(INK)
  pdf.text('Subtotal', margin, y); pdf.text(money(totals.subtotal), pageW - margin, y, { align: 'right' }); y += 14
  if (totals.discount) { pdf.text('Discount', margin, y); pdf.text('-' + money(totals.discount), pageW - margin, y, { align: 'right' }); y += 14 }

  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(12); setColor(ACCENT)
  pdf.text('Total', margin, y); pdf.text(money(totals.grand), pageW - margin, y, { align: 'right' }); y += 18
  setColor(INK)

  const payments = job.payments || []
  if (payments.length) {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9)
    payments.forEach((p) => { pdf.text('Paid (' + p.method + ')', margin, y); pdf.text(money(p.amount), pageW - margin, y, { align: 'right' }); y += 13 })
  }
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10.5)
  pdf.text('Balance due', margin, y)
  setColor(totals.due > 0 ? [192, 57, 43] : INK)
  pdf.text(money(totals.due), pageW - margin, y, { align: 'right' })
  setColor(INK)
  y += 24

  pdf.setDrawColor(RULE[0], RULE[1], RULE[2])
  pdf.line(margin, pageH - 30, pageW - margin, pageH - 30)
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8); setColor(STEEL)
  pdf.text('Thank you for your business — WOLT 69', margin, pageH - 16)

  pdf.save((billNoStr(job) || 'Bill-' + (vehicle?.reg_no || job.id.slice(0, 6))) + '.pdf')
}

export function billWhatsappText(job, customer, vehicle, totals) {
  const lines = []
  lines.push('*WOLT 69*')
  lines.push('Bike & Scooter Repair/Spare parts shop')
  lines.push('Manikandeswaram, Vadakkekad, Thrissur')
  lines.push('Ph: 7034594064, 8921210656')
  lines.push('')
  lines.push((customer?.name || '') + (vehicle?.reg_no ? ' — ' + vehicle.reg_no : ''))
  if (billNoStr(job)) lines.push('Bill No: ' + billNoStr(job))
  lines.push(new Date(job.created_at).toLocaleDateString('en-IN'))
  lines.push('')
  ;(job.lines || []).forEach((l) => {
    const qtyStr = l.partQty ? ' (Qty: ' + l.partQty + ')' : ''
    lines.push('- ' + l.desc + qtyStr + ': ' + money(l.amount))
  })
  lines.push('')
  lines.push('Subtotal: ' + money(totals.subtotal))
  if (totals.discount) lines.push('Discount: -' + money(totals.discount))
  lines.push('*Total: ' + money(totals.grand) + '*')
  const payments = job.payments || []
  payments.forEach((p) => lines.push('Paid (' + p.method + '): ' + money(p.amount)))
  lines.push('Balance due: ' + money(totals.due))
  lines.push('')
  lines.push('Thank you for your business!')
  return lines.join('\n')
}
