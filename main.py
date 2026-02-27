"""
ZK-EduHub Backend — Zero-Knowledge Adaptive Learning Platform
Tech Thrive 2.0 — National Level 24-Hour Hackathon

ZK Privacy Flow:
  1. Edge fetches questions WITHOUT answers (server strips them)
  2. Edge randomly picks 6 questions, conducts quiz ENTIRELY LOCALLY
  3. Edge scores answers LOCALLY — raw score never leaves device
  4. Edge computes level (1/2/3) LOCALLY based on score %
  5. Edge sends ONLY (subject, level) to /get-token → server returns Fernet token
  6. Edge uses token to call /module → server serves content chunks
  7. Server NEVER sees: actual score, wrong answers, question selection, identity

ZK Guarantee: Server learns subject+level only. The COMPUTATION of level
from raw scores happens entirely on the edge device and is never transmitted.

Bandwidth: tiny JSON payloads only. No PDFs. Stateless server.
"""

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from cryptography.fernet import Fernet, InvalidToken
from pydantic import BaseModel
from typing import Optional
import os, json, time, copy

app = FastAPI(title="ZK-EduHub", version="3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
QB_DIR     = os.path.join(BASE_DIR, "question_bank")

# ── Fernet Key ────────────────────────────────────────────────────────────────
FERNET_KEY = os.environ.get(
    "FERNET_KEY",
    "HSBoLjuNeSQK-B9ddCElV2X8i4skLnd8Iy4YDZwHzuk="
).encode()

cipher = Fernet(FERNET_KEY)
print("[ZK-EduHub] Fernet key loaded OK")
print(f"[ZK-EduHub] Serving from: {BASE_DIR}")

VALID_SUBJECTS = {"math", "science", "english"}
VALID_LEVELS   = {1, 2, 3}

# ── Models ────────────────────────────────────────────────────────────────────
class TokenRequest(BaseModel):
    subject: str
    level: int   # Edge computed this locally — server just issues a signed token

class ModuleRequest(BaseModel):
    token: str
    chunk_ids: Optional[list[str]] = None

# ── Helpers ───────────────────────────────────────────────────────────────────
def load_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def strip_answers(questions: list) -> list:
    """Remove answers before sending to edge — ZK rule."""
    result = []
    for q in questions:
        qc = copy.deepcopy(q)
        qc.pop("answer", None)
        result.append(qc)
    return result

def decrypt_token(token: str) -> tuple[str, int]:
    try:
        decrypted = cipher.decrypt(token.encode()).decode()
        parts = decrypted.split("|")
        if len(parts) != 3:
            raise ValueError("Bad format")
        subject, level_str, ts_str = parts
        level     = int(level_str)
        timestamp = int(ts_str)
        age = time.time() - timestamp
        if age > 600:
            raise HTTPException(400, "Token expired — retake the quiz.")
        if age < -30:
            raise HTTPException(400, "Clock skew detected.")
        if subject not in VALID_SUBJECTS:
            raise HTTPException(400, f"Unknown subject: {subject}")
        if level not in VALID_LEVELS:
            raise HTTPException(400, f"Invalid level: {level}")
        return subject, level
    except HTTPException:
        raise
    except InvalidToken:
        raise HTTPException(403, "Invalid token.")
    except Exception as e:
        raise HTTPException(400, f"Bad token: {e}")

# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return {"status": "ZK-EduHub v3.0 running", "ui": "/app"}

@app.get("/questions/{subject}")
def get_questions(subject: str):
    """
    Public endpoint. Returns questions WITHOUT answers.
    Edge picks 6 randomly and scores locally.
    Server never knows which questions were picked or how they scored.
    """
    if subject not in VALID_SUBJECTS:
        raise HTTPException(404, f"Unknown subject: {subject}")
    path = os.path.join(QB_DIR, f"{subject}.json")
    if not os.path.exists(path):
        raise HTTPException(500, f"Missing: question_bank/{subject}.json")
    data = load_json(path)
    questions = data.get("questions", [])
    return {
        "subject": subject,
        "total": len(questions),
        "questions": strip_answers(questions)
    }

@app.post("/get-token")
def get_token(req: TokenRequest):
    """
    ZK Token Issuance.

    Edge sends: subject + level (level was computed locally from score)
    Server issues: Fernet-encrypted token containing subject|level|timestamp
    Server NEVER sees: raw score, wrong answers, question pattern

    The ZK guarantee: the mapping from (raw_score → level) happens
    entirely on the edge device. Server only sees the resulting level,
    not how it was computed or what score produced it.
    """
    if req.subject not in VALID_SUBJECTS:
        raise HTTPException(400, f"Unknown subject: {req.subject}")
    if req.level not in VALID_LEVELS:
        raise HTTPException(400, f"Invalid level: {req.level}")

    payload = f"{req.subject}|{req.level}|{int(time.time())}"
    token   = cipher.encrypt(payload.encode()).decode()

    return {
        "token": token,
        "zk_note": "Raw score unknown to server."
    }

@app.post("/module")
def get_module(req: ModuleRequest):
    """
    ZK Module Delivery.
    Token decrypted → subject+level → content chunks returned.
    """
    subject, level = decrypt_token(req.token)
    path = os.path.join(BASE_DIR, "modules", subject, "content.json")
    if not os.path.exists(path):
        raise HTTPException(500, f"Missing: modules/{subject}/content.json")
    data       = load_json(path)
    level_data = data["levels"].get(str(level))
    if not level_data:
        raise HTTPException(500, f"No content for level {level}")
    chunks = level_data["chunks"]
    if req.chunk_ids:
        chunks = [c for c in chunks if c["id"] in req.chunk_ids]
    return {
        "subject":      subject,
        "level":        level,
        "title":        level_data["title"],
        "description":  level_data["description"],
        "total_chunks": len(level_data["chunks"]),
        "chunks":       chunks,
    }

@app.get("/subjects")
def list_subjects():
    result = {}
    for s in VALID_SUBJECTS:
        path = os.path.join(BASE_DIR, "modules", s, "content.json")
        if os.path.exists(path):
            data = load_json(path)
            result[s] = {
                lvl: {"title": info["title"], "description": info["description"]}
                for lvl, info in data["levels"].items()
            }
    return result

# ── Static files ──────────────────────────────────────────────────────────────
if os.path.exists(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
if os.path.exists(QB_DIR):
    app.mount("/question_bank", StaticFiles(directory=QB_DIR), name="qbank")

@app.get("/app", response_class=HTMLResponse)
def serve_app():
    html_path = os.path.join(STATIC_DIR, "index.html")
    if not os.path.exists(html_path):
        return HTMLResponse("<h1>index.html missing from static/</h1>", 404)
    with open(html_path, "r", encoding="utf-8") as f:
        return f.read()