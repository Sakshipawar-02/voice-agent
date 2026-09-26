const wsProtocol = window.location.protocol === "https:" ? "wss://" : "ws://";
const socket = new WebSocket(`${wsProtocol}${window.location.host}`);

const recordBtn = document.getElementById("recordBtn");
const statusDiv = document.getElementById("status");
const chatLog = document.getElementById("chatLog");
const clearBtn = document.getElementById("clearBtn");
const voiceSelect = document.getElementById("voiceSelect");

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let isListening = false;

const synth = window.speechSynthesis;
let voices = [];

function populateVoiceList() {
  voices = synth.getVoices();
  voiceSelect.innerHTML = "";

  voices.forEach((voice, index) => {
    const option = document.createElement("option");
    option.textContent = `${voice.name} (${voice.lang})`;
    option.setAttribute("data-lang", voice.lang);
    option.setAttribute("data-name", voice.name);
    option.value = index;
    voiceSelect.appendChild(option);
  });
}

populateVoiceList();
if (speechSynthesis.onvoiceschanged !== undefined) {
  speechSynthesis.onvoiceschanged = populateVoiceList;
}

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = "mr-IN"; // Default recognition language

  recognition.onstart = () => {
    isListening = true;
    recordBtn.textContent = "Listening...";
    recordBtn.classList.add("recording");
    statusDiv.textContent = "Listening to your voice...";
    statusDiv.style.color = "blue";
  };

  recognition.onresult = event => {
    const transcript = event.results[0][0].transcript;
    statusDiv.textContent = `You said: "${transcript}"`;
    statusDiv.style.color = "black";

    socket.send(JSON.stringify({ type: "USER_PROMPT", text: transcript }));
  };

  recognition.onerror = event => {
    console.error("Speech recognition error:", event.error);
    statusDiv.textContent = `Error: ${event.error}`;
    statusDiv.style.color = "red";
    resetRecordButton();
  };

  recognition.onend = () => {
    resetRecordButton();
  };
} else {
  statusDiv.textContent = "Web Speech API is not supported in this browser.";
  statusDiv.style.color = "red";
  recordBtn.disabled = true;
}

function resetRecordButton() {
  isListening = false;
  recordBtn.textContent = "Start Talking";
  recordBtn.classList.remove("recording");
}

recordBtn.addEventListener("click", () => {
  if (!recognition) return;

  if (isListening) {
    recognition.stop();
  } else {
    recognition.start();
  }
});

socket.onmessage = event => {
  const data = JSON.parse(event.data);

  if (data.type === "AGENT_RESPONSE") {
    appendLog(data.text, "agent");
    speakResponse(data.text, data.language);
  } else if (data.type === "ERROR") {
    appendLog(`Error: ${data.message}`, "error");
    statusDiv.textContent = "Error occurred.";
    statusDiv.style.color = "red";
  }
};

function speakResponse(text, langCode) {
  if (synth.speaking) {
    synth.cancel();
  }

  // Pre-process Devanagari text to remove trailing pronunciation bugs
  let spokenText = text;
  if (langCode === "mr" || /[\u0900-\u097f]/.test(text)) {
    spokenText = spokenText
      .replace(/नक्कीच/g, "नक्की,")
      .replace(/आहेच/g, "आहे,");
  }

  const utterance = new SpeechSynthesisUtterance(spokenText);
  utterance.rate = 0.90; // Speech speed for natural Indian cadence
  utterance.pitch = 1.0;

  if (voiceSelect.value !== "") {
    utterance.voice = voices[voiceSelect.value];
  } else {
    // Select best matching Indian accent voice
    const matchedVoice = voices.find(v => 
      v.lang.includes("mr") || 
      v.lang.includes("hi-IN") || 
      v.lang.includes("en-IN")
    );
    if (matchedVoice) utterance.voice = matchedVoice;
  }

  utterance.onstart = () => {
    statusDiv.textContent = "Aarya is speaking...";
    statusDiv.style.color = "green";
  };

  utterance.onend = () => {
    statusDiv.textContent = "Ready.";
    statusDiv.style.color = "green";
  };

  synth.speak(utterance);
}

function appendLog(message, sender) {
  const div = document.createElement("div");
  div.className = `log-entry ${sender}`;
  const timestamp = new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone: 'Asia/Kolkata'
  }).format(new Date());

  div.textContent = `${message} #${timestamp}`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function loadHistory() {
  try {
    const res = await fetch("/api/history");
    const data = await res.json();
    chatLog.innerHTML = "";
    data.reverse().forEach(row => {
      appendLog(`You: ${row.user_prompt}`, "user");
      appendLog(`Aarya: ${row.agent_response}`, "agent");
    });
  } catch (err) {
    console.error("Failed to load history:", err);
  }
}

clearBtn.addEventListener("click", async () => {
  try {
    await fetch("/api/history", { method: "DELETE" });
    chatLog.innerHTML = "";
    statusDiv.textContent = "Logs cleared.";
    statusDiv.style.color = "green";
  } catch (err) {
    console.error("Failed to clear history:", err);
  }
});

loadHistory();