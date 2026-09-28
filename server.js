import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import multer from 'multer';
import Groq, { toFile } from 'groq-sdk';
import { SarvamAIClient } from 'sarvamai';
import { initDB, saveConversation, getConversations } from './database.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT) || 3000;
const groq = process.env.GROQ_API_KEY && !process.env.GROQ_API_KEY.includes('your_actual')
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;
const sarvam = process.env.SARVAM_API_KEY
  ? new SarvamAIClient({ apiSubscriptionKey: process.env.SARVAM_API_KEY })
  : null;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});
const requestWindows = new Map();
const languageNames = {
  arabic: 'ar', bengali: 'bn', chinese: 'zh', dutch: 'nl', english: 'en', farsi: 'fa',
  french: 'fr', german: 'de', gujarati: 'gu', hindi: 'hi', indonesian: 'id', italian: 'it',
  japanese: 'ja', kannada: 'kn', korean: 'ko', malayalam: 'ml', marathi: 'mr', nepali: 'ne',
  persian: 'fa', polish: 'pl', portuguese: 'pt', punjabi: 'pa', russian: 'ru', spanish: 'es',
  swahili: 'sw', tamil: 'ta', telugu: 'te', thai: 'th', turkish: 'tr', ukrainian: 'uk',
  urdu: 'ur', vietnamese: 'vi'
};

function normalizeLanguageTag(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return 'en';
  const languageNameTag = languageNames[normalized.toLowerCase()];
  if (languageNameTag) return ['en', 'mr'].includes(languageNameTag) ? `${languageNameTag}-IN` : languageNameTag;
  try {
    const locale = new Intl.Locale(normalized).toString();
    const baseLanguage = locale.split('-')[0].toLowerCase();
    return ['en', 'mr'].includes(baseLanguage) ? `${baseLanguage}-IN` : locale;
  } catch {
    return 'en';
  }
}

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));
initDB();

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'voice-agent', aiConfigured: Boolean(groq), indianVoiceConfigured: Boolean(sarvam) });
});

app.get('/api/history', async (req, res) => {
  try {
    res.json({ success: true, logs: await getConversations() });
  } catch (error) {
    console.error('[DB] Could not load conversation history:', error);
    res.status(500).json({ success: false, error: 'Could not load conversation history.' });
  }
});

function limitVoiceRequests(req, res, next) {
  const now = Date.now();
  const key = req.ip;
  const window = requestWindows.get(key);
  if (!window || now - window.startedAt >= 60_000) {
    requestWindows.set(key, { startedAt: now, count: 1 });
    return next();
  }
  if (window.count >= 20) {
    return res.status(429).json({ error: 'Too many voice messages. Wait a minute and try again.' });
  }
  window.count += 1;
  next();
}

// Transcribe first so the client can correct the recognized text before requesting an answer.
app.post('/api/voice-chat', limitVoiceRequests, upload.single('audio'), async (req, res) => {
  if (!groq) {
    return res.status(503).json({ error: 'The server is missing its GROQ_API_KEY environment variable.' });
  }
  const correctedText = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!req.file && !correctedText) {
    return res.status(400).json({ error: 'Record a message before sending it.' });
  }

  try {
    let userText = correctedText;
    if (!userText) {
      const audioFile = await toFile(req.file.buffer, req.file.originalname || 'voice.webm', {
        type: req.file.mimetype || 'audio/webm'
      });
      const selectedLanguage = ['mr', 'en'].includes(req.body.speechLanguage) ? req.body.speechLanguage : null;
      const transcription = await groq.audio.transcriptions.create({
        file: audioFile,
        model: process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo',
        response_format: 'json',
        ...(selectedLanguage ? { language: selectedLanguage } : {}),
        ...(selectedLanguage === 'mr' ? { prompt: 'मराठी भाषेतील शब्द देवनागरी लिपीत लिहा.' } : {})
      });
      userText = transcription.text?.trim();
    }
    if (!userText) {
      return res.status(422).json({ error: 'I could not hear any speech. Try again closer to the microphone.' });
    }
    if (userText.length > 5000) {
      return res.status(413).json({ error: 'Keep each message under 5,000 characters.' });
    }
    if (req.body.transcribeOnly === 'true') {
      return res.json({ transcript: userText });
    }

    let history = [];
    try {
      const parsed = JSON.parse(req.body.history || '[]');
      if (Array.isArray(parsed)) {
        history = parsed
          .filter((item) => ['user', 'assistant'].includes(item?.role) && typeof item.content === 'string')
          .slice(-10)
          .map(({ role, content }) => ({ role, content: content.slice(0, 2000) }));
      }
    } catch {
      // Ignore malformed optional history and answer this utterance as a new conversation.
    }

    const responseLanguage = ['mr', 'en'].includes(req.body.speechLanguage) ? req.body.speechLanguage : null;
    const languageInstruction = responseLanguage === 'mr'
      ? 'The user selected Marathi. Reply only in natural, conversational Marathi written in Devanagari script, and set language to mr-IN. The transcription may be written in Latin letters or contain speech recognition errors; interpret it as Marathi. Do not reply in Hindi.'
      : responseLanguage === 'en'
        ? 'The user selected Indian English. Reply only in natural Indian English and set language to en-IN.'
        : null;

    const completion = await groq.chat.completions.create({
      model: process.env.GROQ_CHAT_MODEL || 'openai/gpt-oss-20b',
      messages: [
        {
          role: 'system',
          content: 'You are a friendly, concise multilingual voice assistant. Reply in the same language and writing script as the user’s latest message. If the user mixes languages, naturally mirror that mix. Do not switch to English unless asked. Keep answers natural and suitable for speaking aloud.'
        },
        ...(languageInstruction ? [{ role: 'system', content: languageInstruction }] : []),
        ...history,
        { role: 'user', content: userText }
      ],
      max_tokens: 300,
      temperature: 0.6,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'multilingual_voice_reply',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              reply: { type: 'string' },
              language: { type: 'string', description: 'BCP-47 language tag for the reply, such as en, hi, es, or fr.' }
            },
            required: ['reply', 'language'],
            additionalProperties: false
          }
        }
      }
    });
    const answer = JSON.parse(completion.choices[0]?.message?.content || '{}');
    const reply = answer.reply?.trim();
    const language = responseLanguage === 'mr'
      ? 'mr-IN'
      : responseLanguage === 'en'
        ? 'en-IN'
        : normalizeLanguageTag(answer.language);
    if (!reply) throw new Error('Groq returned an empty response.');

    let audioBase64 = null;
    let voiceError = null;
    if (['en-IN', 'mr-IN'].includes(language)) {
      if (!sarvam) {
        voiceError = 'Indian voice is not configured. Add SARVAM_API_KEY in Render → Environment, then redeploy.';
      } else if (reply.length > 2500) {
        voiceError = 'This reply is too long for one voice clip. Ask me to give a shorter answer.';
      } else {
        try {
          const speech = await sarvam.textToSpeech.convert({
            text: reply,
            model: 'bulbul:v3',
            language_code: language,
            speaker: process.env.SARVAM_TTS_SPEAKER || 'ishita',
            pace: 0.95,
            output_audio_codec: 'wav'
          });
          audioBase64 = speech.audios?.[0] || null;
          if (!audioBase64) voiceError = 'The Indian voice service returned no audio. Check the Render logs.';
        } catch (error) {
          console.error('[Sarvam] Indian voice synthesis failed:', error);
          voiceError = 'Indian voice generation failed. Check the SARVAM_API_KEY and Render logs.';
        }
      }
    }

    try {
      await saveConversation(userText, reply);
    } catch (error) {
      // Conversation still succeeds if persistence is temporarily unavailable.
      console.error('[DB] Could not save conversation:', error);
    }
    res.json({ transcript: userText, reply, language, audioBase64, voiceError });
  } catch (error) {
    console.error('[Groq] Voice request failed:', error);
    const status = error.status === 401 ? 503 : 502;
    const message = error.status === 401
      ? 'Groq rejected the API key. Check GROQ_API_KEY in your server environment.'
      : 'Groq could not process that message. Check the server logs and try again.';
    res.status(status).json({ error: message });
  }
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'That recording is too large. Keep each message under 20 MB.' });
  }
  console.error('[Server] Request failed:', error);
  res.status(400).json({ error: 'The request could not be processed.' });
});

app.listen(port, () => {
  console.log(`Voice Agent server listening on port ${port}`);
  if (!groq) console.warn('GROQ_API_KEY is not configured. Add it to the server environment to enable voice chat.');
});
