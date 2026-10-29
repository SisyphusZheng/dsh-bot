"""Optional address phrase after ASR; this does not implement offline wake-word detection."""
import time


class WakePhrase:
    def __init__(self, phrase: str = "", window_seconds: float = 30):
        self.phrase = phrase.strip()
        self.window_seconds = window_seconds
        self.until = 0.0

    def admit(self, text: str, *, active: bool = False, now: float | None = None, commit: bool = True) -> str | None:
        now = time.monotonic() if now is None else now
        if not self.phrase:
            return text
        if text.startswith(self.phrase):
            if commit:
                self.until = now + self.window_seconds
            return text[len(self.phrase):].lstrip(" ，,。.!！?？：:")
        if active or now < self.until:
            if commit:
                self.until = now + self.window_seconds
            return text
        return None
