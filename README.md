# المُنسِق — Quran Verse Formatter (Enhanced)

تنسيق وتدقيق الآيات القرآنية داخل نصوص التفسير، مع دعم قواعد بيانات SQLite.

---

## The headline fix

The original engine took **90–110 seconds per multi-verse quotation**. A single
tafsir row containing `(مالك يوم الدين اياك نعبد واياك نستعين)` would freeze the
browser tab for over a minute.

| Benchmark | Before | After | Change |
|---|---|---|---|
| 6 mixed candidates | **200,395 ms** | **6 ms** | **~33,000× faster** |
| 2,000-row database (end-to-end, in-browser) | *hours (projected)* | **0.5 s** | usable |
| 400 quotes in one text | — | 21 ms | — |
| Max reported confidence | **147 %** (impossible) | 100 % | correctness fix |

**Root cause.** `matchMultiVerseGreedy` looped over all 114 surahs × every verse ×
every substring length × every window position, and called `QF.Utils.tokenize()`
on each verse *inside* the innermost loop — re-splitting the same strings millions
of times. It is now anchored on an inverted token index and walks `ayah + 1`
directly, so it is effectively linear.

---

## Accuracy work (second pass)

After the speed fix I stress-tested matching against the whole mushaf and found
three real accuracy problems. All are now fixed.

| Metric (simulated tafsir rows, whole mushaf) | Before | After |
|---|---|---|
| Correct surah **and** ayah | 94.77 % | **100 %** |
| Wrong references | 0 | **0** |
| Missed verses | 8 | **0** |
| False positives on scholarly prose | 0 / 6 | **0 / 6** |
| Unstable re-runs (idempotence) | 0 | **0** |

### 1. Your `quran.json` is corrupt — 156 verses
This is worth knowing about independently of this refactor. The `ayah_notashkil`
field has **156 verses where a word is truncated**, and the original engine built its
entire search index from that field:

```
2:117  imlai     : بَدِيعُ السَّمَاوَاتِ وَالْأَرْضِ وَإِذَا قَضَى أَمْرًا…
       notashkil : بديع السماوات و واذا قضى امرا…     ← "والأرض" collapsed to "و"
```

Also affected: 6:73, 10:31, 13:16, 15:85, 21:19, 57:10 and 150 others. Word counts
still match, so it's silent truncation rather than deletion — easy to miss.

**Fix:** the index is now derived from the intact `ayah_imlai` and normalised in-house.
The corrupt spelling is retained as a searchable *alias*, so text copied from the bad
field still resolves. No verses were lost either way — zero regressions in the diff.

### 2. Repeated verses are now disambiguated, not guessed
**280 verses repeat verbatim** in the Quran — `فبأي آلاء ربكما تكذبان` appears **31 times**.
No amount of text analysis can tell those apart, and the old code silently returned
whichever came first (so 55:47 was reported as 55:13).

Two changes:
- `processText` accepts `{surah, ayah}` as well as a bare surah number, and the app
  now passes each row's own **`AyahID`** — the column was already in your schema but
  went unused. Verified: two identical `فبأي آلاء` rows correctly resolve to ٤٧ and ١٣.
- When a quote is genuinely ambiguous it is **flagged** (`ambiguous`, `occurrences`,
  `alternatives`), shown as a `⚠ متكرر ×31` badge, counted in a new **مواضع متكررة**
  stat, filterable via *مواضع متكررة (تحتاج مراجعة)*, and marked `needsReview` so it
  can't be bulk-approved unseen. Confidence drops to 92 % only when context can't resolve it.

### 3. Two smaller matching fixes
- **Split words** (`اياك نعبد و اياك نستعين`, common in OCR) are now rejoined — previously matched nothing, now resolves to الفاتحة: ٥ at 95 %.
- **Muqaṭṭaʿāt**: single-token verses (`حم`, `الم`, `ص`, `ق`) were rejected by a hard `tokens < 2` guard. They now match on an exact whole-verse hit only — so `حم` resolves, while a lone ordinary word like `الكتاب` is still correctly ignored.

---

## Reported cases (third pass)

Five inputs that were being skipped or formatted awkwardly. All fixed and locked
into the test suite.

| Input | Before | After |
|---|---|---|
| `﴿…الْعَالَمِينَ ٢ الرَّحْمَنِ الرَّحِيمِ ٣﴾` | unchanged | `﴿… (٢) … (٣)﴾ [الفاتحة: ٢–٣]` |
| `(الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ ٢)` | unchanged | `﴿…﴾ [الفاتحة: ٢]` |
| `(الحمد لله رب العالمين k)` | unchanged | `﴿…﴾ [الفاتحة: ٢]` |
| `(الحمد لله رب العلمين الرحمن الرحيم)` | unchanged | `﴿… (٢) … (٣)﴾ [الفاتحة: ٢–٣]` |
| `(الحمد لله رب العالمين....` | `﴿…﴾ [الفاتحة: ٢]....` | `﴿… ...﴾ [الفاتحة: ٢]` |

**Causes and fixes**

1. **Bare verse numbers** (`٢`, `٣`) used as separators became search tokens — the old
   `VERSE_NUMBER_RE` only stripped bracketed forms like `(٢)`. A new `stripNoiseTokens`
   pass drops bare digits and stray 1–3 letter Latin/OCR junk. Quranic text contains
   neither, so this is safe; single-letter Arabic openings (`ن والقلم`, `ق والقرآن`)
   are explicitly preserved and tested.
2. **Trailing ellipsis** sat *outside* the matched span, so the tag landed before the
   dots. The ellipsis is now absorbed into the replacement and rendered inside the
   braces. Verified idempotent.
3. **OCR typo in a multi-verse quote** (`العلمين` → `العالمين`) — fuzzy matching only
   ever ran on single verses, so one bad word broke the whole chain. The chain walker
   now tolerates up to `MAX_CHAIN_TYPOS` (2) near-miss words and can seed from the
   second word when the first is misspelled.

> Case 4 requires **تدقيق وتصحيح** to be enabled, since it rewrites the author's text
> rather than just reformatting it. It reports 94 % rather than 100 % so corrections
> stay visible in the report.

### A latent normalisation bug this uncovered

While testing case 4 I found a bug **inherited from the original code** that was
silently corrupting matches:

```js
t.replace(/يا\s+(?=[\u0600-\u06FF])/g, 'يا')   // joins the vocative يا
```

This was unanchored, so **every word ending in يا fused with the next word**:
`عتيا قال` → `عتياقال`, `الدنيا قال` → `الدنياقال`. Verses like 19:8, 19:45, 18:46,
18:77, 42:7 and 60:12 could not be matched as a result. Now anchored to a standalone
particle — clean consecutive-verse pairs went from **156/166 to 166/166**.

### Correction stays conservative

Typo tolerance is deliberately narrow, and the suite asserts it:

| Input | Result |
|---|---|
| `الحمد لله رب العلمين` (1 typo) | repaired, 88 % |
| `الحمد للع رب العلمين` (2 typos) | **no match** |
| `الحمد لله رب الخلائق اجمعين` (wrong word) | **no match** |
| `(سبحان الله وبحمده...)`, `(اللهم صل على محمد...)` | **no match** |
| `(2 3 4)`, `(abc def)` | **no match** |

---

## Truncated verse runs (fourth pass)

**Reported:** `(الحمد لله رب العالمين الرحمن )` split across two unrelated surahs
instead of completing the passage.

```
before   ﴿الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ﴾ [الفاتحة: ٢]
         ﴿الرَّحْمَنُ﴾ [الرحمن: ١]              ← wrong surah

after    ﴿الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ (٢) الرَّحْمَنِ الرَّحِيمِ (٣)﴾ [الفاتحة: ٢–٣]
```

**Cause.** The trailing word `الرحمن` is *itself* a complete verse — سورة الرحمن ١.
The segmenter matched the longest standalone verse for each fragment, so a partial
final ayah was hijacked by an unrelated surah that happened to share that opening.

**Fix.** When a run is already underway and the remaining words are a prefix of the
*next* ayah, the chain continues in the same surah and the omitted words are restored
from the mushaf. Applies to runs of any length:

| Input | Output |
|---|---|
| `(مالك يوم الدين اياك نعبد)` | `﴿… (٤) … (٥)﴾ [الفاتحة: ٤–٥]` |
| `(قل هو الله احد الله)` | `﴿… (١) … (٢)﴾ [الإخلاص: ١–٢]` |
| `(الحمد … الرحمن الرحيم مالك)` | `﴿… (٢) … (٣) … (٤)﴾ [الفاتحة: ٢–٤]` |

**Guardrails** — completion restores words the author didn't type, so it is deliberately restricted:

- Requires **تدقيق وتصحيح**; reports 98 %, never 100 %, so it stays visible in the report.
- Only continues an existing run — a lone partial verse is never padded
  (`﴿الحمد لله رب﴾` stays `﴿الْحَمْدُ لِلَّهِ رَبِّ﴾ [الفاتحة: ٢]`).
- An explicit `...` is honoured as intentional truncation: the fragment is kept, but
  still resolved **within the same surah** —
  `﴿… (٢) الرَّحْمَنِ ... (٣)﴾ [الفاتحة: ٢–٣]`, never سورة الرحمن.

Audited across the mushaf: **58/58 truncated tails completed correctly, 0 wrong**,
while clean consecutive pairs stay exact at 100 % (**166/166**) and prose still
matches nothing. A 1,500-row database run produced **zero** cross-surah splits.

> Idempotence note: the `...` marker is detected anywhere in the quote, not just at
> the end, so re-running an already-formatted `﴿… الرَّحْمَنِ ... (٣)﴾` does not quietly
> complete it on the second pass.

---

## Missing words inside a run (fifth pass)

**Reported:** `(الحمد رب العالمين الرحمن )` wasn't converted at all. Here the *first*
ayah is missing a word (**لله** dropped) **and** the last is truncated.

```
before   (الحمد رب العالمين الرحمن )        ← unchanged
after    ﴿الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ (٢) الرَّحْمَنِ الرَّحِيمِ (٣)﴾ [الفاتحة: ٢–٣]
```

**Cause.** The chain walker compared words *positionally*, so it tolerated a
mistyped word but not a **missing** one — a single dropped word shifted every
following word out of alignment and the whole run collapsed.

**Fix.** Added `_alignVerse()`, a banded token-level edit-distance alignment with an
early-exit budget. It handles dropped, extra and mistyped words together, so each
ayah in a run is repaired independently:

| Input | Output |
|---|---|
| `(الحمد رب العالمين الرحمن )` | `﴿… (٢) … (٣)﴾ [الفاتحة: ٢–٣]` |
| `(مالك يوم اياك نعبد)` | `﴿… (٤) … (٥)﴾ [الفاتحة: ٤–٥]` |
| `(قل هو الله احد الصمد)` | `﴿… (١) … (٢)﴾ [الإخلاص: ١–٢]` |

Budgets are deliberately tight: `MAX_VERSE_EDITS = 2` per ayah, `MAX_CHAIN_EDITS = 3`
across a run. Confidence drops with each edit and never reports 100 %.

### A DB-only bug this caught

The first pipeline run after this change looked worse, not better: **1,035 rows
converted instead of 1,667**, with cross-surah splits reappearing. Standalone tests
all passed — the difference was the row's `SuraID`.

The repair pool was **hard-filtering candidates by `preferredSurah`**. But a tafsir
row commenting on البقرة routinely quotes الفاتحة, so whenever the quoted verse came
from a different surah than the row, repair found nothing. Surah context is now a
ranking *preference* (+5) rather than a filter. Same 2,000-row database:

```
before fix   1035 rows modified, cross-surah split: True
after fix    1667 rows modified, cross-surah split: False
```

Worth stressing: this only showed up in the end-to-end database test, not in any
unit test.

### Repair safety

Audited across the mushaf, with correction enabled:

| Check | Result |
|---|---|
| Dropped word in 2nd ayah recovered | **52/52**, 0 wrong |
| Dropped word in 1st ayah recovered | **55/55**, 0 wrong |
| Clean text never "repaired" | **112/112** preserved at 100 % |
| Wrong word / 3 typos / ordinary names | **rejected** |
| Prose & devotional phrases | **0/9** matched |
| Re-running is stable | **29/29** |

> One test of mine was wrong, not the engine: `الحمد لله الذي هدانا لهذا` is genuinely
> **الأعراف: ٤٣**, so matching it was correct. The audit list now avoids phrases that
> are themselves Quranic.

---

## Requested behaviour changes (sixth pass)

### 1 + 2 — One-word ayat are never converted

`﴿حمٓ ١ عٓسٓقٓ﴾` used to become two references in **two different surahs**:

```
before   ﴿حم﴾ [غافر: ١]  ﴿عسق﴾ [الشورى: ٢]
after    ﴿حمٓ ١ عٓسٓقٓ﴾            ← left exactly as written
```

A single word is far too generic to identify safely — the muqaṭṭaʿāt (حم، الم، يس،
ص، ق) and ordinary words that happen to be complete ayat (الرحمن، مدهامتان، والفجر)
appear constantly in tafsir prose. `MIN_VERSE_WORDS = 2` now governs this centrally,
so no matching strategy can emit one.

One subtlety worth flagging: my first attempt summed the word counts of a run, which
still let `حم عسق` through (1 + 1 = 2). The rule is now that **at least one ayah must
stand on its own**, which is what actually prevents the cross-surah split.

They are still converted when anchored by a real ayah in the same run:

```
﴿الم ١ ذلك الكتاب لا ريب فيه﴾
→ ﴿الم (١) ذَلِكَ الْكِتَابُ لَا رَيْبَ فِيهِ هُدًى لِلْمُتَّقِينَ (٢)﴾ [البقرة: ١–٢]
```

### 3 — 🗄️ قاعدة البيانات opens `.db` **or** `.json`

Positional arrays are mapped as **SuraID, AyahID, AyahText**, with any further
columns carried through untouched:

```json
[[1, 3, "text", null, "1-7"]]
```

Arrays of objects (`{"SuraID":1,…}`) and `{rows:[…]}` / `{data:[…]}` wrappers also
work. JSON needs no SQLite engine, so it loads even without `sql-wasm.js`.

### 4 — 💾 حفظ JSON

A new button next to *حفظ قاعدة البيانات*. JSON input round-trips in its original
shape (arrays stay arrays, extra columns and `null`s preserved); a SQLite source
exports as objects so column names survive.

### 5 — Unchecked (تحويل) rows are left byte-identical

Previously a row was rebuilt from its original text with only the approved spans
applied — correct, but a row whose conversions were *all* unchecked still went
through the rewrite path. It is now skipped outright, so the stored text is
untouched. Verified on both the SQLite and JSON paths.

### 6 — quran.json loads automatically

Auto-load tries the bundled `QURAN_DATA` global first (so it works from `file://`),
then `quran.json` beside the page, then `data/`, `json/`, `assets/` and the parent
folder before giving up.

## Unchecked rows were still being converted (seventh pass)

**Reported:** unticking **تحويل** for `﴿بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ﴾` still saved the
converted text into `AyahText`.

**Cause.** Approvals were keyed on `replacementId`, a per-session counter. But
`startProcessing()` clears `state.results` **without** resetting that counter, so a
second run minted brand-new ids for the same replacements. The id stored in
`uncheckedIds` then matched nothing: the checkbox rendered as ticked again and the
row was converted on save.

Reproduced exactly — after re-processing, `uncheckedIds` still held `[1]` while every
checkbox read `true` and all rows converted:

```
after uncheck : المعتمدة: 5 / 6   ids: [1]
after re-run  : المعتمدة: 5 / 6   ids: [1]     ← stale, matches nothing
checkboxes    : [true, true, true, true, true, true]
rows kept original: []                          ← should have been [1]
```

**Fix.** Approvals now use a **stable content key** instead of a counter:

```
db|<rowIndex>|<start>|<end>|<originalText>
```

This survives re-processing, sorting, filtering and re-rendering, because it is
derived from the replacement itself rather than from creation order. Same scenario
after the fix:

```
checkboxes        : [false, true, true, true, true, true]
rows kept original: [1]
```

Unticked rows are now left **byte-identical** in both `.db` and `.json` output, and
the case is covered by a browser test that unticks a row, re-runs the whole table,
and asserts the saved text is unchanged.

## Unchecked ayat reappearing formatted (eighth pass)

**Reported:** unticking **تحويل** for an ayah, saving, then finding *that same ayah*
formatted elsewhere in the database.

The per-row mechanics from the previous pass were working — so I reproduced the
workflow instead of re-reading the code, and found **two separate causes**:

### 1. Rows past 500 were unreachable

The report rendered only the first 500 matches. With 700 bismillah rows, row 600 had
no checkbox at all, so it could never be unticked and was always written converted:

```
total replacements=700   rendered rows=500
ID1   (unticked)      : UNCHANGED
ID600 (never visible) : CONVERTED     ← impossible to prevent from the UI
```

Fixed with real pagination (200/page, `السابق` / `التالي`). Every match is now
reachable, so no conversion can be written that you never had a chance to review.

### 2. Unticking applied to one row only

This is the behaviour you actually described. A tafsir database repeats the same
quotation across hundreds of rows; unticking row 1's bismillah left the other 699
untouched, so the ayah still looked converted everywhere else.

Approvals now carry **two** keys: the positional one, plus a content key
(`text|<normalised original>`). Unticking an ayah suppresses **every identical
quotation in the table**:

```
-- untick ONE bismillah row --
  المعتمدة: 0 / 700
  all visible boxes now unchecked: True (200/200)
  → no download: all 700 rows kept their original text ✅
```

Partial rows still behave correctly — in `قال ﴿بسم الله…﴾ ثم (الحمد لله رب العالمين)`
the bismillah stays raw while الحمد is converted, because approval is per
*conversion*, not per row.

If you prefer the old row-by-row behaviour, untick
**تطبيق على كل المواضع المطابقة** next to the الكل / لا شيء buttons.

## quran.json never auto-loaded (ninth pass)

**Reported:** the mushaf always had to be uploaded by hand.

**Cause.** `quran-data.js` declares:

```js
const QURAN_DATA = [ … ];
```

A top-level `const` creates a *lexical binding*, *not* a property of `window` — so
the check `typeof window.QURAN_DATA !== 'undefined'` was **always false**, even
though the data was loaded and valid:

```
typeof window.QURAN_DATA : undefined
typeof QURAN_DATA        : object     ← the data was there all along
```

With the bundled copy invisible, auto-load fell through to `fetch('quran.json')` —
which browsers block on `file://`. Opening `index.html` from disk could therefore
never succeed, which is exactly the reported behaviour.

**Fix.** `bundledQuran()` now resolves the value by bare identifier (which sees the
lexical binding) before falling back to `window`, then to fetch. Verified in a real
browser over `file://`:

```
OK   auto-loads over file://
OK   all 6236 verses indexed
OK   formatting works offline
```

All three deployment modes are covered by tests:

| Mode | Result |
|---|---|
| `file://` with `quran-data.js` | auto-loads, fully offline |
| `http://` without `quran-data.js` | fetches `quran.json` |
| `file://` without `quran-data.js` | no crash; hint to add `quran-data.js` or run a server |

### Verified against the old engine
A 728-case regression harness (real verses: exact quotes and truncated prefixes)
compares old vs new output:

```
identical output : 715
different output : 6      <- all are accuracy improvements, see below
new finds, old missed: 7  <- verses the original could not match
old found, new missed: 0  <- zero regressions
confidence >100 (new): 0
```

Four of the six differences are verses the `يا`-fusion bug used to mangle (18:46,
18:77, 42:7, 60:12) — all now resolve correctly at 100 %. A broader sweep over 3,118
verses confirms the two engines are **equally verbatim-correct (101 vs 101)** on the
cases where they disagree, so nothing was traded away.

The 2 differences are bugs that were fixed. For the input `﴿ان الذين لا يومنون بالاخرة﴾`
the old code emitted `﴿وَأَنَّ الَّذِينَ...﴾` — inventing a leading **وَ** that the user never
quoted. The new code returns the correct `﴿إِنَّ الَّذِينَ لَا يُؤْمِنُونَ بِالْآخِرَةِ﴾ [النمل: ٤]`.

---

## What changed, file by file

### `utils.js`
- `normalizeArabic` rewritten as a **single character pass** (was 11 chained regexes) with a bounded LRU cache — the hottest function in the app.
- `levenshtein` uses typed arrays + **early termination** via a `maxDist` bound.
- `escapeHTML` no longer needs the DOM and escapes `& < > " ' \``.
- Added `toArabicDigits`, `clamp`, `hasTrailingDots`, `debounce`, `levenshteinRatio`.
- `extractQuranCandidates` handles «», proper nesting, and merges overlaps correctly.

### `quran.js`
- Built **four indexes at load time**: `byKey` (O(1) verse lookup, was a linear `.find()` on every call), `byExact`, `tokenIndex` (inverted), and `bySurah`.
- Verse tokens and display words are **pre-split once** and reused everywhere.
- `getCandidateEntries()` prunes the search space using rarest-token ranking.
- Validates input and throws a clear Arabic error instead of silently loading 0 verses.

### `matcher.js`
- Multi-verse matching is anchored and index-driven (the 100 s → ms fix).
- Added `segmentIntoVerses` fast path for exact consecutive-verse runs.
- **Confidence is clamped to 0–100** everywhere (`_avgConfidence`).
- **Idempotence fix:** re-running no longer duplicates the `[الفاتحة: ٢]` tag — an existing reference tag is absorbed into the replacement span.
- Inline verse numbers like `(1)` are stripped before matching.
- `resolveAmbiguous` now requires ≥2 votes and only switches on a *strict* confidence improvement, so it can't downgrade a good match.

### `app.js`
- **Test-panel results no longer pollute database results.** Previously `testFormat()` pushed a result with `rowIndex = -1` into the same array used by `saveDatabase()`, corrupting saves after using the sandbox.
- Removed all inline `onclick=` handlers → CSP-safe event delegation.
- Output rendered with `textContent`, not `innerHTML` (**XSS fix** — verified in the browser test).
- Settings persist to `localStorage` (theme, script, correction, column mapping).
- Sortable columns, extra filters, select-all/none, approval counter, throttled progress (~20 fps), race-free pause/cancel, `beforeunload` guard.

### `database.js`
- **All identifiers quoted** — a table named `my"tbl` no longer breaks or injects SQL.
- Validates the `SQLite format 3` magic header before parsing.
- Export **preserves the original schema** (types, PKs) instead of creating untyped columns.
- Transactional inserts; `init()` is concurrency-safe; object URLs are revoked.

### `report.js`
- CSV is RFC-4180 compliant with CRLF and **formula-injection guarding** (`=cmd` → `'=cmd`).
- Added JSON and standalone printable HTML exports.

### `index.html` / `style.css`
- ~50 duplicated inline CSS rules removed; `style.css` is now the single source of truth.
- Semantic landmarks, ARIA labels, focus-visible styling, responsive + print stylesheets.

---

## Running it

`quran-data.js` bundles the mushaf as a script, so **opening `index.html` directly
from disk works** — no server, no manual upload. If you delete `quran-data.js` and
rely on `quran.json` instead, you need a local server (browsers block `fetch()` on
`file://`):

```bash
cd quran-formatter
python3 -m http.server 8000
# open http://localhost:8000
```

`quran-data.js` is loaded first and defines `QURAN_DATA`, so the app also works by
opening `index.html` directly — only the SQLite `.wasm` needs a server.

### Tests

```bash
node tests/run-tests.js     # 143 engine assertions
node tests/audit.js         # statistical sweep over all 6,236 verses
node tests/audit.js --compare ../uploads   # regression vs the original engine
python3 tests/ui-test.py    # 50 browser assertions (needs playwright)
```

Both suites pass. The engine suite covers normalisation, indexing, matching,
corrupt-source recovery, repeated-verse disambiguation, muqaṭṭaʿāt, split-word
repair, idempotence, offset integrity and export escaping. The browser suite covers
loading, the test panel, approvals, filtering/sorting, theme persistence, XSS safety,
CSV/JSON export, a full SQLite round-trip, and quoted-identifier injection safety.

Also verified end-to-end in a real browser: a 2,000-row tafsir database processes in
**0.4 s**, writes 1,600 formatted rows, leaves all 400 prose rows byte-identical, and
loses no data.

---

## Compatibility

All public APIs are unchanged — `QF.Formatter.processText(text, outputType,
preferredSurah, correctionEnabled)`, `QF.Matcher.*`, `QF.Database.*`,
`QF.Report.exportCSV(rows)` and `window.QuranFormatterApp.toggleConversion` all keep
their original signatures, so any code you have outside these files keeps working.

The third argument now *also* accepts `{surah, ayah}` for verse-level
disambiguation; passing a plain number behaves exactly as before.

New optional additions: `Formatter.processBatch`, `Formatter.applyReplacements`,
`Report.exportJSON/exportHTML`, `Database.applyUpdates/iterateRows`, `Quran.stats()`.

### Note on the two data files
`quran.json` and `quran-data.js` contain the same 6,236 verses (~4 MB each). You only
need one: keep `quran-data.js` for serverless use, or delete it and keep `quran.json`
if you always serve over HTTP.
