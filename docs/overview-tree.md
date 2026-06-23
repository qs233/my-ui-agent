# 概览树

## 目标

概览树用于把网页复杂的 DOM 结构压缩成一棵更接近用户视觉认知的树，供 UI Agent 快速理解页面区域、可交互元素及其包含关系。

它不是 DOM 树的复刻，而是一个简洁、稳定、适合后续理解与操作的页面概览。

## 原始需求

- 只保留可见且具有有效尺寸的页面节点。
- 将节点分为两类：可交互元素 `ENTITY` 和普通视觉区域 `ZONE`。
- 以视觉包含关系为主构建层级，同时利用 DOM 父子关系提高准确性和效率。
- 合并视觉上几乎重合的 DOM 包装层，减少无意义层级；合并后保留原始 DOM 节点 ID。
- 正确处理弹窗、吸顶栏等 `fixed`、`sticky` 或高 `z-index` 元素，避免它们被普通页面容器错误包含。
- 输出应紧凑、可读，并保留理解页面所需的标签、类名、名称、文本和可滚动标记。

## 当前设计逻辑

整体流程严格分为四步：

1. **采集页面快照**：`captureSnapshot(page)` 只通过 CDP 获取主文档的 DOM、layout、paintOrder 和必要计算样式，输出 `SnapshotResponse`。
2. **准备原始节点**：主路径使用 `rawNodesFromSnapshot()` 直接从 `SnapshotResponse` 收集元素和文本候选，完成可见性与尺寸过滤、文本归属和最近有效 parent 重写，输出不再带可见性标志的 `RawNode[]`。`decodeSnapshot()` 和 `prepareNodes()` 仍保留为兼容、调试和单元测试用的分层 API。
3. **压缩 DOM 层级**：`compressDomTree()` 恢复 retained DOM，归类 `ENTITY | LEAF | ZONE`，后序折叠单子包装层，输出 parent 已指向存活代表的扁平 `CompressedNode[]`。
4. **构建视觉树**：`buildSpatialTree()` 只消费 `CompressedNode[]`，按面积从大到小处理，并分为两条路径：
   - **DOM 快路径**：沿 DOM 祖先向上查找已经进入视觉树的有效节点。只有同时满足空间包含和绘制顺序时才挂载；遇到空间断层或普通容器下的悬浮元素时立即停止。
   - **R-Tree 慢路径**：快路径失败后，通过空间索引寻找候选容器，过滤掉不满足近似包含、绘制顺序或悬浮层级规则的节点，再选择面积最小的容器作为视觉父节点。找不到时保留为独立根节点。

最终结果既可以输出为结构化树，也可以按页面空间顺序序列化为缩进文本。

完整调用链：

```text
captureSnapshot(page) → SnapshotResponse
rawNodesFromSnapshot(snapshot) → RawNode[]
compressDomTree(raw) → CompressedNode[]
buildSpatialTree(compressed) → TreeNode[]
```

## 当前边界

- 交互性目前主要识别原生表单控件、按钮及带 `href` 的链接；其他 retained DOM 叶子暂时归为 `LEAF`。
- 普通可见文本只读取 CDP `layout.text`，不使用 DOM `nodeValue` fallback。
- 当前只处理 `documents[0]`，暂不合并 iframe 文档。
- 视觉包含采用约 80% 的面积重叠阈值，属于启发式判断。
- 当前目标是页面概览，不负责推断控件业务语义或操作意图。
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
- 子节点至少约 80% 的面积位于候选容器内。
- 候选容器的绘制顺序早于或等于子节点；同一绘制批次允许 paintOrder 相等。
- 在所有有效候选中选择面积最小、包裹最紧的容器。
- `fixed`、`sticky` 或高 `z-index` 节点不能被普通流式容器吸收。

绝对包含可以作为候选排序时的高置信信号，但不适合作为慢路径的硬性门槛。
