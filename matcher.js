/**
 * matcher.js — محرك مطابقة الآيات
 *
 * Enhanced over the original:
 *  • All hot loops go through QF.Quran inverted indexes instead of scanning
 *    the full 6,236-verse dictionary (the old multi-verse greedy search was
 *    O(surahs × verses × len × window) and took 90–110s per candidate).
 *  • Verse tokens are pre-computed at load time; nothing re-tokenises inside a loop.
 *  • Confidence is always clamped to 0–100 (the old code emitted 147%).
 *  • Multi-verse detection is anchored + consecutive-aware, so it is exact and fast.
 *  • Every public method keeps its original name and signature.
 */
(function (QF) {
    'use strict';

    const U = QF.Utils;

    const SURAH_NAMES = {
        1:'الفاتحة',2:'البقرة',3:'آل عمران',4:'النساء',5:'المائدة',6:'الأنعام',7:'الأعراف',8:'الأنفال',
        9:'التوبة',10:'يونس',11:'هود',12:'يوسف',13:'الرعد',14:'إبراهيم',15:'الحجر',16:'النحل',17:'الإسراء',
        18:'الكهف',19:'مريم',20:'طه',21:'الأنبياء',22:'الحج',23:'المؤمنون',24:'النور',25:'الفرقان',
        26:'الشعراء',27:'النمل',28:'القصص',29:'العنكبوت',30:'الروم',31:'لقمان',32:'السجدة',33:'الأحزاب',
        34:'سبأ',35:'فاطر',36:'يس',37:'الصافات',38:'ص',39:'الزمر',40:'غافر',41:'فصلت',42:'الشورى',
        43:'الزخرف',44:'الدخان',45:'الجاثية',46:'الأحقاف',47:'محمد',48:'الفتح',49:'الحجرات',50:'ق',
        51:'الذاريات',52:'الطور',53:'النجم',54:'القمر',55:'الرحمن',56:'الواقعة',57:'الحديد',58:'المجادلة',
        59:'الحشر',60:'الممتحنة',61:'الصف',62:'الجمعة',63:'المنافقون',64:'التغابن',65:'الطلاق',66:'التحريم',
        67:'الملك',68:'القلم',69:'الحاقة',70:'المعارج',71:'نوح',72:'الجن',73:'المزمل',74:'المدثر',
        75:'القيامة',76:'الإنسان',77:'المرسلات',78:'النبأ',79:'النازعات',80:'عبس',81:'التكوير',82:'الانفطار',
        83:'المطففين',84:'الانشقاق',85:'البروج',86:'الطارق',87:'الأعلى',88:'الغاشية',89:'الفجر',90:'البلد',
        91:'الشمس',92:'الليل',93:'الضحى',94:'الشرح',95:'التين',96:'العلق',97:'القدر',98:'البينة',
        99:'الزلزلة',100:'العاديات',101:'القارعة',102:'التكاثر',103:'العصر',104:'الهمزة',105:'الفيل',
        106:'قريش',107:'الماعون',108:'الكوثر',109:'الكافرون',110:'النصر',111:'المسد',112:'الإخلاص',
        113:'الفلق',114:'الناس'
    };

    // Vocalised surah names in the genitive, as they appear in printed
    // references: [الفَاتِحَةِ: ٢]. Stripping the tashkeel yields SURAH_NAMES
    // (except سَبَإٍ / النَّبَإِ, whose genitive hamza seat differs).
    const SURAH_NAMES_TASHKEEL = {
        1:'الفَاتِحَةِ',2:'البَقَرَةِ',3:'آلِ عِمْرَانَ',4:'النِّسَاءِ',
        5:'المَائِدَةِ',6:'الأَنْعَامِ',7:'الأَعْرَافِ',8:'الأَنْفَالِ',
        9:'التَّوْبَةِ',10:'يُونُسَ',11:'هُودٍ',12:'يُوسُفَ',
        13:'الرَّعْدِ',14:'إِبْرَاهِيمَ',15:'الحِجْرِ',16:'النَّحْلِ',
        17:'الإِسْرَاءِ',18:'الكَهْفِ',19:'مَرْيَمَ',20:'طه',
        21:'الأَنْبِيَاءِ',22:'الحَجِّ',23:'المُؤْمِنُونَ',24:'النُّورِ',
        25:'الفُرْقَانِ',26:'الشُّعَرَاءِ',27:'النَّمْلِ',28:'القَصَصِ',
        29:'العَنْكَبُوتِ',30:'الرُّومِ',31:'لُقْمَانَ',32:'السَّجْدَةِ',
        33:'الأَحْزَابِ',34:'سَبَإٍ',35:'فَاطِرٍ',36:'يس',
        37:'الصَّافَّاتِ',38:'ص',39:'الزُّمَرِ',40:'غَافِرٍ',
        41:'فُصِّلَتْ',42:'الشُّورَى',43:'الزُّخْرُفِ',44:'الدُّخَانِ',
        45:'الجَاثِيَةِ',46:'الأَحْقَافِ',47:'مُحَمَّدٍ',48:'الفَتْحِ',
        49:'الحُجُرَاتِ',50:'ق',51:'الذَّارِيَاتِ',52:'الطُّورِ',
        53:'النَّجْمِ',54:'القَمَرِ',55:'الرَّحْمَنِ',56:'الوَاقِعَةِ',
        57:'الحَدِيدِ',58:'المُجَادِلَةِ',59:'الحَشْرِ',60:'المُمْتَحَنَةِ',
        61:'الصَّفِّ',62:'الجُمُعَةِ',63:'المُنَافِقُونَ',64:'التَّغَابُنِ',
        65:'الطَّلَاقِ',66:'التَّحْرِيمِ',67:'المُلْكِ',68:'القَلَمِ',
        69:'الحَاقَّةِ',70:'المَعَارِجِ',71:'نُوحٍ',72:'الجِنِّ',
        73:'المُزَّمِّلِ',74:'المُدَّثِّرِ',75:'القِيَامَةِ',76:'الإِنْسَانِ',
        77:'المُرْسَلَاتِ',78:'النَّبَإِ',79:'النَّازِعَاتِ',80:'عَبَسَ',
        81:'التَّكْوِيرِ',82:'الانْفِطَارِ',83:'المُطَفِّفِينَ',84:'الانْشِقَاقِ',
        85:'البُرُوجِ',86:'الطَّارِقِ',87:'الأَعْلَى',88:'الغَاشِيَةِ',
        89:'الفَجْرِ',90:'البَلَدِ',91:'الشَّمْسِ',92:'اللَّيْلِ',
        93:'الضُّحَى',94:'الشَّرْحِ',95:'التِّينِ',96:'العَلَقِ',
        97:'القَدْرِ',98:'البَيِّنَةِ',99:'الزَّلْزَلَةِ',100:'العَادِيَاتِ',
        101:'القَارِعَةِ',102:'التَّكَاثُرِ',103:'العَصْرِ',104:'الهُمَزَةِ',
        105:'الفِيلِ',106:'قُرَيْشٍ',107:'المَاعُونِ',108:'الكَوْثَرِ',
        109:'الكَافِرُونَ',110:'النَّصْرِ',111:'المَسَدِ',112:'الإِخْلَاصِ',
        113:'الفَلَقِ',114:'النَّاسِ'
    };

    QF.Matcher = {
        // ---- tunable thresholds -------------------------------------------
        MIN_FULL_CONFIDENCE: 75,
        MIN_PREFIX_CONFIDENCE: 70,
        MIN_FUZZY_CONFIDENCE: 85,
        MIN_CONTEXT_CONFIDENCE: 75,
        MIN_MULTI_CONFIDENCE: 90,
        MAX_CORRECTION_TOKENS: 40,
        MAX_FUZZY_CANDIDATES: 300,
        MAX_CHAIN_TYPOS: 2,
        MAX_VERSE_EDITS: 2,   // per-ayah budget (missing / extra / mistyped words)
        MAX_CHAIN_EDITS: 3,   // total budget across a multi-ayah run
        MIN_VERSE_WORDS: 2,   // never emit an ayah shorter than this (حم، الم، يس…)
        // Reference style. RANGE_SEPARATOR joins the first and last ayah of a run
        // ("٥٣-٥٤"); VOCALISED_NAMES prints [الفَاتِحَةِ: ٢] instead of [الفاتحة: ٢].
        RANGE_SEPARATOR: '-',
        VOCALISED_NAMES: true,
        SURAH_BONUS: 6,
        VERSE_NUMBER_RE: /[(\[]\s*[\d٠-٩]{1,3}\s*[)\]]/g,
        // An existing reference tag such as " [الفاتحة: ٢]" or " [النحل: ٥٣]"
        // An existing reference tag such as " [الفاتحة: ٢]" or, on its own line,
        // "[سُورَةُ النَّحْلِ: ٥٣-٥٤]". Blank lines between the quote and the tag are
        // allowed so an author's layout is absorbed rather than duplicated.
        REFERENCE_TAG_RE: /^[ \t]*(?:\r?\n[ \t]*){0,2}\[[^\]\n]{1,60}\]/,

        // ===================================================================
        //  Entry point
        // ===================================================================
        /**
         * @param {string} tafsirText
         * @param {'imlai'|'uthmani'} outputType
         * @param {number|null} preferredSurah
         * @param {boolean} correctionEnabled
         */
        processText(tafsirText, outputType = 'imlai', preferredSurah = null, correctionEnabled = true) {
            if (!QF.Quran.isLoaded) throw new Error('لم يتم تحميل القرآن');
            if (!tafsirText || typeof tafsirText !== 'string') {
                return { modifiedText: tafsirText || '', replacements: [], totalVerses: 0, lowConfidenceCount: 0, averageConfidence: 0, ambiguousCount: 0 };
            }

            // `preferredSurah` may be a plain number (legacy) or {surah, ayah}.
            this._ctxAyah = (preferredSurah && typeof preferredSurah === 'object')
                ? (Number(preferredSurah.ayah) || null) : null;
            if (preferredSurah && typeof preferredSurah === 'object') {
                preferredSurah = Number(preferredSurah.surah) || null;
            }

            const candidates = U.extractQuranCandidates(tafsirText);
            const replacements = [];

            for (const cand of candidates) {
                try {
                    // An ellipsis just outside the quote ("...الحمد لله رب العالمين(")
                    // belongs to the quotation: absorb it so it renders inside the
                    // braces instead of dangling after the reference tag.
                    let candText = cand.text;
                    let candEnd = cand.end;
                    const dots = /^\s*(?:\.{2,}|…)/.exec(tafsirText.slice(cand.end, cand.end + 12));
                    if (dots) {
                        candText += ' ...';
                        candEnd = cand.end + dots[0].length;
                    }

                    const { verses, correctionUsed } =
                        this.extractVersesFromCandidate(candText, outputType, preferredSurah, correctionEnabled);
                    if (!verses.length) continue;

                    const groups = this.groupConsecutiveVerses(verses);
                    const formatted = groups.map(g => this.formatGroup(g, outputType)).join('\n');

                    // If the quote is already followed by a reference tag, absorb it so
                    // re-running the formatter replaces rather than duplicates it.
                    let end = candEnd;
                    const tail = tafsirText.slice(candEnd, candEnd + 80);
                    const tagMatch = this.REFERENCE_TAG_RE.exec(tail);
                    // Only absorb a tag that really cites this passage, so an
                    // unrelated bracket after the quote is never swallowed.
                    if (tagMatch && this._tagCitesVerses(tagMatch[0], verses)) {
                        end = candEnd + tagMatch[0].length;
                    }

                    const original = tafsirText.substring(cand.start, end);
                    if (formatted === original) continue; // nothing to change

                    replacements.push({
                        start: cand.start,
                        end,
                        original,
                        formatted,
                        confidence: this._avgConfidence(verses),
                        surahNum: verses[0].surahNum,
                        surahName: this.getPlainSurahName(verses[0].surahNum),
                        // Mushaf page of the first ayah in the run (report column "ص").
                        page: this.getPage(verses[0].surahNum, verses[0].ayahNum),
                        ayahNum: verses[0].ayahNum,
                        endAyahNum: verses[verses.length - 1].ayahNum,
                        verseCount: verses.length,
                        isConsecutive: groups.some(g => g.length > 1),
                        correctionType: correctionUsed ? 'correct' : 'format',
                        ambiguous: verses.some(v => v.ambiguous),
                        occurrences: verses[0].occurrences || 1,
                        alternatives: verses[0].alternatives || null
                    });
                } catch (err) {
                    console.warn('Candidate failed:', cand.text.slice(0, 60), err);
                }
            }

            this.resolveAmbiguous(replacements, tafsirText, outputType);

            // Apply back-to-front so earlier offsets stay valid.
            const ordered = [...replacements].sort((a, b) => b.start - a.start);
            let modifiedText = tafsirText;
            for (const rep of ordered) {
                modifiedText = modifiedText.substring(0, rep.start) + rep.formatted + modifiedText.substring(rep.end);
            }

            const all = replacements
                .slice()
                .sort((a, b) => a.start - b.start)
                .map(rep => ({
                    start: rep.start, end: rep.end,
                    original: rep.original, formatted: rep.formatted,
                    confidence: rep.confidence,
                    surahNum: rep.surahNum,
                    surahName: rep.surahName,
                    page: rep.page ?? this.getPage(rep.surahNum, rep.ayahNum),
                    ayahNum: rep.ayahNum,
                    endAyahNum: rep.endAyahNum ?? rep.ayahNum,
                    verseCount: rep.verseCount,
                    isConsecutive: rep.isConsecutive,
                    needsReview: rep.confidence < 80 || !!rep.ambiguous,
                    ambiguous: !!rep.ambiguous,
                    occurrences: rep.occurrences || 1,
                    alternatives: rep.alternatives || null,
                    correctionType: rep.correctionType
                }));

            return {
                modifiedText,
                replacements: all,
                totalVerses: all.reduce((s, r) => s + r.verseCount, 0),
                lowConfidenceCount: all.filter(r => r.needsReview).length,
                ambiguousCount: all.filter(r => r.ambiguous).length,
                averageConfidence: all.length
                    ? Math.round(all.reduce((s, r) => s + r.confidence, 0) / all.length)
                    : 0
            };
        },

        /**
         * A match is only worth emitting when it carries real textual weight.
         *
         * Single-word ayat (the muqaṭṭaʿāt حم، الم، يس، ص، ق، and words such as
         * الرحمن or مدهامتان that form a complete ayah) are far too generic to
         * identify on their own: they appear as ordinary words throughout tafsir
         * prose, and "حم عسق" would otherwise resolve to two unrelated surahs.
         *
         * They are still emitted when part of a longer run — e.g.
         * ﴿الم (١) ذَلِكَ الْكِتَابُ…﴾ — because the surrounding ayah anchors them.
         *
         * @param {object[]} verses
         * @returns {boolean}
         */
        _runHasSubstance(verses) {
            if (!verses || !verses.length) return false;

            let total = 0;
            let hasSubstantialAyah = false;
            for (const v of verses) {
                const n = v.wordCount || U.tokenize(v.verseText || '').length;
                total += n;
                if (n >= this.MIN_VERSE_WORDS) hasSubstantialAyah = true;
            }

            // At least one ayah must stand on its own. Summing word counts is not
            // enough: "حم عسق" is two *separate* one-word ayat (غافر ١ + الشورى ٢)
            // that would otherwise total 2 and slip through.
            return total >= this.MIN_VERSE_WORDS && hasSubstantialAyah;
        },

        _avgConfidence(verses) {
            if (!verses.length) return 0;
            const sum = verses.reduce((s, v) => s + U.clamp(v.confidence, 0, 100), 0);
            return Math.round(U.clamp(sum / verses.length, 0, 100));
        },

        // ===================================================================
        //  Context disambiguation: neighbouring quotes vote on a surah
        // ===================================================================
        resolveAmbiguous(replacements, originalText, outputType) {
            if (replacements.length < 2) return;

            const groups = [];
            for (const rep of replacements) {
                const last = groups[groups.length - 1];
                if (!last || rep.start - last[last.length - 1].end > 200) groups.push([rep]);
                else last.push(rep);
            }

            for (const group of groups) {
                const votes = new Map();
                for (const rep of group) {
                    if (rep.confidence > 90) votes.set(rep.surahNum, (votes.get(rep.surahNum) || 0) + 1);
                }
                if (votes.size === 0) continue;

                let dominant = null, bestVotes = 0;
                for (const [surah, count] of votes) {
                    if (count > bestVotes) { bestVotes = count; dominant = surah; }
                }
                if (dominant == null || bestVotes < 2) continue;

                for (const rep of group) {
                    if (rep.surahNum === dominant) continue;
                    if (rep.confidence >= 100) continue; // already perfect, don't second-guess

                    const { verses } = this.extractVersesFromCandidate(rep.original, outputType, dominant, true);
                    if (!verses.length) continue;

                    const avgConf = this._avgConfidence(verses);
                    if (avgConf <= rep.confidence) continue; // only switch on a strict improvement

                    const newGroups = this.groupConsecutiveVerses(verses);
                    rep.formatted = newGroups.map(g => this.formatGroup(g, outputType)).join('\n');
                    rep.confidence = avgConf;
                    rep.surahNum = verses[0].surahNum;
                    rep.surahName = this.getPlainSurahName(verses[0].surahNum);
                    rep.ayahNum = verses[0].ayahNum;
                    rep.endAyahNum = verses[verses.length - 1].ayahNum;
                    rep.verseCount = verses.length;
                    rep.isConsecutive = newGroups.some(g => g.length > 1);
                    rep.correctionType = 'correct';
                }
            }
        },

        // ===================================================================
        //  Strategy selection for one bracketed candidate
        // ===================================================================
        extractVersesFromCandidate(candidateText, outputType, preferredSurah = null, correctionEnabled = true) {
            const cleaned = this.cleanParentheses(candidateText);
            const tokens = U.tokenize(cleaned);
            if (tokens.length === 0) return { verses: [], correctionUsed: false };

            // A quotation of a single word is never converted, even when it is a
            // complete ayah (حم، الم، يس، ص، ق، الرحمن، مدهامتان…). Such words are
            // indistinguishable from ordinary tafsir prose, so acting on them
            // produces far more noise than value.
            if (tokens.length < this.MIN_VERSE_WORDS) return { verses: [], correctionUsed: false };

            const options = [];
            const add = (verses, coverage, conf, type) => {
                if (!verses || !verses.length) return;
                // Rule: a run must never be built out of one-word ayat alone.
                // "حم عسق" are two separate single-word ayat (غافر ١ / الشورى ٢) and
                // used to be emitted as two references spanning different surahs.
                if (!this._runHasSubstance(verses)) return;
                options.push({ verses, coverage, avgConf: U.clamp(conf, 0, 100), type });
            };

            // 1. Exact multi-verse segmentation (handles "verse1 verse2 verse3").
            // An explicit "..." means the author deliberately cut the quote short,
            // so don't silently restore the words they chose to omit. The marker
            // may be mid-string once a run has already been formatted, e.g.
            // "﴿… (٢) الرَّحْمَنِ ... (٣)﴾" — otherwise re-running would complete it.
            const explicitlyTruncated =
                this.hasTrailingDots(candidateText) || /(?:\.{2,}|…)/.test(candidateText);
            let segmented = this.segmentIntoVerses(
                cleaned, outputType, preferredSurah, !explicitlyTruncated);
            // Nothing aligned exactly — retry allowing dropped/mistyped words
            // inside each ayah (correction mode only).
            if (segmented.length < 2 && correctionEnabled) {
                const repaired = this.segmentIntoVerses(
                    cleaned, outputType, preferredSurah, !explicitlyTruncated, true);
                if (repaired.length > 1) segmented = repaired;
            }
            if (segmented.length > 1 && this._runHasSubstance(segmented)) {
                const wasCompleted = segmented.some(v => v.completed);
                // A completed tail restores words the author omitted, so it only
                // applies in correction mode; an exact chain always applies.
                if (!wasCompleted || correctionEnabled) {
                    add(segmented, 1.0, this._avgConfidence(segmented), 'multi');
                    return { verses: segmented, correctionUsed: wasCompleted };
                }
            }

            // 2. Whole-text exact / prefix match.
            const whole = this.matchWholeText(cleaned, outputType, preferredSurah, candidateText);
            if (whole) add([whole], U.clamp(whole.wordCount / tokens.length, 0, 1), whole.confidence, 'single');

            // 3. Candidate is an exact substring of a verse.
            const sub = this.matchSubstringRobust(cleaned, outputType, preferredSurah, candidateText);
            if (sub) add([sub], 1.0, sub.confidence, 'single');

            const perfect = options.find(o => o.avgConf >= 100 && o.coverage >= 1.0);
            if (perfect) return { verses: perfect.verses, correctionUsed: false };

            const pickBest = () => {
                options.sort((a, b) =>
                    (b.coverage - a.coverage) ||
                    (b.avgConf - a.avgConf) ||
                    (a.type === 'multi' ? 1 : -1));
                return options[0];
            };

            if (!correctionEnabled || tokens.length > this.MAX_CORRECTION_TOKENS) {
                if (!options.length) return { verses: [], correctionUsed: false };
                return { verses: pickBest().verses, correctionUsed: false };
            }

            const good = options.find(o => o.coverage >= 0.9 && o.avgConf >= 80);
            if (good) return { verses: good.verses, correctionUsed: false };

            // 4. Correction strategies (only for short, imperfect candidates).
            const fuzzy = this.matchFuzzy(cleaned, outputType, preferredSurah, candidateText);
            if (fuzzy) add([fuzzy], U.clamp(fuzzy.wordCount / tokens.length, 0, 1), fuzzy.confidence, 'single');

            const ctx = this.matchByContext(cleaned, outputType, preferredSurah, candidateText);
            if (ctx) add([ctx], 1.0, ctx.confidence, 'single');

            const greedy = this.matchMultiVerseGreedy(cleaned, outputType, preferredSurah);
            if (greedy && greedy.length > 1) {
                const conf = this._avgConfidence(greedy);
                const fullCount = greedy.filter(v => !v.isPartial).length;
                // A typo-corrected chain scores ~88, just under MIN_MULTI_CONFIDENCE;
                // accept it when every verse is complete and consecutive.
                const allFull = fullCount === greedy.length;
                if ((conf >= this.MIN_MULTI_CONFIDENCE && fullCount >= 2) ||
                    (allFull && greedy.length >= 2 && conf >= 85)) {
                    add(greedy, 1.0, conf, 'multi');
                }
            }

            if (!options.length) return { verses: [], correctionUsed: false };
            const best = pickBest();
            return { verses: best.verses, correctionUsed: best.type !== 'exact' };
        },

        // ===================================================================
        //  Exact multi-verse segmentation (indexed, linear)
        // ===================================================================
        /**
         * Split the candidate into a chain of complete consecutive verses.
         * Returns [] unless every token is consumed by exact verse matches.
         */
        /**
         * @param {boolean} [allowCompletion=true] when false, a trailing fragment
         *        is not expanded into the full ayah (used when the author wrote an
         *        explicit ellipsis, which signals a deliberate partial quotation).
         */
        /**
         * @param {boolean} [allowCompletion=true] restore words the author omitted
         * @param {boolean} [allowRepair=false] tolerate dropped/mistyped words
         *        *inside* an ayah (correction mode only)
         */
        segmentIntoVerses(text, outputType, preferredSurah = null, allowCompletion = true, allowRepair = false) {
            const tokens = U.tokenize(text);
            if (tokens.length < 2) return [];

            const verses = [];
            let pos = 0;
            let prev = null;
            let budget = this.MAX_CHAIN_EDITS;

            while (pos < tokens.length) {
                let matched = null;
                let completed = false;
                let truncatedTo = 0;
                let edits = 0;
                let consumed = 0;

                // Prefer continuing the current surah with the very next ayah.
                if (prev) {
                    const next = QF.Quran.getNext(prev);
                    if (next && this._tokensStartWith(tokens, pos, next.tokens)) {
                        matched = next;
                        consumed = next.tokens.length;
                    }

                    // Trailing fragment: the quotation stops part-way through the
                    // next ayah (e.g. "…رب العالمين الرحمن" — الرحمن opens الفاتحة ٣).
                    // Continue the run and restore the missing words rather than
                    // matching the fragment as an unrelated verse: "الرحمن" is also
                    // سورة الرحمن ١, which used to hijack the chain.
                    if (!matched && next) {
                        const remaining = tokens.length - pos;
                        if (remaining >= 1 && remaining < next.tokens.length) {
                            let prefixOk = true;
                            for (let i = 0; i < remaining; i++) {
                                if (tokens[pos + i] !== next.tokens[i]) { prefixOk = false; break; }
                            }
                            if (prefixOk) {
                                matched = next;
                                consumed = remaining;
                                if (allowCompletion) completed = true;
                                else truncatedTo = remaining;
                            }
                        }
                    }

                    // Imperfect continuation: words dropped or mistyped inside the
                    // next ayah. Align rather than give up.
                    if (!matched && next && allowRepair && budget > 0) {
                        const cap = Math.min(this.MAX_VERSE_EDITS, budget);
                        const al = this._alignVerse(tokens, pos, next.tokens, cap);
                        if (al) {
                            matched = next;
                            consumed = al.consumed;
                            edits = al.edits;
                            completed = allowCompletion;
                        }
                    }
                }

                if (!matched) {
                    // Anchor on the first token, test only verses that contain it.
                    const bucket = QF.Quran.tokenIndex.get(tokens[pos]);
                    if (!bucket) return [];
                    // Collect every verse that matches, then pick the longest;
                    // ties are broken by surah/ayah context.
                    let bestLen = 0;
                    let tied = [];
                    for (const idx of bucket) {
                        const entry = QF.Quran.dictionary[idx];
                        if (entry.tokens[0] !== tokens[pos]) continue;
                        if (entry.tokens.length < bestLen) continue;
                        if (!this._tokensStartWith(tokens, pos, entry.tokens)) continue;
                        if (entry.tokens.length > bestLen) { bestLen = entry.tokens.length; tied = [entry]; }
                        else tied.push(entry);
                    }
                    if (tied.length) {
                        // Several verses share this opening text (حم starts seven
                        // surahs). Prefer the one whose FOLLOWING ayah continues the
                        // quotation, otherwise "حم والكتاب المبين" anchors on غافر ١
                        // and then splits across two unrelated surahs.
                        matched = this._pickChainable(tied, tokens, pos, preferredSurah);
                        consumed = matched.tokens.length;
                    }
                }

                // Opening ayah quoted with a missing/mistyped word: align against
                // every verse that starts with this word, plus verses whose second
                // word matches (covers a dropped first word).
                if (!matched && allowRepair && budget > 0) {
                    const cap = Math.min(this.MAX_VERSE_EDITS, budget);
                    const seen = new Set();
                    const pool = [];
                    for (let k = 0; k < Math.min(2, tokens.length - pos); k++) {
                        const b = QF.Quran.tokenIndex.get(tokens[pos + k]);
                        if (!b) continue;
                        for (const idx of b) {
                            if (seen.has(idx)) continue;
                            seen.add(idx);
                            const e = QF.Quran.dictionary[idx];
                            // Only consider verses that plausibly *start* here.
                            if (e.tokens[0] === tokens[pos] ||
                                this._tokenSimilar(e.tokens[0], tokens[pos]) ||
                                e.tokens[0] === tokens[pos + k]) pool.push(e);
                        }
                    }
                    let bestAl = null, bestEntry = null, bestRank = -Infinity;
                    for (const e of pool) {
                        const al = this._alignVerse(tokens, pos, e.tokens, cap);
                        if (!al) continue;
                        // Surah context is a preference, not a filter: a tafsir row
                        // on one surah routinely quotes another.
                        const rank = -al.edits * 10 + al.consumed +
                            (preferredSurah && e.surahNum === preferredSurah ? 5 : 0);
                        if (rank > bestRank) { bestRank = rank; bestAl = al; bestEntry = e; }
                    }
                    if (bestEntry) {
                        matched = bestEntry;
                        consumed = bestAl.consumed;
                        edits = bestAl.edits;
                        completed = allowCompletion;
                    }
                }

                if (!matched) return [];
                if (edits > budget) return [];
                budget -= edits;

                const vs = this.makeVerseObj(matched, outputType, '', true, null);
                // Flag verses whose text repeats verbatim elsewhere in the mushaf.
                const dupes = QF.Quran.getExact(matched.normalized);
                if (dupes.length > 1) {
                    vs.ambiguous = true;
                    vs.occurrences = dupes.length;
                    vs.alternatives = dupes.slice(0, 8).map(e => `${e.surahNum}:${e.ayahNum}`);
                }
                if (completed || edits) {
                    // Words were supplied from the mushaf, so this is a correction.
                    vs.completed = true;
                    vs.confidence = edits ? Math.max(85, 95 - edits * 4) : 95;
                } else if (truncatedTo) {
                    // Keep only the words the author actually quoted.
                    const words = outputType === 'uthmani' ? matched.uthmaniWords : matched.imlaiWords;
                    vs.verseText = words.slice(0, truncatedTo).join(' ') + ' ...';
                    vs.isPartial = true;
                    vs.wordCount = truncatedTo;
                }
                verses.push(vs);

                const step = truncatedTo || consumed || matched.tokens.length;
                pos += (completed && !edits && !truncatedTo && step < 1)
                    ? (tokens.length - pos) : step;
                if (step <= 0) return [];
                prev = matched;
            }

            return verses;
        },

        /** True if tokens[pos..] begins with the whole of `seq`. */
        _tokensStartWith(tokens, pos, seq) {
            if (pos + seq.length > tokens.length) return false;
            for (let i = 0; i < seq.length; i++) {
                if (tokens[pos + i] !== seq[i]) return false;
            }
            return true;
        },

        // ===================================================================
        //  Single-verse matching
        // ===================================================================
        /** Strip inline "(3)" verse numbers, nested parentheticals and stray noise. */
        cleanParentheses(text) {
            const stripped = String(text || '')
                .replace(this.VERSE_NUMBER_RE, ' ')
                .replace(/\([^)]*\)/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            return this.stripNoiseTokens(stripped);
        },

        /**
         * Remove tokens that can never be part of a verse: bare verse numbers
         * (٢ / 2 — used as separators inside quotations) and short Latin/OCR
         * garbage. Quranic text contains neither digits nor Latin letters, so
         * this is safe. Falls back to the input if everything would be removed.
         * @param {string} text
         * @returns {string}
         */
        stripNoiseTokens(text) {
            if (!text) return '';
            const parts = text.split(/\s+/).filter(Boolean);
            const kept = [];
            for (const tok of parts) {
                // Ignore decorations when deciding whether a token is noise.
                const core = tok.replace(/[^\u0600-\u06FF0-9\u0660-\u0669a-zA-Z]/g, '');
                if (!core) continue;                                   // pure punctuation
                if (/^[0-9\u0660-\u0669\u06F0-\u06F9]+$/.test(core)) continue; // bare verse number
                if (/^[a-zA-Z]{1,3}$/.test(core)) continue;            // stray latin / OCR noise
                kept.push(tok);
            }
            return kept.length ? kept.join(' ') : text;
        },

        hasTrailingDots(text) { return U.hasTrailingDots(text); },

        matchWholeText(text, outputType, preferredSurah = null, originalCandidate = null) {
            const normalized = U.normalizeArabic(text);
            if (!normalized) return null;

            // Exact hit via hash map — O(1) instead of a 6,236-entry scan.
            const exact = QF.Quran.getExact(normalized);
            if (exact.length) {
                const chosen = this.pickBestOccurrence(exact, preferredSurah);
                const vs = this.makeVerseObj(chosen, outputType, text, true, originalCandidate);
                // 280 verses in the mushaf repeat verbatim (e.g. فبأي آلاء ربكما تكذبان
                // occurs 31×). Flag the reference as uncertain so the UI can warn.
                if (exact.length > 1) {
                    vs.ambiguous = true;
                    vs.occurrences = exact.length;
                    vs.alternatives = exact.slice(0, 8).map(e => `${e.surahNum}:${e.ayahNum}`);
                    if (!this._resolvedByContext) vs.confidence = Math.min(vs.confidence, 92);
                }
                return vs;
            }

            // Prefix match: candidate is the opening words of a verse.
            const tokens = U.tokenize(normalized);
            if (!tokens.length) return null;

            const bucket = QF.Quran.tokenIndex.get(tokens[0]);
            if (!bucket) return null;

            let best = null, bestScore = 0;
            for (const idx of bucket) {
                const entry = QF.Quran.dictionary[idx];
                if (entry.normalized.length <= normalized.length) continue;
                if (!entry.normalized.startsWith(normalized)) continue;
                // must break on a word boundary
                if (entry.normalized[normalized.length] !== ' ') continue;

                const ratio = normalized.length / entry.normalized.length;
                let confidence = ratio >= 0.6 ? 85 : (ratio >= 0.4 ? 75 : 70);
                if (preferredSurah && entry.surahNum === preferredSurah) confidence += this.SURAH_BONUS;
                confidence = U.clamp(confidence, 0, 100);

                if (confidence > bestScore) { bestScore = confidence; best = entry; }
            }

            if (best && bestScore >= this.MIN_PREFIX_CONFIDENCE) {
                const vs = this.makeVerseObj(best, outputType, text, false, originalCandidate);
                vs.confidence = bestScore;
                return vs;
            }

            return this.matchBySkeleton(normalized, outputType, preferredSurah, originalCandidate, text);
        },

        /**
         * Last-resort match that ignores the imlā'ī/ʿUthmānī spelling split.
         *
         * ʿUthmānī drops the alef that modern spelling writes (ٱلصَّلَوٰةَ vs الصلاة,
         * يَٰٓأَيُّهَا vs يا أيها), and the dagger alef marking it is stripped as a
         * diacritic. Comparing skeletons — long vowels and hamza carriers removed —
         * reunites the two scripts.
         *
         * Only reached after exact, alias and prefix matching have all failed.
         *
         * @returns {object|null}
         */
        matchBySkeleton(normalized, outputType, preferredSurah, originalCandidate, rawText) {
            const skel = U.skeleton(normalized);
            if (!skel || skel.length < 4) return null;

            const hits = QF.Quran.getBySkeleton(skel);
            if (!hits.length) return null;

            const chosen = this.pickBestOccurrence(hits, preferredSurah);
            const vs = this.makeVerseObj(chosen, outputType, rawText, true, originalCandidate);
            // The spelling differed, so this is a script conversion rather than a
            // verbatim hit: report slightly below certainty.
            vs.confidence = 97;
            if (hits.length > 1) {
                vs.ambiguous = true;
                vs.occurrences = hits.length;
                vs.alternatives = hits.slice(0, 8).map(e => `${e.surahNum}:${e.ayahNum}`);
                if (!this._resolvedByContext) vs.confidence = 92;
            }
            return vs;
        },

        /**
         * Does an existing "[…]" tag cite the verses we just matched?
         *
         * Compares the surah name (ignoring tashkeel and the word سورة) and, when
         * the tag carries ayah numbers, checks they overlap the matched range.
         * Anything else is left alone — a stray bracket must never be deleted.
         *
         * @param {string} tag raw tag text including the brackets
         * @param {object[]} verses matched verses
         * @returns {boolean}
         */
        _tagCitesVerses(tag, verses) {
            if (!verses || !verses.length) return false;
            const inner = tag.replace(/^[\s\r\n]*\[/, '').replace(/\]\s*$/, '');
            const norm = U.normalizeArabic(inner).replace(/\bسوره\b/g, '').trim();
            if (!norm) return false;

            const expected = U.normalizeArabic(this.getPlainSurahName(verses[0].surahNum));
            if (!expected || norm.indexOf(expected) === -1) return false;

            // Ayah numbers are optional; when present they must overlap.
            const nums = (norm.match(/\d+/g) || []).map(Number);
            if (!nums.length) return true;

            const first = verses[0].ayahNum;
            const last = verses[verses.length - 1].ayahNum;
            return nums.some(n => n >= first && n <= last);
        },

        /**
         * Choose among equally-matching verses by looking one ayah ahead.
         *
         * When the quotation continues past this verse, the right occurrence is
         * the one whose next ayah matches what follows. Falls back to the normal
         * surah/ayah context when lookahead cannot decide.
         *
         * @param {object[]} tied candidates that all match at `pos`
         * @param {string[]} tokens full candidate token list
         * @param {number} pos offset already consumed
         * @param {number|null} preferredSurah
         * @returns {object}
         */
        _pickChainable(tied, tokens, pos, preferredSurah) {
            if (tied.length === 1) return tied[0];

            const after = pos + tied[0].tokens.length;
            if (after < tokens.length) {
                const chainable = [];
                for (const entry of tied) {
                    const next = QF.Quran.getNext(entry);
                    if (!next) continue;
                    const rest = tokens.length - after;
                    // Either the next ayah is quoted in full, or the quote stops
                    // part-way through it (a truncated tail).
                    const full = this._tokensStartWith(tokens, after, next.tokens);
                    let prefix = false;
                    if (!full && rest < next.tokens.length) {
                        prefix = true;
                        for (let i = 0; i < rest; i++) {
                            if (tokens[after + i] !== next.tokens[i]) { prefix = false; break; }
                        }
                    }
                    if (full || prefix) chainable.push(entry);
                }
                if (chainable.length) return this.pickBestOccurrence(chainable, preferredSurah);
            }
            return this.pickBestOccurrence(tied, preferredSurah);
        },

        /**
         * Choose between several verses carrying identical text.
         * Prefers the caller's surah, then the ayah closest to the row's own
         * ayah number (tafsir rows usually quote the verse they comment on).
         * @param {object[]} entries
         * @param {number|null} preferredSurah
         */
        pickBestOccurrence(entries, preferredSurah) {
            this._resolvedByContext = false;
            if (entries.length === 1) return entries[0];

            let pool = entries;
            if (preferredSurah) {
                const inSurah = entries.filter(e => e.surahNum === preferredSurah);
                if (inSurah.length) {
                    pool = inSurah;
                    this._resolvedByContext = true;
                }
            }
            if (pool.length === 1) return pool[0];

            const ctxAyah = this._ctxAyah;
            if (ctxAyah) {
                let best = pool[0], bestDist = Infinity;
                for (const e of pool) {
                    const d = Math.abs(e.ayahNum - ctxAyah);
                    if (d < bestDist) { bestDist = d; best = e; }
                }
                // Only trust the ayah hint when it is genuinely close.
                if (bestDist <= 3) { this._resolvedByContext = true; return best; }
            }
            return pool[0];
        },

        /** Candidate appears verbatim somewhere inside a verse. */
        matchSubstringRobust(text, outputType, preferredSurah = null, originalCandidate = null) {
            const candNorm = U.normalizeArabic(text);
            const candTokens = U.tokenize(candNorm);
            if (candTokens.length < 2) return null;

            // Alias entries are indexed with their original word boundaries, so
            // probe them with an unjoined copy of the query.
            const rawNorm = U.normalizeArabic(text, { joinPrefixes: false });
            const rawTokens = rawNorm === candNorm
                ? candTokens : rawNorm.split(' ').filter(Boolean);

            // May be absent when the quote is ʿUthmānī and the index imlā'ī —
            // don't bail out, the skeleton fallback below can still resolve it.
            const bucket = QF.Quran.tokenIndex.get(candTokens[0]) || [];

            let bestEntry = null, bestStart = -1, aliasLen = 0, skeletonMatch = false;
            const aliasHits = [];
            for (const idx of bucket) {
                const entry = QF.Quran.dictionary[idx];
                if (entry.tokens.length >= candTokens.length) {
                    const start = this._findTokenRun(entry.tokens, candTokens);
                    if (start !== -1) {
                        if (preferredSurah && entry.surahNum === preferredSurah) { bestEntry = entry; bestStart = start; break; }
                        if (!bestEntry) { bestEntry = entry; bestStart = start; }
                        continue;
                    }
                }
                // Fall back to the alternate spelling (corrupt notashkil source).
                if (entry.aliasTokens && entry.aliasTokens.length >= rawTokens.length) {
                    const aStart = this._findTokenRun(entry.aliasTokens, rawTokens);
                    if (aStart !== -1) aliasHits.push({ entry, start: aStart, len: rawTokens.length });
                }
            }
            if (!bestEntry && aliasHits.length) {
                const pick = aliasHits.find(h => preferredSurah && h.entry.surahNum === preferredSurah) || aliasHits[0];
                bestEntry = pick.entry;
                // Alias and canonical token arrays are word-aligned (same length),
                // so the index maps directly onto the display words.
                bestStart = pick.start;
                aliasLen = pick.len;
            }
            // Still nothing: the fragment may be ʿUthmānī while the verse is
            // indexed from its imlā'ī spelling (ٱلصَّلَوٰةَ vs الصلاة). Retry on
            // skeletons, which are script-neutral.
            if (!bestEntry) {
                const candSkel = candTokens.map(t => U.skeleton(t)).filter(Boolean);
                if (candSkel.length === candTokens.length && candSkel.join('').length >= 4) {
                    const seen = new Set();
                    for (const tok of candSkel) {
                        const b = QF.Quran.skeletonTokenIndex.get(tok);
                        if (!b) continue;
                        for (const idx of b) {
                            if (seen.has(idx)) continue;
                            seen.add(idx);
                            const entry = QF.Quran.dictionary[idx];
                            if (!entry.skeletonTokens ||
                                entry.skeletonTokens.length < candSkel.length) continue;
                            const start = this._findTokenRun(entry.skeletonTokens, candSkel);
                            if (start === -1) continue;
                            if (preferredSurah && entry.surahNum === preferredSurah) {
                                bestEntry = entry; bestStart = start; break;
                            }
                            if (!bestEntry) { bestEntry = entry; bestStart = start; }
                        }
                        if (bestEntry && preferredSurah && bestEntry.surahNum === preferredSurah) break;
                    }
                    if (bestEntry) skeletonMatch = true;
                }
            }
            if (!bestEntry) return null;

            const words = outputType === 'uthmani' ? bestEntry.uthmaniWords : bestEntry.imlaiWords;
            const span = aliasLen || candTokens.length;
            let displayText = words.slice(bestStart, bestStart + span).join(' ');
            const partial = span !== bestEntry.tokens.length;
            if (partial && this.hasTrailingDots(originalCandidate || text)) displayText += ' ...';

            const result = {
                surahNum: bestEntry.surahNum,
                ayahNum: bestEntry.ayahNum,
                verseText: displayText,
                confidence: skeletonMatch ? 97 : 100,
                isPartial: partial,
                wordCount: span
            };

            // Whole-verse hit whose text repeats elsewhere: mark for review.
            if (!partial) {
                const dupes = QF.Quran.getExact(bestEntry.normalized);
                if (dupes.length > 1) {
                    const chosen = this.pickBestOccurrence(dupes, preferredSurah);
                    result.surahNum = chosen.surahNum;
                    result.ayahNum = chosen.ayahNum;
                    result.ambiguous = true;
                    result.occurrences = dupes.length;
                    result.alternatives = dupes.slice(0, 8).map(e => `${e.surahNum}:${e.ayahNum}`);
                    if (!this._resolvedByContext) result.confidence = 92;
                }
            }
            return result;
        },

        /** Index of the first contiguous occurrence of `needle` inside `hay`, else -1. */
        _findTokenRun(hay, needle) {
            const limit = hay.length - needle.length;
            outer:
            for (let i = 0; i <= limit; i++) {
                for (let j = 0; j < needle.length; j++) {
                    if (hay[i + j] !== needle[j]) continue outer;
                }
                return i;
            }
            return -1;
        },

        /** Fuzzy window match, restricted to index-selected candidate verses. */
        matchFuzzy(text, outputType, preferredSurah = null, originalCandidate = null, customThreshold = null) {
            const threshold = customThreshold || this.MIN_FUZZY_CONFIDENCE;
            const tokens = U.tokenize(text);
            const total = tokens.length;
            if (total < 2) return null;

            const candidateStr = tokens.join(' ');
            const pool = preferredSurah
                ? QF.Quran.getSurah(preferredSurah)
                : QF.Quran.getCandidateEntries(tokens, this.MAX_FUZZY_CANDIDATES, preferredSurah);
            if (!pool.length) return null;

            let bestEntry = null, bestScore = 0, bestStart = -1;

            for (const entry of pool) {
                const et = entry.tokens;
                if (et.length < total) continue;
                for (let i = 0; i <= et.length - total; i++) {
                    let windowText = '';
                    for (let k = 0; k < total; k++) windowText += (k ? ' ' : '') + et[i + k];

                    // Cheap length filter before the expensive distance computation.
                    if (Math.abs(windowText.length - candidateStr.length) > candidateStr.length * 0.4) continue;

                    let score = this.computeSimilarity(candidateStr, windowText) * 100;
                    if (score + 12 < bestScore) continue;
                    if (U.levenshtein(candidateStr, windowText, 2) <= 2 && total >= 2) score += 10;
                    score = U.clamp(score, 0, 100);

                    if (score > bestScore) { bestScore = score; bestEntry = entry; bestStart = i; }
                }
            }

            if (!bestEntry || bestScore < threshold) return null;

            const words = outputType === 'uthmani' ? bestEntry.uthmaniWords : bestEntry.imlaiWords;
            let displayText = words.slice(bestStart, bestStart + total).join(' ');
            const partial = total !== bestEntry.tokens.length;
            if (partial && this.hasTrailingDots(originalCandidate || text)) displayText += ' ...';

            return {
                surahNum: bestEntry.surahNum,
                ayahNum: bestEntry.ayahNum,
                verseText: displayText,
                confidence: Math.round(bestScore),
                isPartial: partial,
                wordCount: total
            };
        },

        /** Blended Jaccard + edit-distance similarity in [0,1]. */
        computeSimilarity(a, b) {
            if (a === b) return 1;
            const tokensA = a.split(' '), tokensB = b.split(' ');
            const setA = new Set(tokensA), setB = new Set(tokensB);
            let common = 0;
            for (const t of setA) if (setB.has(t)) common++;
            const union = setA.size + setB.size - common;
            const jaccard = union ? common / union : 0;
            const levSim = U.levenshteinRatio(a, b);
            return (jaccard * 0.5) + (levSim * 0.5);
        },

        // ===================================================================
        //  Context-based correction (split / missing / substituted word)
        // ===================================================================
        matchByContext(text, outputType, preferredSurah = null, originalCandidate = null) {
            const tokens = U.tokenize(text);
            if (tokens.length < 2) return null;
            if (!QF.Quran.contextIndex || QF.Quran.contextIndex.size === 0) return null;

            // (a) a word was wrongly glued together — try splitting it
            for (let p = 0; p < tokens.length; p++) {
                const token = tokens[p];
                if (token.length < 5) continue;
                for (let s = 2; s <= token.length - 2; s++) {
                    const a = token.substring(0, s), b = token.substring(s);
                    if (!QF.Quran.tokenIndex.has(a) || !QF.Quran.tokenIndex.has(b)) continue;
                    const newTokens = [...tokens.slice(0, p), a, b, ...tokens.slice(p + 1)];
                    const r = this.findContextMatch(newTokens, outputType, originalCandidate || text, preferredSurah);
                    if (r) return r;
                }
            }

            // (a2) a word was wrongly split apart (e.g. "و اياك" -> "واياك")
            for (let p = 0; p < tokens.length - 1; p++) {
                const joined = tokens[p] + tokens[p + 1];
                if (!QF.Quran.tokenIndex.has(joined)) continue;
                const newTokens = [...tokens.slice(0, p), joined, ...tokens.slice(p + 2)];
                const merged = newTokens.join(' ');

                // Try the repaired string as a whole verse or verse fragment.
                const exact = QF.Quran.getExact(merged);
                if (exact.length) {
                    const chosen = this.pickBestOccurrence(exact, preferredSurah);
                    const vs = this.makeVerseObj(chosen, outputType, merged, true, originalCandidate || text);
                    vs.confidence = 95;
                    return vs;
                }
                const subHit = this.matchSubstringRobust(merged, outputType, preferredSurah, originalCandidate || text);
                if (subHit) { subHit.confidence = Math.min(subHit.confidence, 95); return subHit; }

                const r = this.findContextMatch(newTokens, outputType, originalCandidate || text, preferredSurah);
                if (r) return r;
            }

            // (b) a word is missing
            for (let i = 1; i < tokens.length; i++) {
                const r = this.findContextMatchWithMissing(
                    tokens.slice(0, i), tokens.slice(i), tokens, outputType, originalCandidate || text, preferredSurah);
                if (r) return r;
            }

            // (c) a word was replaced by a similar one
            for (let i = 1; i < tokens.length - 1; i++) {
                const r = this.findContextMatchWithSubstitution(
                    tokens.slice(0, i), tokens.slice(i + 1), tokens, i, outputType, originalCandidate || text, preferredSurah);
                if (r) return r;
            }

            return null;
        },

        findContextMatch(tokens, outputType, originalText, preferredSurah) {
            for (let i = 1; i < tokens.length; i++) {
                const r = this.findContextMatchWithMissing(
                    tokens.slice(0, i), tokens.slice(i), tokens, outputType, originalText, preferredSurah);
                if (r) return r;
            }
            return null;
        },

        findContextMatchWithMissing(leftTokens, rightTokens, allTokens, outputType, originalText, preferredSurah) {
            if (!leftTokens.length || !rightTokens.length) return null;

            const leftMatches = this.findSequenceInVerses(leftTokens, 'forward', preferredSurah);
            if (!leftMatches.length) return null;
            const rightMatches = this.findSequenceInVerses(rightTokens, 'backward', preferredSurah);
            if (!rightMatches.length) return null;

            const rightByKey = new Map();
            for (const rm of rightMatches) rightByKey.set(rm.surahNum + ':' + rm.ayahNum + ':' + rm.firstWordIdx, rm);

            let best = null;
            for (const lm of leftMatches) {
                const rm = rightByKey.get(lm.surahNum + ':' + lm.ayahNum + ':' + (lm.lastWordIdx + 2));
                if (!rm) continue;
                const entry = QF.Quran.getVerseEntry(lm.surahNum, lm.ayahNum);
                if (!entry) continue;
                const missingIdx = lm.lastWordIdx + 1;
                if (missingIdx >= entry.tokens.length) continue;

                const score = (lm.coverage + rm.coverage) / 2;
                if (!best || score > best.score) {
                    best = {
                        word: entry.tokens[missingIdx],
                        surahNum: lm.surahNum, ayahNum: lm.ayahNum,
                        wordIdx: missingIdx, score,
                        startIdx: lm.firstWordIdx, endIdx: rm.lastWordIdx
                    };
                }
            }
            if (!best) return null;
            return this.buildCorrectedOutput(best, outputType, originalText, preferredSurah);
        },

        findContextMatchWithSubstitution(leftTokens, rightTokens, allTokens, suspectIdx, outputType, originalText, preferredSurah) {
            const result = this.findContextMatchWithMissing(
                leftTokens, rightTokens, allTokens, outputType, originalText, preferredSurah);
            if (!result || typeof result !== 'object') return null;

            const entry = QF.Quran.getVerseEntry(result.surahNum, result.ayahNum);
            if (!entry) return null;

            const leftMatches = this.findSequenceInVerses(leftTokens, 'forward', preferredSurah);
            let candidateWord = null;
            for (const lm of leftMatches) {
                if (lm.surahNum !== result.surahNum || lm.ayahNum !== result.ayahNum) continue;
                candidateWord = entry.tokens[lm.lastWordIdx + 1];
                if (candidateWord) break;
            }
            if (!candidateWord) return null;

            const originalWord = allTokens[suspectIdx];
            return U.levenshteinRatio(originalWord, candidateWord) >= 0.5 ? result : null;
        },

        buildCorrectedOutput(best, outputType, originalText) {
            const entry = QF.Quran.getVerseEntry(best.surahNum, best.ayahNum);
            if (!entry) return null;

            const words = outputType === 'uthmani' ? entry.uthmaniWords : entry.imlaiWords;
            const coversFull = best.startIdx === 0 && best.endIdx === words.length - 1;
            const trailing = this.hasTrailingDots(originalText);

            let verseText;
            if (coversFull && !trailing) {
                verseText = words.join(' ');
            } else {
                verseText = words.slice(best.startIdx, best.endIdx + 1).join(' ');
                if (trailing) verseText += ' ...';
            }

            return {
                surahNum: best.surahNum,
                ayahNum: best.ayahNum,
                verseText,
                confidence: U.clamp(Math.round(best.score * 100), 0, 100),
                isPartial: !coversFull || trailing,
                wordCount: best.endIdx - best.startIdx + 1
            };
        },

        /** Find in-order (gapped) occurrences of a token sequence inside verses. */
        findSequenceInVerses(tokens, direction, preferredSurah) {
            if (!tokens.length) return [];
            const results = [];
            const occurrences = QF.Quran.contextIndex.get(tokens[0]) || [];

            for (const occ of occurrences) {
                if (preferredSurah && occ.surahNum !== preferredSurah) continue;
                const entry = QF.Quran.getVerseEntry(occ.surahNum, occ.ayahNum);
                if (!entry) continue;

                const verseTokens = entry.tokens;
                let cur = occ.wordIdx;
                let ok = true;
                const positions = [cur];

                for (let i = 1; i < tokens.length; i++) {
                    cur++;
                    while (cur < verseTokens.length && verseTokens[cur] !== tokens[i]) cur++;
                    if (cur >= verseTokens.length) { ok = false; break; }
                    positions.push(cur);
                }
                if (!ok) continue;

                const firstIdx = positions[0];
                const lastIdx = positions[positions.length - 1];
                const coverage = tokens.length / (lastIdx - firstIdx + 1);

                if (direction === 'forward') {
                    if (lastIdx + 1 < verseTokens.length) {
                        results.push({ surahNum: occ.surahNum, ayahNum: occ.ayahNum, firstWordIdx: firstIdx, lastWordIdx: lastIdx, nextWordIdx: lastIdx + 1, coverage });
                    }
                } else if (firstIdx - 1 >= 0) {
                    results.push({ surahNum: occ.surahNum, ayahNum: occ.ayahNum, firstWordIdx: firstIdx, lastWordIdx: lastIdx, prevWordIdx: firstIdx - 1, coverage });
                }
            }
            return results;
        },

        // ===================================================================
        //  Greedy multi-verse (anchored, fuzzy tail) — the old hot spot
        // ===================================================================
        /**
         * Chain consecutive verses starting from index-selected anchors.
         * Old version: full cross-product over 114 surahs (~100s).
         * New version: anchors on the first token, walks ayah+1 (~milliseconds).
         */
        matchMultiVerseGreedy(text, outputType, preferredSurah = null) {
            const tokens = U.tokenize(text);
            if (tokens.length < 4) return null;

            // Seed verses: those whose first token equals our first token.
            const seeds = [];
            const seen = new Set();
            const addSeed = entry => {
                if (preferredSurah && entry.surahNum !== preferredSurah) return;
                const key = entry.surahNum + ':' + entry.ayahNum;
                if (seen.has(key)) return;
                seen.add(key);
                seeds.push(entry);
            };

            const bucket = QF.Quran.tokenIndex.get(tokens[0]);
            if (bucket) {
                for (const idx of bucket) {
                    const entry = QF.Quran.dictionary[idx];
                    if (entry.tokens[0] === tokens[0]) addSeed(entry);
                }
            }

            // The very first word may itself be misspelled — seed from the second
            // word too, keeping only verses whose opening word is a near match.
            if (tokens.length > 1) {
                const b2 = QF.Quran.tokenIndex.get(tokens[1]);
                if (b2) {
                    for (const idx of b2) {
                        const entry = QF.Quran.dictionary[idx];
                        if (entry.tokens[1] !== tokens[1]) continue;
                        if (this._tokenSimilar(entry.tokens[0], tokens[0])) addSeed(entry);
                    }
                }
            }
            if (!seeds.length) return null;

            let bestChain = null, bestScore = -1;

            for (const seed of seeds) {
                const chain = [];
                let pos = 0;
                let entry = seed;
                let scoreSum = 0;
                let typos = 0;

                while (entry && pos < tokens.length) {
                    const et = entry.tokens;
                    const remaining = tokens.length - pos;

                    if (remaining >= et.length) {
                        // Compare the whole verse, tolerating near-miss words
                        // (OCR/typo) rather than demanding an exact run.
                        const near = this._compareRun(tokens, pos, et);
                        if (near && typos + near.typos <= this.MAX_CHAIN_TYPOS) {
                            typos += near.typos;
                            const vs = this.makeVerseObj(entry, outputType, '', true, null);
                            vs.confidence = near.typos ? 88 : 100;
                            chain.push(vs);
                            scoreSum += vs.confidence;
                            pos += et.length;
                            entry = QF.Quran.getNext(entry);
                            continue;
                        }
                    }

                    // Allow the final verse to be a partial (prefix) quotation.
                    if (remaining < et.length && remaining >= 2) {
                        const near = this._compareRun(tokens, pos, et.slice(0, remaining));
                        if (near && typos + near.typos <= this.MAX_CHAIN_TYPOS) {
                            typos += near.typos;
                            const words = outputType === 'uthmani' ? entry.uthmaniWords : entry.imlaiWords;
                            const conf = near.typos ? 85 : 90;
                            chain.push({
                                surahNum: entry.surahNum, ayahNum: entry.ayahNum,
                                verseText: words.slice(0, remaining).join(' '),
                                confidence: conf, isPartial: true, wordCount: remaining
                            });
                            scoreSum += conf;
                            pos = tokens.length;
                        }
                    }
                    break;
                }

                if (pos === tokens.length && chain.length > 1) {
                    const avg = scoreSum / chain.length;
                    // Prefer longer chains, then cleaner ones.
                    const score = avg + chain.length * 2 - typos * 5;
                    if (score > bestScore) { bestScore = score; bestChain = chain; }
                }
            }

            return bestChain;
        },

        /**
         * Word-level alignment of a quotation against a full ayah.
         *
         * Unlike `_compareRun` (positional, substitutions only) this tolerates
         * words the author dropped — "الحمد رب العالمين" is missing "لله" — as
         * well as extra or mistyped words. Uses a banded edit-distance DP over
         * tokens with an early-exit budget, so it stays cheap.
         *
         * @param {string[]} tokens   candidate words
         * @param {number}   pos      offset into `tokens`
         * @param {string[]} verse    the ayah's words
         * @param {number}   maxEdits budget
         * @returns {{consumed:number, edits:number}|null}
         *          `consumed` = how many candidate words the ayah accounts for
         */
        _alignVerse(tokens, pos, verse, maxEdits) {
            const avail = tokens.length - pos;
            if (avail <= 0) return null;
            const vn = verse.length;
            // The quote may stop early, but never covers more words than the ayah.
            const maxTake = Math.min(avail, vn + maxEdits);
            if (maxTake <= 0) return null;

            const INF = 99;
            // dp[i][j] = edits to align first i candidate words with first j verse words
            let prev = new Int32Array(vn + 1);
            for (let j = 0; j <= vn; j++) prev[j] = j;      // deletions from the verse
            let curr = new Int32Array(vn + 1);

            let best = null;
            for (let i = 1; i <= maxTake; i++) {
                curr[0] = i;
                let rowMin = i;
                const a = tokens[pos + i - 1];
                for (let j = 1; j <= vn; j++) {
                    const b = verse[j - 1];
                    let sub = prev[j - 1] + (a === b ? 0 : (this._tokenSimilar(a, b) ? 1 : INF));
                    const del = prev[j] + 1;   // verse word omitted by the author
                    const ins = curr[j - 1] + 1; // extra word in the quotation
                    const v = Math.min(sub, del, ins);
                    curr[j] = v > INF ? INF : v;
                    if (curr[j] < rowMin) rowMin = curr[j];
                }
                // Consuming i candidate words completes the whole ayah.
                if (curr[vn] <= maxEdits) {
                    if (!best || curr[vn] < best.edits ||
                        (curr[vn] === best.edits && i > best.consumed)) {
                        best = { consumed: i, edits: curr[vn] };
                    }
                }
                if (rowMin > maxEdits) break;  // no viable alignment remains
                const tmp = prev; prev = curr; curr = tmp;
            }
            return best;
        },

        /**
         * Compare tokens[pos..] against `seq`, allowing a small number of
         * near-miss words (single-character OCR slips such as العلمين/العالمين).
         * @returns {{typos:number}|null} null when the run is not a plausible match
         */
        _compareRun(tokens, pos, seq) {
            let typos = 0;
            for (let i = 0; i < seq.length; i++) {
                const a = tokens[pos + i], b = seq[i];
                if (a === b) continue;
                if (!this._tokenSimilar(a, b)) return null;
                if (++typos > this.MAX_CHAIN_TYPOS) return null;
            }
            return { typos };
        },

        /** True when two words differ by a plausible OCR-level slip. */
        _tokenSimilar(a, b) {
            if (!a || !b) return false;
            if (a === b) return true;
            const len = Math.max(a.length, b.length);
            if (len < 4) return false;                 // too short to judge safely
            if (Math.abs(a.length - b.length) > 2) return false;
            const d = U.levenshtein(a, b, 2);
            return d <= (len >= 7 ? 2 : 1);
        },

        getDisplayTextFromWindow(entry, outputType, matchTokens, windowStart) {
            const words = outputType === 'uthmani' ? entry.uthmaniWords : entry.imlaiWords;
            return words.slice(windowStart, windowStart + matchTokens.length).join(' ');
        },

        // ===================================================================
        //  Verse object construction & output formatting
        // ===================================================================
        makeVerseObj(entry, outputType, text, isFull, originalCandidate) {
            const words = outputType === 'uthmani' ? entry.uthmaniWords : entry.imlaiWords;
            const vs = {
                surahNum: entry.surahNum,
                ayahNum: entry.ayahNum,
                verseText: '',
                confidence: 100,
                isPartial: !isFull,
                wordCount: isFull ? entry.tokens.length : 0
            };

            if (isFull) {
                vs.verseText = words.join(' ');
            } else {
                vs.verseText = this.getDisplayText(entry, outputType, text);
                vs.wordCount = vs.verseText.split(/\s+/).filter(Boolean).length;
            }

            if (originalCandidate && this.hasTrailingDots(originalCandidate)) {
                vs.isPartial = true;
                if (!/\.\.\.$/.test(vs.verseText)) vs.verseText += ' ...';
            }
            return vs;
        },

        getDisplayText(entry, outputType, originalText) {
            const matchTokens = U.tokenize(originalText);
            const words = outputType === 'uthmani' ? entry.uthmaniWords : entry.imlaiWords;
            if (!matchTokens.length) return words.join(' ');

            const start = this._findTokenRun(entry.tokens, matchTokens);
            if (start === -1) return words.slice(0, Math.min(matchTokens.length, words.length)).join(' ');
            return words.slice(start, start + matchTokens.length).join(' ');
        },

        groupConsecutiveVerses(verses) {
            if (!verses.length) return [];
            const groups = [];
            let cur = [verses[0]];
            for (let i = 1; i < verses.length; i++) {
                const prev = cur[cur.length - 1], v = verses[i];
                if (v.surahNum === prev.surahNum && v.ayahNum === prev.ayahNum + 1 && !prev.isPartial) {
                    cur.push(v);
                } else {
                    groups.push(cur); cur = [v];
                }
            }
            groups.push(cur);
            return groups;
        },

        formatGroup(group, outputType) {
            const d = n => U.toArabicDigits(n);
            const name = num => this.getSurahName(num);
            if (group.length === 1) {
                const v = group[0];
                return `\uFD3F${v.verseText || ''}\uFD3E [${name(v.surahNum)}: ${d(v.ayahNum)}]`;
            }
            const parts = group.map(v => `${v.verseText} (${d(v.ayahNum)})`);
            const first = group[0], last = group[group.length - 1];
            return `\uFD3F${parts.join(' ')}\uFD3E [${name(first.surahNum)}: ` +
                   `${d(first.ayahNum)}${this.RANGE_SEPARATOR}${d(last.ayahNum)}]`;
        },

        /**
         * @param {number} num surah number
         * @param {boolean} [vocalised] override the VOCALISED_NAMES setting
         */
        getSurahName(num, vocalised) {
            const useTashkeel = vocalised === undefined ? this.VOCALISED_NAMES : vocalised;
            if (useTashkeel && SURAH_NAMES_TASHKEEL[num]) return SURAH_NAMES_TASHKEEL[num];
            return SURAH_NAMES[num] || `سورة ${num}`;
        },

        /** Plain (unvocalised) surah name — used for report columns and search. */
        getPlainSurahName(num) { return SURAH_NAMES[num] || `سورة ${num}`; },

        /**
         * Mushaf page (1–604) for an ayah, or null when the dataset omits it.
         * @param {number} surahNum
         * @param {number} ayahNum
         * @returns {number|null}
         */
        getPage(surahNum, ayahNum) {
            const e = QF.Quran.getVerseEntry(surahNum, ayahNum);
            return (e && e.page) || null;
        }
    };
})(QuranFormatter);
