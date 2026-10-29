"""One expiring, single-use transcript preview per WebRTC connection.

ASR text is not speaker identity or confidence. Passive listening therefore
requires explicit submission; hold/toggle retain their deliberate capture path.
"""
import time
import uuid


class InputAdmission:
    def __init__(self, now=time.monotonic, ttl=30):
        self.now, self.ttl = now, ttl
        self.draft = None
        self.seen = {}

    def offer(self, text, metadata):
        key = (metadata.get('capture_id'), metadata.get('utterance_id'))
        if key in self.seen:
            return None
        self.seen[key] = None
        if len(self.seen) > 256:
            self.seen.pop(next(iter(self.seen)))
        if self.draft and self.now() < self.draft['expires']:
            return None
        self.draft = dict(id=uuid.uuid4().hex, text=text, metadata=dict(metadata), expires=self.now()+self.ttl)
        return self.draft

    def take(self, draft_id, text=None):
        draft = self.draft
        if not draft or draft_id != draft['id']:
            return None
        self.draft = None
        if self.now() >= draft['expires']:
            return None
        chosen = draft['text'] if text is None else text
        if not isinstance(chosen, str) or not chosen.strip() or len(chosen) > 20000:
            return None
        return {**draft, 'text': chosen.strip()}

    def discard(self, draft_id):
        if self.draft and self.draft['id'] == draft_id:
            self.draft = None
            return True
        return False
