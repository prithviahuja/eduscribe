import os
import shutil
import uuid

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# Only load backend/.env — a bare load_dotenv() walks up parent folders and can
# silently pick up some other project's .env.
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

from database import (  # noqa: E402
    DatabaseNotConfigured, is_configured,
    get_all_subjects, get_subject, create_subject, delete_subject,
    get_lectures_by_subject, create_lecture, update_lecture_notes,
    get_lecture, delete_lecture,
)
from importance_scorer import score_text_importance, score_audio_importance  # noqa: E402
from ppt_parser import extract_ppt_text  # noqa: E402
from pyq_parser import extract_pyq_text  # noqa: E402
from text_cleaner import clean_transcript  # noqa: E402

app = FastAPI(title="EduScribe API")

_default_origins = "http://localhost:3000,http://127.0.0.1:3000"
ALLOWED_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", _default_origins).split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)


# ── Error handling ────────────────────────────────────
# Handlers for specific exception classes run inside the CORS middleware, so
# the browser receives a readable JSON error instead of an opaque CORS failure.

@app.exception_handler(DatabaseNotConfigured)
async def db_not_configured_handler(_: Request, exc: DatabaseNotConfigured):
    return JSONResponse(status_code=503, content={"detail": str(exc)})

try:
    from postgrest.exceptions import APIError as PostgrestAPIError

    @app.exception_handler(PostgrestAPIError)
    async def postgrest_error_handler(_: Request, exc: PostgrestAPIError):
        msg = getattr(exc, "message", None) or str(exc)
        return JSONResponse(status_code=502, content={"detail": f"Database error: {msg}"})
except ImportError:
    pass

@app.exception_handler(httpx.HTTPError)
async def httpx_error_handler(_: Request, exc: httpx.HTTPError):
    return JSONResponse(status_code=502, content={"detail": f"Upstream connection error: {exc}"})


@app.get("/")
def root():
    return {"status": "EduScribe backend running", "database_configured": is_configured()}


# ── Audio processing ──────────────────────────────────
# Plain `def` routes run in FastAPI's threadpool, so the CPU-heavy Whisper /
# summarizer work doesn't block the event loop for other requests.

@app.post("/process-chunk")
def process_chunk(audio: UploadFile = File(...)):
    chunk_id = str(uuid.uuid4())
    ext = os.path.splitext(audio.filename or "")[1] or ".webm"
    raw_path = os.path.join(UPLOAD_DIR, f"{chunk_id}{ext}")
    wav_path = os.path.join(UPLOAD_DIR, f"{chunk_id}.wav")

    with open(raw_path, "wb") as f:
        shutil.copyfileobj(audio.file, f)

    try:
        if os.path.getsize(raw_path) < 1000:
            return {"transcript": "", "importance_score": 0.0, "summary": ""}

        try:
            from pydub import AudioSegment
            # Let ffmpeg probe the container (Chrome sends webm, Safari sends mp4)
            audio_seg = AudioSegment.from_file(raw_path)
            audio_seg.export(wav_path, format="wav")
        except Exception as e:
            raise HTTPException(
                status_code=422,
                detail=f"Audio conversion failed (is ffmpeg installed and on PATH?): {e}",
            )

        from stt import transcribe_audio
        transcript = transcribe_audio(wav_path)
        cleaned = clean_transcript(transcript)
        text_score = score_text_importance(cleaned)
        audio_score = score_audio_importance(wav_path)
        combined_score = round((text_score + audio_score) / 2, 2)

        summary = ""
        if cleaned.strip():
            try:
                from summarizer import summarize_chunk
                summary = summarize_chunk(cleaned)
            except Exception as e:
                print(f"[Summarizer] failed, using transcript: {e}")
                summary = cleaned
    finally:
        for p in (raw_path, wav_path):
            if os.path.exists(p):
                try:
                    os.remove(p)
                except OSError:
                    pass

    return {
        "transcript": cleaned,
        "importance_score": combined_score,
        "summary": summary,
    }


def _build_prompt(numbered: str, extra_context: str) -> str:
    return f"""You are an expert academic note-taker for university students. Below are sequential summaries extracted from a live lecture recording. Convert them into comprehensive, well-structured study notes.

LECTURE SUMMARIES (chronological order):
{numbered}
{extra_context}
Write detailed academic study notes using this EXACT structure in markdown:

# [Detect and write the actual main topic of this lecture]

## Overview
2-3 sentences describing what this lecture covers and why it matters to students.

## Core Concepts

For EACH distinct concept found in the summaries, write:

### [Concept Name]
**Definition:** Clear, precise definition.
**Explanation:** 3-5 sentences explaining how it works, a student can understand and memorize.
**Example:** Concrete example. Use one from the lecture if present.

## Key Relationships
How do the concepts connect or build on each other? Explain in bullet points.

## Important Facts to Remember
- Every specific fact, number, formula, named item, or technical term mentioned
- Each bullet is a standalone fact worth memorizing
- Include all named algorithms, methods, or models mentioned

## Exam Focus
4-6 likely exam questions based on this content, with brief answers.

## Summary
4-5 sentence paragraph tying everything together. A student reading only this should understand the full lecture scope.

STRICT RULES:
- Only use content present in the summaries. Never invent or hallucinate facts.
- Be thorough and detailed — students will study exclusively from these notes.
- If a concept appears across multiple summaries, combine all mentions into one rich section.
- Always fill in actual content — never write placeholder text like [concept name].
- Use proper academic English throughout."""


@app.post("/generate-notes")
def generate_notes(data: dict):
    summaries = [s for s in data.get("summaries", []) if isinstance(s, str) and s.strip()]
    lecture_id = data.get("lecture_id", "") or ""

    if not summaries:
        return {"notes": "", "session_id": lecture_id}

    numbered = "\n".join(f"{i+1}. {s.strip()}" for i, s in enumerate(summaries))
    ppt_context = data.get("ppt_text", "") or ""
    pyq_context = data.get("pyq_text", "") or ""

    extra_context = ""
    if ppt_context:
        extra_context += f"\n\nSLIDE CONTENT FROM PPT:\n{ppt_context[:1500]}"
    if pyq_context:
        extra_context += f"\n\nPREVIOUS YEAR EXAM QUESTIONS:\n{pyq_context[:1000]}"

    prompt = _build_prompt(numbered, extra_context)
    notes = ""

    # 1. Groq
    groq_key = os.getenv("GROQ_API_KEY", "").strip()
    if groq_key and not groq_key.startswith("your_"):
        try:
            from groq import Groq
            client = Groq(api_key=groq_key)
            response = client.chat.completions.create(
                model=os.getenv("GROQ_MODEL", "openai/gpt-oss-120b"),
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3,
                max_tokens=4000,
            )
            notes = response.choices[0].message.content or ""
            print(f"[Notes] Generated via Groq — {len(notes)} chars")
        except Exception as e:
            print(f"[Notes] Groq error: {e}")

    # 2. Anthropic
    if not notes:
        anthropic_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
        if anthropic_key and not anthropic_key.startswith("your_"):
            try:
                with httpx.Client(timeout=90.0) as client:
                    response = client.post(
                        "https://api.anthropic.com/v1/messages",
                        headers={
                            "Content-Type": "application/json",
                            "x-api-key": anthropic_key,
                            "anthropic-version": "2023-06-01",
                        },
                        json={
                            "model": "claude-haiku-4-5-20251001",
                            "max_tokens": 3000,
                            "messages": [{"role": "user", "content": prompt}],
                        },
                    )
                if response.status_code == 200:
                    blocks = response.json().get("content", [])
                    notes = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
                    print(f"[Notes] Generated via Anthropic — {len(notes)} chars")
                else:
                    print(f"[Notes] Anthropic error: {response.status_code} {response.text[:300]}")
            except Exception as e:
                print(f"[Notes] Anthropic error: {e}")

    # 3. Gemini
    if not notes:
        gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
        if gemini_key and not gemini_key.startswith("your_"):
            try:
                from google import genai as google_genai
                gclient = google_genai.Client(api_key=gemini_key)
                response = gclient.models.generate_content(
                    model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
                    contents=prompt,
                )
                notes = response.text or ""
                print(f"[Notes] Generated via Gemini — {len(notes)} chars")
            except Exception as e:
                print(f"[Notes] Gemini error: {e}")

    # 4. Local fallback
    if not notes:
        print("[Notes] All APIs failed or unconfigured, using local fallback")
        try:
            from summarizer import _generate
            combined = ". ".join(summaries[:6])
            notes = _generate(f"List the main topics and key facts from: {combined}", max_new_tokens=300)
            notes = "# Lecture Notes (local fallback)\n\n" + notes + \
                "\n\n## Key Points\n" + "\n".join(f"- {s}" for s in summaries)
        except Exception as e:
            print(f"[Notes] Local fallback failed: {e}")
            notes = "# Lecture Notes\n\n## Key Points\n" + "\n".join(f"- {s}" for s in summaries)

    return {"notes": notes, "session_id": lecture_id}


@app.get("/session/{session_id}")
def get_session_route(session_id: str):
    session = get_lecture(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


# ── Subjects ──────────────────────────────────────────

@app.get("/subjects")
def list_subjects():
    return get_all_subjects()

@app.get("/subjects/{subject_id}")
def get_subject_route(subject_id: str):
    subject = get_subject(subject_id)
    if not subject:
        raise HTTPException(status_code=404, detail="Subject not found")
    return subject

@app.post("/subjects")
def add_subject(data: dict):
    name = (data.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Subject name is required")
    return create_subject(name, data.get("description", "") or "", data.get("color", "#6366f1") or "#6366f1")

@app.delete("/subjects/{subject_id}")
def remove_subject(subject_id: str):
    delete_subject(subject_id)
    return {"ok": True}


# ── Lectures ──────────────────────────────────────────

@app.get("/subjects/{subject_id}/lectures")
def list_lectures(subject_id: str):
    return get_lectures_by_subject(subject_id)

@app.post("/subjects/{subject_id}/lectures")
def add_lecture(
    subject_id: str,
    title: str = Form(...),
    ppt_file: UploadFile | None = File(None),
    pyq_file: UploadFile | None = File(None),
):
    if not title.strip():
        raise HTTPException(status_code=400, detail="Lecture title is required")

    ppt_text = ""
    pyq_text = ""

    if ppt_file and ppt_file.filename:
        ppt_path = os.path.join(UPLOAD_DIR, f"ppt_{uuid.uuid4()}.pptx")
        try:
            with open(ppt_path, "wb") as f:
                shutil.copyfileobj(ppt_file.file, f)
            ppt_text = " ".join(extract_ppt_text(ppt_path))
        except Exception as e:
            print(f"PPT parse error: {e}")
        finally:
            if os.path.exists(ppt_path):
                os.remove(ppt_path)

    if pyq_file and pyq_file.filename:
        pyq_path = os.path.join(UPLOAD_DIR, f"pyq_{uuid.uuid4()}.pdf")
        try:
            with open(pyq_path, "wb") as f:
                shutil.copyfileobj(pyq_file.file, f)
            pyq_text = extract_pyq_text(pyq_path)
        except Exception as e:
            print(f"PYQ parse error: {e}")
        finally:
            if os.path.exists(pyq_path):
                os.remove(pyq_path)

    return create_lecture(subject_id, title.strip(), ppt_text, pyq_text)

@app.get("/lectures/{lecture_id}")
def get_lecture_route(lecture_id: str):
    lecture = get_lecture(lecture_id)
    if not lecture:
        raise HTTPException(status_code=404, detail="Lecture not found")
    return lecture

@app.delete("/lectures/{lecture_id}")
def remove_lecture(lecture_id: str):
    delete_lecture(lecture_id)
    return {"ok": True}

@app.post("/lectures/{lecture_id}/save")
def save_lecture(lecture_id: str, data: dict):
    if not get_lecture(lecture_id):
        raise HTTPException(status_code=404, detail="Lecture not found")
    summaries = data.get("summaries", []) or []
    notes = data.get("notes", "") or ""
    duration = int(data.get("duration", 0) or 0)
    update_lecture_notes(lecture_id, summaries, notes, duration)
    return {"ok": True}
