# المُنسِق — Quran Verse Formatter

Detects Qur'anic quotations inside Arabic tafsir text and rewrites them with the
correct script, ornate brackets, and a surah\:ayah reference — then writes the result
back to SQLite, JSON, or plain text.

Runs entirely in the browser. **No server, no build step, no network.** Your data
never leaves the machine.

```
(الحمد لله رب العالمين)          →  ﴿الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ﴾ [الفاتحة: ٢]
(الحمد رب العالمين الرحمن )      →  ﴿الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ (٢) الرَّحْمَنِ الرَّحِيمِ (٣)﴾ [الفاتحة: ٢–٣]
(و وهبنا له اسحاق ويعقوب)        →  ﴿وَوَهَبْنَا لَهُ إِسْحَاقَ وَيَعْقُوبَ﴾ [الأنعام: ٨٤]
```

> **بالعربية:** انظر [ABOUT.md](ABOUT.md) لوصف موجز بالعربية.

---

## Quick start

```bash
git clone <repo-url>
cd quran-formatter
```

Open `index.html`. That's it — `quran-data.js` bundles all 6,236 verses, so the
mushaf loads itself even from `file://`.

For SQLite support in stricter browsers, serve the folder instead:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

---

## Features

**Matching**
- Full mushaf indexed (6,236 verses) — inverted token index, O(1) verse lookup
- Imlā'ī or ʿUthmānī output script
- Consecutive verses merged into one run: `﴿… (٢) … (٣)﴾ [الفاتحة: ٢–٣]`
- Partial quotes, trailing `...`, and inline verse numbers handled
- Repeated verses flagged (`فَبِأَيِّ آلَاءِ رَبِّكُمَا تُكَذِّبَانِ` occurs 31×) and disambiguated
  using the row's own `SuraID`/`AyahID`

**Correction** (opt-in, via *تدقيق وتصحيح*)
- Recovers dropped words: `الحمد رب العالمين` → `الحمد لله رب العالمين`
- Fixes OCR-style typos: `العلمين` → `العالمين`
- Rejoins split prefixes: `و وهبنا` → `ووهبنا`
- Completes a truncated final ayah in a run
- Deliberately conservative — 2 edits per ayah, 3 per run; anything noisier is rejected

**Review & output**
- Per-conversion approval checkbox; unticking one ayah suppresses every identical
  quotation, and the original text is preserved byte-for-byte
- Sortable, filterable, paginated report with confidence scores
- Sources: SQLite `.db`, JSON, Word `.docx`, plain `.txt`
- Exports: `.db`, `.json`, `.docx`, `.txt`, plus CSV / JSON / HTML reports
- Documents keep their source format and styling on save

---

## Input formats

### SQLite
Any table works; you pick the columns in the ⚙️ dialog. `ID`, `SuraID`, `AyahID`,
`AyahText` are auto-detected.

### JSON
Positional arrays map to **SuraID, AyahID, AyahText**; extra columns pass through
untouched:

```json
[[1, 3, "قال تعالى (الحمد لله رب العالمين)", null, "1-7"]]
```

Arrays of objects and `{rows:[…]}` / `{data:[…]}` wrappers also work.

### Word / text
`.docx` is read *and written* natively (no library) using `DecompressionStream` /
`CompressionStream`. The report's **ص** column shows the document page each quote
came from — hover it to see the mushaf page. `.txt` treats form feeds as page breaks.

Page numbers come from Word's own markers (`lastRenderedPageBreak`, explicit page
breaks, section breaks). Those markers are written by Word's *layout* engine, so
documents produced by other tools carry none — in that case pages are estimated from
text volume and the UI says *أرقام الصفحات تقديرية*.

**Documents round-trip in their original format:** a `.docx` saves as `.docx`, a
`.txt` saves as `.txt`. When writing a Word file only `word/document.xml` is
regenerated — styles, fonts, colours, headings, headers/footers, images and page
breaks are copied through byte-for-byte.

---

## Usage

1. Load the mushaf (automatic) — or pick `quran.json` manually.
2. Load a source: **🗄️ قاعدة البيانات** (`.db` / `.json`) or **📄 Word / نص**.
3. **▶️ بدء المعالجة**.
4. Review the table; untick **تحويل** for anything you want left alone.
5. Save: **حفظ قاعدة البيانات** / **حفظ JSON** / **حفظ Word** (or **حفظ نص** for `.txt`).

Single-word ayat (`حم`, `الم`, `يس`, `الرحمن`) are never converted on their own —
they're indistinguishable from ordinary prose — but *are* converted inside a longer
run.

---

## Testing

```bash
node tests/run-tests.js                      # 155 engine assertions
node tests/audit.js                          # statistical sweep over all 6,236 verses
node tests/audit.js --compare ../uploads     # regression vs a previous version
python3 tests/ui-test.py                     # 74 browser assertions (needs playwright)
```

Current status — all green:

| Metric | Result |
|---|---|
| Exact-verse accuracy (whole mushaf) | **100 %** (0 wrong, 0 missed) |
| False positives on scholarly prose | **0 / 9** |
| Clean text never altered by correction | **112 / 112** |
| Dropped words recovered | **107 / 107** |
| Idempotence (re-running is stable) | **29 / 29** |

---

## Performance

The matcher was rebuilt around an inverted index. The original engine's
multi-verse search was `O(surahs × verses × length × window)` and re-tokenised
every verse inside the innermost loop:

| Benchmark | Before | After |
|---|---|---|
| 6 mixed candidates | 200,395 ms | **6 ms** |
| 2,000-row database (in-browser, end-to-end) | hours (projected) | **0.4 s** |
| 400 quotes in one text | — | 21 ms |

---

## Project layout

| File | Role |
|---|---|
| `index.html` / `style.css` | UI |
| `utils.js` | Arabic normalisation, candidate extraction |
| `quran.js` | Mushaf loading and indexing |
| `matcher.js` | Matching and correction engine |
| `formatter.js` | High-level formatting facade |
| `database.js` | SQLite + JSON data sources |
| `docx.js` | Word / text reader + writer |
| `report.js` | CSV / JSON / HTML export |
| `app.js` | UI logic and state |
| `tests/` | Engine, audit and browser suites |

`quran.json` and `quran-data.js` hold the same 6,236 verses (~4 MB each). Keep
`quran-data.js` for serverless use, or delete it and keep `quran.json` if you always
serve over HTTP.

---

## Notes on the bundled data

The included `quran.json` has **156 verses whose `ayah_notashkil` field is
truncated** — e.g. 2:117 stores `بديع السماوات و` with `والأرض` collapsed to `و`.
The index is therefore built from the intact `ayah_imlai` field, with the corrupt
spelling kept as a searchable alias so text copied from it still resolves.

A development changelog with the reasoning behind each fix is in [DEVLOG.md](DEVLOG.md).

---

## License

The source code is provided as-is. The Qur'anic text is reproduced from the bundled
dataset; verify it against a certified mushaf before publishing any output.
