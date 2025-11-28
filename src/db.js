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
if (!columnNames.includes('transcription_status')) {
    db.exec("ALTER TABLE episodes ADD COLUMN transcription_status TEXT"); // null, 'processing', 'ready', 'error'
}
if (!columnNames.includes('transcription_file_path')) {
    db.exec("ALTER TABLE episodes ADD COLUMN transcription_file_path TEXT");
}

// Create push subscriptions table
db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    keys_auth TEXT NOT NULL,
    keys_p256dh TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Create RSS feeds table for Podcast IA feature
db.exec(`
  CREATE TABLE IF NOT EXISTS rss_feeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    language TEXT DEFAULT 'en',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Create generated podcasts table for Podcast IA feature
db.exec(`
  CREATE TABLE IF NOT EXISTS generated_podcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    topic TEXT NOT NULL,
    title TEXT NOT NULL,
    file_path TEXT,
    script_text TEXT,
    status TEXT DEFAULT 'processing',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

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
  getEpisodes: (userId = null, { limit = 50, offset = 0 } = {}) => {
    if (userId) {
        return db.prepare('SELECT * FROM episodes WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(userId, limit, offset);
    }
    // For admin view, include username
    return db.prepare(`
        SELECT e.*, u.username as owner_username 
        FROM episodes e 
        LEFT JOIN users u ON e.user_id = u.id 
        ORDER BY e.created_at DESC
        LIMIT ? OFFSET ?
    `).all(limit, offset);
  },
  getEpisodesCount: (userId = null) => {
    if (userId) {
        return db.prepare('SELECT COUNT(*) as count FROM episodes WHERE user_id = ?').get(userId).count;
    }
    return db.prepare('SELECT COUNT(*) as count FROM episodes').get().count;
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
      return db.prepare(`SELECT id, youtube_id, status, file_path, user_id, translation_status, translated_file_path, transcription_status, transcription_file_path FROM episodes WHERE id IN (${placeholders})`).all(...ids);
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
  },
  // Transcription status management
  updateTranscriptionStatusById: (id, status, transcriptionFilePath = null) => {
      if (transcriptionFilePath) {
          return db.prepare('UPDATE episodes SET transcription_status = ?, transcription_file_path = ? WHERE id = ?').run(status, transcriptionFilePath, id);
      } else {
          return db.prepare('UPDATE episodes SET transcription_status = ? WHERE id = ?').run(status, id);
      }
  },

  // Push Subscription Management
  savePushSubscription: (userId, subscription) => {
      const { endpoint, keys } = subscription;
      try {
          return db.prepare(`
              INSERT OR REPLACE INTO push_subscriptions (user_id, endpoint, keys_auth, keys_p256dh)
              VALUES (?, ?, ?, ?)
          `).run(userId, endpoint, keys.auth, keys.p256dh);
      } catch (err) {
          console.error('Error saving push subscription:', err);
          throw err;
      }
  },
  getPushSubscriptionsByUserId: (userId) => {
      return db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  },
  deletePushSubscription: (endpoint) => {
      return db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  },

  // RSS Feeds Management
  addRssFeed: (feed) => {
      try {
          return db.prepare('INSERT INTO rss_feeds (name, url, category, language) VALUES (?, ?, ?, ?)').run(feed.name, feed.url, feed.category, feed.language || 'en');
      } catch (err) {
          if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
              throw new Error('Feed URL already exists');
          }
          throw err;
      }
  },
  getAllRssFeeds: () => {
      return db.prepare('SELECT * FROM rss_feeds ORDER BY category, name').all();
  },
  getRssFeedsByCategory: (category) => {
      return db.prepare('SELECT * FROM rss_feeds WHERE category = ?').all(category);
  },
  getRssFeedCategories: () => {
      return db.prepare('SELECT DISTINCT category FROM rss_feeds ORDER BY category').all().map(r => r.category);
  },
  deleteRssFeed: (id) => {
      return db.prepare('DELETE FROM rss_feeds WHERE id = ?').run(id);
  },

  // Generated Podcasts Management
  addGeneratedPodcast: (podcast) => {
      const stmt = db.prepare(`
          INSERT INTO generated_podcasts (user_id, topic, title, status)
          VALUES (@user_id, @topic, @title, @status)
      `);
      return stmt.run(podcast);
  },
  updateGeneratedPodcastStatus: (id, status, filePath = null, scriptText = null) => {
      if (filePath && scriptText) {
          return db.prepare('UPDATE generated_podcasts SET status = ?, file_path = ?, script_text = ? WHERE id = ?').run(status, filePath, scriptText, id);
      } else if (filePath) {
          return db.prepare('UPDATE generated_podcasts SET status = ?, file_path = ? WHERE id = ?').run(status, filePath, id);
      } else {
          return db.prepare('UPDATE generated_podcasts SET status = ? WHERE id = ?').run(status, id);
      }
  },
  getGeneratedPodcastsByUserId: (userId) => {
      return db.prepare('SELECT * FROM generated_podcasts WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  },
  getGeneratedPodcastById: (id) => {
      return db.prepare('SELECT * FROM generated_podcasts WHERE id = ?').get(id);
  },
  countGeneratedPodcastsByUserId: (userId) => {
      return db.prepare('SELECT COUNT(*) as count FROM generated_podcasts WHERE user_id = ?').get(userId).count;
  },
  getAllGeneratedPodcasts: () => {
      return db.prepare(`
          SELECT gp.*, u.username as owner_username 
          FROM generated_podcasts gp 
          LEFT JOIN users u ON gp.user_id = u.id 
          ORDER BY gp.created_at DESC
      `).all();
  },
  deleteGeneratedPodcast: (id) => {
      return db.prepare('DELETE FROM generated_podcasts WHERE id = ?').run(id);
  },

  // Admin Stats for Dashboard
  getAdminStats: () => {
      // Total counts
      const totalEpisodes = db.prepare('SELECT COUNT(*) as count FROM episodes').get().count;
      const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
      
      // Status distribution
      const statusDistribution = db.prepare(`
          SELECT 
              status,
              COUNT(*) as count 
          FROM episodes 
          GROUP BY status
      `).all();
      
      // Transcription status distribution
      const transcriptionDistribution = db.prepare(`
          SELECT 
              transcription_status,
              COUNT(*) as count 
          FROM episodes 
          WHERE transcription_status IS NOT NULL
          GROUP BY transcription_status
      `).all();
      
      // Translation status distribution
      const translationDistribution = db.prepare(`
          SELECT 
              translation_status,
              COUNT(*) as count 
          FROM episodes 
          WHERE translation_status IS NOT NULL
          GROUP BY translation_status
      `).all();
      
      // Episodes per day (last 7 days)
      const episodesPerDay = db.prepare(`
          SELECT 
              DATE(created_at) as date,
              COUNT(*) as count
          FROM episodes
          WHERE created_at >= DATE('now', '-7 days')
          GROUP BY DATE(created_at)
          ORDER BY date ASC
      `).all();
      
      // Top users by episode count
      const topUsers = db.prepare(`
          SELECT 
              u.username,
              COUNT(e.id) as episode_count
          FROM users u
          LEFT JOIN episodes e ON u.id = e.user_id
          GROUP BY u.id
          ORDER BY episode_count DESC
          LIMIT 5
      `).all();
      
      // Recent activity (last 10 episodes)
      const recentActivity = db.prepare(`
          SELECT 
              e.id,
              e.title,
              e.status,
              e.transcription_status,
              e.translation_status,
              e.created_at,
              u.username
          FROM episodes e
          LEFT JOIN users u ON e.user_id = u.id
          ORDER BY e.created_at DESC
          LIMIT 10
      `).all();
      
      return {
          totalEpisodes,
          totalUsers,
          statusDistribution,
          transcriptionDistribution,
          translationDistribution,
          episodesPerDay,
          topUsers,
          recentActivity
      };
  }
};
