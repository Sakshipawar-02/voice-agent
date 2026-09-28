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
  arabic: 'ar',
  bengali: 'bn',
  chinese: 'zh',
  dutch: 'nl',
  english: 'en',
  farsi: 'fa',
  french: 'fr',
  german: 'de',
  gujarati: 'gu',
  hindi: 'hi',
  indonesian: 'id',
  italian: 'it',
  japanese: 'ja',
  kannada: 'kn',
  korean: 'ko',
  malayalam: 'ml',
  marathi: 'mr',
  nepali: 'ne',
  odia: 'od',
  persian: 'fa',
  polish: 'pl',
  portuguese: 'pt',
  punjabi: 'pa',
  russian: 'ru',
  spanish: 'es',
  swahili: 'sw',
  tamil: 'ta',
  telugu: 'te',
  thai: 'th',
  turkish: 'tr',
  ukrainian: 'uk',
  urdu: 'ur',
  vietnamese: 'vi'
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

function inferReplyLanguage(text, reportedLanguage) {
  const normalizedText = String(text || '').toLowerCase();
  const marathiMarkers = [
    'kay', 'kaay', 'kai', 'nav', 'naav', 'mala', 'majha', 'majhi', 'maza', 'mazi',
    'tujhe', 'tujha', 'aahe', 'ahe', 'kasa', 'kashi', 'kuthe', 'kadhi', 'aapan', 'tumhi',
    'mhanje', 'ithe', 'tithe', 'zhala', 'zala', 'marathi', 'madhe', 'bol', 'bola'
  ];
  const markerCount = marathiMarkers.filter((word) =>
    new RegExp(`\\b${word}\\b`).test(normalizedText)
  ).length;
  const marathiScriptMarkers = ['मराठी', 'महाराठी', 'महाराधि', 'मध्ये', 'मधे', 'बोल'];
  const devanagariMarkerCount = marathiScriptMarkers.filter((word) => normalizedText.includes(word)).length;

  if (markerCount >= 2 || devanagariMarkerCount >= 2) return 'mr-IN';
  return reportedLanguage ? normalizeLanguageTag(reportedLanguage) : null;
}

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));
initDB();

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'voice-agent',
    aiConfigured: Boolean(groq),
    indianVoiceConfigured: Boolean(sarvam)
  });
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
    let detectedLanguage = null;
    if (!userText) {
      const audioFile = await toFile(req.file.buffer, req.file.originalname || 'voice.webm', {
        type: req.file.mimetype || 'audio/webm'
      });
      const transcription = await groq.audio.transcriptions.create({
        file: audioFile,
        model: process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo',
        response_format: 'verbose_json'
      });
      userText = transcription.text?.trim();
      detectedLanguage = typeof transcription.language === 'string'
        ? transcription.language.slice(0, 40)
        : null;
    }
    if (!userText) {
      return res.status(422).json({ error: 'I could not hear any speech. Try again closer to the microphone.' });
    }
    if (userText.length > 5000) {
      return res.status(413).json({ error: 'Keep each message under 5,000 characters.' });
    }
    if (req.body.transcribeOnly === 'true') {
      return res.json({ transcript: userText, detectedLanguage });
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

    const reportedSpeechLanguage = typeof req.body.detectedLanguage === 'string'
      ? req.body.detectedLanguage.slice(0, 40)
      : null;
    const detectedReplyLanguage = inferReplyLanguage(userText, reportedSpeechLanguage);
    const transcriptOverridesMetadata = detectedReplyLanguage === 'mr-IN'
      && reportedSpeechLanguage
      && normalizeLanguageTag(reportedSpeechLanguage) !== 'mr-IN';
    const languageInstruction = detectedReplyLanguage
      ? transcriptOverridesMetadata
        ? [
            'The transcript contains distinctive Marathi words, even if Whisper labeled the audio Hindi.',
            'Reply only in natural Marathi written in Devanagari.',
            'For example, “Tujhe nav kay?” means “तुझे नाव काय?” and is Marathi.',
            '“Marathi madhe bol” asks for a Marathi reply.',
            'Do not reply in Hindi.'
          ].join(' ')
        : [
            `Whisper identified the spoken audio as ${detectedReplyLanguage}.`,
            'Use this as a strong clue and reply only in that language using its normal writing system.',
            'The transcript may be written in Latin letters or contain speech recognition errors.',
            'Do not translate it or switch to a related language.'
          ].join(' ')
      : [
          'Infer the actual spoken language from the words and grammar, not from the script.',
          'The transcript may be romanized.',
          'For example, “tujhe nav kay” is Marathi, not Hindi; reply in Marathi using Devanagari.',
          'Reply in the speaker’s language using its normal writing system.'
        ].join(' ');

    const completion = await groq.chat.completions.create({
      model: process.env.GROQ_CHAT_MODEL || 'openai/gpt-oss-20b',
      messages: [
        {
          role: 'system',
          content: [
            'You are a friendly, concise multilingual voice assistant called Voice Assistant.',
            'If asked your name or identity, say you are the user’s voice assistant; never call yourself ChatGPT or OpenAI.',
            'Infer language from the spoken words, not just the script.',
            'Reply in that language and normal writing system.',
            'Keep replies short and natural for speech.'
          ].join(' ')
        },
        { role: 'system', content: languageInstruction },
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
    const sarvamLanguageBases = new Set(['en', 'hi', 'bn', 'ta', 'te', 'gu', 'kn', 'ml', 'mr', 'pa', 'od']);
    const detectedBaseLanguage = detectedReplyLanguage?.split('-')[0];
    const language = detectedReplyLanguage
      ? (sarvamLanguageBases.has(detectedBaseLanguage)
        ? `${detectedBaseLanguage}-IN`
        : detectedReplyLanguage)
      : normalizeLanguageTag(answer.language);
    if (!reply) throw new Error('Groq returned an empty response.');

    let audioBase64 = null;
    let voiceError = null;
    if (sarvamLanguageBases.has(language.split('-')[0]) && language.endsWith('-IN')) {
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
            speaker: process.env.SARVAM_TTS_SPEAKER || (language === 'mr-IN' ? 'priya' : 'ishita'),
            pace: 0.95,
            output_audio_codec: 'wav'
          });
          audioBase64 = speech.audios?.[0] || null;
          if (!audioBase64) voiceError = 'The Indian voice service returned no audio. Check the Render logs.';
        } catch (error) {
          const statusCode = error.statusCode || error.status;
          console.error('[Sarvam] Indian voice synthesis failed:', {
            statusCode,
            message: error.message,
            body: error.body
          });
          if (statusCode === 401 || statusCode === 403) {
            voiceError = [
              'Sarvam rejected the API key or this key does not have text-to-speech access.',
              'Check the key and account access in Sarvam.'
            ].join(' ');
          } else if (statusCode === 429) {
            voiceError = 'Sarvam voice quota or rate limit reached. Check your Sarvam account usage.';
          } else if (statusCode === 400 || statusCode === 422) {
            voiceError = [
              'Sarvam rejected the voice request.',
              'Check the speaker and language settings in the Render logs.'
            ].join(' ');
          } else {
            const errorStatus = statusCode ? ` (HTTP ${statusCode})` : '';
            voiceError = `Sarvam voice generation failed${errorStatus}. Check the Render logs for details.`;
          }
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
    const apiStatus = error.status || error.statusCode;
    const groqError = error.error?.error || error.error;
    const detail = typeof groqError?.message === 'string'
      ? groqError.message.replace(/[\r\n]+/g, ' ').slice(0, 240)
      : '';
    console.error('[Groq] Voice request failed:', {
      status: apiStatus,
      code: groqError?.code,
      message: detail || error.message
    });
    const status = [401, 403, 429].includes(apiStatus) ? 503 : 502;
    const message = apiStatus === 401 || apiStatus === 403
      ? 'Groq rejected the API key. Check GROQ_API_KEY in Render Environment.'
      : apiStatus === 429
        ? 'Groq rate limit or usage quota reached. Check your Groq account usage.'
        : apiStatus === 400 || apiStatus === 404
          ? `Groq rejected the request (HTTP ${apiStatus})${detail ? `: ${detail}` : '. Check Render logs.'}`
          : `Groq could not process that message${apiStatus ? ` (HTTP ${apiStatus})` : ''}. Check Render logs and try again.`;
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
