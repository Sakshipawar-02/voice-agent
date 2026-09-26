import sqlite3 from "sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.resolve(__dirname, "interactions.db");
const db = new sqlite3.Database(dbPath);

export function initDB() {
  db.serialize(() => {
    db.run(`
    CREATE TABLE IF NOT EXISTS interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_prompt TEXT NOT NULL,
      agent_response TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
    `);
  });
}

export function saveConversation(userPrompt, agentResponse) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO interactions (user_prompt, agent_response) VALUES (?, ?)',
      [userPrompt, agentResponse],
      function (err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

export function getConversations() {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM interactions ORDER BY timestamp DESC, id DESC', (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

export default db;
