const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
}

const db = new Database(path.join(dataDir, 'youtube2podcast.db'));

// Initialize DB
db.exec(`
  CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    youtube_id TEXT UNIQUE,
    title TEXT,
    file_path TEXT,
    original_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

module.exports = {
  db,
  addEpisode: (episode) => {
    const stmt = db.prepare(`
      INSERT INTO episodes (youtube_id, title, file_path, original_url)
      VALUES (@youtube_id, @title, @file_path, @original_url)
    `);
    return stmt.run(episode);
  },
  getEpisodes: () => {
    return db.prepare('SELECT * FROM episodes ORDER BY created_at DESC').all();
  },
  getEpisodeById: (id) => {
    return db.prepare('SELECT * FROM episodes WHERE id = ?').get(id);
  },
  getEpisodeByYoutubeId: (youtubeId) => {
      return db.prepare('SELECT * FROM episodes WHERE youtube_id = ?').get(youtubeId);
  },
  deleteAllEpisodes: () => {
      return db.prepare('DELETE FROM episodes').run();
  }
};

