import os
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

supabase_url = os.getenv("SUPABASE_URL", "").strip()
supabase_key = os.getenv("SUPABASE_KEY", "").strip()


class DatabaseNotConfigured(RuntimeError):
    pass


_client = None


def _db():
    """Lazily create the Supabase client so the server can still boot (and the
    audio/notes endpoints keep working) when Supabase isn't configured yet."""
    global _client
    if _client is not None:
        return _client
    if not supabase_url or not supabase_key or "your_supabase" in supabase_url:
        raise DatabaseNotConfigured(
            "SUPABASE_URL and SUPABASE_KEY must be set in backend/.env "
            "(copy .env.example to .env and fill in your Supabase credentials)."
        )
    from supabase import create_client
    _client = create_client(supabase_url, supabase_key)
    return _client


def is_configured() -> bool:
    try:
        _db()
        return True
    except Exception:
        return False


# ── Subjects ──────────────────────────────────────────
def get_all_subjects():
    r = _db().table("subjects").select("*").order("created_at", desc=False).execute()
    return r.data or []

def get_subject(subject_id: str):
    r = _db().table("subjects").select("*").eq("id", subject_id).execute()
    return r.data[0] if r.data else None

def create_subject(name: str, description: str = "", color: str = "#6366f1"):
    r = _db().table("subjects").insert({
        "name": name, "description": description, "color": color
    }).execute()
    return r.data[0]

def delete_subject(subject_id: str):
    # Delete child lectures first so this works even without ON DELETE CASCADE
    _db().table("lectures").delete().eq("subject_id", subject_id).execute()
    _db().table("subjects").delete().eq("id", subject_id).execute()

# ── Lectures ──────────────────────────────────────────
def get_lectures_by_subject(subject_id: str):
    r = _db().table("lectures").select("*").eq("subject_id", subject_id).order("created_at", desc=True).execute()
    return r.data or []

def create_lecture(subject_id: str, title: str, ppt_text: str = "", pyq_text: str = ""):
    r = _db().table("lectures").insert({
        "subject_id": subject_id,
        "title": title,
        "ppt_text": ppt_text,
        "pyq_text": pyq_text,
        "summaries": [],
        "notes": ""
    }).execute()
    return r.data[0]

def update_lecture_notes(lecture_id: str, summaries: list, notes: str, duration: int = 0):
    _db().table("lectures").update({
        "summaries": summaries,
        "notes": notes,
        "duration_seconds": duration
    }).eq("id", lecture_id).execute()

def get_lecture(lecture_id: str):
    r = _db().table("lectures").select("*").eq("id", lecture_id).execute()
    return r.data[0] if r.data else None

def delete_lecture(lecture_id: str):
    _db().table("lectures").delete().eq("id", lecture_id).execute()
