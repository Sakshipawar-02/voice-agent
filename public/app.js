const toggleAgentBtn = document.getElementById('toggleAgentBtn');
const statusBadge = document.getElementById('statusBadge');
const transcriptBox = document.getElementById('transcriptBox');

const silenceAfterSpeechMs = 1400;
const minimumSpeechMs = 700;
const speechRmsThreshold = 0.022;

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
  if (['en-in', 'mr-in'].includes(requested)) return false;
  utterance.voice = voices.find((voice) => voice.lang.toLowerCase().split('-')[0] === base) || null;
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

function speakReply(result, currentSession) {
  if (result.audioBase64 && typeof Audio !== 'undefined') {
    const player = new Audio(`data:audio/wav;base64,${result.audioBase64}`);
    replyAudio = player;
    assistantSpeaking = true;
    setStatus('Speaking…', 'active');
    player.onended = resumeListeningAfterReply;
    player.onerror = () => {
      if (!sessionActive || currentSession !== sessionId) return;
      replyAudio = null;
      assistantSpeaking = false;
      if (!speakWithDeviceVoice(result.reply, result.language)) resumeListeningAfterReply();
    };
    player.play().catch(() => player.onerror?.());
    return true;
  }
  return speakWithDeviceVoice(result.reply, result.language);
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
    const response = await fetch('/api/voice-chat', { method: 'POST', body: form });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
    if (!sessionActive || currentSession !== sessionId) return;

    addTurn(result.transcript, result.reply);
    history.push({ role: 'user', content: result.transcript }, { role: 'assistant', content: result.reply });
    history = history.slice(-10);
    const voicePlayed = speakReply(result, currentSession);
    voiceNotice = voicePlayed ? '' : 'For Indian English/Marathi voice, add SARVAM_API_KEY or install en-IN/mr-IN voices.';
    if (!voicePlayed) addOutputNotice('I could not play a voice reply. Check that audio is enabled and add SARVAM_API_KEY on the server for Indian English and Marathi.');
  } catch (error) {
    if (sessionActive && currentSession === sessionId) addOutputNotice(error.message || 'I could not process that recording. Please try again.');
  } finally {
    requestInProgress = false;
    if (sessionActive && currentSession === sessionId && !assistantSpeaking) beginRecording();
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
  if (replyAudio) replyAudio.pause();
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
