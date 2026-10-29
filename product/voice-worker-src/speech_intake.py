"""Assemble capture-owned speech and retain bounded, editable unsubmitted inputs."""
from collections import deque
import re
import time
import uuid


def needs_confirmation(text):
    value = re.sub(r'[^0-9a-z\u4e00-\u9fff]', '', text.lower())
    value = re.sub(r'^[嗯啊呃额]+', '', value)
    if value in ('你好', '我在', '想聊什么', '谢谢', '好的', 'hello', 'thanks'):
        return False
    if re.match(r'^(打开|搜索|查找|整理|创建|读取|列出|翻译|计算|解释|总结|请|帮我)', value):
        return False
    return len(value) <= 4 or value in ('我需要', '我想要', '帮我把', '然后呢')


class SpeechAssembly:
    """Hold-mode segments wait for release; other modes share a quiet window.

    Deadlines pace submission, not identity: only one capture can own a group,
    provider item ids deduplicate finals, and finalized hold groups never reopen.
    """
    def __init__(self, settle=0.65, now=time.monotonic):
        if not 0.2 <= settle <= 1.5:
            raise ValueError('DSH_INPUT_SETTLE_MS must be between 200 and 1500')
        self.settle, self.now = settle, now
        self.groups = {}
        self.released = set()
        self.finished = set()
        self.seen = {}

    def add(self, text, metadata):
        capture = metadata.get('capture_id')
        key = (capture, metadata.get('utterance_id'))
        if key in self.seen or capture in self.finished:
            return False
        self.seen[key] = None
        if len(self.seen) > 256:
            self.seen.pop(next(iter(self.seen)))
        group = self.groups.setdefault(capture, {'id':uuid.uuid4().hex, 'parts':[], 'metadata':dict(metadata), 'updated':self.now()})
        if sum(len(part) for part in group['parts']) + len(text) > 20000:
            raise ValueError('Speech input exceeds 20000 characters')
        previous = group['parts'][-1] if group['parts'] else ''
        if text != previous:
            if previous and text.startswith(previous): group['parts'][-1] = text
            else: group['parts'].append(text)
        group['updated'] = self.now()
        return True

    def release(self, capture, discard=False):
        self.released.add(capture)
        if discard:
            self.groups.pop(capture, None); self.finished.add(capture)
        elif capture in self.groups:
            self.groups[capture]['updated'] = self.now()
        if len(self.released) > 256:
            self.released = set(list(self.released)[-128:])

    def deadline(self):
        values = [g['updated'] + self.settle for capture,g in self.groups.items() if g['metadata'].get('input_mode') != 'hold' or capture in self.released]
        return min(values) if values else None

    def ready(self):
        result = []
        for capture,group in list(self.groups.items()):
            mode = group['metadata'].get('input_mode')
            if mode == 'hold' and capture not in self.released or self.now() < group['updated'] + self.settle:
                continue
            self.groups.pop(capture)
            if mode == 'hold' or capture in self.released: self.finished.add(capture)
            text = ''.join(group['parts'])
            result.append((text, {**group['metadata'], 'speech_id':group['id'], 'segments':len(group['parts']), 'assembled':True}))
        if len(self.finished) > 256: self.finished = set(list(self.finished)[-128:])
        return result


class PendingInputs:
    """Unsubmitted input queue only. DSH retains all admitted execution authority."""
    def __init__(self, limit=5, ttl=60, now=time.monotonic):
        if not 1 <= limit <= 20 or not 10 <= ttl <= 600:
            raise ValueError('Invalid pending-input limit or lifetime')
        self.limit,self.ttl,self.now = limit,ttl,now
        self.items = deque()
        self.revision = 0

    def __bool__(self): return bool(self.items)
    def __len__(self): return len(self.items)
    def __iter__(self): return (item['text'] for item in self.items)

    def append(self, text, metadata=None, confirm=False):
        if len(self.items) >= self.limit: raise ValueError('等待队列已满，请先处理现有输入。')
        item = {'id':uuid.uuid4().hex,'text':text,'metadata':dict(metadata or {}),'created':self.now(),'expires':self.now()+self.ttl,'confirm':confirm}
        self.items.append(item);self.revision += 1
        return item

    def clear(self): self.items.clear();self.revision += 1
    def restore(self, item): self.items.appendleft(item);self.revision += 1
    def quarantine(self):
        for item in self.items: item['confirm'] = True
        self.revision += 1

    def snapshot(self):
        return {'revision':self.revision,'entries':[{'id':x['id'],'text':x['text'],'position':i+1,'waitedSeconds':round(self.now()-x['created']),'needsConfirmation':x['confirm'] or self.now() >= x['expires']} for i,x in enumerate(self.items)]}

    def edit(self, item_id, revision, action, text=None):
        if revision != self.revision: raise ValueError('队列已变化，请重新查看。')
        item = next((x for x in self.items if x['id']==item_id),None)
        if item is None: raise ValueError('这条输入已被接收或删除。')
        if action == 'delete': self.items.remove(item)
        elif action in ('edit','confirm'):
            if action == 'edit':
                if not isinstance(text,str) or not text.strip() or len(text)>20000: raise ValueError('请输入有效内容。')
                item['text']=text.strip()
            item['confirm']=False;item['expires']=self.now()+self.ttl
            item['metadata']['input_confirmed']=True
            item['metadata']['queue_action']=action
        else: raise ValueError('不支持的队列操作。')
        self.revision += 1

    def take(self):
        if not self.items or self.items[0]['confirm'] or self.now() >= self.items[0]['expires']: return None
        item=self.items.popleft();self.revision += 1;return item

    def popleft(self):
        item=self.take()
        return item['text'] if item else None
