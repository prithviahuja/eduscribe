const API = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/\/$/, "");

export interface Subject {
  id: string;
  name: string;
  description: string;
  color: string;
  created_at: string;
}

export interface Lecture {
  id: string;
  subject_id: string | null;
  title: string;
  notes: string;
  ppt_text: string;
  pyq_text: string;
  summaries: string[];
  duration_seconds: number;
  created_at: string;
}

export interface ChunkResult {
  transcript: string;
  importance_score: number;
  summary: string;
}

/** Fetch wrapper: throws an Error with the backend's `detail` message on failure. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, init);
  } catch {
    throw new Error(`Cannot reach the backend at ${API}. Is it running?`);
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Subjects
export function getSubjects() {
  return request<Subject[]>("/subjects");
}
export function getSubject(id: string) {
  return request<Subject>(`/subjects/${id}`);
}
export function createSubject(name: string, description: string, color: string) {
  return request<Subject>("/subjects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description, color }),
  });
}
export async function deleteSubject(id: string) {
  await request(`/subjects/${id}`, { method: "DELETE" });
}

// Lectures
export function getLectures(subjectId: string) {
  return request<Lecture[]>(`/subjects/${subjectId}/lectures`);
}
export function createLecture(subjectId: string, title: string, pptFile?: File, pyqFile?: File) {
  const form = new FormData();
  form.append("title", title);
  if (pptFile) form.append("ppt_file", pptFile);
  if (pyqFile) form.append("pyq_file", pyqFile);
  return request<Lecture>(`/subjects/${subjectId}/lectures`, { method: "POST", body: form });
}
export function getLecture(lectureId: string) {
  return request<Lecture>(`/lectures/${lectureId}`);
}
export async function deleteLecture(id: string) {
  await request(`/lectures/${id}`, { method: "DELETE" });
}
export async function saveLecture(lectureId: string, summaries: string[], notes: string, duration: number) {
  await request(`/lectures/${lectureId}/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ summaries, notes, duration }),
  });
}

// Audio processing
export function processChunk(audioBlob: Blob) {
  const form = new FormData();
  const ext = audioBlob.type.includes("mp4") ? "mp4" : audioBlob.type.includes("ogg") ? "ogg" : "webm";
  form.append("audio", audioBlob, `chunk.${ext}`);
  return request<ChunkResult>("/process-chunk", { method: "POST", body: form });
}
export function generateNotes(
  summaries: string[],
  transcripts: string[],
  pptText = "",
  pyqText = "",
  lectureId = "",
) {
  return request<{ notes: string; session_id: string }>("/generate-notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ summaries, transcripts, ppt_text: pptText, pyq_text: pyqText, lecture_id: lectureId }),
  });
}
