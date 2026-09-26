import "dotenv/config";
import express from "express";
import http from "http";
import WebSocket from "ws";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import Groq from "groq-sdk";
import db from "./database.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const GROQ_MODEL = "llama-3.3-70b-versatile";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

const upload = multer({
  storage: multer.memoryStorage()
});

app.use(express.static(path.join(__dirname, "public")));

/* ---------- SARVAM STT ---------- */

app.post("/api/stt", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: "No audio received"
      });
    }

    const form = new FormData();

    form.append(
      "file",
      new Blob([req.file.buffer], {
        type: req.file.mimetype
      }),
      "voice.webm"
    );

    form.append("model", "saaras:v4");

    const response = await fetch(
      "https://api.sarvam.ai/speech-to-text",
      {
        method: "POST",
        headers: {
          "api-subscription-key": process.env.SARVAM_API_KEY
        },
        body: form
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data?.error?.message || "Sarvam STT failed"
      );
    }

    res.json({
      text: data.transcript,
      language: data.language_code
    });

  } catch (error) {
    console.error("STT ERROR:", error);

    res.status(500).json({
      error: error.message
    });
  }
});

/* ---------- SARVAM TTS ---------- */

async function generateVoice(text, language) {
  const response = await fetch(
    "https://api.sarvam.ai/text-to-speech",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": process.env.SARVAM_API_KEY
      },
      body: JSON.stringify({
        text: text,
        target_language_code: language,
        language_code: language,
        model: "bulbul:v3",
        speaker: "priya",
        pace: 0.95,
        speech_sample_rate: 24000,
        output_audio_codec: "wav"
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error?.message || "Sarvam TTS failed"
    );
  }

  return data.audios[0];
}

/* ---------- GROQ + SIRI ---------- */

wss.on("connection", ws => {
  console.log("Client connected");

  ws.on("message", async message => {
    try {
      const data = JSON.parse(message);

      if (data.type !== "USER_PROMPT") return;

      const text = data.text.trim();
      const language = data.language || "en-IN";

      console.log("User:", text);
      console.log("Language:", language);

      const result = await groq.chat.completions.create({
        model: GROQ_MODEL,

        messages: [
          {
            role: "system",
            content: `
You are SIRI, a friendly Indian female voice assistant.

Reply naturally like a real person speaking.

Keep answers short and conversational.

IMPORTANT LANGUAGE RULES:

If language is mr-IN:
Reply only in natural Marathi using Devanagari script.

If language is hi-IN:
Reply only in natural Hindi using Devanagari script.

If language is en-IN:
Reply only in natural Indian English.

Never change the user's language.

Do not use markdown.
Do not use bullets.
Do not use emojis.
Do not use asterisks.

Your response will be converted directly into voice.
Write exactly what SIRI should speak.
`
          },
          {
            role: "user",
            content: `Language: ${language}

User says:
${text}`
          }
        ],

        temperature: 0.7,
        max_tokens: 150
      });

      const answer =
        result.choices?.[0]?.message?.content?.trim() ||
        "Sorry, I could not understand that.";

      console.log("SIRI:", answer);

      const audio = await generateVoice(
        answer,
        language
      );

      db.run(
        `INSERT INTO interactions
        (user_query, agent_response)
        VALUES (?, ?)`,
        [text, answer]
      );

      ws.send(
        JSON.stringify({
          type: "AGENT_RESPONSE",
          text: answer,
          language: language,
          audio: audio,
          audioType: "audio/wav"
        })
      );

    } catch (error) {
      console.error("ERROR:", error);

      ws.send(
        JSON.stringify({
          type: "ERROR",
          message: error.message
        })
      );
    }
  });
});

/* ---------- HISTORY ---------- */

app.get("/api/history", (req, res) => {
  db.all(
    "SELECT * FROM interactions ORDER BY id DESC",
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({
          error: err.message
        });
      }

      res.json(rows);
    }
  );
});

app.delete("/api/history", (req, res) => {
  db.run(
    "DELETE FROM interactions",
    [],
    err => {
      if (err) {
        return res.status(500).json({
          error: err.message
        });
      }

      res.json({
        success: true
      });
    }
  );
});

/* ---------- SERVER ---------- */

server.listen(PORT, () => {
  console.log(
    `Server running: http://localhost:${PORT}`
  );

  console.log("Agent: SIRI");
  console.log("Groq:", GROQ_MODEL);
  console.log("STT: Sarvam Saaras v4");
  console.log("TTS: Sarvam Bulbul v3");
  console.log("Voice: Priya");
});