# Hangout 4 - Live Sync (Toman)

Host: sadra89.r@gmail.com (global host)

## Run (for ngrok sharing)
```powershell
# install deps first
pip install -r backend/requirements.txt

# start server (serves frontend + API + WS)
python -m uvicorn backend.server:app --host 0.0.0.0 --port 8000 --reload

# in another terminal
ngrok http 8000
# share the https://xxxx.ngrok-free.app URL - friends will see same hangouts live
```

Do NOT use `python -m http.server` anymore - that is static only and will not sync.

## Features
- Live Sync via WebSocket `/ws/{userId}` + fallback polling
- Currency: تومان (Toman) - 1 تومان = 10 ریال, comma every 3 digits auto while typing (1,000,000)
- Host Panel: 👑 - kick, make/revoke admin, transfer host (global host sadra can manage all)
- Expenses in تومان with equal/exact/percent/shares splits

## How friends join
1. Open your ngrok URL
2. Register (or Login)
3. You (host) create hangout and invite them via member picker
4. They instantly see it (Live Sync). Votes/expenses/chat propagate in <1s.
