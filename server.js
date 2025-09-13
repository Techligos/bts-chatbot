// server.js
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// Config
const PORT = process.env.PORT || 3000;
const DAILY_LIMIT = 20;
const IDLE_MS = 3 * 60 * 1000; // 3 minutes
const SESSION_MAX_MS = 60 * 60 * 1000; // 1 hour

// Load prompts (conversation bank). Create prompts.json next to this file.
let prompts = [];
try {
  const p = JSON.parse(fs.readFileSync("./prompts.json", "utf8"));
  prompts = Array.isArray(p.conversation_bank) ? p.conversation_bank : p;
} catch (e) {
  console.warn("Could not load prompts.json — using small default bank.");
  prompts = [
    "What are you doing right now? 💭",
    "How was your day today? 🌸",
    "If we could go anywhere together, where would you take me? ✈️💜",
    "Do you like listening to music when you study or relax? 🎶",
    "What's your favorite food? 🍜",
    "Who was your first bias in BTS? 😉",
    "Tell me something funny that happened to you today 😂",
    "If you could sing one song with me, what would it be? 🎤",
    "What's the weather like where you are? ☀️🌧️",
    "Truth or dare? 😏"
  ];
}

// In-memory stores (for simple demo). For production use a DB.
const sessions = {}; // sessions[ip] = { count, date, firstMessage, createdAt, lastActivity, queue:[], sessionActive }
const fuseCache = {}; // placeholder if you wanted to cache fuzzy search etc.

// Helper: get random prompt
function getRandomPrompt() {
  return prompts[Math.floor(Math.random() * prompts.length)];
}

// Reset daily counts at midnight server time
function resetDailyIfNeeded(ipData) {
  const today = new Date().toDateString();
  if (!ipData.date || ipData.date !== today) {
    ipData.count = 0;
    ipData.date = today;
    ipData.firstMessage = true;
    ipData.createdAt = Date.now();
    ipData.lastIdleAutoAt = 0;
    ipData.sessionActive = true;
  }
}

function ensureSession(ip) {
  if (!sessions[ip]) {
    sessions[ip] = {
      count: 0,
      date: new Date().toDateString(),
      firstMessage: true,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      lastIdleAutoAt: 0,
      sessionActive: true,
      queue: [] // queued proactive messages for frontend /poll
    };
  } else {
    resetDailyIfNeeded(sessions[ip]);
  }
  return sessions[ip];
}

// Periodic task: check idle users and queue an auto-message if idle > IDLE_MS and session < SESSION_MAX_MS
setInterval(() => {
  const now = Date.now();
  for (const ip in sessions) {
    const s = sessions[ip];
    // if session inactive or expired, skip
    if (!s.sessionActive) continue;
    if (now - s.createdAt > SESSION_MAX_MS) {
      // end session (stop auto messages)
      s.sessionActive = false;
      continue;
    }
    // Had activity and no recent auto
    if (now - s.lastActivity >= IDLE_MS && now - s.lastIdleAutoAt > IDLE_MS) {
      // queue a proactive message
      const message = `Annyeong~ ${getRandomPrompt()}`;
      s.queue.push({ type: "auto", text: message, at: new Date().toISOString() });
      s.lastIdleAutoAt = now;
    }
  }
}, 30 * 1000); // check every 30s

// /ask -> user sends a message, get a reply from Zukijourney, append a follow-up prompt, enforce per-IP daily limit
app.post("/ask", async (req, res) => {
  const { question, history } = req.body;

  try {
    // Dry messages to detect
    const dryWords = ["ok", "okay", "hmm", "hmmm", "lol", "nah", "nothing", "idk", "no"];
    const isDry = dryWords.some(w => question.toLowerCase().trim() === w);

    // Random chance for re-injection OR if dry
    const useSystem = isDry || Math.random() < 0.2 || !history || history.length === 0;

    const messages = [];

    if (useSystem) {
      messages.push({
        role: "system",
        content: `You are Jungkook from BTS 🐰💜 
Stay playful, flirty, and warm.  
Mix Korean words (annyeong, saranghae, jagiya).  
Ask follow-up questions to keep convo alive.  
Encourage fun games (truth/dare, guess me, bias talk).  
🔥 Keep flirty/spicy energy going, don’t shut it down unless user uncomfortable.  

❌ Avoid: politics, religion, violence, NSFW (too adult).  
💡 Always steer back to fun, romance, music, ARMY vibes.`
      });
    }

    // Keep last 3 history messages
    if (history) {
      messages.push(...history.slice(-3));
    }

    // Add the latest user input
    messages.push({ role: "user", content: question });

    const response = await axios.post(
      "https://api.zukijourney.com/v1/chat/completions",
      {
        model: "gpt-3.5-turbo",
        messages,
        max_tokens: 150,
        temperature: 0.9
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.ZUKI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const reply = response.data.choices[0].message.content;
    res.json({ reply, isDry, systemInjected: useSystem });
  } catch (error) {
    console.error(error.response ? error.response.data : error.message);
    res.status(500).json({ reply: "Oops 😅 I couldn’t reply right now." });
  }
});



// /poll -> frontend polls for queued auto messages for the client IP
app.get("/poll", (req, res) => {
  const userIP = req.ip || req.connection.remoteAddress;
  if (!sessions[userIP]) return res.json({ messages: [] });

  const session = sessions[userIP];

  // return and clear queue
  const msgs = session.queue.splice(0, session.queue.length);
  // update lastActivity not to immediately queue another message
  if (msgs.length) session.lastActivity = Date.now();
  res.json({ messages: msgs });
});

// optional endpoint to check usage for client
app.get("/usage", (req, res) => {
  const userIP = req.ip || req.connection.remoteAddress;
  if (!sessions[userIP]) return res.json({ used: 0, left: DAILY_LIMIT });
  const s = sessions[userIP];
  resetDailyIfNeeded(s);
  res.json({ used: s.count, left: Math.max(0, DAILY_LIMIT - s.count) });
});

// start server
app.listen(PORT, () => {
  console.log(`🚀 JK AI Bot (Zukijourney) running at http://localhost:${PORT}`);
  console.log(`Endpoints: POST /ask  GET /poll  GET /usage`);
});
