let socket = null;
let audioContext = null;
let mediaStream = null;
let scriptProcessor = null;

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusBadge = document.getElementById('statusBadge');
const transcriptBox = document.getElementById('transcriptBox');

function setStatus(text, state = 'normal') {
  statusBadge.textContent = text;
  statusBadge.className = 'status-badge';
  if (state === 'active') statusBadge.classList.add('active');
  if (state === 'error') statusBadge.classList.add('error');
}

function appendLog(text) {
  const line = document.createElement('div');
  line.style.marginBottom = '0.5rem';
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  transcriptBox.appendChild(line);
  transcriptBox.scrollTop = transcriptBox.scrollHeight;
}

startBtn.addEventListener('click', async () => {
  try {
    startBtn.disabled = true;
    setStatus('Connecting...');
    transcriptBox.innerHTML = '';
    appendLog('Initializing session...');

    // 1. Initialize AudioContext directly inside user click handler
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    // 2. Request microphone access
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    appendLog('Microphone access granted.');

    // 3. Resolve dynamic WebSocket path (works on localhost and production HTTPS/WSS)
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      setStatus('Connected & Streaming', 'active');
      stopBtn.disabled = false;
      appendLog('WebSocket connected. Streaming audio...');

      // Send start control signal
      socket.send(JSON.stringify({ type: 'start' }));

      // 4. Hook up audio node processing
      const source = audioContext.createMediaStreamSource(mediaStream);
      scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);

      source.connect(scriptProcessor);
      scriptProcessor.connect(audioContext.destination);

      scriptProcessor.onaudioprocess = (e) => {
        if (!socket || socket.readyState !== WebSocket.OPEN) return;

        const inputBuffer = e.inputBuffer.getChannelData(0);
        // Convert Float32 to 16-bit PCM Int16Array
        const pcmBuffer = new Int16Array(inputBuffer.length);
        for (let i = 0; i < inputBuffer.length; i++) {
          pcmBuffer[i] = Math.max(-1, Math.min(1, inputBuffer[i])) * 0x7fff;
        }

        socket.send(pcmBuffer.buffer);
      };
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'status') {
          appendLog(data.message);
        } else if (data.text) {
          appendLog(`AI: ${data.text}`);
        }
      } catch (e) {
        console.log('Raw message received:', event.data);
      }
    };

    socket.onerror = (err) => {
      console.error('WebSocket Error:', err);
      setStatus('Connection Error', 'error');
      appendLog('WebSocket encountered an error.');
      stopSession();
    };

    socket.onclose = () => {
      setStatus('Disconnected');
      appendLog('WebSocket connection closed.');
      stopSession();
    };

  } catch (err) {
    console.error('Error starting voice agent:', err);
    setStatus('Mic Access Denied / Error', 'error');
    appendLog(`Error: ${err.message}`);
    startBtn.disabled = false;
  }
});

stopBtn.addEventListener('click', () => {
  stopSession();
});

function stopSession() {
  if (scriptProcessor) {
    scriptProcessor.disconnect();
    scriptProcessor = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (socket) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
    socket = null;
  }

  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus('Disconnected');
}