import threading

_model = None
_lock = threading.Lock()


def _get_model():
    global _model
    if _model is None:
        with _lock:
            if _model is None:
                from faster_whisper import WhisperModel
                print("Loading Whisper model...")
                _model = WhisperModel("base", device="cpu", compute_type="int8")
                print("Whisper model loaded.")
    return _model


def _load_audio(audio_path: str):
    """Decode audio to 16 kHz mono float32 ourselves. Passing a numpy array
    skips faster-whisper's PyAV decoder, which breaks with newer `av` releases."""
    import librosa
    audio, _ = librosa.load(audio_path, sr=16000, mono=True)
    return audio.astype("float32")


def transcribe_audio(audio_path: str) -> str:
    audio = _load_audio(audio_path)
    if audio.size == 0:
        return ""
    segments, _ = _get_model().transcribe(audio, beam_size=5)
    transcript = " ".join([seg.text for seg in segments])
    return transcript.strip()


if __name__ == "__main__":
    import sys
    audio_file = sys.argv[1] if len(sys.argv) > 1 else "test.wav"
    print("Transcript:")
    print(transcribe_audio(audio_file))
