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

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.use(express.static(path.join(__dirname, "public")));

const LANG_RULES = {
  mr: { 
    name: "Marathi (Devanagari)", 
    script: "Reply STRICTLY in natural, simple Devanagari Marathi (Pune style). Avoid heavy trailing conjuncts like 'नक्कीच'—use lighter words like 'नक्की'. Keep responses clean and conversational without bullet points." 
  },
  hi: { 
    name: "Hindi (Devanagari)", 
    script: "Use clean, spoken Hindi in Devanagari script." 
  },
  "hi-roman": { 
    name: "Roman Hindi", 
    script: "Use natural spoken Hindi in English letters." 
  },
  en: { 
    name: "Indian English", 
    script: "Reply in simple, friendly Indian English conversational style." 
  }
};

function detectLanguage(text) {
  const t = text.toLowerCase().trim();
  
  if (
    /[\u0900-\u097f]/.test(t) ||
    /\b(marathi|madhe|bol|bola|kay|kaay|karat|kart|aahe|ahe|mala|tula|kasa|kashi|kuthe|nahi|sang|nav|naav|naave|song|sanga|tujhe|majha)\b/i.test(t)
  ) {
    return "mr";
  }

  if (/\b(kaise|kaisa|kaisi|kya|aap|tum|main|mujhe|tumhe|hai|hoon|kyun|kahan|batao|hindi|naam)\b/i.test(t)) {
    return "hi-roman";
  }

  return "en";
}

app.get("/api/history", (req, res) => {
  db.all("SELECT * FROM interactions ORDER BY id DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.delete("/api/history", (req, res) => {
  db.run("DELETE FROM interactions", [], err => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "History cleared" });
  });
});

wss.on("connection", ws => {
  ws.on("message", async msg => {
    try {
      const { type, text } = JSON.parse(msg);
      if (type !== "USER_PROMPT" || !text) return;

      const lang = detectLanguage(text);
      const cleanText = text.toLowerCase().replace(/[^\w\s\u0900-\u097f]/g, "").trim();

      // 1. Direct Intercept for Language Switch
      if (/\b(marathi madhe bol|marathi madhe bola|marathi bol|marathi bola|speak in marathi)\b/i.test(cleanText)) {
        const marathiResponse = "हो, नक्की! मी आता तुमच्याशी मराठीत बोलेन. सांगा, मी तुम्हाला कशी मदत करू?";
        db.run("INSERT INTO interactions (user_prompt, agent_response) VALUES (?, ?)", [text, marathiResponse]);
        ws.send(JSON.stringify({ type: "AGENT_RESPONSE", text: marathiResponse, language: "mr" }));
        return;
      }

      // 2. Direct Intercept for Identity / Name
      if (
        (/\b(nav|naav|naam|name|नाव)\b/i.test(cleanText) && /\b(kay|kaay|kya|what|kon|who|काय)\b/i.test(cleanText)) ||
        /\b(tu kon aahes|tu kon ahes|who are you|tumhara naam kya hai|तू कोण आहेस)\b/i.test(cleanText)
      ) {
        let nameResponse = `माझे नाव ${ASSISTANT_NAME} आहे. सांग, मी तुला कशी मदत करू?`;
        if (lang === "hi") nameResponse = `मेरा नाम ${ASSISTANT_NAME} है। बताइए, मैं आपकी क्या मदद कर सकती हूँ?`;
        else if (lang === "hi-roman") nameResponse = `Mera naam ${ASSISTANT_NAME} hai. Batao, main aapki kya madad karoon?`;
        else if (lang === "en") nameResponse = `My name is ${ASSISTANT_NAME}. How can I help you today?`;

        db.run("INSERT INTO interactions (user_prompt, agent_response) VALUES (?, ?)", [text, nameResponse]);
        ws.send(JSON.stringify({ type: "AGENT_RESPONSE", text: nameResponse, language: lang }));
        return;
      }

      // 3. Direct Intercept for Greetings
      if (/^(hello|hi|hey|namaste|namaskar|नमस्कार)\b/i.test(cleanText)) {
        let greetingResponse = "नमस्कार! मी तुला कशी मदत करू शकते?";
        if (lang === "hi") greetingResponse = "नमस्ते! मैं आपकी क्या मदद कर सकती हूँ?";
        else if (lang === "hi-roman") greetingResponse = "Namaste! Main aapki kya madad kar sakti hoon?";
        else if (lang === "en") greetingResponse = "Hello! How can I help you today?";

        db.run("INSERT INTO interactions (user_prompt, agent_response) VALUES (?, ?)", [text, greetingResponse]);
        ws.send(JSON.stringify({ type: "AGENT_RESPONSE", text: greetingResponse, language: lang }));
        return;
      }

      // 4. Groq Dynamic Call
      const rule = LANG_RULES[lang] || LANG_RULES.en;
      
      const completion = await groq.chat.completions.create({
        messages: [
          {
            role: "system",
            content: `Your name is ${ASSISTANT_NAME}. You are an Indian female voice assistant. Target Language: ${rule.name}. Rule: ${rule.script} Keep responses short, concise, and easy to speak aloud.`
          },
          { role: "user", content: text }
        ],
        model: "openai/gpt-oss-120b",
        temperature: 0.7,
        max_tokens: 300,
      });

      const answer = completion.choices[0]?.message?.content?.trim();

      if (!answer) {
        throw new Error("No response received from model.");
      }

      db.run("INSERT INTO interactions (user_prompt, agent_response) VALUES (?, ?)", [text, answer]);
      ws.send(JSON.stringify({ type: "AGENT_RESPONSE", text: answer, language: lang }));

    } catch (err) {
      console.error("Groq API Error:", err.message);
      ws.send(JSON.stringify({ type: "ERROR", message: err.message }));
    }
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));