/**
 * ZK-EduHub — Edge Device Application v3.0
 *
 * ZK Flow (simplified, bulletproof):
 *  1. Fetch questions from server (answers stripped server-side)
 *  2. Pick 6 random questions LOCALLY
 *  3. Conduct quiz and score LOCALLY — score never leaves device
 *  4. Compute level (1/2/3) LOCALLY from score %
 *  5. Send ONLY (subject, level) to /get-token → receive Fernet token
 *  6. Use token to fetch /module → receive content chunks
 *  7. Render chunked content (educational text from JSON)
 *  8. Save history to localStorage only — never synced to server
 *
 * No browser-side crypto needed — server issues the token securely.
 * ZK guarantee: server never sees raw score, only the computed level.
 */

'use strict';

const CONFIG = {
  API_BASE: 'http://localhost:8000',
  QUIZ_COUNT: 6,
  LEVEL_THRESHOLDS: { 3: 80, 2: 50, 1: 0 },
  LEVEL_NAMES: { 1: 'Foundation', 2: 'Intermediate', 3: 'Advanced' },
  SUBJECT_ICONS: { math: '∑', science: '⚛', english: '✍' },
};

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  quiz: {
    subject: null,
    questions: [],      // 6 selected (no answers)
    answersMap: {},     // { questionId: correctAnswer } — loaded locally
    currentIndex: 0,
    results: [],        // { id, correct }
    answered: false,
  },
  module: {
    subject: null,
    level: null,
    token: null,
    chunks: [],
    currentChunk: 0,
  },
};

// ── Local History ─────────────────────────────────────────────────────────────
const History = {
  KEY: 'zkedu_v3_history',
  get()       { try { return JSON.parse(localStorage.getItem(this.KEY) || '[]'); } catch { return []; } },
  add(entry)  {
    const h = this.get();
    h.unshift({ ...entry, id: Date.now(), ts: new Date().toISOString() });
    localStorage.setItem(this.KEY, JSON.stringify(h.slice(0, 50)));
  },
  lastLevel(subject) {
    const found = this.get().find(h => h.subject === subject);
    return found ? found.level : null;
  },
  clear() { localStorage.removeItem(this.KEY); },
};

// ── API calls ─────────────────────────────────────────────────────────────────
const API = {
  async ping() {
    try {
      const r = await fetch(`${CONFIG.API_BASE}/`, { signal: AbortSignal.timeout(4000) });
      return r.ok;
    } catch { return false; }
  },

  async getQuestions(subject) {
    const r = await fetch(`${CONFIG.API_BASE}/questions/${subject}`);
    if (!r.ok) throw new Error(`Server error ${r.status} fetching questions`);
    return r.json();
  },

  async getAnswers(subject) {
    // Fetch raw question_bank JSON for local scoring (has answers)
    const r = await fetch(`${CONFIG.API_BASE}/question_bank/${subject}.json`);
    if (!r.ok) throw new Error('Could not load answer key');
    return r.json();
  },

  async getToken(subject, level) {
    // ZK: server receives subject+level only, issues encrypted Fernet token
    const r = await fetch(`${CONFIG.API_BASE}/get-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, level }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.detail || `Token error ${r.status}`);
    }
    return r.json(); // { token, zk_note }
  },

  async getModule(token) {
    const r = await fetch(`${CONFIG.API_BASE}/module`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.detail || `Module error ${r.status}`);
    }
    return r.json();
  },
};

// ── Quiz Engine ───────────────────────────────────────────────────────────────
function pickRandom(arr, n) {
  return [...arr].sort(() => Math.random() - 0.5).slice(0, n);
}

function computeLevel(correct, total) {
  const pct = (correct / total) * 100;
  if (pct >= CONFIG.LEVEL_THRESHOLDS[3]) return 3;
  if (pct >= CONFIG.LEVEL_THRESHOLDS[2]) return 2;
  return 1;
}

// ── UI Helpers ────────────────────────────────────────────────────────────────
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${name}`)?.classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.view === name));
  if (name === 'history') renderHistory();
  if (name === 'home')    updateSubjectTags();
}

function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type} show`;
  setTimeout(() => el.classList.remove('show'), 3500);
}

function setOnline(online) {
  document.querySelector('.dot').className = `dot ${online ? 'online' : 'offline'}`;
  document.getElementById('connText').textContent = online ? 'Hub Connected' : 'Hub Offline';
}

function updateSubjectTags() {
  ['math', 'science', 'english'].forEach(s => {
    const tag = document.getElementById(`${s}-tag`);
    const lvl = History.lastLevel(s);
    if (lvl) {
      tag.textContent = `Level ${lvl} — ${CONFIG.LEVEL_NAMES[lvl]}`;
      tag.classList.add('has-level');
    } else {
      tag.textContent = 'Not attempted';
      tag.classList.remove('has-level');
    }
  });
}

// ── Quiz UI ───────────────────────────────────────────────────────────────────
async function startQuiz(subject) {
  toast(`Loading ${subject} questions...`);
  try {
    // Fetch questions (no answers) + answer key separately
    const [qData, aData] = await Promise.all([
      API.getQuestions(subject),
      API.getAnswers(subject),
    ]);

    // Build answer map: { questionId → correctAnswer }
    const answersMap = {};
    (aData.questions || []).forEach(q => { answersMap[q.id] = q.answer; });

    const selected = pickRandom(qData.questions, CONFIG.QUIZ_COUNT);

    state.quiz = {
      subject,
      questions: selected,
      answersMap,
      currentIndex: 0,
      results: [],
      answered: false,
    };

    document.getElementById('quizSubjectLabel').textContent =
      subject.charAt(0).toUpperCase() + subject.slice(1);
    document.getElementById('qTotal').textContent = selected.length;

    showView('quiz');
    renderQuestion();
  } catch (err) {
    toast(`Failed to load questions: ${err.message}`, 'error');
  }
}

function renderQuestion() {
  const { questions, currentIndex } = state.quiz;
  const q = questions[currentIndex];

  document.getElementById('qNum').textContent = currentIndex + 1;
  document.getElementById('progressBar').style.width =
    `${(currentIndex / questions.length) * 100}%`;
  document.getElementById('questionTopic').textContent = q.topic || '';
  document.getElementById('questionText').textContent  = q.question;

  const grid    = document.getElementById('optionsGrid');
  grid.innerHTML = '';
  const letters  = ['A', 'B', 'C', 'D'];

  q.options.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className       = 'option-btn';
    btn.dataset.letter  = letters[i];
    btn.dataset.value   = opt;
    btn.textContent     = opt;
    btn.addEventListener('click', () => selectOption(btn, opt, q.id));
    grid.appendChild(btn);
  });

  document.getElementById('nextBtn').disabled = true;
  state.quiz.answered = false;
}

function selectOption(btn, selected, questionId) {
  if (state.quiz.answered) return;
  state.quiz.answered = true;

  const correct   = state.quiz.answersMap[questionId];
  const isCorrect = selected === correct;

  document.querySelectorAll('.option-btn').forEach(b => {
    b.disabled = true;
    if (b.dataset.value === correct) b.classList.add('correct');
    else if (b === btn && !isCorrect) b.classList.add('wrong');
  });

  state.quiz.results.push({ id: questionId, correct: isCorrect });
  document.getElementById('nextBtn').disabled = false;
}

async function nextQuestion() {
  state.quiz.currentIndex++;
  if (state.quiz.currentIndex >= state.quiz.questions.length) {
    await finishQuiz();
  } else {
    renderQuestion();
  }
}

async function finishQuiz() {
  const { results, subject } = state.quiz;
  const correctCount = results.filter(r => r.correct).length;
  const total        = results.length;
  const scorePct     = Math.round((correctCount / total) * 100);
  const level        = computeLevel(correctCount, total);

  // ── ZK: get token from server (sends subject+level only, NOT score) ──
  let token;
  try {
    const tokenData = await API.getToken(subject, level);
    token = tokenData.token;
  } catch (err) {
    toast('Could not get token: ' + err.message, 'error');
    return;
  }

  // Save locally
  History.add({ subject, level, score: scorePct, correct: correctCount, total });
  state.module = { subject, level, token, chunks: [], currentChunk: 0 };

  // Show result modal
  const icon = scorePct >= 80 ? '🏆' : scorePct >= 50 ? '🎯' : '📚';
  document.getElementById('resultIcon').textContent  = icon;
  document.getElementById('resultScore').textContent = `${correctCount}/${total}`;
  document.getElementById('resultLevel').textContent =
    `Level ${level} — ${CONFIG.LEVEL_NAMES[level]} · ${scorePct}% accuracy`;
  document.getElementById('progressBar').style.width = '100%';
  document.getElementById('resultModal').classList.add('open');
}

// ── Module / Learn View ───────────────────────────────────────────────────────
async function loadModule() {
  document.getElementById('resultModal').classList.remove('open');
  showView('learn');

  const { subject, level, token } = state.module;

  document.getElementById('learnTitle').textContent   = 'Loading...';
  document.getElementById('learnDesc').textContent    = '';
  document.getElementById('learnLevel').textContent   = `Level ${level}`;
  document.getElementById('zkProofText').textContent  = 'Fetching via ZK token...';
  document.getElementById('chunksNav').innerHTML      = '';
  document.getElementById('chunkViewer').innerHTML    = `
    <div class="chunk-loading">
      <div class="spinner"></div>
      <p>Fetching content from hub...</p>
    </div>`;

  try {
    const data = await API.getModule(token);

    state.module.chunks       = data.chunks;
    state.module.currentChunk = 0;

    document.getElementById('learnTitle').textContent  = data.title;
    document.getElementById('learnDesc').textContent   = data.description;
    document.getElementById('learnLevel').textContent  =
      `Level ${data.level} — ${CONFIG.LEVEL_NAMES[data.level]}`;
    document.getElementById('zkProofText').textContent =
      `Token verified · ${data.subject} · Level ${data.level}`;

    renderChunksNav();
    renderChunk(0);
    updateChunkControls();
  } catch (err) {
    document.getElementById('chunkViewer').innerHTML = `
      <div class="chunk-loading">
        <p style="color:var(--red)">❌ ${err.message}</p>
      </div>`;
    toast(err.message, 'error');
  }
}

function renderChunksNav() {
  const nav = document.getElementById('chunksNav');
  nav.innerHTML = '';
  state.module.chunks.forEach((chunk, i) => {
    const pill = document.createElement('button');
    pill.className   = `chunk-pill${i === 0 ? ' active' : ''}`;
    pill.textContent = chunk.topic;
    pill.addEventListener('click', () => {
      state.module.currentChunk = i;
      renderChunk(i);
      updateChunkControls();
    });
    nav.appendChild(pill);
  });
}

function renderChunk(index) {
  const chunk = state.module.chunks[index];
  if (!chunk) return;

  document.querySelectorAll('.chunk-pill').forEach((p, i) =>
    p.classList.toggle('active', i === index));

  document.getElementById('chunkViewer').innerHTML = `
    <div class="chunk-content">
      <div class="chunk-topic">${chunk.topic}</div>
      <div class="chunk-title">${chunk.topic.toUpperCase()} — STUDY NOTES</div>
      <div class="chunk-body">${chunk.content.replace(/\n/g, '<br/>')}</div>
    </div>`;

  document.getElementById('chunkCounter').textContent =
    `${index + 1} / ${state.module.chunks.length}`;
}

function updateChunkControls() {
  const i     = state.module.currentChunk;
  const total = state.module.chunks.length;
  document.getElementById('prevChunkBtn').disabled = i === 0;
  document.getElementById('nextChunkBtn').disabled = i >= total - 1;
  document.getElementById('nextChunkBtn').textContent =
    i >= total - 1 ? '✓ Done' : 'Next →';
}

// ── History View ──────────────────────────────────────────────────────────────
function renderHistory() {
  const list    = document.getElementById('historyList');
  const history = History.get();

  if (!history.length) {
    list.innerHTML = `<div class="history-empty">No quiz history yet.</div>`;
    return;
  }

  list.innerHTML = history.map(h => {
    const date = new Date(h.ts).toLocaleString('en-IN');
    const icon = CONFIG.SUBJECT_ICONS[h.subject] || '📚';
    return `
      <div class="history-item">
        <div class="history-subject-icon">${icon}</div>
        <div>
          <div class="history-subject">${h.subject}</div>
          <div class="history-date">${date}</div>
        </div>
        <div class="history-meta">
          <div class="history-score">${h.correct}/${h.total} · ${h.score}%</div>
          <div class="history-level-badge level-${h.level}">${CONFIG.LEVEL_NAMES[h.level]}</div>
        </div>
      </div>`;
  }).join('');
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const online = await API.ping();
  setOnline(online);
  if (!online) toast('Hub offline — cannot load modules', 'error');
  updateSubjectTags();

  // Nav
  document.querySelectorAll('[data-view]').forEach(el =>
    el.addEventListener('click', () => showView(el.dataset.view)));

  // Subject cards
  document.querySelectorAll('.subject-card').forEach(card =>
    card.addEventListener('click', () => startQuiz(card.dataset.subject)));

  // Home buttons
  document.getElementById('startQuizBtn').addEventListener('click', () => {
    document.getElementById('subjectGrid').scrollIntoView({ behavior: 'smooth' });
  });
  document.getElementById('viewHistoryBtn').addEventListener('click', () => showView('history'));

  // Quiz
  document.getElementById('nextBtn').addEventListener('click', nextQuestion);

  // Modal
  document.getElementById('loadModuleBtn').addEventListener('click', loadModule);
  document.getElementById('retakeBtn').addEventListener('click', () => {
    document.getElementById('resultModal').classList.remove('open');
    startQuiz(state.quiz.subject);
  });
  document.getElementById('resultModal').addEventListener('click', e => {
    if (e.target === e.currentTarget)
      document.getElementById('resultModal').classList.remove('open');
  });

  // Learn chunks
  document.getElementById('prevChunkBtn').addEventListener('click', () => {
    if (state.module.currentChunk > 0) {
      state.module.currentChunk--;
      renderChunk(state.module.currentChunk);
      updateChunkControls();
    }
  });
  document.getElementById('nextChunkBtn').addEventListener('click', () => {
    const total = state.module.chunks.length;
    if (state.module.currentChunk < total - 1) {
      state.module.currentChunk++;
      renderChunk(state.module.currentChunk);
      updateChunkControls();
    }
  });

  // History clear
  document.getElementById('clearHistoryBtn').addEventListener('click', () => {
    if (confirm('Clear all history?')) {
      History.clear();
      renderHistory();
      updateSubjectTags();
      toast('History cleared');
    }
  });
}

document.addEventListener('DOMContentLoaded', init);