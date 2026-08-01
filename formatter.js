/**
 * formatter.js — واجهة التنسيق عالية المستوى
 * Thin facade over QF.Matcher, plus batch helpers with cancellation support.
 */
(function (QF) {
    'use strict';

    QF.Formatter = {
        /**
         * Format a single text blob.
         * @param {string} text
         * @param {'imlai'|'uthmani'} [outputType]
         * @param {number|null} [preferredSurah]
         * @param {boolean} [correctionEnabled]
         * @returns {{modifiedText:string,replacements:object[],totalVerses:number,lowConfidenceCount:number,averageConfidence:number}}
         */
        processText(text, outputType = 'imlai', preferredSurah = null, correctionEnabled = true) {
            return QF.Matcher.processText(text, outputType, preferredSurah, correctionEnabled);
        },

        /**
         * Format many texts cooperatively, yielding to the event loop so the UI
         * stays responsive and can be paused/cancelled.
         *
         * @param {Array<{text:string, preferredSurah?:number|null, meta?:any}>} items
         * @param {object} [opts]
         * @param {'imlai'|'uthmani'} [opts.outputType]
         * @param {boolean} [opts.correctionEnabled]
         * @param {number} [opts.chunkSize]
         * @param {(done:number,total:number)=>void} [opts.onProgress]
         * @param {()=>boolean} [opts.shouldCancel]
         * @param {()=>Promise<void>} [opts.waitIfPaused]
         * @returns {Promise<Array<{index:number, meta:any, result:object}>>}
         */
        async processBatch(items, opts = {}) {
            const {
                outputType = 'imlai',
                correctionEnabled = true,
                chunkSize = 25,
                onProgress,
                shouldCancel,
                waitIfPaused
            } = opts;

            const out = [];
            for (let i = 0; i < items.length; i++) {
                if (shouldCancel && shouldCancel()) break;
                if (waitIfPaused) await waitIfPaused();

                const item = items[i];
                const text = item && item.text;
                if (text && text.trim()) {
                    try {
                        const result = this.processText(
                            text, outputType, item.preferredSurah ?? null, correctionEnabled);
                        if (result.replacements.length) {
                            out.push({ index: i, meta: item.meta, result });
                        }
                    } catch (err) {
                        console.warn('processBatch item failed at', i, err);
                    }
                }

                if ((i + 1) % chunkSize === 0) {
                    if (onProgress) onProgress(i + 1, items.length);
                    await new Promise(r => setTimeout(r, 0));
                }
            }
            if (onProgress) onProgress(items.length, items.length);
            return out;
        },

        /**
         * Re-apply only the approved replacements onto the original text.
         * @param {string} originalText
         * @param {object[]} replacements each with {start,end,formatted}
         * @param {(rep:object)=>boolean} isApproved
         * @returns {string}
         */
        applyReplacements(originalText, replacements, isApproved = () => true) {
            let text = originalText || '';
            const ordered = [...replacements]
                .filter(isApproved)
                .sort((a, b) => b.start - a.start);
            for (const rep of ordered) {
                if (rep.start == null || rep.end == null) continue;
                if (rep.start < 0 || rep.end > text.length || rep.start > rep.end) continue;
                text = text.substring(0, rep.start) + rep.formatted + text.substring(rep.end);
            }
            return text;
        }
    };
})(QuranFormatter);
