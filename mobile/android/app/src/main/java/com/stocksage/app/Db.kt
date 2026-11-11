package com.stocksage.app

import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteCursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteProgram
import org.json.JSONArray
import org.json.JSONObject

/**
 * The app's SQLite database. The schema and its migrations live in the
 * TypeScript backend (mobile/web/src/backend/schema.ts); this class only
 * executes statements with properly typed bindings and returns JSON rows.
 * One instance per process, shared by the UI and background WebViews.
 */
class Db private constructor(context: Context) {
    // Opened directly, NOT via SQLiteOpenHelper: the helper claims PRAGMA
    // user_version for itself, which is exactly what the TypeScript migrator uses.
    private val writableDatabase: SQLiteDatabase = SQLiteDatabase.openDatabase(
        context.applicationContext.getDatabasePath("stocksage.db").apply { parentFile?.mkdirs() }.path,
        null,
        SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.CREATE_IF_NECESSARY or SQLiteDatabase.ENABLE_WRITE_AHEAD_LOGGING,
    ).apply { setForeignKeyConstraintsEnabled(true) }

    private fun bind(p: SQLiteProgram, params: JSONArray?) {
        if (params == null) return
        for (i in 0 until params.length()) {
            val idx = i + 1
            when (val v = params.get(i)) {
                JSONObject.NULL -> p.bindNull(idx)
                is Boolean -> p.bindLong(idx, if (v) 1 else 0)
                is Int -> p.bindLong(idx, v.toLong())
                is Long -> p.bindLong(idx, v)
                is Number -> {
                    val d = v.toDouble()
                    if (d == Math.floor(d) && Math.abs(d) < 9.0e15) p.bindLong(idx, d.toLong()) else p.bindDouble(idx, d)
                }
                else -> p.bindString(idx, v.toString())
            }
        }
    }

    fun query(sql: String, params: JSONArray?): JSONArray {
        val db = writableDatabase
        val cursor = db.rawQueryWithFactory({ _, driver, table, query ->
            bind(query, params)
            SQLiteCursor(driver, table, query)
        }, sql, null, "")
        val rows = JSONArray()
        cursor.use { c ->
            val names = c.columnNames
            while (c.moveToNext()) {
                val row = JSONObject()
                for (i in names.indices) {
                    when (c.getType(i)) {
                        Cursor.FIELD_TYPE_NULL -> row.put(names[i], JSONObject.NULL)
                        Cursor.FIELD_TYPE_INTEGER -> row.put(names[i], c.getLong(i))
                        Cursor.FIELD_TYPE_FLOAT -> row.put(names[i], c.getDouble(i))
                        else -> row.put(names[i], c.getString(i))
                    }
                }
                rows.put(row)
            }
        }
        return rows
    }

    /** Returns (changes, lastInsertRowId). */
    private fun exec(db: SQLiteDatabase, sql: String, params: JSONArray?): Pair<Long, Long> {
        val head = sql.trimStart().take(8).uppercase()
        if (head.startsWith("PRAGMA") || head.startsWith("CREATE") || head.startsWith("DROP") || head.startsWith("ALTER")) {
            db.execSQL(sql)
            return 0L to 0L
        }
        db.compileStatement(sql).use { st ->
            bind(st, params)
            return if (head.startsWith("INSERT") || head.startsWith("REPLACE")) {
                val id = st.executeInsert()
                (if (id == -1L) 0L else 1L) to id
            } else {
                st.executeUpdateDelete().toLong() to 0L
            }
        }
    }

    fun run(sql: String, params: JSONArray?): Pair<Long, Long> = exec(writableDatabase, sql, params)

    fun batch(statements: JSONArray) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            for (i in 0 until statements.length()) {
                val s = statements.getJSONObject(i)
                exec(db, s.getString("sql"), s.optJSONArray("params"))
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    companion object {
        @Volatile private var instance: Db? = null
        fun get(context: Context): Db = instance ?: synchronized(this) {
            instance ?: Db(context).also { instance = it }
        }
    }
}
