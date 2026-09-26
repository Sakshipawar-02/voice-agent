document.addEventListener("DOMContentLoaded", () => {
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const clearBtn = document.getElementById("clearBtn");
  const statusDiv = document.getElementById("status");
  const transcriptDiv = document.getElementById("transcript");
  const voiceSelect = document.getElementById("voiceSelect");

  let ws;
  let recognition;
  let isListening = false;
  let synth = window.speechSynthesis;
  let voices = [];

  // 1. Populate Speech Synthesis Voices
  function populateVoices() {
    voices = synth.getVoices();
    voiceSelect.innerHTML = "";

    if (voices.length === 0) return;

    voices.forEach((voice, index) => {
      const option = document.createElement("option");
      option.value = index;
      option.textContent = `${voice.name} (${voice.lang})`;
      
      if (
        (voice.lang.includes("IN") || voice.lang.includes("hi") || voice.lang.includes("mr")) &&
        (voice.name.toLowerCase().includes("female") || voice.name.toLowerCase().includes("google") || voice.name.toLowerCase().includes("natural"))
      ) {
        option.selected = true;
      }
      voiceSelect.appendChild(option);
    });
  }

  populateVoices();
  if (speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.onvoiceschanged = populateVoices;
  }

  // 2. Setup WebSocket Connection
  function connectWebSocket() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}`;
    
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      statusDiv.textContent = "Connected. Ready to speak.";
      statusDiv.style.color = "green";
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === "AGENT_RESPONSE") {
          appendMessage("Agent", data.text);
          speakResponse(data.text, data.language);
        } else if (data.type === "ERROR") {
          statusDiv.textContent = `Error: ${data.message}`;
          statusDiv.style.color = "red";
        }
      } catch (e) {
        console.error("Failed to parse WebSocket message", e);
      }
    };

    ws.onclose = () => {
      statusDiv.textContent = "Disconnected. Reconnecting...";
      statusDiv.style.color = "orange";
      setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = (err) => {
      console.error("WebSocket error:", err);
    };
  }

  connectWebSocket();

  // 3. Web Speech Recognition Setup
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    statusDiv.textContent = "Browser does not support Speech Recognition. Please use Chrome.";
    statusDiv.style.color = "red";
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = "en-IN";

  recognition.onstart = () => {
    isListening = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    statusDiv.textContent = "Listening... Speak now.";
    statusDiv.style.color = "blue";
  };

  recognition.onresult = (event) => {
    const userText = event.results[0][0].transcript;
    appendMessage("You", userText);

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "USER_PROMPT", text: userText }));
      statusDiv.textContent = "Thinking...";
      statusDiv.style.color = "purple";
    }
  };

  recognition.onerror = (event) => {
    console.error("Speech recognition error:", event.error);
    statusDiv.textContent = `Recognition error: ${event.error}`;
    statusDiv.style.color = "red";
    resetButtons();
  };

  recognition.onend = () => {
    resetButtons();
  };

  // 4. Speech Synthesis Function
  function speakResponse(text, langCode) {
    if (synth.speaking) {
      synth.cancel();
    }

    const utterance = new SpeechSynthesisUtterance(text);
    
    utterance.rate = 0.95;
    utterance.pitch = 1.0;

    if (voiceSelect.value !== "") {
      utterance.voice = voices[voiceSelect.value];
    } else {
      const matchedVoice = voices.find(v => 
        (langCode === "mr" && v.lang.includes("mr")) ||
        (langCode === "hi" && v.lang.includes("hi")) ||
        v.lang.includes("IN")
      );
      if (matchedVoice) utterance.voice = matchedVoice;
    }

    utterance.onstart = () => {
      statusDiv.textContent = "Speaking...";
      statusDiv.style.color = "green";
    };

    utterance.onend = () => {
      statusDiv.textContent = "Ready.";
      statusDiv.style.color = "green";
    };

    synth.speak(utterance);
  }

  // 5. Helper Functions
  function appendMessage(sender, text) {
    const msgDiv = document.createElement("div");
    msgDiv.className = sender === "You" ? "user-msg" : "agent-msg";
    msgDiv.innerHTML = `<strong>${sender}:</strong> ${text}`;
    transcriptDiv.appendChild(msgDiv);
    transcriptDiv.scrollTop = transcriptDiv.scrollHeight;
  }

  function resetButtons() {
    isListening = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    if (statusDiv.textContent === "Listening...") {
      statusDiv.textContent = "Ready.";
      statusDiv.style.color = "green";
    }
  }

  // 6. UI Event Listeners
  startBtn.addEventListener("click", () => {
    if (synth.speaking) synth.cancel();
    recognition.start();
  });

  stopBtn.addEventListener("click", () => {
    recognition.stop();
    resetButtons();
  });

  clearBtn.addEventListener("click", async () => {
    transcriptDiv.innerHTML = "";
    try {
      await fetch("/api/history", { method: "DELETE" });
      statusDiv.textContent = "History cleared.";
    } catch (e) {
      console.error("Failed to clear history", e);
    }
  });

  async function loadHistory() {
    try {
      const res = await fetch("/api/history");
      const rows = await res.json();
      if (Array.isArray(rows)) {
        rows.reverse().forEach(row => {
          appendMessage("You", row.user_prompt);
          appendMessage("Agent", row.agent_response);
        });
      }
    } catch (e) {
      console.error("Failed to load history", e);
    }
  }

  loadHistory();
});