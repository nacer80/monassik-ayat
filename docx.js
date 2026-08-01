/**
 * docx.js — قراءة ملفات Word (.docx) والنصوص (.txt)
 *
 * A .docx is a ZIP archive whose `word/document.xml` holds the text. Rather than
 * pull in a third-party library, this reads the archive directly using the
 * browser's native `DecompressionStream('deflate-raw')`, so the app stays
 * dependency-free and works offline.
 *
 * Page numbers: Word stores `<w:lastRenderedPageBreak/>` markers (written by the
 * layout engine on save) and explicit `<w:br w:type="page"/>` breaks. Both are
 * counted so each paragraph can report the page it sits on.
 */
(function (QF) {
    'use strict';

    const SIG_EOCD = 0x06054b50;
    const SIG_CEN  = 0x02014b50;
    const SIG_LOC  = 0x04034b50;

    QF.Docx = {
        /** True when this browser can inflate deflate-raw streams. */
        get supported() {
            return typeof DecompressionStream !== 'undefined';
        },

        /**
         * Read a .docx or .txt File into page-tagged paragraphs.
         * @param {File|Blob} file
         * @returns {Promise<{paragraphs:{page:number,index:number,text:string}[],pageCount:number,kind:'docx'|'txt'}>}
         */
        async read(file) {
            const name = (file && file.name) || '';
            if (/\.(txt|md|csv)$/i.test(name)) return this.readText(await this._text(file));
            if (!/\.docx$/i.test(name)) {
                // Sniff: a docx always starts with "PK".
                const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
                if (!(head[0] === 0x50 && head[1] === 0x4b)) {
                    return this.readText(await this._text(file));
                }
            }
            if (/\.docx?$/i.test(name) && !/\.docx$/i.test(name)) {
                throw new Error('صيغة .doc القديمة غير مدعومة — احفظ الملف بصيغة .docx');
            }
            return this.readDocx(await file.arrayBuffer());
        },

        _text(file) {
            if (file.text) return file.text();
            return new Promise((res, rej) => {
                const r = new FileReader();
                r.onload = () => res(r.result);
                r.onerror = () => rej(new Error('فشل قراءة الملف'));
                r.readAsText(file);
            });
        },

        /**
         * Split plain text into paragraphs. A form feed (\f) starts a new page;
         * otherwise pages are estimated at LINES_PER_PAGE non-empty lines.
         */
        readText(text, linesPerPage = 45) {
            const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
            const paragraphs = [];
            let page = 1, onPage = 0;

            for (const raw of lines) {
                if (raw.indexOf('\f') !== -1) {
                    page++; onPage = 0;
                    const after = raw.replace(/\f/g, '').trim();
                    if (after) { paragraphs.push({ page, index: paragraphs.length, text: after }); onPage++; }
                    continue;
                }
                const t = raw.trim();
                if (!t) continue;
                if (onPage >= linesPerPage) { page++; onPage = 0; }
                paragraphs.push({ page, index: paragraphs.length, text: t });
                onPage++;
            }
            return { paragraphs, pageCount: page, kind: 'txt' };
        },

        /**
         * @param {ArrayBuffer} buffer raw .docx bytes
         */
        async readDocx(buffer) {
            if (!this.supported) {
                throw new Error('متصفحك لا يدعم فك ضغط .docx — استخدم متصفحاً حديثاً أو ملف .txt');
            }
            const bytes = new Uint8Array(buffer);
            const entries = this._readZipIndex(bytes);
            const target = entries.find(e => e.name === 'word/document.xml');
            if (!target) throw new Error('الملف ليس مستند Word صالحاً (word/document.xml غير موجود)');

            const xmlBytes = await this._extract(bytes, target);
            const xml = new TextDecoder('utf-8').decode(xmlBytes);
            const parsed = this._parseDocumentXml(xml);
            // Keep the original archive so edits can be written back into it,
            // preserving styles, headers, images and every other part.
            parsed.source = { bytes, entries, xml };
            return parsed;
        },

        // ---------------- ZIP ----------------
        _readZipIndex(bytes) {
            const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            // Locate the End Of Central Directory record (scan back over the comment).
            let eocd = -1;
            const min = Math.max(0, bytes.length - 66000);
            for (let i = bytes.length - 22; i >= min; i--) {
                if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
            }
            if (eocd === -1) throw new Error('أرشيف غير صالح: تعذّر العثور على فهرس ZIP');

            const count = dv.getUint16(eocd + 10, true);
            let off = dv.getUint32(eocd + 16, true);

            const entries = [];
            for (let i = 0; i < count && off + 46 <= bytes.length; i++) {
                if (dv.getUint32(off, true) !== SIG_CEN) break;
                const method = dv.getUint16(off + 10, true);
                const compSize = dv.getUint32(off + 20, true);
                const nameLen = dv.getUint16(off + 28, true);
                const extraLen = dv.getUint16(off + 30, true);
                const cmtLen = dv.getUint16(off + 32, true);
                const local = dv.getUint32(off + 42, true);
                const name = new TextDecoder('utf-8')
                    .decode(bytes.subarray(off + 46, off + 46 + nameLen));
                entries.push({ name, method, compSize, local });
                off += 46 + nameLen + extraLen + cmtLen;
            }
            return entries;
        },

        async _extract(bytes, entry) {
            const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            let p = entry.local;
            if (dv.getUint32(p, true) !== SIG_LOC) throw new Error('أرشيف تالف');
            const nameLen = dv.getUint16(p + 26, true);
            const extraLen = dv.getUint16(p + 28, true);
            p += 30 + nameLen + extraLen;

            const data = bytes.subarray(p, p + entry.compSize);
            if (entry.method === 0) return data;            // stored
            if (entry.method !== 8) throw new Error('ضغط ZIP غير مدعوم');

            const stream = new Blob([data]).stream()
                .pipeThrough(new DecompressionStream('deflate-raw'));
            return new Uint8Array(await new Response(stream).arrayBuffer());
        },

        // ---------------- WordprocessingML ----------------
        _parseDocumentXml(xml) {
            const doc = new DOMParser().parseFromString(xml, 'application/xml');
            if (doc.querySelector('parsererror')) throw new Error('تعذّر تحليل محتوى المستند');

            const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
            const body = doc.getElementsByTagNameNS(W, 'body')[0] || doc.documentElement;
            const paras = body.getElementsByTagNameNS(W, 'p');

            const paragraphs = [];
            let page = 1;
            let sawRealBreak = false;

            for (let i = 0; i < paras.length; i++) {
                const p = paras[i];

                // Page breaks recorded before this paragraph's text.
                // `lastRenderedPageBreak` is written by Word's LAYOUT engine, so it
                // is absent from documents produced by other tools (and from many
                // real .docx files). Explicit <w:br w:type="page"/> is authored.
                const rendered = p.getElementsByTagNameNS(W, 'lastRenderedPageBreak').length;
                let explicit = 0;
                const brs = p.getElementsByTagNameNS(W, 'br');
                for (let b = 0; b < brs.length; b++) {
                    if (brs[b].getAttributeNS(W, 'type') === 'page') explicit++;
                }
                // A section break that starts a new page also advances the count.
                let sectionBreak = 0;
                const sects = p.getElementsByTagNameNS(W, 'sectPr');
                for (let sIdx = 0; sIdx < sects.length; sIdx++) {
                    const typeEl = sects[sIdx].getElementsByTagNameNS(W, 'type')[0];
                    const val = typeEl && typeEl.getAttributeNS(W, 'val');
                    if (!val || val === 'nextPage' || val === 'oddPage' || val === 'evenPage') {
                        sectionBreak++;
                    }
                }

                const advance = rendered + explicit + sectionBreak;
                if (advance) { page += advance; sawRealBreak = true; }

                // Text runs, honouring tabs and soft line breaks.
                let text = '';
                const kids = p.getElementsByTagNameNS(W, '*');
                for (let k = 0; k < kids.length; k++) {
                    const el = kids[k];
                    const ln = el.localName;
                    if (ln === 't') text += el.textContent;
                    else if (ln === 'tab') text += ' ';
                    else if (ln === 'br' && el.getAttributeNS(W, 'type') !== 'page') text += ' ';
                }

                text = text.replace(/\s+/g, ' ').trim();
                // `pIndex` maps back to <w:p> position so edits can be written
                // into the original document rather than a fresh one.
                if (text) paragraphs.push({ page, index: paragraphs.length, pIndex: i, text });
            }

            // No usable markers anywhere: Word never laid the file out (or it was
            // generated by another tool). Fall back to estimating pages from the
            // volume of text so the report's ص column is still meaningful.
            if (!sawRealBreak && paragraphs.length) {
                this._estimatePages(paragraphs);
            }

            const pageCount = paragraphs.length
                ? paragraphs[paragraphs.length - 1].page : page;
            return { paragraphs, pageCount, kind: 'docx', estimated: !sawRealBreak };
        },

        /** Characters of Arabic body text that typically fill one A4 page. */
        CHARS_PER_PAGE: 1800,

        /**
         * Assign page numbers by accumulated text volume.
         *
         * Used when a .docx carries no layout markers at all. It cannot match
         * Word's pagination exactly (that depends on fonts, margins and images),
         * but it keeps the ص column monotonic and roughly right instead of
         * reporting every paragraph as page 1.
         *
         * @param {{text:string,page:number}[]} paragraphs mutated in place
         */
        _estimatePages(paragraphs) {
            let page = 1;
            let used = 0;
            for (const p of paragraphs) {
                // +1 for the paragraph break itself.
                const cost = p.text.length + 1;
                if (used && used + cost > this.CHARS_PER_PAGE) { page++; used = 0; }
                p.page = page;
                used += cost;
            }
        },

        /**
         * Present the document as a table, so it flows through the same
         * load → process → review → save pipeline as SQLite and JSON.
         * @returns {object} a duck-typed database handle
         */
        toDataSource(parsed, tableName = 'Document') {
            const columns = [
                { name: 'ص', type: 'INTEGER' },
                { name: 'الفقرة', type: 'INTEGER' },
                { name: 'AyahText', type: 'TEXT' }
            ];
            const rows = parsed.paragraphs.map(p => [p.page, p.index + 1, p.text]);
            return {
                __isJson: true,
                __isDoc: true,
                __docKind: parsed.kind,
                __pageCount: parsed.pageCount,
                // Row index → <w:p> position, for writing edits back to the docx.
                __pIndex: parsed.paragraphs.map(p => (p.pIndex != null ? p.pIndex : -1)),
                __parsed: parsed,
                __table: tableName,
                __columns: columns,
                __rows: rows,
                __objectKeys: ['page', 'paragraph', 'text'],
                __wrapper: null,
                close() {}
            };
        },

        /** Rebuild plain text from (possibly edited) rows. */
        toPlainText(rows, textIdx = 2) {
            return rows.map(r => String(r[textIdx] ?? '')).join('\n\n');
        },

        // =================================================================
        //  Writing .docx back out
        // =================================================================
        /**
         * Rewrite the original .docx with updated paragraph text.
         *
         * Only `word/document.xml` is regenerated; every other part (styles,
         * fonts, headers, footers, images, numbering…) is copied through
         * byte-for-byte, so the saved file keeps the author's formatting.
         *
         * Within a changed paragraph the text is placed in its FIRST run and the
         * remaining runs are emptied — that preserves the paragraph's own styling
         * (font, size, direction) while replacing the wording.
         *
         * @param {object} parsed result of {@link read}, carrying `source`
         * @param {Map<number,string>} edits pIndex → new text
         * @returns {Promise<Blob>}
         */
        async writeDocx(parsed, edits) {
            if (!parsed || !parsed.source) {
                throw new Error('لا يمكن الحفظ بصيغة Word: المستند الأصلي غير متاح');
            }
            if (typeof CompressionStream === 'undefined') {
                throw new Error('متصفحك لا يدعم إنشاء ملفات .docx — احفظ كنص بدلاً من ذلك');
            }

            const { bytes, entries, xml } = parsed.source;
            const newXml = this._applyEdits(xml, edits);
            const encoder = new TextEncoder();
            const replacement = encoder.encode(newXml);

            // Re-pack: deflate the edited part, copy the rest verbatim.
            const files = [];
            for (const entry of entries) {
                if (entry.name === 'word/document.xml') {
                    files.push({ name: entry.name, data: replacement });
                } else {
                    files.push({ name: entry.name, data: await this._extract(bytes, entry) });
                }
            }
            return this._buildZip(files);
        },

        /**
         * Replace the text of selected paragraphs inside document.xml.
         * @param {string} xml
         * @param {Map<number,string>} edits
         * @returns {string}
         */
        _applyEdits(xml, edits) {
            const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
            const doc = new DOMParser().parseFromString(xml, 'application/xml');
            if (doc.querySelector('parsererror')) throw new Error('تعذّر تحليل المستند للحفظ');

            const body = doc.getElementsByTagNameNS(W, 'body')[0] || doc.documentElement;
            const paras = body.getElementsByTagNameNS(W, 'p');

            for (const [pIndex, text] of edits) {
                const p = paras[pIndex];
                if (!p) continue;

                const runs = p.getElementsByTagNameNS(W, 'r');
                let placed = false;

                for (let r = 0; r < runs.length; r++) {
                    const ts = runs[r].getElementsByTagNameNS(W, 't');
                    for (let t = 0; t < ts.length; t++) {
                        if (!placed) {
                            ts[t].textContent = text;
                            // Protect leading/trailing spaces from being collapsed.
                            ts[t].setAttribute('xml:space', 'preserve');
                            placed = true;
                        } else {
                            ts[t].textContent = '';
                        }
                    }
                }

                // Paragraph had no text run (rare): create one.
                if (!placed) {
                    const run = doc.createElementNS(W, 'w:r');
                    const t = doc.createElementNS(W, 'w:t');
                    t.setAttribute('xml:space', 'preserve');
                    t.textContent = text;
                    run.appendChild(t);
                    p.appendChild(run);
                }
            }

            return new XMLSerializer().serializeToString(doc);
        },

        /**
         * Build a ZIP archive (deflate) from in-memory files.
         * @param {{name:string,data:Uint8Array}[]} files
         * @returns {Promise<Blob>}
         */
        async _buildZip(files) {
            const enc = new TextEncoder();
            const chunks = [];
            const central = [];
            let offset = 0;

            for (const f of files) {
                const nameBytes = enc.encode(f.name);
                const crc = this._crc32(f.data);
                const raw = f.data.length;

                const deflated = new Uint8Array(await new Response(
                    new Blob([f.data]).stream()
                        .pipeThrough(new CompressionStream('deflate-raw'))
                ).arrayBuffer());

                // Fall back to STORED when compression does not help.
                const useDeflate = deflated.length < raw;
                const payload = useDeflate ? deflated : f.data;
                const method = useDeflate ? 8 : 0;

                const local = new Uint8Array(30 + nameBytes.length);
                const lv = new DataView(local.buffer);
                lv.setUint32(0, SIG_LOC, true);
                lv.setUint16(4, 20, true);      // version needed
                lv.setUint16(6, 0x0800, true);  // UTF-8 filenames
                lv.setUint16(8, method, true);
                lv.setUint16(10, 0, true);      // time
                lv.setUint16(12, 0, true);      // date
                lv.setUint32(14, crc, true);
                lv.setUint32(18, payload.length, true);
                lv.setUint32(22, raw, true);
                lv.setUint16(26, nameBytes.length, true);
                lv.setUint16(28, 0, true);
                local.set(nameBytes, 30);

                chunks.push(local, payload);

                const cen = new Uint8Array(46 + nameBytes.length);
                const cv = new DataView(cen.buffer);
                cv.setUint32(0, SIG_CEN, true);
                cv.setUint16(4, 20, true);
                cv.setUint16(6, 20, true);
                cv.setUint16(8, 0x0800, true);
                cv.setUint16(10, method, true);
                cv.setUint16(12, 0, true);
                cv.setUint16(14, 0, true);
                cv.setUint32(16, crc, true);
                cv.setUint32(20, payload.length, true);
                cv.setUint32(24, raw, true);
                cv.setUint16(28, nameBytes.length, true);
                cv.setUint16(42, offset, true);
                cen.set(nameBytes, 46);
                central.push(cen);

                offset += local.length + payload.length;
            }

            const centralSize = central.reduce((n, c) => n + c.length, 0);
            const end = new Uint8Array(22);
            const ev = new DataView(end.buffer);
            ev.setUint32(0, SIG_EOCD, true);
            ev.setUint16(8, files.length, true);
            ev.setUint16(10, files.length, true);
            ev.setUint32(12, centralSize, true);
            ev.setUint32(16, offset, true);

            return new Blob([...chunks, ...central, end], {
                type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            });
        },

        /** CRC-32 (ZIP variant), table built once on first use. */
        _crc32(buf) {
            let table = this._crcTable;
            if (!table) {
                table = this._crcTable = new Uint32Array(256);
                for (let i = 0; i < 256; i++) {
                    let c = i;
                    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                    table[i] = c >>> 0;
                }
            }
            let crc = 0xFFFFFFFF;
            for (let i = 0; i < buf.length; i++) {
                crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
            }
            return (crc ^ 0xFFFFFFFF) >>> 0;
        }
    };
})(QuranFormatter);
