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
    script: "Reply STRICTLY in authentic Devanagari Marathi (Pune dialect). Do NOT use English letters." 
  },
  hi: { 
    name: "Hindi (Devanagari)", 
    script: "Use proper Hindi Devanagari script." 
  },
  "hi-roman": { 
    name: "Roman Hindi", 
    script: "Use Hindi in English letters." 
  },
  en: { 
    name: "Indian English", 
    script: "Reply in natural Indian English." 
  }
};

function detectLanguage(text) {
  const t = text.toLowerCase().trim();
  
  if (
    /[\u0900-\u097f]/.test(t) ||
    /\b(marathi|madhe|bol|kay|kaay|karat|kart|aahe|ahe|mala|tula|kasa|kashi|kuthe|nahi|sang|nav|naav|naave|song|sanga|tujhe|majha)\b/i.test(t)
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

      // Direct Intercept for Language Change Request
      if (/\b(marathi madhe bol|marathi bol|speak in marathi)\b/i.test(cleanText)) {
        const marathiResponse = "हो नक्कीच! मी आता तुमच्याशी मराठीत बोलेन. सांगा, मी तुम्हाला कशी मदत करू?";
        db.run("INSERT INTO interactions (user_prompt, agent_response) VALUES (?, ?)", [text, marathiResponse]);
        ws.send(JSON.stringify({ type: "AGENT_RESPONSE", text: marathiResponse, language: "mr" }));
        return;
      }

      // Direct Intercept for Greetings (ONLY reply with time-based greetings if explicitly requested)
      if (/^(good morning|good afternoon|good evening|say good afternoon)\b/i.test(cleanText)) {
        let greetingResponse = "शुभ दुपार! मी तुला कशी मदत करू शकते?";
        if (lang === "hi") greetingResponse = "शुभ दोपहर! मैं आपकी क्या मदद कर सकती हूँ?";
        else if (lang === "hi-roman") greetingResponse = "Shubh dopahar! Main aapki kya madad kar sakti hoon?";
        else if (lang === "en") greetingResponse = "Good afternoon! How can I help you today?";

        db.run("INSERT INTO interactions (user_prompt, agent_response) VALUES (?, ?)", [text, greetingResponse]);
        ws.send(JSON.stringify({ type: "AGENT_RESPONSE", text: greetingResponse, language: lang }));
        return;
      }

      // Direct Intercept for Identity / Name Questions
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

      // Groq Model Cascade Execution with Active Fallback Models
      const rule = LANG_RULES[lang] || LANG_RULES.en;
      const messagesPayload = [
        {
          role: "system",
          content: `Your name is ${ASSISTANT_NAME}. You are a female AI assistant.
Target Language: ${rule.name}.
Rule: ${rule.script}
CRITICAL INSTRUCTION: Do NOT include greetings like "Good afternoon", "Good morning", or "Namaste" unless the user explicitly asks for a greeting.
Grammar Rule: ALWAYS use female self-referencing verbs (e.g., in Marathi use 'मी करू शकते', 'मी सांगेन', 'माझे नाव आर्या आहे').
Keep answers short, clear, and direct (1-2 sentences).`
        },
        { role: "user", content: text }
      ];

      const candidateModels = [
        "llama-3.3-70b-versatile",
        "mixtral-8x7b-32768",
        "gemma2-9b-it"
      ];

      let answer = null;
      let lastError = null;

      for (const model of candidateModels) {
        try {
          const completion = await groq.chat.completions.create({
            messages: messagesPayload,
            model: model,
            temperature: 0.7,
            max_tokens: 300,
          });
          answer = completion.choices[0]?.message?.content?.trim();
          if (answer) break;
        } catch (err) {
          console.warn(`Model ${model} failed: ${err.message}. Trying fallback...`);
          lastError = err;
        }
      }

      if (!answer) {
        throw new Error(lastError ? lastError.message : "Failed to retrieve response from active Groq models.");
      }

      db.run("INSERT INTO interactions (user_prompt, agent_response) VALUES (?, ?)", [text, answer]);
      ws.send(JSON.stringify({ type: "AGENT_RESPONSE", text: answer, language: lang }));

    } catch (err) {
      console.error("Error:", err.message);
      ws.send(JSON.stringify({ type: "ERROR", message: err.message }));
    }
  });
});

server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));