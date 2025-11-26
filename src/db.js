const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

// Ensure data directory exists
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
}

const db = new Database(path.join(dataDir, 'youtube2podcast.db'));

// Initialize DB
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user', -- 'admin' or 'user'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    youtube_id TEXT UNIQUE,
    title TEXT,
    file_path TEXT,
    original_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migrations: Add new columns to episodes if they don't exist
const columns = db.prepare("PRAGMA table_info(episodes)").all();
const columnNames = columns.map(c => c.name);

if (!columnNames.includes('user_id')) {
    db.exec("ALTER TABLE episodes ADD COLUMN user_id INTEGER REFERENCES users(id)");
}
if (!columnNames.includes('status')) {
    db.exec("ALTER TABLE episodes ADD COLUMN status TEXT DEFAULT 'ready'"); // 'processing', 'ready', 'error'
}
if (!columnNames.includes('thumbnail_url')) {
    db.exec("ALTER TABLE episodes ADD COLUMN thumbnail_url TEXT");
}
if (!columnNames.includes('translation_status')) {
    db.exec("ALTER TABLE episodes ADD COLUMN translation_status TEXT"); // null, 'processing', 'ready', 'error'
}
if (!columnNames.includes('translated_file_path')) {
    db.exec("ALTER TABLE episodes ADD COLUMN translated_file_path TEXT");
}

// Seed Users
const seedUsers = () => {
    const usersToCreate = [
        { username: 'admin', password: 'admin', role: 'admin' },
        { username: 'user', password: 'user', role: 'user' },
        { username: 'test1', password: 'password', role: 'user' },
        { username: 'test2', password: 'password', role: 'user' }
    ];

    const insertStmt = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)');
    const checkStmt = db.prepare('SELECT * FROM users WHERE username = ?');

    usersToCreate.forEach(u => {
        if (!checkStmt.get(u.username)) {
            const hash = bcrypt.hashSync(u.password, 10);
            insertStmt.run(u.username, hash, u.role);
            console.log(`User created: ${u.username}`);
        }
    });
};

seedUsers();

module.exports = {
  db,
  // User Management
  createUser: (username, password, role = 'user') => {
      const hash = bcrypt.hashSync(password, 10);
      try {
          return db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, hash, role);
      } catch (err) {
          if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
              throw new Error('Username already exists');
          }
          throw err;
      }
  },
  updateUser: (id, { username, password, role }) => {
      // Build dynamic query
      let query = 'UPDATE users SET ';
      const params = [];
      
      if (username) {
          query += 'username = ?, ';
          params.push(username);
      }
      if (password) {
          const hash = bcrypt.hashSync(password, 10);
          query += 'password_hash = ?, ';
          params.push(hash);
      }
      if (role) {
          query += 'role = ?, ';
          params.push(role);
      }

      // Remove trailing comma
      query = query.slice(0, -2);
      query += ' WHERE id = ?';
      params.push(id);

      if (params.length === 1) {
          // No updates
          return;
      }

      return db.prepare(query).run(...params);
  },
  getUserByUsername: (username) => {
      return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  },
  getUserById: (id) => {
      return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  },
  getAllUsers: () => {
      return db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC').all();
  },
  deleteUser: (id) => {
      return db.prepare('DELETE FROM users WHERE id = ?').run(id);
  },

  // Episode Management
  addEpisode: (episode) => {
    const stmt = db.prepare(`
      INSERT INTO episodes (youtube_id, title, file_path, original_url, user_id, status, thumbnail_url)
      VALUES (@youtube_id, @title, @file_path, @original_url, @user_id, @status, @thumbnail_url)
    `);
    return stmt.run(episode);
  },
  updateEpisodeStatus: (youtubeId, status, filePath = null) => {
      if (filePath) {
          return db.prepare('UPDATE episodes SET status = ?, file_path = ? WHERE youtube_id = ?').run(status, filePath, youtubeId);
      } else {
          return db.prepare('UPDATE episodes SET status = ? WHERE youtube_id = ?').run(status, youtubeId);
      }
  },
  getEpisodes: (userId = null) => {
    if (userId) {
        return db.prepare('SELECT * FROM episodes WHERE user_id = ? ORDER BY created_at DESC').all(userId);
    }
    return db.prepare('SELECT * FROM episodes ORDER BY created_at DESC').all();
  },
  getEpisodeById: (id) => {
    return db.prepare('SELECT * FROM episodes WHERE id = ?').get(id);
  },
  getEpisodeByYoutubeId: (youtubeId) => {
      return db.prepare('SELECT * FROM episodes WHERE youtube_id = ?').get(youtubeId);
  },
  deleteEpisode: (id) => {
      return db.prepare('DELETE FROM episodes WHERE id = ?').run(id);
  },
  deleteAllEpisodes: () => {
      return db.prepare('DELETE FROM episodes').run();
  },
  // Reset stale processing episodes (for server restart recovery)
  resetStaleProcessingEpisodes: () => {
      return db.prepare("UPDATE episodes SET status = 'error' WHERE status = 'processing'").run();
  },
  // Get episodes by multiple IDs (for status polling)
  getEpisodesByIds: (ids) => {
      if (!ids || ids.length === 0) return [];
      const placeholders = ids.map(() => '?').join(',');
      return db.prepare(`SELECT id, youtube_id, status, file_path, user_id, translation_status, translated_file_path FROM episodes WHERE id IN (${placeholders})`).all(...ids);
  },
  // Translation status management
  updateTranslationStatus: (youtubeId, status, translatedFilePath = null) => {
      if (translatedFilePath) {
          return db.prepare('UPDATE episodes SET translation_status = ?, translated_file_path = ? WHERE youtube_id = ?').run(status, translatedFilePath, youtubeId);
      } else {
          return db.prepare('UPDATE episodes SET translation_status = ? WHERE youtube_id = ?').run(status, youtubeId);
      }
  },
  updateTranslationStatusById: (id, status, translatedFilePath = null) => {
      if (translatedFilePath) {
          return db.prepare('UPDATE episodes SET translation_status = ?, translated_file_path = ? WHERE id = ?').run(status, translatedFilePath, id);
      } else {
          return db.prepare('UPDATE episodes SET translation_status = ? WHERE id = ?').run(status, id);
      }
  }
};
