import re
from collections import Counter

import numpy as np

IMPORTANCE_KEYWORDS = ["important", "remember", "note this", "exam", "key concept", "definition", "formula"]


def score_text_importance(text: str) -> float:
    score = 0.0
    text_lower = text.lower()

    for kw in IMPORTANCE_KEYWORDS:
        if kw in text_lower:
            score += 1.5

    words = re.findall(r'\b\w+\b', text_lower)
    word_freq = Counter(words)
    repetition_bonus = sum(1 for count in word_freq.values() if count > 2)
    score += repetition_bonus * 0.3

    return min(score, 10.0)  # cap at 10


def score_audio_importance(audio_path: str) -> float:
    try:
        import librosa
        y, sr = librosa.load(audio_path, sr=None)
        if y.size == 0:
            return 0.0
        rms = librosa.feature.rms(y=y)[0]
        avg_loudness = float(np.mean(rms))
        pitches, _ = librosa.piptrack(y=y, sr=sr)
        voiced = pitches[pitches > 0]
        pitch_variance = float(np.var(voiced)) if voiced.size else 0.0
        score = avg_loudness * 10 + pitch_variance * 0.001
        if not np.isfinite(score):
            return 0.0
        return float(min(score, 10.0))
    except Exception as e:
        print(f"[Audio score] failed: {e}")
        return 0.0
