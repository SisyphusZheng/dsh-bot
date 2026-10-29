"""Exact spoken controls; ordinary speech stays with the DSH Agent."""
import re


def normalize(text):
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]", "", str(text).lower())


_PHRASES = {
    'playback-stop': ('停', '停啊', '停吧', '停止', '停下', '取消', '不用了', '别播', '打断', '先停', '停一下', '先停一下', '等一下', '暂停', '别说了', '别念了', '别播了', '停止播放', '停止播报', 'stop', 'cancel'),
    'playback-brief':('只说结论','简短播报','跳过细节'),
    'playback-full':('详细播报','完整播报'),
    'task-stop': ('停止任务', '确认停止任务', '停止当前任务', '取消任务', '取消当前任务', '取消这个任务', '停止这个任务', 'stop task', 'cancel task'),
    'approval-allow': ('允许', '允许一次', '确认允许一次', '允许这次', '批准这次', '同意这次', '是'),
    'approval-reject': ('拒绝', '不允许', '拒绝这次', '不要执行', '否'),
    'approval-ambiguous': ('可以', '好', '好像可以', '应该可以'),
    'task-status': ('现在做到哪里了', '现在做到哪了', '任务进度', '当前任务状态', '任务怎么样了'),
}
_CONTROLS = {normalize(phrase): kind for kind, phrases in _PHRASES.items() for phrase in phrases}

# Spoken approvals usually arrive as "我允许一次" / "好的，确认允许一次".  Only
# strip a leading discourse prefix when the remainder is still an exact control
# phrase; this keeps ordinary sentences such as "我不允许你这么做" untouched.
_PREFIXES = ('我这边', '我', '好的', '好', '嗯', '那', '那就', '请', '麻烦', '确认一下')


def control_text(text):
    """Normalized text with an optional leading discourse prefix removed."""
    value = normalize(text)
    for prefix in sorted(_PREFIXES, key=len, reverse=True):
        if value.startswith(prefix) and len(value) > len(prefix):
            candidate = value[len(prefix):]
            if candidate in _CONTROLS:
                return candidate
    return value


def control_kind(text):
    value = normalize(text)
    kind = _CONTROLS.get(value)
    if kind is not None:
        return kind
    return _CONTROLS.get(control_text(text))
