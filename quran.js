/**
 * quran.js — تحميل وفهرسة المصحف
 * Enhanced: O(1) verse lookup, exact-text hash map, inverted token index with
 * document frequencies (for fast candidate pruning), per-surah buckets, and
 * pre-computed token arrays so no hot loop ever re-tokenises a verse.
 */
(function (QF) {
    'use strict';

    const U = QF.Utils;

    QF.Quran = {
        verses: [],
        dictionary: [],          // { normalized, tokens, surahNum, ayahNum, imlai, uthmani }
        versesTokenized: [],     // { surahNum, ayahNum, tokens }  (compat)
        contextIndex: new Map(), // token -> [{surahNum, ayahNum, wordIdx, totalWords}]  (compat)

        // --- new indexes ---
        byKey: new Map(),        // "surah:ayah" -> dictionary entry
        byExact: new Map(),      // normalized text -> [entries]
        bySkeleton: new Map(),   // script-agnostic skeleton -> [entries]
        tokenIndex: new Map(),   // token -> Set<entryIdx>
        skeletonTokenIndex: new Map(), // skeleton token -> Set<entryIdx>
        bySurah: new Map(),      // surahNum -> entries sorted by ayahNum
        maxVerseTokens: 0,
        isLoaded: false,

        /**
         * @param {Array|Object} jsonData verse records
         * @param {(pct:number)=>void} [onProgress]
         * @returns {Promise<number>} number of indexed verses
         */
        async loadFromJSON(jsonData, onProgress) {
            const arr = Array.isArray(jsonData)
                ? jsonData
                : (jsonData && (jsonData.verses || jsonData.data)) || [jsonData];

            if (!Array.isArray(arr) || arr.length === 0) {
                throw new Error('ملف القرآن فارغ أو بصيغة غير معروفة');
            }

            this.reset();

            const total = arr.length;
            for (let i = 0; i < total; i++) {
                const item = arr[i] || {};
                const surahNum = Number(item.surah_num ?? item.surahNum ?? item.sura ?? 0);
                const ayahNum = Number(item.ayah_num ?? item.ayahNum ?? item.aya ?? 0);
                const imlai = item.ayah_imlai ?? item.ayahImlai ?? '';
                const uthmani = item.ayah_uthmani ?? item.ayahUthmani ?? '';
                if ((!imlai && !uthmani) || !surahNum || !ayahNum) continue;

                // Derive the search key from the *vocalised* text rather than the
                // supplied `ayah_notashkil`. Some datasets (including the bundled
                // quran.json) have 156 verses where that field is corrupt — e.g.
                // 2:117 stores "بديع السماوات و واذا" with "والأرض" truncated to "و".
                // Normalising imlai ourselves is both safer and self-consistent.
                const primary = imlai || uthmani;
                let normalized = U.normalizeArabic(primary);
                const supplied = item.ayah_notashkil ?? item.ayahNotashkil ?? '';

                if (!normalized && supplied) normalized = U.normalizeArabic(supplied);
                if (!normalized) continue;

                // Keep the supplied variant as an extra alias when it genuinely
                // differs, so quotes copied from that field still resolve.
                // Index the alias WITHOUT prefix-joining: in the corrupt rows a
                // lone "و" is a truncated word (والأرض), not a detached particle,
                // so joining it to the next word would destroy the alias.
                const suppliedNorm = supplied
                    ? U.normalizeArabic(supplied, { joinPrefixes: false }) : '';
                const aliasNorm = (suppliedNorm && suppliedNorm !== normalized) ? suppliedNorm : null;

                const tokens = normalized.split(' ').filter(Boolean);
                if (tokens.length > this.maxVerseTokens) this.maxVerseTokens = tokens.length;

                const entry = {
                    normalized,
                    tokens,
                    surahNum,
                    ayahNum,
                    imlai: imlai || uthmani,
                    uthmani: uthmani || imlai,
                    // pre-split display words: avoids repeated .split in the matcher
                    imlaiWords: (imlai || uthmani).split(/\s+/).filter(Boolean),
                    uthmaniWords: (uthmani || imlai).split(/\s+/).filter(Boolean),
                    // Mushaf page (1–604), surfaced in the report as "ص".
                    page: Number(item.page_num ?? item.pageNum ?? 0) || null,
                    // Alternate spelling from a (possibly corrupt) notashkil field,
                    // kept searchable so quotes copied from it still resolve.
                    aliasNormalized: aliasNorm,
                    aliasTokens: aliasNorm ? aliasNorm.split(' ').filter(Boolean) : null,
                    // Word skeletons, so an ʿUthmānī fragment can be located
                    // inside a verse indexed from its imlā'ī spelling.
                    skeletonTokens: null
                };

                entry.skeletonTokens = tokens.map(t => U.skeleton(t));
                const idx = this.dictionary.length;
                this.dictionary.push(entry);

                this.verses.push({
                    id: item.ID ?? item.id ?? idx + 1,
                    surah: surahNum, ayah: ayahNum,
                    imlai: entry.imlai, uthmani: entry.uthmani, notashkil: normalized,
                    page: item.page_num ?? item.pageNum ?? null
                });

                this.versesTokenized.push({ surahNum, ayahNum, tokens });
                this.byKey.set(surahNum + ':' + ayahNum, entry);

                let exact = this.byExact.get(normalized);
                if (!exact) this.byExact.set(normalized, (exact = []));
                exact.push(entry);

                if (aliasNorm) {
                    let alias = this.byExact.get(aliasNorm);
                    if (!alias) this.byExact.set(aliasNorm, (alias = []));
                    alias.push(entry);
                }

                // The verse as written in the mushaf: lets an ʿUthmānī quotation
                // hit the exact index directly instead of falling through.
                const uthNorm = uthmani ? U.normalizeArabic(uthmani) : '';
                if (uthNorm && uthNorm !== normalized && uthNorm !== aliasNorm) {
                    let u = this.byExact.get(uthNorm);
                    if (!u) this.byExact.set(uthNorm, (u = []));
                    u.push(entry);
                }

                for (const tok of new Set(entry.skeletonTokens)) {
                    if (!tok) continue;
                    let set = this.skeletonTokenIndex.get(tok);
                    if (!set) this.skeletonTokenIndex.set(tok, (set = new Set()));
                    set.add(idx);
                }

                // Script-agnostic fallback (see Utils.skeleton).
                const skel = U.skeleton(normalized);
                if (skel) {
                    let sk = this.bySkeleton.get(skel);
                    if (!sk) this.bySkeleton.set(skel, (sk = []));
                    if (sk.indexOf(entry) === -1) sk.push(entry);
                }

                let bucket = this.bySurah.get(surahNum);
                if (!bucket) this.bySurah.set(surahNum, (bucket = []));
                bucket.push(entry);

                // inverted index (unique tokens per verse)
                const seen = new Set();
                if (aliasNorm) {
                    for (const tok of aliasNorm.split(' ')) {
                        if (!tok || seen.has(tok)) continue;
                        seen.add(tok);
                        let set = this.tokenIndex.get(tok);
                        if (!set) this.tokenIndex.set(tok, (set = new Set()));
                        set.add(idx);
                    }
                }
                for (let w = 0; w < tokens.length; w++) {
                    const tok = tokens[w];
                    if (!seen.has(tok)) {
                        seen.add(tok);
                        let set = this.tokenIndex.get(tok);
                        if (!set) this.tokenIndex.set(tok, (set = new Set()));
                        set.add(idx);
                    }
                    let occ = this.contextIndex.get(tok);
                    if (!occ) this.contextIndex.set(tok, (occ = []));
                    occ.push({ surahNum, ayahNum, wordIdx: w, totalWords: tokens.length });
                }

                if (onProgress && (i & 1023) === 0) {
                    onProgress(Math.round((i / total) * 100));
                    await new Promise(r => setTimeout(r, 0)); // keep UI responsive
                }
            }

            for (const bucket of this.bySurah.values()) bucket.sort((a, b) => a.ayahNum - b.ayahNum);

            this.isLoaded = this.dictionary.length > 0;
            if (!this.isLoaded) throw new Error('لم يتم استخراج أي آية صالحة من الملف');
            if (onProgress) onProgress(100);
            return this.dictionary.length;
        },

        reset() {
            this.verses = [];
            this.dictionary = [];
            this.versesTokenized = [];
            this.contextIndex = new Map();
            this.byKey = new Map();
            this.byExact = new Map();
            this.bySkeleton = new Map();
            this.tokenIndex = new Map();
            this.skeletonTokenIndex = new Map();
            this.bySurah = new Map();
            this.maxVerseTokens = 0;
            this.isLoaded = false;
        },

        /** O(1) exact lookup. */
        getVerseEntry(surahNum, ayahNum) {
            return this.byKey.get(surahNum + ':' + ayahNum) || null;
        },

        getVerseTokens(surahNum, ayahNum) {
            const e = this.byKey.get(surahNum + ':' + ayahNum);
            return e ? { surahNum, ayahNum, tokens: e.tokens } : null;
        },

        /** Entries whose script-agnostic skeleton equals `skel`, or []. */
        getBySkeleton(skel) { return this.bySkeleton.get(skel) || []; },

        /** Entries whose normalized text equals `norm`, or []. */
        getExact(norm) { return this.byExact.get(norm) || []; },

        getSurah(surahNum) { return this.bySurah.get(surahNum) || []; },

        /** Next verse in the same surah, or null. */
        getNext(entry) {
            return entry ? this.getVerseEntry(entry.surahNum, entry.ayahNum + 1) : null;
        },

        /**
         * Candidate verses that share at least one token with `tokens`,
         * ranked by rarest-token pruning. Dramatically shrinks the search
         * space versus scanning all 6,236 verses.
         * @param {string[]} tokens
         * @param {number} [limit=400]
         * @param {number|null} [preferredSurah]
         * @returns {object[]}
         */
        getCandidateEntries(tokens, limit = 400, preferredSurah = null) {
            if (!tokens || tokens.length === 0) return [];

            // Use the rarest tokens first — they discriminate best.
            const ranked = tokens
                .map(t => ({ t, set: this.tokenIndex.get(t) }))
                .filter(x => x.set && x.set.size > 0)
                .sort((a, b) => a.set.size - b.set.size);

            if (ranked.length === 0) return [];

            const scores = new Map();
            const probe = Math.min(ranked.length, 6);
            for (let i = 0; i < probe; i++) {
                const { set } = ranked[i];
                if (set.size > 1500) continue; // stop-word-like token, skip
                for (const idx of set) scores.set(idx, (scores.get(idx) || 0) + 1);
            }
            if (scores.size === 0) {
                for (const idx of ranked[0].set) scores.set(idx, 1);
            }

            const out = [];
            for (const [idx, score] of scores) {
                const entry = this.dictionary[idx];
                out.push({ entry, score: score + (preferredSurah && entry.surahNum === preferredSurah ? 2 : 0) });
            }
            out.sort((a, b) => b.score - a.score);
            return out.slice(0, limit).map(x => x.entry);
        },

        stats() {
            return {
                verses: this.dictionary.length,
                surahs: this.bySurah.size,
                uniqueTokens: this.tokenIndex.size,
                maxVerseTokens: this.maxVerseTokens
            };
        }
    };
})(QuranFormatter);
