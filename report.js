/**
 * report.js — تصدير التقارير
 * Enhanced: RFC-4180-safe CSV (formula-injection guarded), JSON + HTML export.
 */
(function (QF) {
    'use strict';

    const HEADERS = ['#', 'قبل', 'بعد', 'الثقة%', 'السورة', 'الآيات', 'العدد', 'متتالية', 'النوع'];

    /** Quote a CSV field and neutralise spreadsheet formula injection. */
    function csvCell(value) {
        let s = value == null ? '' : String(value);
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
        return '"' + s.replace(/"/g, '""') + '"';
    }

    QF.Report = {
        /**
         * @param {Array<object>} rows
         * @returns {string} UTF-8 BOM + CRLF CSV (opens correctly in Excel with Arabic)
         */
        exportCSV(rows) {
            const lines = [HEADERS.map(csvCell).join(',')];
            for (const r of rows) {
                lines.push([
                    r.id,
                    r.before,
                    r.after,
                    r.confidence,
                    r.surah,
                    r.ayahRange,
                    r.count,
                    r.isConsecutive ? 'نعم' : 'لا',
                    r.correctionType === 'correct' ? 'تصحيح' : 'تنسيق'
                ].map(csvCell).join(','));
            }
            return '\uFEFF' + lines.join('\r\n');
        },

        /** Pretty-printed JSON report with a small summary block. */
        exportJSON(rows, meta = {}) {
            const confidences = rows.map(r => Number(r.confidence) || 0);
            return JSON.stringify({
                generatedAt: new Date().toISOString(),
                summary: {
                    ...meta,
                    replacements: rows.length,
                    verses: rows.reduce((s, r) => s + (Number(r.count) || 0), 0),
                    averageConfidence: confidences.length
                        ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length)
                        : 0,
                    lowConfidence: rows.filter(r => Number(r.confidence) < 80).length
                },
                rows
            }, null, 2);
        },

        /** Standalone RTL HTML report for printing or sharing. */
        exportHTML(rows, meta = {}) {
            const esc = QF.Utils.escapeHTML;
            const body = rows.map(r => `<tr>
    <td>${esc(r.id)}</td>
    <td>${esc(r.before)}</td>
    <td>${esc(r.after)}</td>
    <td>${esc(r.confidence)}%</td>
    <td>${esc(r.surah)}</td>
    <td>${esc(r.ayahRange)}</td>
    <td>${esc(r.count)}</td>
  </tr>`).join('\n');

            return `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="UTF-8">
<title>تقرير المُنسِق</title>
<style>
 body{font-family:'Segoe UI',Tahoma,sans-serif;padding:24px;background:#fff;color:#212529}
 h1{color:#b8860b} table{width:100%;border-collapse:collapse;font-size:.9em;margin-top:16px}
 th,td{border:1px solid #dee2e6;padding:8px;text-align:right;vertical-align:top}
 th{background:#e9ecef} tr:nth-child(even){background:#f8f9fa}
 .meta{color:#495057;font-size:.9em}
</style></head><body>
<h1>تقرير تنسيق الآيات</h1>
<p class="meta">التاريخ: ${esc(new Date().toLocaleString('ar'))} — عدد التحويلات: ${rows.length}${
    meta.totalRows ? ` — إجمالي الصفوف: ${esc(meta.totalRows)}` : ''}</p>
<table><thead><tr>${HEADERS.slice(0, 7).map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
<tbody>
${body}
</tbody></table></body></html>`;
        },

        /** Convenience: build a blob and hand it to Database.downloadBlob. */
        download(content, filename, mime) {
            const blob = new Blob([content], { type: mime + ';charset=utf-8' });
            QF.Database.downloadBlob(blob, filename);
        }
    };
})(QuranFormatter);
