# ZK-EduHub
### Zero-Knowledge Adaptive Learning Platform
**Tech Thrive 2.0 — National Level 24-Hour Hackathon**

---

## Architecture Overview

```
Edge Device (Browser)                  Central Hub (FastAPI)
──────────────────────                 ──────────────────────
1. Fetch questions (public)    →       Return all questions
2. Select 6 randomly (LOCAL)
3. Conduct quiz (LOCAL)
4. Score answers (LOCAL)       ✗       Server never sees scores
5. Compute level (LOCAL)       ✗       Server never sees level computation
6. Fernet.encrypt(            
     "math|2|1708950000"       →       Decrypt token → learn: math + level 2
   ) = opaque token
7.                             ←       Return level 2 content chunks
8. Render chunks (LOCAL)
9. Save history (localStorage) ✗       Server never sees history
```

**Zero-Knowledge guarantee:** Server learns ONLY `subject + level` — never scores, wrong answers, question patterns, or student identity.

---

## Project Structure

```
zk-edu/
├── main.py                    # FastAPI backend (ZK server)
├── requirements.txt
├── question_bank/
│   ├── math.json              # 12 math questions (difficulty 1-3)
│   ├── science.json           # 12 science questions
│   └── english.json           # 12 english questions
├── modules/
│   ├── math/content.json      # 3 levels × 3 chunks each
│   ├── science/content.json
│   └── english/content.json
└── static/
    ├── index.html             # Main SPA
    ├── css/style.css          # Dark geometric theme
    └── js/
        ├── fernet.js          # Browser Fernet encryption (Web Crypto API)
        └── app.js             # Edge device ZK logic + quiz engine
```

---

## Setup & Run

### 1. Install dependencies
```bash
cd zk-edu
pip install -r requirements.txt
```

### 2. Run the server
```bash
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### 3. Open the app
Visit: http://localhost:8000/app

---

## Key Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/questions/{subject}` | GET | Public question bank |
| `/module` | POST | ZK module delivery (token required) |
| `/module/chunk` | GET | Single chunk delivery (bandwidth-optimized) |
| `/key-info` | GET | Returns Fernet key for edge device |
| `/subjects` | GET | List all subjects and level metadata |
| `/app` | GET | Serve frontend SPA |

---

## ZK Flow Detail

### Token Creation (Browser)
```javascript
// 1. Compute level locally
const level = score >= 80 ? 3 : score >= 50 ? 2 : 1;

// 2. Encrypt — runs entirely in browser via Web Crypto API
const payload = `math|2|1708950000`;  // subject|level|unix_timestamp
const token = await FernetJS.encrypt(fernetKey, payload);
// → "gAAAAABl..." (opaque base64url string)

// 3. Send ONLY the token
await fetch('/module', { body: JSON.stringify({ token }) });
```

### Token Verification (Server)
```python
def decrypt_token(token):
    decrypted = cipher.decrypt(token.encode()).decode()
    subject, level, timestamp = decrypted.split("|")
    # Validate timestamp (reject if > 10 minutes old)
    # Return ONLY subject + level — the full profile stays on device
    return subject, int(level)
```

---

## Constraints Satisfied

| Constraint | Implementation |
|-----------|---------------|
| **Zero-Knowledge Rule** | Server decrypts token → learns only subject+level. Scores, wrong answers, and profile never transmitted. |
| **Bandwidth Budget** | Token = ~150 bytes. Content = JSON chunks only. No PDF downloads. No full catalog download. |
| **Stateless Server** | No sessions, no DB, no user tracking. Pure function: token → content. |
| **Local History** | `localStorage` only. Nothing synced to server. |
| **Replay Protection** | Token expires after 10 minutes (timestamp embedded in ciphertext). |

---

## Changing the Fernet Key

```bash
# Generate new key
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

# Set as environment variable
export FERNET_KEY="your-new-key-here"
uvicorn main:app --reload
```

The frontend fetches the key from `/key-info` on startup. In production, serve this endpoint over HTTPS only.

---

## Adding More Content

To add questions, append to `question_bank/{subject}.json`:
```json
{
  "id": "m13", "topic": "topology", "difficulty": 3,
  "question": "Your question here?",
  "options": ["A", "B", "C", "D"],
  "answer": "B"
}
```

To add content chunks, append to `modules/{subject}/content.json` under the appropriate level.
