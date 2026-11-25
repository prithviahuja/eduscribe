import threading

MODEL_NAME = "google/flan-t5-small"

_tokenizer = None
_model = None
_lock = threading.Lock()


def _load():
    global _tokenizer, _model
    if _model is None:
        with _lock:
            if _model is None:
                from transformers import AutoTokenizer, AutoModelForSeq2SeqLM
                print("Loading summarizer model...")
                _tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
                model = AutoModelForSeq2SeqLM.from_pretrained(MODEL_NAME)
                model.eval()
                _model = model
                print("Summarizer model loaded.")
    return _tokenizer, _model


def _generate(prompt: str, max_new_tokens: int = 200) -> str:
    import torch
    tokenizer, model = _load()
    inputs = tokenizer(prompt, return_tensors="pt", truncation=True, max_length=512)
    with torch.no_grad():
        outputs = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            num_beams=4,
            repetition_penalty=2.5,
            length_penalty=1.0,
            early_stopping=True
        )
    return tokenizer.decode(outputs[0], skip_special_tokens=True)


def summarize_chunk(text: str) -> str:
    prompt = f"Extract key facts and concepts from this lecture segment: {text}"
    return _generate(prompt, max_new_tokens=150)


def generate_structured_notes(summaries: list, topic_hint: str = "") -> str:
    # Local fallback only; main.py prefers the hosted LLM APIs.
    combined = " | ".join(summaries)
    prompt = f"List the main topics and definitions from: {combined}"
    return _generate(prompt, max_new_tokens=300)
