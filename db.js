const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { sbConfigured, sbInsert, sbList, sbGet, sbDelete } = require('./supabase');

// Supabase PostgREST tables (production persistence, snake_case columns).
const T_USERS = 'nexis_users';
const T_ANALYSES = 'nexis_analyses';
const T_VECTORS = 'nexis_vectors';

const isVercel = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NOW_REGION;
const defaultDbDir = isVercel ? '/tmp' : __dirname;
const DB_PATH = process.env.DATABASE_PATH || path.join(defaultDbDir, 'nexis_insights.db');

let db;

function saveDb() {
  if (!db) return;
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (err) {
    console.error('[Database] Warning: Could not persist DB file:', err.message);
  }
}

let dbInitPromise = null;

async function initDb() {
  if (sbConfigured()) {
    console.log('☁️ Supabase PostgREST storage active (nexis_users / nexis_analyses / nexis_vectors)');
    return null;
  }
  if (db) return db;
  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      try {
        const wasmPath = path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
        const SQL = await initSqlJs(fs.existsSync(wasmPath) ? { locateFile: () => wasmPath } : {});

        if (fs.existsSync(DB_PATH)) {
          const fileBuffer = fs.readFileSync(DB_PATH);
          db = new SQL.Database(fileBuffer);
        } else {
          db = new SQL.Database();
        }

        // Create Users Table
        db.run(`
          CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // Create Feedback Analyses History Table
        db.run(`
          CREATE TABLE IF NOT EXISTS feedback_analyses (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            input_text TEXT NOT NULL,
            positive_pct INTEGER NOT NULL,
            neutral_pct INTEGER NOT NULL,
            negative_pct INTEGER NOT NULL,
            pain_points TEXT NOT NULL,
            feature_requests TEXT NOT NULL,
            executive_summary TEXT NOT NULL,
            price_intelligence TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id)
          )
        `);

        // Create Feedback Vectors RAG Table
        db.run(`
          CREATE TABLE IF NOT EXISTS feedback_vectors (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            feedback_text TEXT NOT NULL,
            source_tag TEXT DEFAULT 'General',
            sentiment TEXT DEFAULT 'Neutral',
            embedding_vector TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);

        saveDb();
        console.log('🗄️ SQLite Database Initialized via sql.js (nexis_insights.db)');
        return db;
      } catch (err) {
        console.error('[Database] Warning: SQLite WASM initialization issue:', err.message);
        return null;
      }
    })();
  }
  return dbInitPromise;
}

// jsonb columns may come back as native objects (PostgREST) or JSON strings
// (legacy sql.js rows) — normalize on read for backward compatibility.
function parseMaybeJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (e) { return fallback; }
  }
  return value;
}

async function createUser(name, email, passwordHash) {
  if (sbConfigured()) {
    const id = uuidv4();
    const normalizedEmail = String(email).toLowerCase();
    const row = await sbInsert(T_USERS, { id, name, email: normalizedEmail, password_hash: passwordHash });
    return { id: (row && row.id) || id, name, email: normalizedEmail };
  }

  const id = uuidv4();
  if (db) {
    try {
      db.run(
        'INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)',
        [id, name, email.toLowerCase(), passwordHash]
      );
      saveDb();
    } catch(err) {
      console.error('[Database] createUser error:', err.message);
    }
  }
  return { id, name, email: email.toLowerCase() };
}

async function findUserByEmail(email) {
  if (sbConfigured()) {
    const rows = await sbList(T_USERS, { filter: { email: `eq.${String(email).toLowerCase()}` }, limit: 1 });
    return rows[0] || null;
  }

  if (!db) return null;
  try {
    const res = db.exec('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (!res.length || !res[0].values.length) return null;
    const row = res[0].values[0];
    const columns = res[0].columns;
    const user = {};
    columns.forEach((col, idx) => user[col] = row[idx]);
    return user;
  } catch(err) {
    console.error('[Database] findUserByEmail error:', err.message);
    return null;
  }
}

async function findUserById(id) {
  if (sbConfigured()) {
    const row = await sbGet(T_USERS, id);
    if (!row) return null;
    return { id: row.id, name: row.name, email: row.email, created_at: row.created_at };
  }

  if (!db) return null;
  try {
    const res = db.exec('SELECT id, name, email, created_at FROM users WHERE id = ?', [id]);
    if (!res.length || !res[0].values.length) return null;
    const row = res[0].values[0];
    const columns = res[0].columns;
    const user = {};
    columns.forEach((col, idx) => user[col] = row[idx]);
    return user;
  } catch(err) {
    console.error('[Database] findUserById error:', err.message);
    return null;
  }
}

async function saveAnalysis(userId, inputText, data) {
  if (sbConfigured()) {
    const id = uuidv4();
    const row = await sbInsert(T_ANALYSES, {
      id,
      user_id: userId || null,
      input_text: inputText,
      positive_pct: data.positive_pct || 0,
      neutral_pct: data.neutral_pct || 0,
      negative_pct: data.negative_pct || 0,
      pain_points: data.pain_points || [],
      feature_requests: data.feature_requests || [],
      executive_summary: data.executive_summary || '',
      price_intelligence: data.price_intelligence || {}
    });
    return { id: (row && row.id) || id, userId, ...data };
  }

  const id = uuidv4();
  if (db) {
    try {
      const painPointsJson = JSON.stringify(data.pain_points || []);
      const featureReqsJson = JSON.stringify(data.feature_requests || []);
      const priceIntelJson = JSON.stringify(data.price_intelligence || {});

      db.run(
        `INSERT INTO feedback_analyses
         (id, user_id, input_text, positive_pct, neutral_pct, negative_pct, pain_points, feature_requests, executive_summary, price_intelligence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          userId || null,
          inputText,
          data.positive_pct || 0,
          data.neutral_pct || 0,
          data.negative_pct || 0,
          painPointsJson,
          featureReqsJson,
          data.executive_summary || '',
          priceIntelJson
        ]
      );
      saveDb();
    } catch(err) {
      console.error('[Database] saveAnalysis error:', err.message);
    }
  }
  return { id, userId, ...data };
}

async function getUserHistory(userId) {
  if (sbConfigured()) {
    const rows = await sbList(T_ANALYSES, {
      filter: userId ? { user_id: `eq.${userId}` } : {},
      order: 'created_at.desc',
      limit: 50
    });
    return rows.map(r => ({
      ...r,
      pain_points: parseMaybeJson(r.pain_points, []),
      feature_requests: parseMaybeJson(r.feature_requests, []),
      price_intelligence: parseMaybeJson(r.price_intelligence, null)
    }));
  }

  if (!db) return [];
  try {
    let query = 'SELECT * FROM feedback_analyses ORDER BY created_at DESC LIMIT 50';
    let params = [];
    if (userId) {
      query = 'SELECT * FROM feedback_analyses WHERE user_id = ? ORDER BY created_at DESC LIMIT 50';
      params = [userId];
    }

    const res = db.exec(query, params);
    if (!res.length) return [];

    const columns = res[0].columns;
    return res[0].values.map(row => {
      const item = {};
      columns.forEach((col, idx) => item[col] = row[idx]);
      try { item.pain_points = JSON.parse(item.pain_points); } catch(e) {}
      try { item.feature_requests = JSON.parse(item.feature_requests); } catch(e) {}
      try { item.price_intelligence = JSON.parse(item.price_intelligence); } catch(e) {}
      return item;
    });
  } catch(err) {
    console.error('[Database] getUserHistory error:', err.message);
    return [];
  }
}

async function deleteAnalysis(id, userId) {
  if (sbConfigured()) {
    const row = await sbGet(T_ANALYSES, id);
    if (!row) return true;
    if (userId && row.user_id && row.user_id !== userId) return true;
    await sbDelete(T_ANALYSES, id);
    return true;
  }

  if (db) {
    try {
      if (userId) {
        db.run('DELETE FROM feedback_analyses WHERE id = ? AND user_id = ?', [id, userId]);
      } else {
        db.run('DELETE FROM feedback_analyses WHERE id = ?', [id]);
      }
      saveDb();
    } catch(err) {
      console.error('[Database] deleteAnalysis error:', err.message);
    }
  }
  return true;
}

// RAG Vector Operations
async function saveVectorEntries(userId, items) {
  if (sbConfigured()) {
    if (!Array.isArray(items)) return [];
    const savedIds = [];
    for (const item of items) {
      const id = uuidv4();
      await sbInsert(T_VECTORS, {
        id,
        user_id: userId || 'anonymous',
        feedback_text: item.text,
        source_tag: item.source || 'Batch Input',
        sentiment: item.sentiment || 'Neutral',
        embedding_vector: item.vector || []
      });
      savedIds.push(id);
    }
    return savedIds;
  }

  if (!db || !Array.isArray(items)) return [];
  const savedIds = [];
  try {
    items.forEach(item => {
      const id = uuidv4();
      const vectorJson = JSON.stringify(item.vector || []);
      db.run(
        `INSERT INTO feedback_vectors (id, user_id, feedback_text, source_tag, sentiment, embedding_vector) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, userId || 'anonymous', item.text, item.source || 'Batch Input', item.sentiment || 'Neutral', vectorJson]
      );
      savedIds.push(id);
    });
    saveDb();
  } catch (err) {
    console.error('[Database] saveVectorEntries error:', err.message);
  }
  return savedIds;
}

async function getUserVectors(userId) {
  if (sbConfigured()) {
    const rows = await sbList(T_VECTORS, {
      filter: userId ? { user_id: `eq.${userId}` } : {},
      order: 'created_at.desc',
      limit: 500
    });
    return rows.map(r => ({ ...r, vector: parseMaybeJson(r.embedding_vector, []) }));
  }

  if (!db) return [];
  try {
    let query = 'SELECT * FROM feedback_vectors ORDER BY created_at DESC LIMIT 500';
    let params = [];
    if (userId) {
      query = 'SELECT * FROM feedback_vectors WHERE user_id = ? ORDER BY created_at DESC LIMIT 500';
      params = [userId];
    }
    const res = db.exec(query, params);
    if (!res.length) return [];
    const columns = res[0].columns;
    return res[0].values.map(row => {
      const item = {};
      columns.forEach((col, idx) => item[col] = row[idx]);
      try { item.vector = JSON.parse(item.embedding_vector); } catch(e) { item.vector = []; }
      return item;
    });
  } catch (err) {
    console.error('[Database] getUserVectors error:', err.message);
    return [];
  }
}

async function clearUserVectors(userId) {
  if (sbConfigured()) {
    const rows = await sbList(T_VECTORS, {
      filter: userId ? { user_id: `eq.${userId}` } : {},
      limit: 1000
    });
    for (const r of rows) {
      await sbDelete(T_VECTORS, r.id);
    }
    return true;
  }

  if (db) {
    try {
      if (userId) {
        db.run('DELETE FROM feedback_vectors WHERE user_id = ?', [userId]);
      } else {
        db.run('DELETE FROM feedback_vectors');
      }
      saveDb();
    } catch (err) {
      console.error('[Database] clearUserVectors error:', err.message);
    }
  }
  return true;
}

module.exports = {
  initDb,
  createUser,
  findUserByEmail,
  findUserById,
  saveAnalysis,
  getUserHistory,
  deleteAnalysis,
  saveVectorEntries,
  getUserVectors,
  clearUserVectors
};
