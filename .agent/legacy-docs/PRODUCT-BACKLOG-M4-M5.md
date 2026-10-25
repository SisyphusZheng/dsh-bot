# Nisse 产品待办（M4/M5）：语音气泡与交互

> 来源：2026-10-21 W2 真机语音测试 + 用户参考图评审
> 性质：**产品层（M4/M5）任务**，不属于 M1 Spike 范围；M1 已产出可参考的视觉原型与补丁。
> 视觉原型证据：`spike/dsh-voice/evidence/W2-UI-BUBBLE-FIX.md` §9、`spike/dsh-voice/evidence/raw/w2-bubble-reference-vs-v3.png`、`w2-bubble-style-v3.patch`

## 1. 待修问题（用户 2026-10-21 指出）

| id | 问题 | 期望 | 优先级 |
|---|---|---|---|
| UI-B1 | **阴影错误**：气泡/Tail 的投影方向与强度不一致，tail 与卡片接缝处出现错位阴影 | 移除 tail 与卡片之间接缝阴影；卡片阴影统一方向/强度（参考图：柔和的向下投影，tail 无独立重影） | P1 |
| UI-B2 | **尖角没有闭合**：tail 旋转方块的角在卡片边缘处露出/未与卡片边框闭合，箭头尖角处有缝隙或重叠 | tail 与卡片边框无缝连接，尖角完整闭合（建议 SVG 绘制 tail 或精确裁剪 mask） | P1 |
| UI-B3 | **无法点击**：气泡窗口当前 `setIgnoreMouseEvents(true)` 点击穿透，按钮/关闭不可用 | action 类气泡可点击：只接受预声明 action（id/label/style），IPC 回产品层；speech 气泡仍点击穿透 | P1 |
| UI-B4 | **实际工作需要交互**：更新重启/下次再说、审批允许/拒绝、任务卡片等都需要可操作 | 气泡支持 actions 协议 + 键盘可达 + 安全白名单；与审批/更新/任务状态机对接 | P1 |
| UI-B5 | 视觉微调：字号/行高/内边距/圆角/按钮宽度/尾巴大小与参考图仍有差距 | 按参考图逐项对齐，产出设计 token（颜色/字号/圆角/阴影） | P2 |
| UI-B6 | 角色头顶 offset 目前为 whale-girl 实测 42px | 从皮肤元数据读取（或渲染层上报角色 bbox），适配多皮肤/缩放 | P2 |
| UI-B7 | headroom 规则：orb 位置需保证上方有气泡空间 | 默认/拖拽/恢复位置时约束；空间不足优先下移 orb，侧边仅极端 fallback | P2 |
| UI-B8 | 多屏/任务卡栈/多皮肤回归 | 统一回归矩阵 + 截图证据 | P2 |

## 2. M4/M5 交付建议

- **M4（MVP 主路径）**：UI-B1/UI-B2/UI-B3/UI-B4/UI-B6/UI-B7（气泡是语音与审批的主要出口）。
- **M5（Alpha 体验）**：UI-B5 视觉对齐、UI-B8 回归、动效与可访问性。
- 设计 token 建议单独成文件（颜色/字号/圆角/阴影/间距），避免散落在 CSS。
- 交互协议建议：`bubble payload = { visible, text, kind:'speech'|'action', actions:[{id,label,style}], closable, turnId }`；
  action 点击走 IPC 白名单，跨 turn 的旧 action 一律丢弃。
