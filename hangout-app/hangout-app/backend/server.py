import sqlite3, json, os, uuid, time
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent
FRONT_DIR = BASE_DIR.parent
DB_PATH = BASE_DIR / "hangout.db"
HOST_EMAIL = "sadra89.r@gmail.com"

COLORS = ["#FF9F0A","#2ECC71","#3498DB","#9B59B6","#E74C3C","#1ABC9C","#F39C12","#34495E"]
def color_for(name):
    h=0
    for ch in name:
        h=(h*31+ord(ch))%len(COLORS)
    return COLORS[h]

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn=get_db()
    cur=conn.cursor()
    cur.execute("""
    CREATE TABLE IF NOT EXISTS users(
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        pass TEXT NOT NULL,
        color TEXT,
        is_host INTEGER DEFAULT 0,
        created_at TEXT
    )""")
    # ensure is_guest column exists for ephemeral guests
    try:
        cur.execute("ALTER TABLE users ADD COLUMN is_guest INTEGER DEFAULT 0")
    except:
        pass
    cur.execute("""
    CREATE TABLE IF NOT EXISTS hangouts(
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT
    )""")
    conn.commit()
    conn.close()

def is_guest_user_id(uid: str) -> bool:
    return uid.startswith("guest_")

def is_guest_email(email: str) -> bool:
    return email.endswith("@guest") or email.endswith("@guest.local")

def is_guest_user_row(row) -> bool:
    if row is None:
        return False
    if row["is_guest"]:
        return True
    return is_guest_email(row["email"]) or is_guest_user_id(row["id"])

init_db()

app = FastAPI(title="Hangout4 Live Sync")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False, allow_methods=["*"], allow_headers=["*"])

# WebSocket manager
class ConnManager:
    def __init__(self):
        self.active: Dict[str, WebSocket] = {}
    async def connect(self, ws, uid):
        await ws.accept()
        self.active[uid]=ws
    def disconnect(self, uid):
        self.active.pop(uid, None)
    async def broadcast(self, msg: dict, exclude=None):
        dead=[]
        for uid, ws in self.active.items():
            if exclude and uid==exclude:
                continue
            try:
                await ws.send_text(json.dumps(msg))
            except:
                dead.append(uid)
        for d in dead:
            self.active.pop(d, None)

manager = ConnManager()

def is_host_user(user_id: str) -> bool:
    conn=get_db()
    cur=conn.execute("SELECT is_host, email FROM users WHERE id=?", (user_id,))
    row=cur.fetchone()
    conn.close()
    if not row: return False
    return bool(row["is_host"]) or (row["email"].lower()==HOST_EMAIL.lower())

def get_user(user_id: str):
    conn=get_db()
    cur=conn.execute("SELECT * FROM users WHERE id=?", (user_id,))
    row=cur.fetchone()
    conn.close()
    return dict(row) if row else None

def parse_hangout(row):
    data=json.loads(row["data"])
    return data

# Models
class RegisterReq(BaseModel):
    name: str
    email: str
    password: str

class LoginReq(BaseModel):
    email: str
    password: str

class GuestReq(BaseModel):
    name: str

class HangoutCreateReq(BaseModel):
    title: str
    description: Optional[str]=""
    members: List[str]
    createdBy: str

class KickReq(BaseModel):
    requesterId: str
    targetId: str

class AdminReq(BaseModel):
    requesterId: str
    targetId: str
    action: str # make | revoke

class TransferReq(BaseModel):
    requesterId: str
    targetId: str

class ResetReq(BaseModel):
    email: str
    newPassword: str
    requesterId: Optional[str] = None  # if host resets another user

@app.post("/api/register")
def register(req: RegisterReq):
    conn=get_db()
    cur=conn.cursor()
    email=req.email.strip().lower()
    if cur.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
        conn.close()
        raise HTTPException(400, "Email exists")
    uid=str(uuid.uuid4())[:8]
    is_host=1 if email==HOST_EMAIL.lower() else 0
    # if no host exists yet and this is first user, also make host? No, only sadra
    color=color_for(req.name)
    cur.execute("INSERT INTO users(id,name,email,pass,color,is_host,created_at) VALUES(?,?,?,?,?,?,?)",
                (uid, req.name.strip(), email, req.password, color, is_host, datetime.utcnow().isoformat()))
    conn.commit()
    # ensure sadra host flag even if registered with different case
    conn.close()
    return {"id":uid, "name":req.name.strip(), "email":email, "color":color, "is_host":bool(is_host)}

@app.post("/api/login")
def login(req: LoginReq):
    conn=get_db()
    cur=conn.execute("SELECT * FROM users WHERE email=? AND pass=?", (req.email.strip().lower(), req.password))
    row=cur.fetchone()
    conn.close()
    if not row:
        raise HTTPException(401, "Invalid credentials")
    d=dict(row)
    d["is_host"]=bool(d["is_host"])
    return d

@app.post("/api/guest-login")
def guest_login(req: GuestReq):
    name=req.name.strip()
    if not name or len(name)<2:
        raise HTTPException(400, "Name required (>=2 chars)")
    uid="guest_"+str(uuid.uuid4())[:8]
    email=f"guest_{uid[6:]}@guest.local"
    color=color_for(name)
    conn=get_db()
    cur=conn.cursor()
    cur.execute("INSERT INTO users(id,name,email,pass,color,is_host,is_guest,created_at) VALUES(?,?,?,?,?,?,?,?)",
                (uid, name, email, "guest", color, 0, 1, datetime.utcnow().isoformat()))
    conn.commit()
    conn.close()
    return {"id":uid, "name":name, "email":email, "color":color, "is_host":False, "is_guest":True}

@app.post("/api/reset-password")
def reset_password(req: ResetReq):
    email = req.email.strip().lower()
    if not email or not req.newPassword or len(req.newPassword) < 4:
        raise HTTPException(400, "Email and password (>=4 chars) required")
    conn=get_db()
    cur=conn.cursor()
    target = cur.execute("SELECT id,email FROM users WHERE email=?", (email,)).fetchone()
    if not target:
        conn.close()
        raise HTTPException(404, "Email not found")
    # If requesterId provided and target is different, check host permission
    if req.requesterId and req.requesterId != target["id"]:
        # host can reset anyone, others can only reset themselves
        if not is_host_user(req.requesterId):
            conn.close()
            raise HTTPException(403, "Only host can reset other users")
    cur.execute("UPDATE users SET pass=? WHERE email=?", (req.newPassword, email))
    conn.commit()
    conn.close()
    return {"ok": True, "email": email}

@app.get("/api/users")
def list_users(requesterId: Optional[str]=None):
    conn=get_db()
    rows=conn.execute("SELECT id,name,email,color,is_host,is_guest,created_at FROM users").fetchall()
    conn.close()
    return [dict(r, is_host=bool(r["is_host"]), is_guest=bool(r["is_guest"] if "is_guest" in r.keys() else 0)) for r in rows]

@app.get("/api/users/with-passwords")
def list_users_with_passwords(requesterId: str):
    if not requesterId or not is_host_user(requesterId):
        raise HTTPException(403, "Only host can view passwords")
    conn=get_db()
    rows=conn.execute("SELECT id,name,email,pass,color,is_host,is_guest,created_at FROM users").fetchall()
    conn.close()
    return [dict(r, is_host=bool(r["is_host"]), is_guest=bool(r["is_guest"] if "is_guest" in r.keys() else 0)) for r in rows]

@app.get("/api/hangouts")
def list_hangouts(userId: Optional[str]=None):
    conn=get_db()
    rows=conn.execute("SELECT data FROM hangouts ORDER BY updated_at DESC").fetchall()
    conn.close()
    all_data=[json.loads(r["data"]) for r in rows]
    if userId:
        # filter where user is member or host sees all? host sees all as well
        filtered=[h for h in all_data if userId in h.get("members",[])]
        # host global sees all anyway, but filter keeps privacy; if is_host, return all?
        if is_host_user(userId):
            return all_data
        return filtered
    return all_data

@app.get("/api/hangouts/{hid}")
def get_hangout(hid: str):
    conn=get_db()
    row=conn.execute("SELECT data FROM hangouts WHERE id=?", (hid,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(404, "Not found")
    return json.loads(row["data"])

@app.post("/api/hangouts")
async def create_hangout(req: HangoutCreateReq):
    hid=str(uuid.uuid4())[:8]
    # roles: creator is host, others member, but if creator is global host then host else host per hangout
    roles={}
    for mid in req.members:
        roles[mid]="member"
    roles[req.createdBy]="host"
    # if global host is in members but not creator, make him admin automatically?
    hangout={
        "id":hid,
        "title":req.title,
        "description":req.description or "",
        "members": req.members[:10],
        "roles": roles,
        "createdBy": req.createdBy,
        "status":"planning",
        "createdAt": datetime.utcnow().isoformat(),
        "finalized": None,
        "dates":[],
        "places":[],
        "activities":[],
        "expenses":[],
        "payments":[],
        "comments":[]
    }
    conn=get_db()
    conn.execute("INSERT INTO hangouts(id,data,updated_at) VALUES(?,?,?)", (hid, json.dumps(hangout), datetime.utcnow().isoformat()))
    conn.commit()
    conn.close()
    await manager.broadcast({"type":"hangout_created","hangout":hangout})
    await manager.broadcast({"type":"hangouts_changed"})
    return hangout

@app.put("/api/hangouts/{hid}")
async def update_hangout(hid: str, data: dict):
    conn=get_db()
    row=conn.execute("SELECT data FROM hangouts WHERE id=?", (hid,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Not found")
    # preserve id and ensure members max 10
    existing=json.loads(row["data"])
    # merge but enforce roles and members if provided
    # keep createdBy immutable
    data["id"]=hid
    if "createdBy" not in data:
        data["createdBy"]=existing.get("createdBy")
    if "members" in data and len(data["members"])>10:
        data["members"]=data["members"][:10]
    # ensure roles exist
    if "roles" not in data:
        data["roles"]=existing.get("roles",{})
    # ephemeral guest cleanup: when hangout becomes done, delete guests only if not in any other hangout
    if data.get("status")=="done" and existing.get("status")!="done":
        # find guest members in this hangout
        guests_in_hangout=[]
        for mid in data.get("members",[]):
            urow=conn.execute("SELECT id,email,is_guest FROM users WHERE id=?", (mid,)).fetchone()
            if urow and is_guest_user_row(urow):
                guests_in_hangout.append(mid)
        for gid in guests_in_hangout:
            # check if guest is in any other *active* hangout (status != done) - delete only if not in any other hangout
            other_found=False
            other_rows=conn.execute("SELECT data FROM hangouts WHERE id!=?", (hid,)).fetchall()
            for orow in other_rows:
                odata=json.loads(orow["data"])
                if odata.get("status")=="done":
                    continue
                if gid in odata.get("members",[]):
                    other_found=True
                    break
            if not other_found:
                conn.execute("DELETE FROM users WHERE id=?", (gid,))
                # keep hangout history as is, but also clean roles if needed
                # do not remove from current hangout members to preserve history, just user row deleted
    conn.execute("UPDATE hangouts SET data=?, updated_at=? WHERE id=?", (json.dumps(data), datetime.utcnow().isoformat(), hid))
    conn.commit()
    conn.close()
    await manager.broadcast({"type":"hangout_updated","hangoutId":hid,"hangout":data})
    await manager.broadcast({"type":"hangouts_changed"})
    if data.get("status")=="done" and existing.get("status")!="done":
        await manager.broadcast({"type":"users_changed"})
    return data

@app.post("/api/hangouts/{hid}/kick")
async def kick_member(hid: str, req: KickReq):
    conn=get_db()
    row=conn.execute("SELECT data FROM hangouts WHERE id=?", (hid,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Hangout not found")
    hangout=json.loads(row["data"])
    requester_role=hangout.get("roles",{}).get(req.requesterId)
    target_role=hangout.get("roles",{}).get(req.targetId)
    # permission: host can kick anyone except self, admin can kick members only, global host can kick anyone
    is_global_host=is_host_user(req.requesterId)
    if not is_global_host:
        if requester_role not in ("host","admin"):
            conn.close()
            raise HTTPException(403, "Only host/admin can kick")
        if requester_role=="admin" and target_role in ("host","admin"):
            conn.close()
            raise HTTPException(403, "Admin cannot kick host/admin")
        if req.requesterId==req.targetId:
            raise HTTPException(400, "Cannot kick yourself")
    if req.targetId not in hangout["members"]:
        conn.close()
        raise HTTPException(400, "Target not in hangout")
    if target_role=="host" and not is_global_host:
        conn.close()
        raise HTTPException(403, "Cannot kick host")
    hangout["members"]=[m for m in hangout["members"] if m!=req.targetId]
    hangout["roles"].pop(req.targetId, None)
    # also remove votes by target?
    for lst in [hangout.get("dates",[]), hangout.get("places",[]), hangout.get("activities",[])]:
        for it in lst:
            if req.targetId in it.get("votes",[]):
                it["votes"]=[v for v in it["votes"] if v!=req.targetId]
    conn.execute("UPDATE hangouts SET data=?, updated_at=? WHERE id=?", (json.dumps(hangout), datetime.utcnow().isoformat(), hid))
    conn.commit()
    conn.close()
    await manager.broadcast({"type":"hangout_updated","hangoutId":hid,"hangout":hangout})
    await manager.broadcast({"type":"hangouts_changed"})
    return hangout

@app.post("/api/hangouts/{hid}/admin")
async def admin_action(hid: str, req: AdminReq):
    conn=get_db()
    row=conn.execute("SELECT data FROM hangouts WHERE id=?", (hid,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Not found")
    hangout=json.loads(row["data"])
    requester_role=hangout.get("roles",{}).get(req.requesterId)
    is_global_host=is_host_user(req.requesterId)
    if not is_global_host and requester_role!="host":
        conn.close()
        raise HTTPException(403, "Only host can manage admins")
    if req.targetId not in hangout["members"]:
        conn.close()
        raise HTTPException(400, "Target not in hangout")
    if req.action=="make":
        if hangout["roles"].get(req.targetId)=="host":
            raise HTTPException(400, "Target is host")
        hangout["roles"][req.targetId]="admin"
    elif req.action=="revoke":
        if hangout["roles"].get(req.targetId)!="admin":
            raise HTTPException(400, "Target is not admin")
        hangout["roles"][req.targetId]="member"
    else:
        raise HTTPException(400, "Invalid action")
    conn.execute("UPDATE hangouts SET data=?, updated_at=? WHERE id=?", (json.dumps(hangout), datetime.utcnow().isoformat(), hid))
    conn.commit()
    conn.close()
    await manager.broadcast({"type":"hangout_updated","hangoutId":hid,"hangout":hangout})
    return hangout

@app.post("/api/hangouts/{hid}/transfer-host")
async def transfer_host(hid: str, req: TransferReq):
    conn=get_db()
    row=conn.execute("SELECT data FROM hangouts WHERE id=?", (hid,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Not found")
    hangout=json.loads(row["data"])
    req_role=hangout.get("roles",{}).get(req.requesterId)
    is_global_host=is_host_user(req.requesterId)
    if not is_global_host and req_role!="host":
        conn.close()
        raise HTTPException(403, "Only host can transfer")
    if req.targetId not in hangout["members"]:
        raise HTTPException(400, "Target not in hangout")
    # transfer
    hangout["roles"][req.requesterId]="admin"
    hangout["roles"][req.targetId]="host"
    hangout["createdBy"]=req.targetId # optional update
    conn.execute("UPDATE hangouts SET data=?, updated_at=? WHERE id=?", (json.dumps(hangout), datetime.utcnow().isoformat(), hid))
    conn.commit()
    conn.close()
    await manager.broadcast({"type":"hangout_updated","hangoutId":hid,"hangout":hangout})
    return hangout

@app.delete("/api/hangouts/{hid}")
async def delete_hangout(hid: str, requesterId: str):
    conn=get_db()
    row=conn.execute("SELECT data FROM hangouts WHERE id=?", (hid,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Not found")
    hangout=json.loads(row["data"])
    is_global_host=is_host_user(requesterId)
    role=hangout.get("roles",{}).get(requesterId)
    if not is_global_host and role!="host" and hangout.get("createdBy")!=requesterId:
        conn.close()
        raise HTTPException(403, "Only host can delete")
    conn.execute("DELETE FROM hangouts WHERE id=?", (hid,))
    conn.commit()
    conn.close()
    await manager.broadcast({"type":"hangout_deleted","hangoutId":hid})
    await manager.broadcast({"type":"hangouts_changed"})
    return {"ok":True}

@app.delete("/api/users/{user_id}")
async def delete_user(user_id: str, requesterId: str):
    if not requesterId or not is_host_user(requesterId):
        raise HTTPException(403, "Only host can delete users")
    if user_id == requesterId:
        raise HTTPException(400, "Cannot delete yourself")
    conn=get_db()
    target=conn.execute("SELECT id,email,is_host FROM users WHERE id=?", (user_id,)).fetchone()
    if not target:
        conn.close()
        raise HTTPException(404, "User not found")
    if target["email"].lower() == HOST_EMAIL.lower():
        conn.close()
        raise HTTPException(403, "Cannot delete primary host")
    # Delete user
    conn.execute("DELETE FROM users WHERE id=?", (user_id,))
    # Cascade: remove from all hangouts members/roles/votes, keep expenses/payments as Deleted User
    rows=conn.execute("SELECT id,data FROM hangouts").fetchall()
    affected=[]
    for row in rows:
        hangout=json.loads(row["data"])
        if user_id not in hangout.get("members",[]):
            continue
        # remove from members/roles
        hangout["members"]=[m for m in hangout["members"] if m!=user_id]
        hangout["roles"].pop(user_id, None)
        # remove votes
        for lst in [hangout.get("dates",[]), hangout.get("places",[]), hangout.get("activities",[])]:
            for it in lst:
                if user_id in it.get("votes",[]):
                    it["votes"]=[v for v in it["votes"] if v!=user_id]
        # transfer host if deleted was host
        if hangout.get("createdBy")==user_id:
            # pick new host: remaining host or first member, prefer admin
            remaining=hangout["members"]
            if remaining:
                new_host=None
                for mid in remaining:
                    if hangout["roles"].get(mid)=="admin":
                        new_host=mid
                        break
                if not new_host:
                    new_host=remaining[0]
                hangout["roles"][new_host]="host"
                hangout["createdBy"]=new_host
            else:
                hangout["createdBy"]=requesterId
        # if no members left, delete hangout else update
        if len(hangout["members"])==0:
            conn.execute("DELETE FROM hangouts WHERE id=?", (hangout["id"],))
            affected.append(hangout["id"]+"(deleted empty)")
        else:
            conn.execute("UPDATE hangouts SET data=?, updated_at=? WHERE id=?", (json.dumps(hangout), datetime.utcnow().isoformat(), hangout["id"]))
            affected.append(hangout["id"])
    conn.commit()
    conn.close()
    await manager.broadcast({"type":"user_deleted","userId":user_id})
    await manager.broadcast({"type":"users_changed"})
    await manager.broadcast({"type":"hangouts_changed"})
    return {"ok":True, "deleted":user_id, "affectedHangouts":affected}
async def websocket_endpoint(websocket: WebSocket, user_id: str):
    await manager.connect(websocket, user_id)
    try:
        while True:
            data=await websocket.receive_text()
            # ping handling
            try:
                msg=json.loads(data)
                if msg.get("type")=="ping":
                    await websocket.send_text(json.dumps({"type":"pong"}))
            except:
                pass
    except WebSocketDisconnect:
        manager.disconnect(user_id)
    except:
        manager.disconnect(user_id)

@app.get("/api/health")
def health():
    return {"ok":True, "host": HOST_EMAIL}

# Serve frontend static (must be after API)
app.mount("/css", StaticFiles(directory=str(FRONT_DIR / "css")), name="css")
app.mount("/js", StaticFiles(directory=str(FRONT_DIR / "js")), name="js")
app.mount("/icons", StaticFiles(directory=str(FRONT_DIR / "icons")), name="icons")

@app.get("/{full_path:path}")
async def serve_front(full_path: str):
    # serve manifest/sw or index
    if full_path in ("manifest.json","sw.js"):
        file = FRONT_DIR / full_path
        if file.exists():
            return FileResponse(file)
    if full_path.startswith("api/") or full_path.startswith("ws"):
        raise HTTPException(404)
    # fallback to index.html for SPA
    index = FRONT_DIR / "index.html"
    return FileResponse(index)
