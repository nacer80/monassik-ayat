/**
 * app.js — منطق واجهة تطبيق المُنسِق
 *
 * Enhanced over the original:
 *  • No inline onclick handlers (CSP-safe) — everything is event-delegated.
 *  • Test-panel results are kept separate from database results, so trying the
 *    sandbox no longer corrupts the rows written back to SQLite.
 *  • Settings (theme, output type, correction, column mapping) persist.
 *  • Sortable report table, "select all / none", live filtering, virtual cap.
 *  • Cancel/pause are race-free; progress updates are throttled.
 *  • Save-to-DB preserves the original schema and only rewrites approved spans.
 */
(function () {
    'use strict';

    const QF = window.QuranFormatter;
    const U = QF.Utils;
    const $ = id => document.getElementById(id);
    const STORAGE_KEY = 'quranFormatter.settings.v2';
    const PAGE_SIZE = 200; // rows rendered per page (all rows remain reachable)

    // ===================================================================
    //  State
    // ===================================================================
    const state = {
        quranLoaded: false,
        dbLoaded: false,
        db: null,
        tableNames: [],
        table: '',
        columns: [],
        idCol: 'ID',
        surahCol: 'SuraID',
        ayahIdCol: 'AyahID',
        ayahTextCol: 'AyahText',
        ayahTextColIdx: -1,
        surahIdx: -1,
        totalRows: 0,
        processed: 0,
        results: [],        // database results only
        testResults: [],    // sandbox results only
        isProcessing: false,
        cancelled: false,
        paused: false,
        pauseResolve: null,
        outputType: 'imlai',
        correctionEnabled: false,
        nextReplacementId: 1,
        uncheckedIds: new Set(),
        replacementMap: new Map(),
        sort: { key: null, dir: 1 },
        visibleRows: [],
        page: 0,
        skipIdentical: true
    };

    // ===================================================================
    //  Persistence
    // ===================================================================
    function saveSettingsToStorage() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                theme: document.body.dataset.theme,
                outputType: state.outputType,
                correctionEnabled: state.correctionEnabled,
                columns: {
                    idCol: state.idCol, surahCol: state.surahCol,
                    ayahIdCol: state.ayahIdCol, ayahTextCol: state.ayahTextCol
                }
            }));
        } catch (_) { /* private mode */ }
    }

    function loadSettingsFromStorage() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const s = JSON.parse(raw);
            if (s.theme) document.body.dataset.theme = s.theme;
            if (s.outputType) state.outputType = s.outputType;
            if (typeof s.correctionEnabled === 'boolean') state.correctionEnabled = s.correctionEnabled;
            if (s.columns) Object.assign(state, s.columns);
        } catch (_) { /* ignore */ }
    }

    // ===================================================================
    //  UI helpers
    // ===================================================================
    let toastTimer = new WeakMap();
    function showToast(msg, type = 'info') {
        const container = $('toastContainer');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = 'toast toast-' + type;
        toast.setAttribute('role', 'status');
        toast.textContent = msg;
        container.appendChild(toast);
        const t = setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 250);
        }, 4000);
        toastTimer.set(toast, t);
        toast.addEventListener('click', () => { clearTimeout(t); toast.remove(); });
    }

    function setBusy(el, busy) {
        if (el) el.disabled = !!busy;
    }

    function updateButtons() {
        const hasResults = state.results.length > 0 || state.testResults.length > 0;
        setBusy($('btnStart'), !(state.quranLoaded && state.dbLoaded) || state.isProcessing);
        setBusy($('btnPause'), !state.isProcessing);
        setBusy($('btnCancel'), !state.isProcessing);
        setBusy($('btnSaveDB'), state.results.length === 0 || state.isProcessing);
        setBusy($('btnSaveJSON'), state.results.length === 0 || state.isProcessing);
        const docBtn = $('btnSaveText');
        if (docBtn) {
            const isDoc = !!(state.db && state.db.__isDoc);
            docBtn.style.display = isDoc ? 'inline-flex' : 'none';
            docBtn.disabled = state.results.length === 0 || state.isProcessing;
            if (isDoc) {
                const asDocx = state.db.__docKind === 'docx';
                docBtn.textContent = asDocx ? '💾 حفظ Word' : '💾 حفظ نص';
                docBtn.title = asDocx
                    ? 'حفظ المستند بصيغة Word مع الحفاظ على التنسيق الأصلي'
                    : 'حفظ المستند كملف نصي';
            }
        }
        setBusy($('btnExportCSV'), !hasResults);
        setBusy($('btnExportJSON'), !hasResults);
        setBusy($('btnExportHTML'), !hasResults);
        setBusy($('btnClearResults'), !hasResults || state.isProcessing);
        setBusy($('btnTestFormat'), !state.quranLoaded);
    }

    function updateQuranStatus() {
        const el = $('quranStatus');
        if (!el) return;
        if (state.quranLoaded) {
            const s = QF.Quran.stats();
            el.textContent = `✅ القرآن محمل (${s.verses} آية)`;
            el.style.background = 'var(--success)';
        } else {
            el.textContent = '⚠️ لم يتم تحميل القرآن';
            el.style.background = 'var(--danger)';
        }
    }

    function markLoaded(btnId, label) {
        const btn = $(btnId);
        if (!btn) return;
        btn.textContent = label;
        btn.classList.add('is-loaded');
    }

    // ===================================================================
    //  Approval toggles
    // ===================================================================
    /**
     * Stable identity for a replacement.
     *
     * `replacementId` is a per-session counter, so re-processing the table mints
     * brand-new ids and any "unchecked" decision silently stops matching — the
     * row then gets converted on save even though the box looked unchecked.
     * Keying on source + row + offset + original text survives re-runs.
     *
     * @param {object} rep
     * @param {object} [res] owning result (for rowIndex/source)
     * @returns {string}
     */
    function repKey(rep, res) {
        const source = (res && res.source) || rep.__source || 'db';
        const row = (res ? res.rowIndex : rep.__rowIndex);
        return `${source}|${row}|${rep.start}|${rep.end}|${rep.original || ''}`;
    }

    /**
     * Identity of the *conversion itself*, independent of which row it occurs in.
     *
     * Unticking تحويل means "never format this ayah". A tafsir database repeats the
     * same quotation in hundreds of rows, so honouring the decision only for the
     * single clicked row makes the ayah look converted everywhere else — which is
     * exactly the reported problem.
     *
     * @param {object} rep
     * @returns {string}
     */
    function repTextKey(rep) {
        return 'text|' + U.normalizeArabic(rep.original || '');
    }

    function isApproved(rep, res) {
        if (state.uncheckedIds.has(repKey(rep, res))) return false;
        if (state.skipIdentical && state.uncheckedIds.has(repTextKey(rep))) return false;
        return true;
    }

    function toggleConversion(key, checked) {
        if (checked) {
            state.uncheckedIds.delete(key);
            const rep = state.replacementMap.get(key);
            if (rep) state.uncheckedIds.delete(repTextKey(rep));
        } else {
            state.uncheckedIds.add(key);
            // Also suppress every identical quotation elsewhere in the table.
            if (state.skipIdentical) {
                const rep = state.replacementMap.get(key);
                if (rep) state.uncheckedIds.add(repTextKey(rep));
            }
        }
        renderReport();
    }

    function setAllApprovals(approved) {
        if (approved) {
            state.uncheckedIds.clear();
        } else {
            for (const row of state.visibleRows) {
                state.uncheckedIds.add(row.key);
                if (state.skipIdentical && row.textKey) state.uncheckedIds.add(row.textKey);
            }
        }
        renderReport();
    }

    function updateApprovalCount() {
        const el = $('lblApproved');
        if (!el) return;
        const total = allReplacements().length;
        const reps = allReplacements();
        let approved = 0;
        for (const rep of reps) if (isApproved(rep, { source: rep.__source, rowIndex: rep.__rowIndex })) approved++;
        el.textContent = `المعتمدة: ${approved} / ${total}`;
    }

    function allReplacements() {
        const out = [];
        for (const res of state.results) out.push(...res.replacements);
        for (const res of state.testResults) out.push(...res.replacements);
        return out;
    }

    // ===================================================================
    //  Test panel
    // ===================================================================
    function testFormat() {
        if (!state.quranLoaded) { showToast('⚠️ يجب تحميل quran.json أولاً', 'warning'); return; }
        const input = $('testInput').value.trim();
        if (!input) { showToast('⚠️ الرجاء إدخال نص للتجربة', 'warning'); return; }

        const t0 = performance.now();
        try {
            const result = QF.Formatter.processText(
                input, state.outputType, null, $('chkCorrection').checked);

            for (const rep of result.replacements) {
                rep.replacementId = state.nextReplacementId++;
                rep.__source = 'test';
                rep.__rowIndex = -1;
                rep.key = repKey(rep);
                state.replacementMap.set(rep.key, rep);
            }

            const elapsed = Math.round(performance.now() - t0);
            const out = $('testOutput');
            out.style.display = 'block';
            out.textContent = result.modifiedText;   // textContent = XSS-safe

            $('testStats').style.display = 'flex';
            $('testVerseCount').textContent = result.totalVerses;
            $('testAvgConf').textContent = result.averageConfidence + '%';
            $('testTime').textContent = elapsed + 'ms';

            if (result.replacements.length === 0) {
                showToast('ℹ️ لم يتم اكتشاف آيات قرآنية في النص', 'info');
            } else {
                result.rowIndex = -1;
                result.source = 'test';
                state.testResults.push(result);
                showToast(`✅ تم اكتشاف ${result.totalVerses} آية في ${elapsed}ms`, 'success');
            }
            renderReport();
            updateStats();
            updateButtons();
        } catch (err) {
            showToast('❌ خطأ في المعالجة: ' + err.message, 'error');
            console.error(err);
        }
    }

    function clearTest() {
        $('testInput').value = '';
        $('testOutput').style.display = 'none';
        $('testOutput').textContent = '';
        $('testStats').style.display = 'none';
    }

    function copyTestOutput() {
        const text = $('testOutput').textContent;
        if (!text) { showToast('⚠️ لا يوجد ناتج للنسخ', 'warning'); return; }
        navigator.clipboard.writeText(text)
            .then(() => showToast('📋 تم نسخ الناتج', 'success'))
            .catch(() => showToast('❌ تعذر النسخ', 'error'));
    }

    function loadSample() {
        $('testInput').value = [
            '* فَصْلٌ في ﴿بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ﴾',
            'قالَ ابْنُ عُمَرَ: نَزَلَتْ في كُلِّ سُورَةٍ.',
            'كَقَوْلِهِ تَعالى: ﴿ثُمَّ إِذَا مَسَّكُمُ الضُّرُّ فَإِلَيْهِ تَجْأَرُونَ﴾ [النحل: ٥٣].',
            '(مالك يوم الدين  اياك نعبد واياك  نستعين)',
            '(الحمد لله رب العالمين (1) الرحمن الرحيم)'
        ].join('\n');
        showToast('📋 تم تحميل النص التجريبي', 'info');
    }

    // ===================================================================
    //  Settings modal
    // ===================================================================
    function guessColumn(colNames, ...patterns) {
        for (const p of patterns) {
            const m = colNames.find(c => c.toLowerCase() === p.toLowerCase());
            if (m) return m;
        }
        for (const p of patterns) {
            const m = colNames.find(c => c.toLowerCase().includes(p.toLowerCase()));
            if (m) return m;
        }
        return colNames[0];
    }

    function fillSelect(sel, names, selected) {
        if (!sel) return;
        sel.innerHTML = '';
        for (const n of names) {
            const opt = document.createElement('option');
            opt.value = n;
            opt.textContent = n;
            sel.appendChild(opt);
        }
        if (selected && names.includes(selected)) sel.value = selected;
    }

    function showSettingsModal() {
        const tableSelect = $('selTable');
        if (!tableSelect) return;
        fillSelect(tableSelect, state.tableNames, state.table);

        const populate = colNames => {
            fillSelect($('colID'), colNames,
                colNames.includes(state.idCol) ? state.idCol : guessColumn(colNames, 'ID', 'id'));
            fillSelect($('colSuraID'), colNames,
                colNames.includes(state.surahCol) ? state.surahCol : guessColumn(colNames, 'SuraID', 'suraid', 'sura_id'));
            fillSelect($('colAyahID'), colNames,
                colNames.includes(state.ayahIdCol) ? state.ayahIdCol : guessColumn(colNames, 'AyahID', 'ayahid', 'ayah_id'));
            fillSelect($('colAyahText'), colNames,
                colNames.includes(state.ayahTextCol) ? state.ayahTextCol : guessColumn(colNames, 'AyahText', 'ayahtext', 'text', 'tafsir'));
        };

        populate(state.columns.map(c => c.name));

        tableSelect.onchange = function () {
            const cols = QF.Database.getColumns(state.db, this.value);
            if (cols.length) populate(cols.map(c => c.name));
        };

        $('settingsModal').style.display = 'flex';
    }

    function hideSettingsModal() {
        $('settingsModal').style.display = 'none';
    }

    function saveSettings() {
        const newTable = $('selTable').value;
        if (newTable !== state.table) {
            state.table = newTable;
            state.columns = QF.Database.getColumns(state.db, newTable);
            state.totalRows = QF.Database.countRows(state.db, newTable);
        }
        state.idCol = $('colID').value;
        state.surahCol = $('colSuraID').value;
        state.ayahIdCol = $('colAyahID').value;
        state.ayahTextCol = $('colAyahText').value;
        state.ayahTextColIdx = state.columns.findIndex(c => c.name === state.ayahTextCol);
        state.surahIdx = state.columns.findIndex(c => c.name === state.surahCol);

        hideSettingsModal();
        saveSettingsToStorage();
        showToast('✅ تم حفظ إعدادات الأعمدة', 'success');
        updateButtons();
    }

    // ===================================================================
    //  Loading the Quran
    // ===================================================================
    /**
     * Read the bundled mushaf, if quran-data.js was included.
     *
     * quran-data.js declares `const QURAN_DATA = […]`, and a top-level `const`
     * does NOT become a property of `window`. Checking `window.QURAN_DATA`
     * therefore always failed, which is why auto-load never worked from
     * file:// (where fetch() is blocked too) and the file had to be picked by
     * hand every time. A bare identifier lookup sees the lexical binding.
     * @returns {any|null}
     */
    function bundledQuran() {
        try {
            // eslint-disable-next-line no-undef
            if (typeof QURAN_DATA !== 'undefined' && QURAN_DATA) return QURAN_DATA;
        } catch (_) { /* not declared */ }
        for (const name of ['QURAN_DATA', 'quranData', 'QURAN', 'quran']) {
            const v = window[name];
            if (v && (Array.isArray(v) || typeof v === 'object')) return v;
        }
        return null;
    }

    /**
     * Load the mushaf without any user action.
     * Tries the bundled QURAN_DATA global first (works from file://), then
     * quran.json next to the page, then a few common sub-folders.
     */
    async function autoLoadQuran() {
        const bundled = bundledQuran();
        if (bundled) {
            try {
                await ingestQuran(bundled, 'تلقائياً');
                return;
            } catch (err) {
                console.warn('QURAN_DATA invalid:', err.message);
            }
        }

        const candidates = [
            'quran.json', './quran.json',
            'data/quran.json', 'json/quran.json', 'assets/quran.json', '../quran.json'
        ];

        for (const url of candidates) {
            try {
                const resp = await fetch(url);
                if (!resp.ok) continue;
                const json = await resp.json();
                await ingestQuran(json, 'تلقائياً');
                return;
            } catch (_) { /* try the next location */ }
        }

        console.warn('Auto-load quran.json failed (tried: ' + candidates.join(', ') + ')');
        if (location.protocol === 'file:') {
            // fetch() is blocked on file://, so the bundled script is the only route.
            showToast('⚠️ تعذر التحميل التلقائي من file:// — أضف quran-data.js أو شغّل خادماً محلياً.', 'warning');
        } else {
            showToast('⚠️ لم يتم العثور على quran.json بجوار الصفحة. يمكنك تحميله يدوياً.', 'warning');
        }
    }

    async function ingestQuran(jsonData, suffix = '') {
        const count = await QF.Quran.loadFromJSON(jsonData);
        state.quranLoaded = true;
        showToast(`✅ تم تحميل ${count} آية ${suffix}`.trim(), 'success');
        markLoaded('btnLoadQuran', '📖 quran.json ✓');
        updateButtons();
        updateQuranStatus();
        return count;
    }

    // ===================================================================
    //  Batch processing
    // ===================================================================
    async function startProcessing() {
        if (!state.quranLoaded || !state.dbLoaded || state.isProcessing) return;

        state.isProcessing = true;
        state.cancelled = false;
        state.paused = false;
        state.processed = 0;
        state.results = [];
        updateButtons();
        $('lblStatus').textContent = '⚙️ جارٍ المعالجة...';
        $('btnPause').textContent = '⏸️ إيقاف مؤقت';

        const rows = QF.Database.getRows(state.db, state.table);
        state.totalRows = rows.length;

        const ayahIdx = state.ayahTextColIdx >= 0
            ? state.ayahTextColIdx
            : state.columns.findIndex(c => c.name === state.ayahTextCol);
        if (ayahIdx < 0) {
            showToast('❌ لم يتم تحديد عمود النص. افتح الإعدادات.', 'error');
            state.isProcessing = false;
            updateButtons();
            return;
        }

        const surahIdx = state.surahIdx;
        const ayahIdIdx = state.columns.findIndex(c => c.name === state.ayahIdCol);
        const docPageIdx = state.db && state.db.__isDoc
            ? state.columns.findIndex(c => c.name === 'ص') : -1;
        const correctionEnabled = $('chkCorrection').checked;
        const startTime = Date.now();
        let lastPaint = 0;

        for (let i = 0; i < rows.length; i++) {
            if (state.cancelled) break;
            if (state.paused) await new Promise(r => (state.pauseResolve = r));

            const raw = rows[i][ayahIdx];
            const text = raw == null ? '' : String(raw);

            if (text.trim()) {
                try {
                    const prefSurah = surahIdx >= 0 ? (Number(rows[i][surahIdx]) || null) : null;
                    // Pass the row's own ayah number too: it disambiguates the 280
                    // verses whose text repeats verbatim elsewhere in the mushaf.
                    const ctxAyah = ayahIdIdx >= 0 ? (Number(rows[i][ayahIdIdx]) || null) : null;
                    const ctx = prefSurah && ctxAyah ? { surah: prefSurah, ayah: ctxAyah } : prefSurah;
                    const result = QF.Formatter.processText(text, state.outputType, ctx, correctionEnabled);
                    if (result.replacements.length) {
                        for (const rep of result.replacements) {
                            rep.replacementId = state.nextReplacementId++;
                            rep.__source = 'db';
                            rep.__rowIndex = i;
                            rep.key = repKey(rep);
                            state.replacementMap.set(rep.key, rep);
                        }
                        result.rowIndex = i;
                        result.source = 'db';
                        result.originalText = text;
                        // For Word/text sources the report's ص column shows the
                        // page of the *document* the quote was found on, so the
                        // user can go back to it. (rep.page holds the mushaf page.)
                        result.docPage = docPageIdx >= 0
                            ? (Number(rows[i][docPageIdx]) || null) : null;
                        state.results.push(result);
                    }
                } catch (err) {
                    console.warn(`خطأ في الصف ${i}:`, err);
                }
            }
            state.processed = i + 1;

            // Repaint at most ~20×/second instead of every chunk.
            const now = Date.now();
            if (now - lastPaint > 50 || i === rows.length - 1) {
                lastPaint = now;
                paintProgress(startTime);
                await new Promise(r => setTimeout(r, 0));
            }
        }

        paintProgress(startTime);
        state.isProcessing = false;

        if (state.cancelled) {
            $('lblStatus').textContent = '⏹️ تم الإلغاء';
            showToast('⏹️ تم إلغاء المعالجة', 'warning');
        } else {
            $('lblStatus').textContent = '✅ اكتملت المعالجة';
            const totalVerses = state.results.reduce((s, r) => s + r.totalVerses, 0);
            showToast(`✅ اكتملت المعالجة: ${state.results.length} صف معدل، ${totalVerses} آية`, 'success');
        }
        updateButtons();
        renderReport();
        updateStats();
    }

    function paintProgress(startTime) {
        const pct = state.totalRows ? Math.round(state.processed / state.totalRows * 100) : 0;
        $('progressBar').style.width = pct + '%';
        $('progressText').textContent = pct + '%';
        $('lblRowInfo').textContent = `الصف: ${state.processed} / ${state.totalRows}`;
        const elapsed = (Date.now() - startTime) / 1000;
        $('lblTime').textContent = `الوقت: ${U.formatTime(elapsed)}`;
        const eta = state.processed > 0
            ? (elapsed / state.processed) * (state.totalRows - state.processed) : 0;
        $('lblETA').textContent = `المتبقي: ${U.formatTime(eta)}`;
    }

    function togglePause() {
        if (!state.isProcessing) return;
        state.paused = !state.paused;
        if (state.paused) {
            $('lblStatus').textContent = '⏸️ متوقف مؤقتاً';
            $('btnPause').textContent = '▶️ استئناف';
        } else {
            $('lblStatus').textContent = '⚙️ جارٍ المعالجة...';
            $('btnPause').textContent = '⏸️ إيقاف مؤقت';
            if (state.pauseResolve) { state.pauseResolve(); state.pauseResolve = null; }
        }
    }

    function cancelProcessing() {
        if (!state.isProcessing) return;
        state.cancelled = true;
        if (state.paused && state.pauseResolve) {
            state.paused = false;
            state.pauseResolve();
            state.pauseResolve = null;
        }
    }

    function clearResults() {
        if (state.isProcessing) return;
        state.results = [];
        state.testResults = [];
        state.uncheckedIds.clear();
        state.replacementMap.clear();
        state.nextReplacementId = 1;
        state.processed = 0;
        renderReport();
        updateStats();
        updateButtons();
        showToast('🗑️ تم مسح النتائج', 'info');
    }

    // ===================================================================
    //  Report table
    // ===================================================================
    function buildRows() {
        const rows = [];
        const push = (res, rep) => {
            rows.push({
                id: rows.length + 1,
                replacementId: rep.replacementId,
                key: rep.key || repKey(rep, res),
                textKey: repTextKey(rep),
                approved: isApproved(rep, res),
                rowIndex: res.rowIndex,
                source: res.source || 'db',
                before: rep.original || '',
                after: rep.formatted || '',
                confidence: rep.confidence,
                surah: rep.surahName || '',
                page: res.docPage ?? null,          // ص = document page
                mushafPage: rep.page || null,       // ص المصحف
                ayahRange: rep.verseCount > 1 ? `${rep.ayahNum}-${rep.endAyahNum}` : String(rep.ayahNum),
                count: rep.verseCount,
                changed: rep.original !== rep.formatted,
                needsReview: rep.confidence < 80,
                correctionType: rep.correctionType || 'format',
                isConsecutive: rep.isConsecutive,
                ambiguous: !!rep.ambiguous,
                occurrences: rep.occurrences || 1,
                alternatives: rep.alternatives || null
            });
        };
        for (const res of state.results) for (const rep of res.replacements) push(res, rep);
        for (const res of state.testResults) for (const rep of res.replacements) push(res, rep);
        return rows;
    }

    function renderReport() {
        const filter = $('selFilter').value;
        const search = $('txtSearch').value.trim().toLowerCase();
        let rows = buildRows();

        if (filter === 'changed') rows = rows.filter(r => r.changed);
        else if (filter === 'lowConf') rows = rows.filter(r => r.needsReview);
        else if (filter === 'corrected') rows = rows.filter(r => r.correctionType === 'correct');
        else if (filter === 'multi') rows = rows.filter(r => r.count > 1);
        else if (filter === 'ambiguous') rows = rows.filter(r => r.ambiguous);

        if (search) {
            const norm = U.normalizeArabic(search);
            rows = rows.filter(r =>
                r.before.toLowerCase().includes(search) ||
                r.after.toLowerCase().includes(search) ||
                r.surah.includes(search) ||
                (norm && (U.normalizeArabic(r.before).includes(norm) ||
                          U.normalizeArabic(r.after).includes(norm))));
        }

        if (state.sort.key) {
            const k = state.sort.key, dir = state.sort.dir;
            rows.sort((a, b) => {
                const va = a[k], vb = b[k];
                if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
                return String(va).localeCompare(String(vb), 'ar') * dir;
            });
        }

        state.visibleRows = rows;
        const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
        if (state.page >= pageCount) state.page = pageCount - 1;
        if (state.page < 0) state.page = 0;
        const from = state.page * PAGE_SIZE;
        const shown = rows.slice(from, from + PAGE_SIZE);

        const tbody = $('reportTbody');
        tbody.innerHTML = shown.map(r => {
            const checked = r.approved ? 'checked' : '';
            const confClass = r.confidence >= 95 ? 'confidence-high'
                : r.confidence >= 80 ? 'confidence-low' : 'confidence-very-low';
            return `<tr data-rid="${U.escapeHTML(r.key)}">
    <td>${r.id}</td>
    <td class="cell-text" title="${U.escapeHTML(r.before)}">${U.escapeHTML(r.before.substring(0, 80))}</td>
    <td class="cell-text" title="${U.escapeHTML(r.after)}">${U.escapeHTML(r.after.substring(0, 80))}</td>
    <td class="${confClass}">${r.confidence}%</td>
    <td title="${(state.db && state.db.__parsed && state.db.__parsed.estimated ? 'رقم تقديري — ' : '') + (r.mushafPage ? 'صفحة المصحف: ' + U.escapeHTML(U.toArabicDigits(r.mushafPage)) : '')}">${
        r.page ? U.escapeHTML(U.toArabicDigits(r.page))
               : (r.mushafPage ? U.escapeHTML(U.toArabicDigits(r.mushafPage)) : '-')}</td>
    <td>${U.escapeHTML(r.surah)}${r.ambiguous
        ? ` <span class="tag tag-warning" title="هذا النص يتكرر في ${r.occurrences} مواضع: ${U.escapeHTML((r.alternatives || []).join('، '))}">⚠ متكرر ×${r.occurrences}</span>`
        : ''}</td>
    <td>${U.escapeHTML(r.ayahRange)}</td>
    <td>${r.count}</td>
    <td>${r.changed ? '<span class="tag tag-success">✓ مصحح</span>' : '<span class="tag">-</span>'}</td>
    <td>${r.correctionType === 'correct'
        ? '<span class="tag tag-warning">تصحيح</span>'
        : '<span class="tag tag-info">تنسيق</span>'}</td>
    <td><input type="checkbox" class="approve-box" data-rid="${U.escapeHTML(r.key)}" ${checked} aria-label="اعتماد التحويل"></td>
  </tr>`;
        }).join('');

        const note = $('lblTableNote');
        if (note) {
            note.textContent = rows.length
                ? `${from + 1}–${Math.min(from + PAGE_SIZE, rows.length)} من ${rows.length}`
                : 'لا نتائج';
        }

        // Pager — every row must stay reachable, otherwise a conversion the user
        // never saw (and could not untick) would be written on save.
        const pager = $('pager');
        if (pager) {
            pager.style.display = pageCount > 1 ? 'flex' : 'none';
            $('lblPage').textContent = `صفحة ${state.page + 1} / ${pageCount}`;
            $('btnPrevPage').disabled = state.page === 0;
            $('btnNextPage').disabled = state.page >= pageCount - 1;
        }
        updateApprovalCount();
    }

    function updateStats() {
        const reps = allReplacements();
        const totalVerses = reps.reduce((s, r) => s + r.verseCount, 0);
        const single = reps.filter(r => r.verseCount === 1).length;
        const multi = reps.filter(r => r.verseCount > 1).length;
        const low = reps.filter(r => r.confidence < 80).length;
        const avg = reps.length ? Math.round(reps.reduce((s, r) => s + r.confidence, 0) / reps.length) : 0;

        $('statScanned').textContent = state.processed;
        $('statModified').textContent = state.results.length;
        $('statVerses').textContent = totalVerses;
        $('statSingle').textContent = single;
        $('statMulti').textContent = multi;
        $('statLowConf').textContent = low;
        $('statAmbiguous').textContent = reps.filter(r => r.ambiguous).length;
        $('statAvgConf').textContent = reps.length ? avg + '%' : '-';
    }

    // ===================================================================
    //  Exports
    // ===================================================================
    function approvedRows() {
        return buildRows().filter(r => r.approved);
    }

    function exportCSV() {
        const rows = approvedRows();
        if (!rows.length) { showToast('⚠️ لا توجد بيانات معتمدة للتصدير', 'warning'); return; }
        QF.Report.download(QF.Report.exportCSV(rows), 'quran_formatter_report.csv', 'text/csv');
        showToast('📥 تم تصدير CSV', 'success');
    }

    function exportJSON() {
        const rows = approvedRows();
        if (!rows.length) { showToast('⚠️ لا توجد بيانات معتمدة للتصدير', 'warning'); return; }
        const json = QF.Report.exportJSON(rows, {
            totalRows: state.totalRows,
            modifiedRows: state.results.length,
            table: state.table,
            outputType: state.outputType
        });
        QF.Report.download(json, 'quran_formatter_report.json', 'application/json');
        showToast('📥 تم تصدير JSON', 'success');
    }

    function exportHTML() {
        const rows = approvedRows();
        if (!rows.length) { showToast('⚠️ لا توجد بيانات معتمدة للتصدير', 'warning'); return; }
        QF.Report.download(
            QF.Report.exportHTML(rows, { totalRows: state.totalRows }),
            'quran_formatter_report.html', 'text/html');
        showToast('📥 تم تصدير HTML', 'success');
    }

    // ===================================================================
    //  Save database
    // ===================================================================
    /**
     * Rebuild every processed row, applying ONLY the approved (checked)
     * replacements. Rows whose conversions are all unchecked keep their exact
     * original text, byte for byte.
     * @returns {{rows:any[][], applied:number, skipped:number}}
     */
    function buildOutputRows() {
        const allRows = QF.Database.getRows(state.db, state.table);
        const ayahIdx = state.ayahTextColIdx >= 0
            ? state.ayahTextColIdx
            : state.columns.findIndex(c => c.name === state.ayahTextCol);
        if (ayahIdx < 0) throw new Error('عمود النص غير محدد');

        let applied = 0, skipped = 0;
        for (const result of state.results) {
            const i = result.rowIndex;
            if (i < 0 || i >= allRows.length) continue;

            const original = result.originalText != null
                ? result.originalText
                : String(allRows[i][ayahIdx] ?? '');

            const approved = result.replacements.filter(
                rep => isApproved(rep, result));

            if (approved.length === 0) { skipped++; continue; }  // leave untouched

            const finalText = QF.Formatter.applyReplacements(original, approved);
            if (finalText !== original) {
                allRows[i][ayahIdx] = finalText;
                applied++;
            }
        }
        return { rows: allRows, applied, skipped };
    }

    /**
     * @param {'auto'|'json'} [format] 'auto' keeps the source format
     *        (SQLite in → .db out, JSON in → .json out)
     */
    function saveDatabase(format = 'auto') {
        if (!state.db || state.results.length === 0) {
            showToast('⚠️ لا توجد بيانات معدلة للحفظ', 'warning');
            return;
        }
        const btn = format === 'json' ? $('btnSaveJSON') : $('btnSaveDB');
        setBusy(btn, true);

        try {
            const { rows, applied, skipped } = buildOutputRows();
            if (applied === 0) {
                showToast('⚠️ لم يتم اعتماد أي تحويل — لا شيء للحفظ', 'warning');
                return;
            }

            const asJson = format === 'json' || (format === 'auto' && state.db.__isJson);
            let blob, filename;

            if (asJson) {
                const handle = state.db.__isJson
                    ? QF.Database.createOutputDB(state.db, state.table, state.columns, rows)
                    : {
                        __isJson: true,
                        __columns: state.columns,
                        __rows: rows,
                        // Export SQLite tables as objects so column names survive.
                        __objectKeys: state.columns.map(c => c.name)
                    };
                blob = QF.Database.exportJsonDB(handle);
                filename = 'database_modified.json';
            } else {
                const newDB = QF.Database.createOutputDB(state.db, state.table, state.columns, rows);
                try {
                    blob = QF.Database.exportDB(newDB);
                } finally {
                    newDB.close();
                }
                filename = 'database_modified.db';
            }

            QF.Database.downloadBlob(blob, filename);
            showToast(
                `💾 تم الحفظ (${applied} صف معدل${skipped ? `، ${skipped} صف بدون تغيير` : ''})`,
                'success');
        } catch (err) {
            showToast('❌ فشل الحفظ: ' + err.message, 'error');
            console.error(err);
        } finally {
            setBusy(btn, false);
            updateButtons();
        }
    }

    // ===================================================================
    //  File inputs
    // ===================================================================
    function makeFileInput(id, accept, handler) {
        const input = document.createElement('input');
        input.type = 'file';
        input.id = id;
        input.accept = accept;
        input.style.display = 'none';
        input.addEventListener('change', async function (e) {
            const file = e.target.files[0];
            if (file) await handler(file);
            this.value = '';
        });
        document.body.appendChild(input);
        return input;
    }

    async function handleQuranFile(file) {
        try {
            showToast('📖 جارٍ تحميل ملف القرآن...', 'info');
            const text = await file.text();
            await ingestQuran(JSON.parse(text));
        } catch (err) {
            showToast('❌ فشل تحميل quran.json: ' + err.message, 'error');
        }
    }

    async function handleDBFile(file) {
        const isJson = /\.json$/i.test(file.name || '');
        try {
            if (isJson) {
                showToast('📄 جارٍ قراءة ملف JSON...', 'info');
            } else {
                showToast('⏳ جارٍ تهيئة محرك SQLite...', 'info');
                await QF.Database.init();
            }

            const db = await QF.Database.load(file);
            const tables = QF.Database.getTableNames(db);
            if (!tables.length) throw new Error('لا توجد جداول في قاعدة البيانات.');

            if (state.db) { try { state.db.close(); } catch (_) {} }

            state.db = db;
            state.tableNames = tables;
            state.table = tables[0];
            state.columns = QF.Database.getColumns(db, state.table);

            const colNames = state.columns.map(c => c.name);
            state.idCol = guessColumn(colNames, 'ID', 'id');
            state.surahCol = guessColumn(colNames, 'SuraID', 'suraid', 'sura_id');
            state.ayahIdCol = guessColumn(colNames, 'AyahID', 'ayahid', 'ayah_id');
            state.ayahTextCol = guessColumn(colNames, 'AyahText', 'ayahtext', 'text', 'tafsir');
            state.ayahTextColIdx = state.columns.findIndex(c => c.name === state.ayahTextCol);
            state.surahIdx = state.columns.findIndex(c => c.name === state.surahCol);
            state.totalRows = QF.Database.countRows(db, state.table);
            state.dbLoaded = true;

            $('btnSettings').style.display = 'inline-flex';

            // A positional JSON array already has the canonical column order,
            // so it needs no mapping dialog.
            const exact = ['SuraID', 'AyahID', 'AyahText'].every(c => colNames.includes(c));
            if (!exact || tables.length > 1) showSettingsModal();

            showToast(
                `✅ تم تحميل ${state.totalRows} صف من ${isJson ? 'ملف JSON' : `جدول "${state.table}"`}`,
                'success');
            markLoaded('btnLoadDB', isJson ? '🗄️ JSON ✓' : '🗄️ قاعدة البيانات ✓');
            updateButtons();
        } catch (err) {
            showToast('❌ فشل التحميل: ' + err.message, 'error');
            console.error(err);
        }
    }

    // ===================================================================
    //  Word / text documents
    // ===================================================================
    /**
     * Load a .docx or .txt file. The document is presented as a table
     * (ص | الفقرة | AyahText) so it reuses the whole existing pipeline:
     * process → review → untick → export.
     */
    async function handleDocFile(file) {
        try {
            showToast('📄 جارٍ قراءة المستند...', 'info');
            const parsed = await QF.Docx.read(file);
            if (!parsed.paragraphs.length) throw new Error('المستند لا يحتوي على نص');

            if (state.db) { try { state.db.close(); } catch (_) {} }

            const name = String(file.name || 'Document').replace(/\.[^.]+$/, '');
            const db = QF.Docx.toDataSource(parsed, name);

            state.db = db;
            state.tableNames = [db.__table];
            state.table = db.__table;
            state.columns = QF.Database.getColumns(db, state.table);
            state.idCol = 'الفقرة';
            state.surahCol = '';
            state.ayahIdCol = '';
            state.ayahTextCol = 'AyahText';
            state.ayahTextColIdx = 2;
            state.surahIdx = -1;
            state.totalRows = db.__rows.length;
            state.dbLoaded = true;

            $('btnSettings').style.display = 'inline-flex';
            showToast(
                `✅ تم تحميل ${state.totalRows} فقرة من ${parsed.pageCount} صفحة` +
                    (parsed.estimated ? ' (أرقام الصفحات تقديرية)' : ''),
                'success');
            markLoaded('btnLoadDoc', '📄 المستند ✓');
            updateButtons();
        } catch (err) {
            showToast('❌ فشل قراءة المستند: ' + err.message, 'error');
            console.error(err);
        }
    }

    /**
     * Save the document back in the format it came from: a .docx source is
     * rewritten as .docx (keeping the original styling), a .txt source as .txt.
     */
    async function saveDocument() {
        if (!state.db || !state.db.__isDoc) return;
        const btn = $('btnSaveText');
        setBusy(btn, true);
        try {
            const { rows, applied } = buildOutputRows();
            if (applied === 0) {
                showToast('⚠️ لم يتم اعتماد أي تحويل — لا شيء للحفظ', 'warning');
                return;
            }

            const base = (state.table || 'document').replace(/[\\/:*?"<>|]/g, '_');
            const isDocx = state.db.__docKind === 'docx' && state.db.__parsed
                && state.db.__parsed.source;

            if (isDocx) {
                // Map each edited row back to its <w:p> and rewrite in place.
                const edits = new Map();
                const pIdx = state.db.__pIndex || [];
                for (let i = 0; i < rows.length; i++) {
                    const p = pIdx[i];
                    if (p == null || p < 0) continue;
                    const text = String(rows[i][state.ayahTextColIdx] ?? '');
                    if (text !== String(state.db.__rows[i][state.ayahTextColIdx] ?? '')) {
                        edits.set(p, text);
                    }
                }
                const blob = await QF.Docx.writeDocx(state.db.__parsed, edits);
                QF.Database.downloadBlob(blob, `${base}_formatted.docx`);
                showToast(`💾 تم حفظ ملف Word (${applied} فقرة معدلة)`, 'success');
            } else {
                const text = QF.Docx.toPlainText(rows, state.ayahTextColIdx);
                const blob = new Blob(['\uFEFF' + text], { type: 'text/plain;charset=utf-8' });
                QF.Database.downloadBlob(blob, `${base}_formatted.txt`);
                showToast(`💾 تم حفظ الملف النصي (${applied} فقرة معدلة)`, 'success');
            }
        } catch (err) {
            showToast('❌ فشل الحفظ: ' + err.message, 'error');
            console.error(err);
        } finally {
            setBusy(btn, false);
            updateButtons();
        }
    }

    // ===================================================================
    //  Init
    // ===================================================================
    function init() {
        loadSettingsFromStorage();

        const selOut = $('selOutputType');
        if (selOut) selOut.value = state.outputType;
        const chkCorr = $('chkCorrection');
        if (chkCorr) chkCorr.checked = state.correctionEnabled;

        $('btnTheme').onclick = function () {
            const next = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
            document.body.dataset.theme = next;
            this.textContent = next === 'dark' ? '☀️' : '🌓';
            saveSettingsToStorage();
        };
        $('btnTheme').textContent = document.body.dataset.theme === 'dark' ? '☀️' : '🌓';

        selOut.onchange = function () { state.outputType = this.value; saveSettingsToStorage(); };
        chkCorr.onchange = function () { state.correctionEnabled = this.checked; saveSettingsToStorage(); };

        const quranInput = makeFileInput('quranFileInput', '.json', handleQuranFile);
        const dbInput = makeFileInput('dbFileInput', '.db,.sqlite,.sqlite3,.db3,.json', handleDBFile);
        const docInput = makeFileInput('docFileInput', '.docx,.txt,.md', handleDocFile);

        $('btnLoadQuran').onclick = () => quranInput.click();
        $('btnLoadDB').onclick = () => dbInput.click();
        $('btnLoadDoc').onclick = () => docInput.click();
        $('btnSettings').onclick = showSettingsModal;
        $('btnSaveSettings').onclick = saveSettings;
        $('btnCancelSettings').onclick = hideSettingsModal;
        $('btnStart').onclick = startProcessing;
        $('btnPause').onclick = togglePause;
        $('btnCancel').onclick = cancelProcessing;
        $('btnExportCSV').onclick = exportCSV;
        $('btnExportJSON').onclick = exportJSON;
        $('btnExportHTML').onclick = exportHTML;
        $('btnSaveDB').onclick = () => saveDatabase('auto');
        $('btnSaveJSON').onclick = () => saveDatabase('json');
        $('btnSaveText').onclick = saveDocument;
        $('btnClearResults').onclick = clearResults;
        $('btnSelectAll').onclick = () => setAllApprovals(true);
        $('btnSelectNone').onclick = () => setAllApprovals(false);
        $('btnTestFormat').onclick = testFormat;
        $('btnClearTest').onclick = clearTest;
        $('btnLoadSample').onclick = loadSample;
        $('btnCopyTest').onclick = copyTestOutput;

        $('txtSearch').addEventListener('input', U.debounce(() => { state.page = 0; renderReport(); }, 200));
        $('selFilter').onchange = () => { state.page = 0; renderReport(); };
        $('btnPrevPage').onclick = () => { state.page--; renderReport(); };
        $('btnNextPage').onclick = () => { state.page++; renderReport(); };
        $('chkSkipIdentical').onchange = function () {
            state.skipIdentical = this.checked;
            renderReport();
        };

        // Approval checkboxes — delegated, so no inline handlers needed.
        $('reportTbody').addEventListener('change', e => {
            const box = e.target.closest('.approve-box');
            if (box) toggleConversion(box.dataset.rid, box.checked);
        });

        // Sortable headers
        document.querySelectorAll('#reportTable thead th[data-sort]').forEach(th => {
            th.addEventListener('click', () => {
                const key = th.dataset.sort;
                state.sort.dir = state.sort.key === key ? -state.sort.dir : 1;
                state.sort.key = key;
                document.querySelectorAll('#reportTable thead th').forEach(h => h.classList.remove('sorted-asc', 'sorted-desc'));
                th.classList.add(state.sort.dir === 1 ? 'sorted-asc' : 'sorted-desc');
                renderReport();
            });
        });

        // Modal dismissal
        $('settingsModal').addEventListener('click', e => {
            if (e.target.id === 'settingsModal') hideSettingsModal();
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') hideSettingsModal();
            if (e.ctrlKey && e.key === 'Enter' && document.activeElement === $('testInput')) {
                e.preventDefault(); testFormat();
            }
        });

        window.addEventListener('beforeunload', e => {
            if (state.isProcessing || state.results.length) {
                e.preventDefault();
                e.returnValue = '';
            }
        });

        autoLoadQuran();
        updateButtons();
        updateQuranStatus();
        renderReport();
        showToast('🚀 المُنسِق جاهز. سيتم تحميل quran.json تلقائياً.', 'info');
    }

    // Public surface (kept for compatibility)
    window.QuranFormatterApp = { toggleConversion, state, renderReport };

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
