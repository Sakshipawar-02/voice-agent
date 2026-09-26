const startBtn = document.getElementById('startBtn');
const sendBtn = document.getElementById('sendBtn');
const stopBtn = document.getElementById('stopBtn');
const statusBadge = document.getElementById('statusBadge');
const transcriptBox = document.getElementById('transcriptBox');

let mediaStream = null;
let recorder = null;
let audioChunks = [];
let history = [];
let requestInProgress = false;
let assistantSpeaking = false;

function setStatus(text, state = 'normal') {
  statusBadge.textContent = text;
  statusBadge.className = 'status-badge';
  if (state === 'active') statusBadge.classList.add('active');
  if (state === 'error') statusBadge.classList.add('error');
}

function appendLog(label, text) {
  const line = document.createElement('div');
  line.style.marginBottom = '0.75rem';
  const heading = document.createElement('strong');
  heading.textContent = `${label}: `;
  line.append(heading, document.createTextNode(text));
  transcriptBox.appendChild(line);
  transcriptBox.scrollTop = transcriptBox.scrollHeight;
}

function supportedAudioType() {
  if (!window.MediaRecorder) return '';
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
    .find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function beginRecording() {
  if (!mediaStream || requestInProgress) return;
  const mimeType = supportedAudioType();
  if (!mimeType) {
    setStatus('Recording unsupported', 'error');
    appendLog('Error', 'This browser cannot record audio in a format supported by the voice service. Try current Chrome or Edge.');
    return;
  }

  audioChunks = [];
  recorder = new MediaRecorder(mediaStream, { mimeType });
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size) audioChunks.push(event.data);
  });
  recorder.start();
  setStatus('Listening…', 'active');
  sendBtn.disabled = false;
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  setStatus('Requesting microphone…');
  transcriptBox.replaceChildren();
  history = [];

  try {
    const healthResponse = await fetch('/api/health');
    const health = await healthResponse.json();
    if (!health.aiConfigured) {
      throw new Error('GROQ_API_KEY is missing from the deployed server environment. Add it there, then restart or redeploy.');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone access needs HTTPS (or localhost) and a supported browser.');
    }
    if (!supportedAudioType()) {
      throw new Error('Audio recording is not supported by this browser. Try current Chrome or Edge.');
    }
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    sendBtn.disabled = false;
    stopBtn.disabled = false;
    appendLog('Ready', 'Speak, then choose Send to AI.');
    beginRecording();
  } catch (error) {
    console.error('Could not start microphone:', error);
    const message = error.name === 'NotAllowedError'
      ? 'Allow microphone access in your browser, then try again.'
      : error.name === 'NotFoundError'
        ? 'No microphone was found. Connect one, then try again.'
        : error.message || 'Could not start microphone.';
    setStatus('Unable to start', 'error');
    appendLog('Error', message);
    startBtn.disabled = false;
  }
});

sendBtn.addEventListener('click', async () => {
  if (!recorder || recorder.state !== 'recording' || requestInProgress) return;

  requestInProgress = true;
  sendBtn.disabled = true;
  setStatus('Preparing audio…');
  await new Promise((resolve) => {
    recorder.addEventListener('stop', resolve, { once: true });
    recorder.stop();
  });

  const blob = new Blob(audioChunks, { type: recorder.mimeType });
  const extension = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
  if (!blob.size) {
    requestInProgress = false;
    appendLog('Error', 'No audio was recorded. Try speaking again.');
    beginRecording();
    return;
  }

  setStatus('Transcribing and thinking…');
  appendLog('You', 'Processing your message…');
  const form = new FormData();
  form.append('audio', blob, `voice.${extension}`);
  form.append('history', JSON.stringify(history));

  try {
    const response = await fetch('/api/voice-chat', { method: 'POST', body: form });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);

    // Replace the temporary processing line with the actual transcription.
    transcriptBox.lastElementChild?.remove();
    appendLog('You', result.transcript);
    appendLog('AI', result.reply);
    history.push({ role: 'user', content: result.transcript }, { role: 'assistant', content: result.reply });
    history = history.slice(-10);
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      assistantSpeaking = true;
      setStatus('Speaking response…', 'active');
      const utterance = new SpeechSynthesisUtterance(result.reply);
      utterance.onend = utterance.onerror = () => {
        assistantSpeaking = false;
        if (mediaStream?.active && !requestInProgress) beginRecording();
      };
      window.speechSynthesis.speak(utterance);
    }
    if (!assistantSpeaking) setStatus('Listening…', 'active');
  } catch (error) {
    console.error('Voice request failed:', error);
    setStatus('Request failed', 'error');
    appendLog('Error', error.message);
  } finally {
    requestInProgress = false;
    if (mediaStream?.active && !assistantSpeaking) beginRecording();
    else startBtn.disabled = false;
  }
});

stopBtn.addEventListener('click', () => {
  if (recorder?.state === 'recording') recorder.stop();
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  recorder = null;
  audioChunks = [];
  sendBtn.disabled = true;
  stopBtn.disabled = true;
  startBtn.disabled = requestInProgress;
  setStatus('Disconnected');
});
