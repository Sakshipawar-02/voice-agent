import fs from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let dataFile;
let nextId = 1;
let pendingWrites = Promise.resolve();

// Use a line based JSON store so deployment doesn't depend on a platform-specific
// SQLite native binary. Set DATA_DIR to a mounted disk path to retain logs on Render.
export function initDB() {
  const dataDirectory = path.resolve(process.env.DATA_DIR || __dirname);
  fs.mkdirSync(dataDirectory, { recursive: true });
  dataFile = path.join(dataDirectory, 'conversations.jsonl');
  try {
    const contents = fs.readFileSync(dataFile, 'utf8');
    for (const line of contents.split('\n')) {
      try {
        const row = JSON.parse(line);
        if (Number.isInteger(row.id)) nextId = Math.max(nextId, row.id + 1);
      } catch {
        // Ignore an incomplete final line left by an interrupted write.
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export function saveConversation(userPrompt, agentResponse) {
  if (!dataFile) throw new Error('Conversation store has not been initialized.');
  const row = {
    id: nextId++,
    user_prompt: userPrompt,
    agent_response: agentResponse,
    timestamp: new Date().toISOString().slice(0, 19).replace('T', ' ')
  };
  const write = pendingWrites.then(() => appendFile(dataFile, `${JSON.stringify(row)}\n`, 'utf8'));
  pendingWrites = write.catch(() => {});
  return write.then(() => row.id);
}

export async function getConversations() {
  if (!dataFile) throw new Error('Conversation store has not been initialized.');
  await pendingWrites;
  try {
    const contents = await readFile(dataFile, 'utf8');
    return contents.split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.id - a.id);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
