const toggleAgentBtn = document.getElementById('toggleAgentBtn');
const speechLanguage = document.getElementById('speechLanguage');
const statusBadge = document.getElementById('statusBadge');
const transcriptBox = document.getElementById('transcriptBox');
const correctionForm = document.getElementById('transcriptCorrection');
const correctedTranscript = document.getElementById('correctedTranscript');
const sendCorrectionBtn = document.getElementById('sendCorrection');
const discardCorrectionBtn = document.getElementById('discardCorrection');

const silenceAfterSpeechMs = 1200;
const minimumSpeechMs = 450;
const speechRmsThreshold = 0.015;

let sessionActive = false;
let starting = false;
let sessionId = 0;
let mediaStream = null;
let audioContext = null;
let analyser = null;
let analyserSamples = null;
let sourceNode = null;
let recorder = null;
let audioChunks = [];
let voiceStartedAt = 0;
let lastVoiceAt = 0;
let vadFrame = 0;
let requestInProgress = false;
let assistantSpeaking = false;
let replyAudio = null;
let history = [];
let voiceNotice = '';
let pendingCorrection = false;

function setStatus(text, state = 'normal') {
  if (!statusBadge) return;
  statusBadge.textContent = text;
  statusBadge.className = '';
  if (state === 'active') statusBadge.classList.add('active');
  if (state === 'error') statusBadge.classList.add('error');
}

function supportedAudioType() {
  if (!window.MediaRecorder) return '';
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
    .find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function addTurn(input, output) {
  const turn = document.createElement('article');
  turn.className = 'turn';
  for (const [label, text] of [['Input', input], ['Output', output]]) {
    const line = document.createElement('p');
    const heading = document.createElement('span');
    heading.className = 'label';
    heading.textContent = label;
    line.append(heading, document.createTextNode(text));
    turn.appendChild(line);
  }
  transcriptBox.appendChild(turn);
  transcriptBox.scrollTop = transcriptBox.scrollHeight;
}

function addOutputNotice(message) {
  const turn = document.createElement('article');
  turn.className = 'turn notice';
  const line = document.createElement('p');
  const heading = document.createElement('span');
  heading.className = 'label';
  heading.textContent = 'Output';
  line.append(heading, document.createTextNode(message));
  turn.appendChild(line);
  transcriptBox.appendChild(turn);
  transcriptBox.scrollTop = transcriptBox.scrollHeight;
}

function setDeviceVoice(utterance, languageTag) {
  utterance.lang = languageTag || 'en-IN';
  const requested = utterance.lang.toLowerCase();
  const base = requested.split('-')[0];
  const voices = window.speechSynthesis.getVoices();
  const exactVoice = voices.find((voice) => voice.lang.toLowerCase() === requested);
  if (exactVoice) {
    utterance.voice = exactVoice;
    return true;
  }
  // Many devices do not include Indian English or Marathi voices. Use the
  // closest installed voice so a missing Sarvam key does not silence replies.
  const fallbackBases = base === 'mr' ? ['hi', 'en'] : base === 'en' ? ['en'] : [base, 'en'];
  const matchingVoice = fallbackBases
    .flatMap((fallbackBase) => voices.filter((voice) => voice.lang.toLowerCase().split('-')[0] === fallbackBase))[0];
  utterance.voice = matchingVoice || voices[0] || null;
  // Some browsers populate their voice list after startup and can still use
  // their default voice while getVoices() is empty.
  return true;
}

function resumeListeningAfterReply() {
  assistantSpeaking = false;
  replyAudio = null;
  if (sessionActive && !requestInProgress) beginRecording();
}

function speakWithDeviceVoice(text, languageTag) {
  if (!('speechSynthesis' in window)) return false;
  const utterance = new SpeechSynthesisUtterance(text);
  if (!setDeviceVoice(utterance, languageTag)) return false;
  assistantSpeaking = true;
  setStatus('Speaking…', 'active');
  utterance.onend = utterance.onerror = resumeListeningAfterReply;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
  return true;
}

async function playSarvamAudio(base64Audio, currentSession) {
  if (!audioContext || audioContext.state !== 'running') return false;
  try {
    const binary = atob(base64Audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const audioBuffer = await audioContext.decodeAudioData(bytes.buffer);
    if (!sessionActive || currentSession !== sessionId) return false;

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    replyAudio = source;
    assistantSpeaking = true;
    setStatus('Speaking…', 'active');
    return await new Promise((resolve) => {
      source.addEventListener('ended', () => {
        if (replyAudio === source) resumeListeningAfterReply();
        resolve(true);
      }, { once: true });
      try {
        source.start();
      } catch {
        replyAudio = null;
        assistantSpeaking = false;
        resolve(false);
      }
    });
  } catch (error) {
    console.warn('[Voice] Could not decode or play the Indian voice audio:', error);
    replyAudio = null;
    assistantSpeaking = false;
    return false;
  }
}

async function speakReply(result, currentSession) {
  if (result.audioBase64 && await playSarvamAudio(result.audioBase64, currentSession)) return true;
  if (!sessionActive || currentSession !== sessionId) return false;
  return speakWithDeviceVoice(result.reply, result.language);
}

async function handleAssistantResult(result, currentSession) {
  if (!sessionActive || currentSession !== sessionId) return;
  correctionForm.hidden = true;
  addTurn(result.transcript, result.reply);
  history.push({ role: 'user', content: result.transcript }, { role: 'assistant', content: result.reply });
  history = history.slice(-10);
  const voicePlayed = await speakReply(result, currentSession);
  voiceNotice = voicePlayed ? '' : 'For Indian English/Marathi voice, add SARVAM_API_KEY or install en-IN/mr-IN voices.';
  if (!voicePlayed) addOutputNotice(result.voiceError || 'I could not play a voice reply. Check that audio is enabled and configure SARVAM_API_KEY for Indian English and Marathi.');
}

async function sendCorrectedTranscript(event) {
  event.preventDefault();
  const text = correctedTranscript.value.trim();
  if (!text || requestInProgress || !pendingCorrection) return;

  const currentSession = sessionId;
  pendingCorrection = false;
  requestInProgress = true;
  sendCorrectionBtn.disabled = true;
  discardCorrectionBtn.disabled = true;
  setStatus('Thinking…');
  try {
    const response = await fetch('/api/voice-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, history: JSON.stringify(history) })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
    result.transcript = text;
    await handleAssistantResult(result, currentSession);
  } catch (error) {
    if (sessionActive && currentSession === sessionId) {
      pendingCorrection = true;
      addOutputNotice(error.message || 'I could not process that message. Please try again.');
    }
  } finally {
    requestInProgress = false;
    sendCorrectionBtn.disabled = false;
    discardCorrectionBtn.disabled = false;
    if (sessionActive && currentSession === sessionId && !assistantSpeaking && !pendingCorrection) beginRecording();
    if (!sessionActive) toggleAgentBtn.disabled = false;
  }
}

function discardCorrectedTranscript() {
  pendingCorrection = false;
  correctionForm.hidden = true;
  if (sessionActive && !requestInProgress) beginRecording();
}

function beginRecording() {
  if (!sessionActive || requestInProgress || assistantSpeaking || !mediaStream) return;
  const mimeType = supportedAudioType();
  if (!mimeType) {
    addOutputNotice('This browser cannot record audio. Try the latest Chrome or Edge.');
    stopAgent();
    return;
  }

  audioChunks = [];
  voiceStartedAt = 0;
  lastVoiceAt = 0;
  recorder = new MediaRecorder(mediaStream, { mimeType });
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size) audioChunks.push(event.data);
  });
  recorder.start(250);
  setStatus(voiceNotice || 'Listening…', voiceNotice ? 'error' : 'active');
}

function monitorMicrophone() {
  if (!sessionActive || !analyser) return;
  const samples = analyserSamples;
  analyser.getFloatTimeDomainData(samples);
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  const rms = Math.sqrt(energy / samples.length);
  const now = performance.now();

  if (recorder?.state === 'recording' && !requestInProgress && !assistantSpeaking) {
    if (rms >= speechRmsThreshold) {
      if (!voiceStartedAt) voiceStartedAt = now;
      lastVoiceAt = now;
    } else if (
      voiceStartedAt &&
      now - lastVoiceAt >= silenceAfterSpeechMs &&
      lastVoiceAt - voiceStartedAt >= minimumSpeechMs
    ) {
      void submitUtterance(sessionId);
    }
  }
  vadFrame = requestAnimationFrame(monitorMicrophone);
}

function stopRecorderAndGetBlob() {
  const activeRecorder = recorder;
  recorder = null;
  if (!activeRecorder || activeRecorder.state !== 'recording') {
    return Promise.resolve(new Blob(audioChunks));
  }
  return new Promise((resolve) => {
    activeRecorder.addEventListener('stop', () => {
      resolve(new Blob(audioChunks, { type: activeRecorder.mimeType }));
    }, { once: true });
    activeRecorder.stop();
  });
}

async function submitUtterance(currentSession) {
  if (requestInProgress || !sessionActive || currentSession !== sessionId) return;
  requestInProgress = true;
  setStatus('Thinking…');

  try {
    const blob = await stopRecorderAndGetBlob();
    if (!sessionActive || currentSession !== sessionId) return;
    if (!blob.size) {
      setStatus('Listening…', 'active');
      requestInProgress = false;
      beginRecording();
      return;
    }

    const extension = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
    const form = new FormData();
    form.append('audio', blob, `voice.${extension}`);
    form.append('history', JSON.stringify(history));
    form.append('speechLanguage', speechLanguage.value);
    form.append('transcribeOnly', 'true');
    const response = await fetch('/api/voice-chat', { method: 'POST', body: form });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
    if (!sessionActive || currentSession !== sessionId) return;
    correctedTranscript.value = result.transcript || '';
    correctionForm.hidden = false;
    pendingCorrection = true;
    setStatus('Review and correct the transcript');
    correctedTranscript.focus();
  } catch (error) {
    if (sessionActive && currentSession === sessionId) addOutputNotice(error.message || 'I could not process that recording. Please try again.');
  } finally {
    requestInProgress = false;
    if (sessionActive && currentSession === sessionId && !assistantSpeaking && !pendingCorrection) beginRecording();
    if (!sessionActive) toggleAgentBtn.disabled = false;
  }
}

async function startAgent() {
  if (starting || requestInProgress) return;
  starting = true;
  toggleAgentBtn.disabled = true;
  setStatus('Starting…');
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone access requires HTTPS and a supported browser.');
    }
    if (!supportedAudioType()) throw new Error('Audio recording is not supported by this browser.');
    const healthResponse = await fetch('/api/health');
    const health = await healthResponse.json();
    if (!health.aiConfigured) throw new Error('The server is missing GROQ_API_KEY.');

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    await audioContext.resume();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyserSamples = new Float32Array(analyser.fftSize);
    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    sourceNode.connect(analyser);

    sessionId += 1;
    sessionActive = true;
    history = [];
    pendingCorrection = false;
    correctionForm.hidden = true;
    transcriptBox.replaceChildren();
    toggleAgentBtn.textContent = 'Stop voice agent';
    toggleAgentBtn.classList.add('active');
    toggleAgentBtn.disabled = false;
    beginRecording();
    monitorMicrophone();
  } catch (error) {
    if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
    const message = error.name === 'NotAllowedError'
      ? 'Microphone permission was denied. Allow microphone access in your browser, then start again.'
      : error.message || 'Could not start the voice agent.';
    addOutputNotice(message);
    toggleAgentBtn.disabled = false;
  } finally {
    starting = false;
  }
}

function stopAgent() {
  sessionActive = false;
  pendingCorrection = false;
  correctionForm.hidden = true;
  sessionId += 1;
  cancelAnimationFrame(vadFrame);
  if (recorder?.state === 'recording') recorder.stop();
  recorder = null;
  audioChunks = [];
  if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  sourceNode?.disconnect();
  sourceNode = null;
  analyser = null;
  analyserSamples = null;
  if (audioContext) void audioContext.close();
  audioContext = null;
  if (replyAudio) {
    try { replyAudio.stop(); } catch { /* It may have ended already. */ }
  }
  replyAudio = null;
  assistantSpeaking = false;
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  toggleAgentBtn.textContent = 'Start voice agent';
  toggleAgentBtn.classList.remove('active');
  toggleAgentBtn.disabled = requestInProgress;
  setStatus('Stopped');
}

toggleAgentBtn.addEventListener('click', () => {
  if (sessionActive) stopAgent();
  else void startAgent();
});
correctionForm.addEventListener('submit', sendCorrectedTranscript);
discardCorrectionBtn.addEventListener('click', discardCorrectedTranscript);
