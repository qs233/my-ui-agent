🌐 UI Scene Graph / VCT 设计（收敛版）
1. 核心思想

系统不再使用纯 DOM containment，而是三种约束共同决定：

VCT = Motion Group + Visual Dominance + Soft Geometry Containment

2. Node 结构（VNode）
interface VNode {
    // ---------- Identity ----------
    id: number;
    tag: string;

    // ---------- Geometry ----------
    bbox: Rect;                 // DOMSnapshot layout bbox
    visibleBBox?: Rect;         // ∩ effectiveClip（可缓存）

    // ---------- Rendering ----------
    paintOrder: number;

    // ---------- CSS ----------
    position: PositionType;
    overflowX: OverflowType;
    overflowY: OverflowType;

    // ---------- Tree ----------
    domParent: VNode | null;
    foldedParent: VNode | null;
    vctParent: VNode | null;
    children: VNode[];

    // ---------- Motion ----------
    motionGroup: number;

    // ---------- Semantic ----------
    anchorId?: number;          // tooltip / dropdown / popover

    // ---------- Flags ----------
    createsClip: boolean;
    createsScrollContainer: boolean;
}
3. Geometry Pass（统一计算阶段）
3.1 当前上下文

DFS 过程中维护：

currentClip: Rect
currentMotionGroup: number
3.2 visibleBBox（延迟计算）
visibleBBox = intersect(bbox, currentClip)
3.3 clip 更新规则
if (node creates clip) {
    childClip = intersect(currentClip, node.clipRect)
} else {
    childClip = currentClip
}
3.4 motion group 更新规则
if (position: fixed) {
    motionGroup = VIEWPORT_GROUP
}

else if (overflow: auto | scroll) {
    motionGroup = NEW_SCROLL_GROUP
}

else {
    inherit parent motionGroup
}
4. VisibleBBox 的意义
代表节点真实参与视觉结构的区域
用于：
VCT 重挂
containment
spatial indexing
merge 判断（可选）
5. Wrapper Merge（折叠阶段）
条件（保守策略）
only one child
AND child is mergeable tag
AND paintOrder(child) > paintOrder(parent)
AND position is static
AND overflow is normal
AND child bbox ⊆ parent bbox (or approx containment)

👉 注意：这里仍然可以用 bbox（不是 visibleBBox）

6. VCT 构建（核心）
6.1 Step 1 — Motion Filter（必须）
candidate.motionGroup == child.motionGroup

否则直接跳过

6.2 Step 2 — Soft Visual Dominance（核心）

定义：

coverage =
area(intersection(child.visibleBBox, candidate.visibleBBox))
/
area(child.visibleBBox)
条件：
coverage >= threshold (0.6 ~ 0.8)

👉 允许“不完全包含”（软约束）

6.3 Step 3 — 选择最佳 parent
score = coverage + bias

在满足条件的 candidate 中：

argmax(score, minimal visibleBBox area)
6.4 Step 4 — fallback

如果没有候选：

if fixed / overlay / portal:
    parent = viewport

else:
    parent = dom fallback OR anchorId
7. VCT 重挂规则总结

一个节点是否脱离 Folded Tree：

❌ 不触发重挂
仅 bbox 溢出
margin / relative offset
小幅 absolute 偏移
overflow visible
✔ 触发重挂
1. Motion Group 不一致
fixed / scroll container mismatch
2. Visual Dominance 太弱
coverage < threshold
3. 跨容器浮层结构
dropdown / tooltip / modal / portal
✔ 不是条件（重要修正）
❌ strict bbox containment
❌ DOM parent 不匹配
❌ paintOrder alone
❌ simple overflow detection
8. Motion Group（运动一致性）
定义

描述节点“跟随哪个滚动/视口系统移动”

分类
VIEWPORT_GROUP → fixed / global UI
SCROLL_GROUP → 主内容
NESTED_SCROLL_GROUP → 嵌套容器
PORTAL_GROUP → body / overlay
规则
motionGroup 决定“能不能互为父子”
9. Anchor 关系（语义补充）

用于：

dropdown
tooltip
popover
context menu
anchorId?: number
10. 最终系统分层
Layer 1：Geometry
bbox + visibleBBox + clip
Layer 2：Motion
motionGroup
Layer 3：Structural (Folded Tree)
DOM compression
Layer 4：Visual (VCT)
soft containment + dominance
Layer 5：Semantic Links
anchorId
11. 核心统一公式（最终版）
VCT Parent =
argmax_candidate(
    coverage(child, candidate)
    + motion_consistency
    + size_bias
)

subject to:

motionGroup match
AND coverage > threshold
12. 一句话总结

VCT 不再是 DOM containment tree，而是：

“在同一运动系统内，通过软几何支配关系构建的视觉归属图”