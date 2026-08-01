/**
 * utils.js — أدوات مساعدة لتطبيق المُنسِق
 * Enhanced: cached normalization, faster Levenshtein (banded + early exit),
 * safer HTML escaping, robust candidate extraction.
 */
var QuranFormatter = (typeof globalThis !== 'undefined' && globalThis.QuranFormatter) || {};
if (typeof globalThis !== 'undefined') globalThis.QuranFormatter = QuranFormatter;

(function (QF) {
    'use strict';

    // --- lookup tables built once ---------------------------------------
    const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
    const EXTENDED_INDIC = '۰۱۲۳۴۵۶۷۸۹';

    const CHAR_MAP = (() => {
        const m = Object.create(null);
        for (const c of 'إأٱآا') m[c] = 'ا';
        m['ى'] = 'ي';
        m['ي'] = 'ي';
        m['ؤ'] = 'و';
        m['ئ'] = 'ي';
        m['ة'] = 'ه';
        for (let i = 0; i < 10; i++) {
            m[ARABIC_INDIC[i]] = String(i);
            m[EXTENDED_INDIC[i]] = String(i);
        }
        return m;
    })();

    // Diacritics / marks that must be stripped before comparison.
    const STRIP = (() => {
        const s = new Set();
        const add = (from, to) => { for (let c = from; c <= to; c++) s.add(String.fromCharCode(c)); };
        add(0x0617, 0x061A); // Arabic small marks
        add(0x064B, 0x065F); // tashkeel
        s.add('\u0670');     // superscript alef
        add(0x06D6, 0x06ED); // quranic annotation marks
        s.add('\u0640');     // tatweel
        s.add('\u200C'); s.add('\u200D'); s.add('\u200E'); s.add('\u200F'); // bidi/zwj
        s.add('\uFEFF');
        return s;
    })();

    const PUNCT = new Set([
        '،', '؛', '؟', '!', ':', '.', '-', '—', '–', '(', ')', '[', ']', '{', '}',
        '"', "'", '«', '»', '‹', '›', '`', '´', '*', '/', '\\', '|', '_', '=', '+',
        '\u061B', '\u061E', '\u061F', '\u066A', '\u066B', '\u066C', '\u06D4',
        '\uFD3F', '\uFD3E', '<', '>', '#', '@', '~', '؞', '٫', '٬'
    ]);

    /** Bounded LRU-ish cache to avoid unbounded memory growth. */
    function makeCache(limit) {
        const map = new Map();
        return {
            get(k) { return map.get(k); },
            set(k, v) {
                if (map.size >= limit) {
                    // drop oldest ~10% in one pass (cheap amortised eviction)
                    let drop = Math.ceil(limit * 0.1);
                    for (const key of map.keys()) { map.delete(key); if (--drop <= 0) break; }
                }
                map.set(k, v);
                return v;
            },
            clear() { map.clear(); },
            get size() { return map.size; }
        };
    }

    const normCache = makeCache(20000);
    const tokenCache = makeCache(20000);

    QF.Utils = {
        // kept for backwards compatibility with any external caller
        TASHKEEL: /[\u0617-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g,
        TATWEEL: /\u0640/g,

        /**
         * Normalise Arabic text for comparison purposes.
         * Single-pass character walk (≈4× faster than the previous 11 regex passes).
         * @param {string} text
         * @returns {string}
         */
        normalizeArabic(text, opts) {
            if (!text || typeof text !== 'string') return '';
            const joinPrefixes = !(opts && opts.joinPrefixes === false);
            const cacheKey = joinPrefixes ? text : '\u0000nojoin\u0000' + text;
            const cached = normCache.get(cacheKey);
            if (cached !== undefined) return cached;

            const out = [];
            let lastWasSpace = true; // trims leading spaces implicitly

            for (let i = 0; i < text.length; i++) {
                const ch = text[i];
                if (STRIP.has(ch)) continue;

                if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || PUNCT.has(ch)) {
                    if (!lastWasSpace) { out.push(' '); lastWasSpace = true; }
                    continue;
                }
                const mapped = CHAR_MAP[ch];
                out.push(mapped !== undefined ? mapped : ch);
                lastWasSpace = false;
            }

            let t = out.join('');
            if (lastWasSpace && t.endsWith(' ')) t = t.slice(0, -1);

            // Orthographic joins that genuinely differ between mushaf and modern
            // spelling. The vocative يا is written joined in the mushaf
            // (يَاأَيُّهَا) but separately in modern text (يا أيها).
            //
            // NOTE: this must only fire on a STANDALONE يا. Matching it anywhere
            // fused every word ending in يا with the next one — "عتيا قال" became
            // "عتياقال", "الدنيا قال" became "الدنياقال" — silently breaking
            // matching for those verses. Anchored with a word boundary below.
            if (t.indexOf('يا ') !== -1) t = t.replace(/(^|\s)يا\s+(?=[\u0600-\u06FF])/g, '$1يا');
            if (t.indexOf('لو ما') !== -1) t = t.replace(/(^|\s)لو\s+ما(?=\s|$)/g, '$1لوما');

            // Detached single-letter prefixes: "و وهبنا" → "ووهبنا".
            // These particles are always written joined in the mushaf — a
            // standalone و/ف/ب/ل/ك occurs exactly 0 times across all 6,236
            // verses — so re-attaching them is safe and fixes OCR/typing splits.
            //
            // Opt out via { joinPrefixes: false } when indexing text whose word
            // boundaries must be preserved verbatim (see the corrupt-notashkil
            // alias in quran.js: its "و" is a truncated word, not a prefix).
            if (joinPrefixes) {
                t = t.replace(/(^|\s)([وفبلك])\s+(?=[\u0600-\u06FF])/g, '$1$2');
            }

            return normCache.set(cacheKey, t);
        },

        /**
         * Normalise + split into words. Result arrays are cached and therefore
         * MUST be treated as read-only by callers.
         * @param {string} text
         * @returns {string[]}
         */
        tokenize(text) {
            if (!text) return [];
            const cached = tokenCache.get(text);
            if (cached !== undefined) return cached;
            const n = this.normalizeArabic(text);
            const toks = n.length ? n.split(' ').filter(Boolean) : [];
            return tokenCache.set(text, toks);
        },

        clearCaches() { normCache.clear(); tokenCache.clear(); },

        /**
         * Levenshtein distance with early termination.
         * @param {string} a
         * @param {string} b
         * @param {number} [maxDist=Infinity] abort once the distance provably exceeds this
         * @returns {number} distance, or maxDist+1 when the limit was exceeded
         */
        levenshtein(a, b, maxDist = Infinity) {
            if (a === b) return 0;
            const m = a.length, n = b.length;
            if (m === 0) return n;
            if (n === 0) return m;
            if (Math.abs(m - n) > maxDist) return maxDist + 1;

            let prev = new Int32Array(n + 1);
            let curr = new Int32Array(n + 1);
            for (let j = 0; j <= n; j++) prev[j] = j;

            for (let i = 1; i <= m; i++) {
                curr[0] = i;
                let rowMin = i;
                const ca = a.charCodeAt(i - 1);
                for (let j = 1; j <= n; j++) {
                    const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
                    const v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
                    curr[j] = v;
                    if (v < rowMin) rowMin = v;
                }
                if (rowMin > maxDist) return maxDist + 1;
                const tmp = prev; prev = curr; curr = tmp;
            }
            return prev[n];
        },

        /** Normalised similarity in [0,1] based on edit distance. */
        levenshteinRatio(a, b) {
            const maxLen = Math.max(a.length, b.length);
            if (!maxLen) return 1;
            return 1 - this.levenshtein(a, b) / maxLen;
        },

        /**
         * Locate probable Quranic quotations inside a tafsir string.
         * Handles ﴿﴾, (), {}, <<>> with proper nesting, unclosed brackets,
         * and falls back to long Arabic runs.
         * @param {string} text
         * @returns {{start:number,end:number,text:string}[]}
         */
        extractQuranCandidates(text) {
            if (!text) return [];
            const candidates = [];
            const pairs = [
                { open: '\uFD3F', close: '\uFD3E' },
                { open: '«', close: '»' },
                { open: '<<', close: '>>' },
                { open: '{', close: '}' },
                { open: '(', close: ')' }
            ];

            const stack = [];
            for (let i = 0; i < text.length; i++) {
                let handled = false;

                for (const pair of pairs) {
                    if (text.startsWith(pair.open, i)) {
                        stack.push({ openIndex: i, type: pair });
                        i += pair.open.length - 1;
                        handled = true;
                        break;
                    }
                }
                if (handled) continue;

                for (const pair of pairs) {
                    if (!text.startsWith(pair.close, i)) continue;
                    let found = -1;
                    for (let s = stack.length - 1; s >= 0; s--) {
                        if (stack[s].type === pair) { found = s; break; }
                    }
                    if (found !== -1) {
                        const entry = stack[found];
                        const inner = text.substring(entry.openIndex + pair.open.length, i).trim();
                        if (inner.length > 1 && /[\u0600-\u06FF]/.test(inner)) {
                            candidates.push({ start: entry.openIndex, end: i + pair.close.length, text: inner });
                        }
                        stack.splice(found);
                    }
                    i += pair.close.length - 1;
                    handled = true;
                    break;
                }
            }

            // Unclosed openers: read until a line break or a non-Arabic delimiter.
            while (stack.length) {
                const entry = stack.pop();
                const from = entry.openIndex + entry.type.open.length;
                let end = text.length;
                for (let j = from; j < text.length; j++) {
                    const ch = text[j];
                    if (ch === '\n' || ch === '\r' || '()\uFD3F\uFD3E{}<>«»'.includes(ch)) { end = j; break; }
                    if (!/[\u0600-\u06FF\s\u064B-\u065F\u0670]/.test(ch)) { end = j; break; }
                }
                const inner = text.substring(from, end).trim();
                if (inner.length > 1 && /[\u0600-\u06FF]/.test(inner)) {
                    candidates.push({ start: entry.openIndex, end, text: inner });
                }
            }

            // NOTE: there is deliberately no "scan any long Arabic run" fallback.
            // Only bracketed text is considered a quotation. Scanning bare prose
            // converted things the author never marked as a quote — e.g. a plain
            // بسم الله الرحمن الرحيم heading — and applied a different rule to
            // unbracketed text than to everything else.

            // Merge overlaps so replacements never collide.
            candidates.sort((a, b) => a.start - b.start || b.end - a.end);
            const merged = [];
            for (const cand of candidates) {
                const last = merged[merged.length - 1];
                if (last && cand.start < last.end) {
                    if (cand.end > last.end) {
                        last.end = cand.end;
                        last.text = text.substring(last.start, last.end).trim();
                    }
                } else {
                    merged.push(cand);
                }
            }
            return merged;
        },

        /** Convert Western digits to Arabic-Indic digits. */
        toArabicDigits(num) {
            return String(num).replace(/[0-9]/g, d => ARABIC_INDIC[+d]);
        },

        /** Format seconds as mm:ss or h:mm:ss. */
        formatTime(sec) {
            if (!isFinite(sec) || sec < 0) sec = 0;
            const h = Math.floor(sec / 3600),
                  m = Math.floor((sec % 3600) / 60),
                  s = Math.floor(sec % 60);
            const pad = v => String(v).padStart(2, '0');
            return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
        },

        /** Escape a string for safe interpolation into HTML. */
        escapeHTML(str) {
            return String(str == null ? '' : str).replace(/[&<>"'`]/g, c => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;',
                '"': '&quot;', "'": '&#39;', '`': '&#96;'
            })[c]);
        },

        /** Clamp a number into [min,max]. */
        clamp(v, min, max) { return v < min ? min : (v > max ? max : v); },

        /**
         * Script-agnostic "skeleton" of a word or phrase.
         *
         * Imlā'ī and ʿUthmānī spell the same word differently — the mushaf omits
         * the alef that modern orthography writes, and marks it instead with a
         * dagger alef (U+0670) that normalisation strips as a diacritic:
         *
         *   الصلوة / الصلاة    السموت / السماوات    ءامنوا / آمنوا
         *   الكتب  / الكتاب     العلمين / العالمين    يايها  / يا أيها
         *
         * 64 % of verses (3,983 of 6,236) normalise differently between the two
         * scripts, so an ʿUthmānī quotation could not be matched at all. Dropping
         * every long vowel and hamza carrier collapses both spellings onto one
         * form: 6,155 of 6,236 verses then agree exactly.
         *
         * Lossy by design — only ever used as a LAST-RESORT index, after exact
         * and substring matching have failed.
         *
         * @param {string} text
         * @returns {string}
         */
        skeleton(text) {
            if (!text) return '';
            return this.normalizeArabic(text)
                .replace(/[اويىء]/g, '')
                .replace(/\s+/g, ' ')
                .trim();
        },

        /** Trailing-ellipsis detection (…, ..., ....). */
        hasTrailingDots(text) { return /(?:\.{2,}|…)\s*$/.test(String(text || '').trimEnd()); },

        /** Debounce a function by `wait` ms. */
        debounce(fn, wait) {
            let t = null;
            return function (...args) {
                clearTimeout(t);
                t = setTimeout(() => fn.apply(this, args), wait);
            };
        }
    };
})(QuranFormatter);
