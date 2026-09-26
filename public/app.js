const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);

const [start, stop, status, user, answer, table, clear] = 
  ["startMicBtn", "stopAgentBtn", "statusIndicator", "userQuery", "agentAnswer", "dashboardTable", "clearBtn"].map(id => document.getElementById(id));

let currentAudio = null;

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SR) {
  if (status) status.innerText = "Use Chrome or Edge";
  if (start) start.disabled = true;
} else {
  const recognition = new SR();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = "en-IN";

  if (start) {
    start.onclick = () => {
      stopSpeaking();
      try { recognition.start(); } catch {}
    };
  }

  recognition.onstart = () => {
    if (status) status.innerText = "🎤 Listening...";
    if (start) start.innerText = "🎤 Listening...";
  };

  recognition.onend = () => {
    if (start) start.innerText = "🎤 Start Listening";
  };

  recognition.onerror = e => {
    if (status) status.innerText = "Mic Error: " + e.error;
    if (start) start.innerText = "🎤 Start Listening";
  };

  recognition.onresult = e => {
    const text = e.results[0][0].transcript.trim();
    if (user) user.innerText = text;
    if (answer) answer.innerText = "Thinking...";
    if (status) status.innerText = "Processing...";

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "USER_PROMPT", text }));
    }
  };
}

ws.onopen = () => {
  if (status) status.innerText = "Ready";
};

ws.onmessage = e => {
  const data = JSON.parse(e.data);

  if (data.type === "AGENT_RESPONSE") {
    if (answer) answer.innerText = data.text;
    speak(data.text, data.language);
    fetchHistory();
  }

  if (data.type === "ERROR") {
    if (answer) answer.innerText = "Error: " + data.message;
    if (status) status.innerText = "Error";
  }
};

function stopSpeaking() {
  speechSynthesis.cancel();
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
}

// Improved Natural Female Voice Configuration
function speak(text, language) {
  stopSpeaking();

  const isDevanagari = /[\u0900-\u097F]/.test(text);

  const speakNow = () => {
    const voices = speechSynthesis.getVoices();

    const isExplicitFemale = (v) => {
      const name = v.name.toLowerCase();
      const femaleKeywords = ["zira", "heera", "swara", "kalpana", "neerja", "sangeeta", "female", "natural", "google"];
      const maleKeywords = ["male", "david", "ravi", "hemant", "mark", "george"];
      return femaleKeywords.some(k => name.includes(k)) && !maleKeywords.some(k => name.includes(k));
    };

    let selectedVoice = null;

    if (isDevanagari) {
      selectedVoice = voices.find(v => (v.lang.includes("mr") || v.lang.includes("hi")) && isExplicitFemale(v)) ||
                      voices.find(v => v.lang.includes("hi") || v.lang.includes("mr"));
    } else {
      selectedVoice = voices.find(v => v.lang.includes("en-IN") && isExplicitFemale(v)) ||
                      voices.find(v => v.lang.includes("en") && isExplicitFemale(v));
    }

    if (selectedVoice) {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.voice = selectedVoice;
      utterance.lang = selectedVoice.lang;
      utterance.rate = 1.0;  // Standard natural speaking speed
      utterance.pitch = 1.15; // Natural warm female pitch level

      utterance.onstart = () => { if (status) status.innerText = "🔊 Speaking..."; };
      utterance.onend = () => { if (status) status.innerText = "Ready"; };
      speechSynthesis.speak(utterance);
    } else {
      const langCode = isDevanagari ? "mr" : "en";
      const encodedText = encodeURIComponent(text);
      const audioUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodedText}&tl=${langCode}&client=tw-ob`;

      currentAudio = new Audio(audioUrl);
      currentAudio.playbackRate = 1.0;

      if (status) status.innerText = "🔊 Speaking...";
      currentAudio.play().catch(() => {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = isDevanagari ? "hi-IN" : "en-IN";
        utterance.pitch = 1.20;
        utterance.rate = 0.95;
        utterance.onstart = () => { if (status) status.innerText = "🔊 Speaking..."; };
        utterance.onend = () => { if (status) status.innerText = "Ready"; };
        speechSynthesis.speak(utterance);
      });

      currentAudio.onended = () => {
        if (status) status.innerText = "Ready";
      };
    }
  };

  if (speechSynthesis.getVoices().length > 0) {
    speakNow();
  } else {
    speechSynthesis.onvoiceschanged = speakNow;
  }
}

if (stop) {
  stop.onclick = () => {
    stopSpeaking();
    if (status) status.innerText = "Voice stopped";
  };
}

async function fetchHistory() {
  try {
    const res = await fetch("/api/history");
    const rows = await res.json();

    if (table) {
      table.innerHTML = rows.map(r => `
        <tr>
          <td>#${r.id}</td>
          <td>${new Date(r.created_at).toLocaleString()}</td>
          <td>${r.user_prompt}</td>
          <td>${r.agent_response}</td>
        </tr>
      `).join("");
    }
  } catch (err) {
    console.error("Failed to load history:", err);
  }
}

if (clear) {
  clear.onclick = async () => {
    if (!confirm("Clear history?")) return;

    await fetch("/api/history", { method: "DELETE" });
    fetchHistory();
  };
}

fetchHistory();