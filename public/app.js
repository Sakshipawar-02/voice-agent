const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);

const [start, stop, status, user, answer, table, clear] = 
  ["startMicBtn", "stopAgentBtn", "statusIndicator", "userQuery", "agentAnswer", "dashboardTable", "clearBtn"].map(id => document.getElementById(id));

// === SPEECH TO TEXT (STT) LOGIC ===
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
      speechSynthesis.cancel();
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

// === TEXT TO SPEECH (TTS) LOGIC (FORCE FEMALE MARATHI/HINDI VOICE) ===
function speak(text, language) {
  speechSynthesis.cancel();

  const isDevanagari = /[\u0900-\u097F]/.test(text);

  const speakNow = () => {
    const voices = speechSynthesis.getVoices();
    let voice = null;

    // Filter female voices explicitly and exclude male voices (Ravi, David, Male, etc.)
    const isFemaleVoice = (v) => {
      const name = v.name.toLowerCase();
      return (
        name.includes("female") ||
        name.includes("swara") ||
        name.includes("kalpana") ||
        name.includes("heera") ||
        name.includes("neerja") ||
        name.includes("sangeeta") ||
        name.includes("zira") ||
        name.includes("google") ||
        name.includes("natural")
      ) && !name.includes("david") && !name.includes("ravi") && !name.includes("male");
    };

    if (isDevanagari) {
      voice =
        voices.find(v => (v.lang.includes("mr") || v.lang.includes("hi")) && isFemaleVoice(v)) ||
        voices.find(v => v.lang.includes("mr-IN") || v.lang.includes("hi-IN"));
    } else {
      voice =
        voices.find(v => v.lang.includes("en-IN") && isFemaleVoice(v)) ||
        voices.find(v => isFemaleVoice(v));
    }

    const utterance = new SpeechSynthesisUtterance(text);

    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else {
      utterance.lang = isDevanagari ? "hi-IN" : "en-IN";
    }

    // Force higher pitch (1.35) and slightly slower speech rate (0.88) to guarantee female tone
    utterance.rate = 0.88;
    utterance.pitch = 1.35;

    utterance.onstart = () => { if (status) status.innerText = "🔊 Speaking..."; };
    utterance.onend = () => { if (status) status.innerText = "Ready"; };

    speechSynthesis.speak(utterance);
  };

  if (speechSynthesis.getVoices().length > 0) {
    speakNow();
  } else {
    speechSynthesis.onvoiceschanged = speakNow;
  }
}

if (stop) {
  stop.onclick = () => {
    speechSynthesis.cancel();
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