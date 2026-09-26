import "dotenv/config";
import express from "express";
import http from "http";
import WebSocket from "ws";
import path from "path";
import { fileURLToPath } from "url";
import Groq from "groq-sdk";
import { SarvamAI } from "sarvamai";
import db from "./database.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const MODEL = "llama-3.3-70b-versatile";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

const sarvam = new SarvamAI({
  apiSubscriptionKey: process.env.SARVAM_API_KEY
});

app.use(express.static(path.join(__dirname, "public")));

function detectLanguage(text) {
  if (/[\u0900-\u097F]/.test(text)) {
    if (/काय|कसा|कशी|कसे|तू|तुम्ही|मी|मला|तुला|आहे|नाही|करत|कुठे/.test(text))
      return "mr-IN";

    return "hi-IN";
  }

  if (/\b(kay|kasa|kashi|kase|mi|mala|tula|tumhi|aahe|nahi|karat|kuthe)\b/i.test(text))
    return "mr-IN";

  if (/\b(hai|hain|aap|tum|mera|mujhe|kya|kaise|nahi)\b/i.test(text))
    return "hi-IN";

  return "en-IN";
}

async function generateVoice(text, language) {
  const response = await sarvam.textToSpeech.convert({
    text,
    languageCode: language,
    model: "bulbul:v3",
    speaker: "priya",
    pace: 1.0
  });

  return response.audios[0];
}

wss.on("connection", ws => {
  console.log("Client connected");

  ws.on("message", async message => {
    try {
      const data = JSON.parse(message);

      if (data.type !== "USER_PROMPT") return;

      const text = data.text.trim();
      const language = detectLanguage(text);

      const result = await groq.chat.completions.create({
        model: MODEL,
        messages: [
          {
            role: "system",
            content: `
You are SIRI, a friendly Indian female voice assistant.

Reply naturally and conversationally.
Keep replies short.
Use the same language as the user.

For Marathi, use proper Marathi Devanagari.
For Hindi, use proper Hindi Devanagari.
For English, use natural Indian English.

Never answer in a different language.
Do not use markdown, bullets or symbols.
`
          },
          {
            role: "user",
            content: text
          }
        ],
        temperature: 0.7,
        max_tokens: 150
      });

      const answer =
        result.choices?.[0]?.message?.content?.trim() ||
        "Sorry, I could not understand that.";

      const audio = await generateVoice(answer, language);

      db.run(
        `INSERT INTO interactions (user_query, agent_response)
         VALUES (?, ?)`,
        [text, answer]
      );

      ws.send(JSON.stringify({
        type: "AGENT_RESPONSE",
        text: answer,
        language,
        audio,
        audioType: "audio/wav"
      }));

    } catch (error) {
      console.error(error);

      ws.send(JSON.stringify({
        type: "ERROR",
        message: error.message || "Something went wrong"
      }));
    }
  });
});

app.get("/api/history", (req, res) => {
  db.all(
    "SELECT * FROM interactions ORDER BY id DESC",
    [],
    (err, rows) => {
      if (err)
        return res.status(500).json({ error: err.message });

      res.json(rows);
    }
  );
});

app.delete("/api/history", (req, res) => {
  db.run("DELETE FROM interactions", [], err => {
    if (err)
      return res.status(500).json({ error: err.message });

    res.json({ success: true });
  });
});

server.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
  console.log("Agent: SIRI");
  console.log("Groq Model:", MODEL);
  console.log("Sarvam TTS: Bulbul v3");
});