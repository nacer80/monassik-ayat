/**
 * database.js — طبقة قواعد بيانات SQLite (sql.js)
 * Enhanced: identifier quoting against SQL injection, schema-preserving export,
 * streaming row iteration, transactional inserts, and proper resource cleanup.
 */
(function (QF) {
    'use strict';

    /** Escape a SQLite identifier: "my""table". */
    const q = name => '"' + String(name).replace(/"/g, '""') + '"';

    QF.Database = {
        sqlInstance: null,
        isReady: false,
        _initPromise: null,

        /** Initialise the wasm engine once (concurrent calls share one promise). */
        async init() {
            if (this.isReady) return;
            if (this._initPromise) return this._initPromise;

            this._initPromise = (async () => {
                if (typeof initSqlJs === 'undefined') {
                    throw new Error('sql-wasm.js غير محمل. تأكد من وجود الملف في المجلد.');
                }

                let config = {};
                if (typeof SQL_WASM_BASE64 !== 'undefined') {
                    const bin = atob(SQL_WASM_BASE64);
                    const bytes = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                    config.wasmBinary = bytes;
                } else {
                    // Let sql.js resolve the .wasm itself (works with file:// + http).
                    config.locateFile = file => file;
                }

                this.sqlInstance = await initSqlJs(config);
                this.isReady = true;
            })();

            try {
                await this._initPromise;
            } catch (err) {
                this._initPromise = null;
                throw err;
            }
        },

        /**
         * Read a File/Blob into an sql.js Database.
         * @param {File|Blob} file
         * @returns {Promise<object>}
         */
        async load(file) {
            if (!file) throw new Error('لم يتم اختيار ملف');

            // A .json data source needs no wasm engine at all.
            if (/\.json$/i.test(file.name || '')) {
                const text = await (file.text ? file.text() : new Promise((res, rej) => {
                    const r = new FileReader();
                    r.onload = () => res(r.result);
                    r.onerror = () => rej(new Error('فشل قراءة الملف'));
                    r.readAsText(file);
                }));
                let parsed;
                try {
                    parsed = JSON.parse(text);
                } catch (e) {
                    throw new Error('ملف JSON غير صالح: ' + e.message);
                }
                const name = String(file.name).replace(/\.json$/i, '') || 'Data';
                return this.fromJSON(parsed, name);
            }

            if (!this.isReady) await this.init();

            const buffer = file.arrayBuffer
                ? await file.arrayBuffer()
                : await new Promise((resolve, reject) => {
                    const r = new FileReader();
                    r.onload = () => resolve(r.result);
                    r.onerror = () => reject(new Error('فشل قراءة ملف قاعدة البيانات'));
                    r.readAsArrayBuffer(file);
                });

            const bytes = new Uint8Array(buffer);
            // SQLite files start with "SQLite format 3\0"
            const header = String.fromCharCode(...bytes.slice(0, 15));
            if (bytes.length < 16 || header !== 'SQLite format 3') {
                throw new Error('الملف ليس قاعدة بيانات SQLite صالحة');
            }

            try {
                return new this.sqlInstance.Database(bytes);
            } catch (e) {
                throw new Error('تعذر فتح قاعدة البيانات: ' + e.message);
            }
        },

        getTableNames(db) {
            if (db && db.__isJson) return [db.__table];
            const res = db.exec(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
            return res.length ? res[0].values.map(r => r[0]) : [];
        },

        /** @returns {{name:string,type:string,notnull:boolean,pk:boolean}[]} */
        getColumns(db, table) {
            if (db && db.__isJson) return db.__columns.map(c => ({ ...c }));
            const res = db.exec(`PRAGMA table_info(${q(table)})`);
            if (!res.length) return [];
            return res[0].values.map(r => ({
                name: r[1],
                type: r[2] || '',
                notnull: !!r[3],
                dflt: r[4],
                pk: !!r[5]
            }));
        },

        getRows(db, table) {
            if (db && db.__isJson) return db.__rows.map(r => r.slice());
            const res = db.exec(`SELECT * FROM ${q(table)}`);
            return res.length ? res[0].values : [];
        },

        countRows(db, table) {
            if (db && db.__isJson) return db.__rows.length;
            const res = db.exec(`SELECT COUNT(*) FROM ${q(table)}`);
            return res.length ? Number(res[0].values[0][0]) : 0;
        },

        /**
         * Iterate rows without materialising the whole table.
         * @yields {any[]}
         */
        *iterateRows(db, table) {
            const stmt = db.prepare(`SELECT * FROM ${q(table)}`);
            try {
                while (stmt.step()) yield stmt.get();
            } finally {
                stmt.free();
            }
        },

        /** Original DDL for a table, so exports keep types and constraints. */
        getTableSQL(db, table) {
            const res = db.exec(
                `SELECT sql FROM sqlite_master WHERE type='table' AND name=${"'" + String(table).replace(/'/g, "''") + "'"}`);
            return res.length && res[0].values.length ? res[0].values[0][0] : null;
        },

        findAyahColumn(columns) {
            const lower = n => String(n).toLowerCase();
            let col = columns.find(c => lower(c.name) === 'ayahtext');
            if (!col) col = columns.find(c => lower(c.name).includes('text') || lower(c.name).includes('tafsir'));
            return col ? col.name : null;
        },

        /**
         * Build a new database containing `table` with the given rows,
         * preserving the original schema when available.
         */
        createOutputDB(originalDB, table, columns, rows) {
            // JSON sources round-trip as JSON, keeping their original shape.
            if (originalDB && originalDB.__isJson) {
                return {
                    __isJson: true,
                    __table: table,
                    __columns: columns.map(c => ({ ...c })),
                    __rows: rows.map(r => r.slice()),
                    __objectKeys: originalDB.__objectKeys,
                    __wrapper: originalDB.__wrapper,
                    close() {}
                };
            }
            const newDB = new this.sqlInstance.Database();
            const colNames = columns.map(c => c.name);

            const originalSQL = originalDB ? this.getTableSQL(originalDB, table) : null;
            newDB.run(originalSQL || `CREATE TABLE ${q(table)} (${colNames.map(q).join(',')})`);

            const placeholders = colNames.map(() => '?').join(',');
            const stmt = newDB.prepare(
                `INSERT INTO ${q(table)} (${colNames.map(q).join(',')}) VALUES (${placeholders})`);
            try {
                newDB.run('BEGIN TRANSACTION');
                for (const row of rows) {
                    stmt.run(row.map(v => (v === undefined ? null : v)));
                    stmt.reset();
                }
                newDB.run('COMMIT');
            } catch (e) {
                try { newDB.run('ROLLBACK'); } catch (_) {}
                stmt.free();
                newDB.close();
                throw new Error('فشل إنشاء قاعدة البيانات الجديدة: ' + e.message);
            }
            stmt.free();
            return newDB;
        },

        /**
         * Update a single column in place on a copy of the original database —
         * preserves every other table, index and trigger.
         * @param {object} db
         * @param {string} table
         * @param {string} pkColumn column uniquely identifying a row
         * @param {Array<{pk:any, value:any}>} updates
         */
        applyUpdates(db, table, column, pkColumn, updates) {
            const stmt = db.prepare(
                `UPDATE ${q(table)} SET ${q(column)} = ? WHERE ${q(pkColumn)} = ?`);
            try {
                db.run('BEGIN TRANSACTION');
                for (const u of updates) {
                    stmt.run([u.value, u.pk]);
                    stmt.reset();
                }
                db.run('COMMIT');
            } catch (e) {
                try { db.run('ROLLBACK'); } catch (_) {}
                throw e;
            } finally {
                stmt.free();
            }
        },

        exportDB(db) {
            if (db && db.__isJson) return this.exportJsonDB(db);
            return new Blob([db.export()], { type: 'application/x-sqlite3' });
        },

        // =================================================================
        //  JSON data sources
        // =================================================================
        /**
         * Wrap a parsed JSON document in the same shape the SQLite paths use,
         * so the rest of the app needs no special-casing.
         *
         * Supported layouts:
         *   • array of arrays   [[1, 3, "text", null, "1-7"], …]
         *       → SuraID, AyahID, AyahText, then extra columns kept verbatim
         *   • array of objects  [{ SuraID: 1, AyahID: 3, AyahText: "…" }, …]
         *   • { rows: [...] } / { data: [...] } wrappers
         *
         * @param {any} json
         * @param {string} [tableName='Data']
         * @returns {object} a duck-typed "database" handle
         */
        fromJSON(json, tableName = 'Data') {
            let rows = json;
            if (!Array.isArray(rows) && rows && typeof rows === 'object') {
                rows = rows.rows || rows.data || rows.records || rows.verses;
            }
            if (!Array.isArray(rows) || rows.length === 0) {
                throw new Error('ملف JSON فارغ أو بصيغة غير مدعومة');
            }

            let columns, values, objectKeys = null;
            const first = rows.find(r => r != null);

            if (Array.isArray(first)) {
                // Positional layout: [SuraID, AyahID, AyahText, …extras]
                const width = rows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
                const base = ['SuraID', 'AyahID', 'AyahText'];
                columns = [];
                for (let i = 0; i < width; i++) {
                    columns.push({ name: base[i] || `col${i + 1}`, type: '' });
                }
                values = rows.map(r => {
                    const row = Array.isArray(r) ? r.slice() : [];
                    while (row.length < width) row.push(null);
                    return row;
                });
            } else if (first && typeof first === 'object') {
                objectKeys = [];
                for (const r of rows) {
                    if (!r || typeof r !== 'object') continue;
                    for (const k of Object.keys(r)) if (!objectKeys.includes(k)) objectKeys.push(k);
                }
                columns = objectKeys.map(k => ({ name: k, type: '' }));
                values = rows.map(r => objectKeys.map(k => (r && r[k] !== undefined ? r[k] : null)));
            } else {
                throw new Error('صيغة JSON غير مدعومة: يجب أن يكون مصفوفة صفوف');
            }

            return {
                __isJson: true,
                __table: tableName,
                __columns: columns,
                __rows: values,
                __objectKeys: objectKeys,
                __wrapper: (!Array.isArray(json) && json && typeof json === 'object') ? json : null,
                close() { /* nothing to release */ }
            };
        },

        /** Serialise a JSON handle back to its original shape. */
        exportJsonDB(db) {
            const rows = db.__objectKeys
                ? db.__rows.map(r => {
                    const o = {};
                    db.__objectKeys.forEach((k, i) => { o[k] = r[i]; });
                    return o;
                })
                : db.__rows.map(r => r.slice());

            let payload = rows;
            if (db.__wrapper) {
                payload = { ...db.__wrapper };
                for (const key of ['rows', 'data', 'records', 'verses']) {
                    if (Array.isArray(db.__wrapper[key])) { payload[key] = rows; break; }
                }
            }
            return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        },

        /** Trigger a browser download and release the object URL. */
        downloadBlob(blob, filename) {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 1000);
        }
    };
})(QuranFormatter);
