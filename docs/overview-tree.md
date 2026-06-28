# Visual Containment Tree

## 目标

VCT（Visual Containment Tree）用于把网页复杂的 DOM 结构整理成一棵以视觉包含关系为主的树，供 UI Agent 快速理解页面区域、文本、媒体和可能的操作边界。视觉包含关系：最紧密空间母节点（Tightest Spatial Parent）

它不是 DOM 树的复刻，也不负责推断控件业务语义；交互等信息主要由后续模型根据真实标签、文本和属性自行判断。

## 原始需求

- 只保留可见且具有有效尺寸的页面节点。
- 以视觉包含关系为主构建层级，同时利用 DOM 父子关系提高准确性和效率。
- 折叠安全的单子 DOM wrapper，减少无意义层级；折叠后通过 `collapsedDomNodeIds` 保留被折叠 wrapper 的 DOM 节点 ID。
- 保留可能带来重要视觉、媒体、表单或原生交互语义的标签边界，不为了紧凑输出而吞掉它们。
- 正确处理弹窗、吸顶栏等 `fixed`、`sticky` 元素和滚动/裁剪候选容器。
- 输出应紧凑、可读，并保留理解页面所需的 VCT 引用 ID、标签、类名、名称、文本、滚动候选标记和必要的重挂载元数据。

## 当前设计逻辑

整体流程严格分为四步：

1. **采集页面快照**：`captureSnapshot(page)` 只通过 CDP 获取主文档的 DOM、layout、paintOrder 和必要计算样式，输出 `SnapshotResponse`。
2. **准备 DOM 记录表**：主路径使用 `visibleNodesFromSnapshot()` 直接从 `SnapshotResponse` 收集元素和文本候选，完成可见性与尺寸过滤、文本归属和最近有效 parent 重写，输出不再带可见性标志的 `DomNodeRecord[]`。这里的 record 只覆盖经过可视筛选保留下来的 DOM 节点，不是原始 CDP snapshot layout 全量节点表。`decodeSnapshot()` 和 `prepareNodes()` 仍保留为兼容、调试和单元测试用的分层 API。
3. **折叠 DOM wrapper**：`collapseDomTree()` 恢复 retained DOM，后序折叠满足绝对包含和绘制顺序条件的单子 wrapper；preserve tags、`fixed`、`sticky` 和滚动/裁剪候选节点作为边界不参与折叠。输出 parent 已指向存活代表的扁平 `CollapsedNode[]`。
4. **构建 VCT**：`buildVisualContainmentTree()` 只消费 `CollapsedNode[]`，按面积从大到小处理，输出 `VctNode[]`；顶层入口会把 DOM 记录表、折叠节点索引和 VCT 根节点包装成 `VctSnapshot`。VCT 构建分为两条路径：
   - **DOM 快路径**：沿 DOM 祖先向上查找已经进入视觉树的有效节点。只有同时满足空间包含和绘制顺序时才挂载；遇到空间断层或普通容器下的悬浮元素时立即停止。
   - **R-Tree 慢路径**：快路径失败后，通过空间索引寻找候选容器，过滤掉不满足近似包含、绘制顺序、悬浮层级或滚动/裁剪边界规则的节点，再选择面积最小的容器作为视觉父节点。找不到时保留为独立根节点。

最终结果既可以输出为结构化树，也可以按页面空间顺序序列化为缩进文本。

完整调用链：

```text
captureSnapshot(page) → SnapshotResponse
visibleNodesFromSnapshot(snapshot) → DomNodeRecord[]
collapseDomTree(raw) → CollapsedNode[]
buildVisualContainmentTree(collapsed) → VctNode[]
captureOverview(page/url) → VctSnapshot
```

`DomNodeRecord`、`CollapsedNode` 与 `VctNode` 分离：`DomNodeRecord` 是当前快照里可查询的 retained DOM 记录；`CollapsedNode` 只表示折叠后的 DOM 节点和它关联的 record id；`VctNode` 额外包含 `vctId`、`vctParentId`、`isCollapsed`、`isReparented`、`floating` 和可选 `alignToId`。`VctSnapshot` 是对下游和后续工具函数的顶层数据包。

## 当前边界

- `DomNodeRecord.isInteractive` 仍在准备阶段保留，但 collapse 和序列化阶段不再基于它生成特殊节点类型。
- `DomNodeRecord.id` 是当前页面/CDP 会话中的 DOM/backend id；`VctNode.vctId` 是最终缩进文本中的短引用 id。
- `CollapsedNode.ctParentId` 表示折叠树父节点的代表 DOM id；`VctNode.vctParentId` 表示视觉树父节点。
- `VctNode.isCollapsed` 由 `collapsedDomNodeIds.length > 0` 派生；序列化中的 `collapsed` 表示该节点可通过 `collapsedDomNodeIds` 展开查看被折叠的 wrapper records。
- `maybe-scroll` 表示 CSS 暗示该节点可能是滚动或裁剪区域；其 collapsed tree 后代禁止被重挂载到该节点外部，但仍可在该节点内部按空间关系重挂载。实际内容是否超出自身可视区域不主动输出，后续可按节点请求计算。
- 折叠时代表节点保留自身语义字段；若被折叠 wrapper 有非 `static` 的 `position` 或非空 `zIndex`，当前实现会继承到代表节点，wrapper 原始属性仍可通过 `collapsedDomNodeIds` 查询。
- 序列化输出直接显示 `[vctId]` 和真实标签；只有没有 retained 子节点的节点带 `LEAF` 标记。
- 普通可见文本只读取 CDP `layout.text`，不使用 DOM `nodeValue` fallback。
- 当前只处理 `documents[0]`，暂不合并 iframe 文档。
- 视觉近似包含使用 double-ratio：完全包含直接通过；非完全包含时要求 child containment ratio 至少约 80%，且 parent occupancy ratio 小于 50%。
- 当前目标是 VCT，不负责推断控件业务语义或操作意图。
- 页面快照当前只读取 `snapshot.documents[0]`，因此通常只能处理主页面，可能遗漏 iframe 内部页面。

## iframe 后续支持

后续支持 iframe 时，不能继续只读取 `snapshot.documents[0]`，需要遍历全部 `SnapshotDocument`，并将各文档恢复为一棵跨文档的页面结构。

文档间关联至少需要结合以下信息：

- `contentDocumentIndex`：定位 iframe 元素所承载的子文档。
- `frameId`：识别文档所属 frame，并辅助建立稳定的父子关系。
- iframe 元素的位置关系：将子文档内节点的坐标映射到主页面坐标系，正确连接各文档的视觉树。

实现时还需注意嵌套 iframe，确保坐标偏移和文档父子关系能够逐层累积。

## R-Tree 的包含规则

R-Tree 慢路径应使用**近似包含**，而不是只接受绝对包含。它负责处理 DOM 关系无法反映视觉结构的情况；负边距、定位偏移、尺寸取整等因素可能让子节点轻微越出容器，绝对包含会漏掉这些合理关系。

为降低误判，近似包含需要同时满足：

- 子节点面积不能大于候选容器。
- 完全包含时直接接受。
- 非完全包含时，子节点至少约 80% 的面积位于候选容器内。
- 非完全包含时，子节点占用候选容器的比例必须小于 50%，避免把几乎同尺寸的 wrapper-like 关系误判为合理视觉包含。
- 候选容器的绘制顺序早于或等于子节点；同一绘制批次允许 paintOrder 相等。
- 在所有有效候选中选择面积最小、包裹最紧的容器。
- `fixed`、`sticky` 节点不能被普通流式容器吸收。

绝对包含可以作为候选排序时的高置信信号，但不适合作为慢路径的硬性门槛。

通过非完全包含挂载的节点会标记 `floating`。当最终 VCT 父节点和 `ctParentId` 指向的折叠树父节点不一致时，节点会标记 `reparented`；序列化时可附带 `parent_id=<vctId>` 指向折叠树父节点对应的 VCT 节点。只有显式提供 alignment resolver 时，`align_to_id` 才会对 reparented 节点计算并输出。
