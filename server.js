import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import Groq from "groq-sdk";
import db from "./database.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const ASSISTANT_NAME = "Aarya";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

app.use(express.static(path.join(__dirname, "public")));

const LANG_RULES = {
  mr: {
    name: "Marathi",
    script:
      "Reply only in simple conversational Marathi using Devanagari. Use natural Pune-style spoken Marathi."
  },

  hi: {
    name: "Hindi",
    script:
      "Reply only in simple natural spoken Hindi using Devanagari."
  },

  "hi-roman": {
    name: "Roman Hindi",
    script:
      "Reply only in natural spoken Hindi using English letters."
  },

  en: {
    name: "Indian English",
    script:
      "Reply in simple natural conversational Indian English."
  }
};

// ================= LANGUAGE =================

function detectLanguage(text) {
  const t = text.toLowerCase().trim();

  if (
    /[\u0900-\u097f]/.test(t) ||
    /\b(marathi|madhe|bol|bola|kay|kaay|karat|kart|aahe|ahe|mala|tula|kasa|kashi|kuthe|nahi|sang|sanga|naav|nav|tujhe|majha)\b/i.test(t)
  ) {
    return "mr";
  }

  if (
    /\b(kaise|kaisa|kaisi|kya|aap|tum|main|mujhe|tumhe|hai|hoon|kyun|kahan|batao|hindi|naam)\b/i.test(t)
  ) {
    return "hi-roman";
  }

  return "en";
}

// ================= HISTORY =================

app.get("/api/history", (req, res) => {
  db.all(
    "SELECT * FROM interactions ORDER BY id DESC",
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      res.json(rows || []);
    }
  );
});

app.delete("/api/history", (req, res) => {
  db.run("DELETE FROM interactions", [], err => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    res.json({ message: "History cleared" });
  });
});

// ================= WEBSOCKET =================

wss.on("connection", ws => {
  ws.on("message", async msg => {
    try {
      const { type, text } = JSON.parse(msg);

      if (type !== "USER_PROMPT" || !text) return;

      const lang = detectLanguage(text);
      const cleanText = text
        .toLowerCase()
        .replace(/[^\w\s\u0900-\u097f]/g, "")
        .trim();

      // Marathi request
      if (
        /\b(marathi madhe bol|marathi madhe bola|marathi bol|marathi bola|speak in marathi)\b/i.test(
          cleanText
        )
      ) {
        const response =
          "हो नक्कीच! मी आता तुमच्याशी मराठीत बोलेन. सांगा, मी तुम्हाला कशी मदत करू?";

        saveAndSend(text, response, "mr", ws);
        return;
      }

      // Name
      if (
        (/\b(nav|naav|naam|name|नाव)\b/i.test(cleanText) &&
          /\b(kay|kaay|kya|what|kon|who|काय)\b/i.test(cleanText)) ||
        /\b(who are you|tu kon aahes|tu kon ahes|tumhara naam kya hai)\b/i.test(
          cleanText
        )
      ) {
        let response;

        if (lang === "mr") {
          response =
            `माझे नाव ${ASSISTANT_NAME} आहे. सांग, मी तुला कशी मदत करू?`;
        } else if (lang === "hi-roman") {
          response =
            `Mera naam ${ASSISTANT_NAME} hai. Batao, main aapki kya madad karoon?`;
        } else {
          response =
            `My name is ${ASSISTANT_NAME}. How can I help you today?`;
        }

        saveAndSend(text, response, lang, ws);
        return;
      }

      // Greetings
      if (/^(hello|hi|hey|namaste|namaskar|नमस्कार)\b/i.test(cleanText)) {
        let response;

        if (lang === "mr") {
          response = "नमस्कार! मी तुम्हाला कशी मदत करू शकते?";
        } else if (lang === "hi-roman") {
          response = "Namaste! Main aapki kya madad kar sakti hoon?";
        } else {
          response = "Hello! How can I help you today?";
        }

        saveAndSend(text, response, lang, ws);
        return;
      }

      // ================= GROQ =================

      const rule = LANG_RULES[lang] || LANG_RULES.en;

      const completion = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",

        messages: [
          {
            role: "system",
            content: `
You are ${ASSISTANT_NAME}, a friendly Indian female voice assistant.

Target language: ${rule.name}

${rule.script}

IMPORTANT VOICE RULES:

Speak like a real person having a friendly conversation.

Do not sound like a textbook or robot.

Write sentences that are easy and natural to speak aloud.

Keep answers short, usually 1 to 3 sentences.

Use simple everyday words.

Use commas and full stops naturally so the voice has pauses.

Do not use markdown.

Do not use bullet points.

Do not use headings.

Do not use emojis.

Do not repeat the question.

Do not give unnecessarily long explanations.

Sound warm, friendly and conversational.
`
          },
          {
            role: "user",
            content: text
          }
        ],

        temperature: 0.8,
        max_tokens: 180
      });

      const answer =
        completion.choices[0]?.message?.content?.trim();

      if (!answer) {
        throw new Error("No response received from Groq.");
      }

      saveAndSend(text, answer, lang, ws);

    } catch (err) {
      console.error("Groq API Error:", err.message);

      ws.send(
        JSON.stringify({
          type: "ERROR",
          message: err.message
        })
      );
    }
  });
});

// ================= SAVE + SEND =================

function saveAndSend(userText, response, language, ws) {
  db.run(
    "INSERT INTO interactions (user_prompt, agent_response) VALUES (?, ?)",
    [userText, response]
  );

  ws.send(
    JSON.stringify({
      type: "AGENT_RESPONSE",
      text: response,
      language
    })
  );
}

// ================= SERVER =================

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Assistant: ${ASSISTANT_NAME}`);
});