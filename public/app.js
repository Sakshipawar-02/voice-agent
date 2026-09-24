const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);

const [start, stop, status, user, answer, table, clear] = 
  ["startMicBtn", "stopAgentBtn", "statusIndicator", "userQuery", "agentAnswer", "dashboardTable", "clearBtn"].map(id => document.getElementById(id));

// === SPEECH TO TEXT (STT) LOGIC ===
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SR) {
  status.innerText = "Use Chrome";
  start.disabled = true;
} else {
  const recognition = new SR();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = "en-IN";

  start.onclick = () => {
    speechSynthesis.cancel();
    try { recognition.start(); } catch {}
  };

  recognition.onstart = () => {
    status.innerText = "🎤 Listening...";
    start.innerText = "🎤 Listening...";
  };

  recognition.onend = () => {
    start.innerText = "🎤 Start Listening";
  };

  recognition.onerror = e => {
    status.innerText = "Mic Error: " + e.error;
    start.innerText = "🎤 Start Listening";
  };

  recognition.onresult = e => {
    const text = e.results[0][0].transcript.trim();
    user.innerText = text;
    answer.innerText = "Thinking...";
    status.innerText = "Processing...";

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "USER_PROMPT", text }));
    }
  };
}

ws.onopen = () => status.innerText = "Ready";

ws.onmessage = e => {
  const data = JSON.parse(e.data);

  if (data.type === "AGENT_RESPONSE") {
    answer.innerText = data.text;
    speak(data.text, data.language);
    fetchHistory();
  }

  if (data.type === "ERROR") {
    answer.innerText = "Error: " + data.message;
    status.innerText = "Error";
  }
};

// === TEXT TO SPEECH (TTS) LOGIC ===
function speak(text, language) {
  speechSynthesis.cancel();

  const isDevanagari = /[\u0900-\u097F]/.test(text);

  const speakNow = () => {
    const voices = speechSynthesis.getVoices();
    let voice = null;

    if (isDevanagari) {
      voice = voices.find(v => v.lang.toLowerCase().includes("hi-in") || 
                               v.lang.toLowerCase().includes("mr-in") || 
                               v.name.toLowerCase().includes("hindi") ||
                               v.name.toLowerCase().includes("marathi"));
    } else {
      voice = voices.find(v => v.name.includes("Google") && (v.lang === "en-IN" || v.lang === "hi-IN")) ||
              voices.find(v => v.lang.toLowerCase() === "en-in") ||
              voices.find(v => v.lang.toLowerCase() === "hi-in") ||
              voices.find(v => v.name.toLowerCase().includes("india")) ||
              voices.find(v => v.name.toLowerCase().includes("heera")) ||
              voices.find(v => v.name.toLowerCase().includes("neerja")) ||
              voices.find(v => v.name.toLowerCase().includes("ravi")) ||
              voices.find(v => v.name.toLowerCase().includes("sangeeta"));
    }

    const utterance = new SpeechSynthesisUtterance(text);

    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
      utterance.rate = 0.92;
      utterance.pitch = 1.0;
    } else {
      utterance.lang = "en-IN";
      utterance.rate = 0.88;
      utterance.pitch = 0.95;
    }

    utterance.onstart = () => status.innerText = "🔊 Speaking...";
    utterance.onend = () => status.innerText = "Ready";

    speechSynthesis.speak(utterance);
  };

  if (speechSynthesis.getVoices().length > 0) {
    speakNow();
  } else {
    speechSynthesis.onvoiceschanged = speakNow;
  }
}

stop.onclick = () => {
  speechSynthesis.cancel();
  status.innerText = "Voice stopped";
};

async function fetchHistory() {
  try {
    const res = await fetch("/api/history");
    const rows = await res.json();

    table.innerHTML = rows.map(r => `
      <tr>
        <td>#${r.id}</td>
        <td>${new Date(r.created_at).toLocaleString()}</td>
        <td>${r.user_prompt}</td>
        <td>${r.agent_response}</td>
      </tr>
    `).join("");
  } catch (err) {
    console.error("Failed to load history:", err);
  }
}

clear.onclick = async () => {
  if (!confirm("Clear history?")) return;

  await fetch("/api/history", { method: "DELETE" });
  fetchHistory();
};

fetchHistory();