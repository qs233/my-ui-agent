# Collapse 阶段

本文记录 `collapseDomTree()` 当前的折叠阶段逻辑。Collapse 阶段消费 prepare 输出的 retained `DomNodeRecord[]`，输出 `CollapsedTreeNode[]`。

## 输入与 DOM 恢复

输入是 prepare 阶段保留下来的 `DomNodeRecord[]`，不是完整 DOM。

处理步骤：

```text
1. 按 id 建立 DomTreeNode map。
2. 根据 parentId/childIds 恢复 retained DOM forest。
3. 找到没有 retained parent 的 root。
4. 对每个 root 后序 collapse。
5. 最后重新规范化 collapsed tree 的 ctParentId。
```

`ctParentId` 表示 collapsed tree parent 的代表 DOM id，不是 VCT parent。

## 节点分类

每个 retained record 会转换成 `CollapsedTreeNode`。字段会从 `DomNodeRecord` 传播，包括：

```ts
position
zIndex
maybeScrollRegion
overflowX
overflowY
boxOverflowScopeId
ownedOverflowScopeId
isVisible
isInvisibleOverflowBoundary
```

如果节点没有 retained child，则标记为：

```ts
type: "LEAF"
```

## 单子 wrapper 折叠

Collapse 只折叠“单子 wrapper”：

```text
parent
  child
```

当且仅当 parent 只有一个 child，且满足安全条件时，collapse 会尝试两种方向：

```text
1. parent -> child
   普通 wrapper 折叠，child 作为代表节点。

2. parent <- child
   maybeScrollRegion parent 吸收普通 child wrapper，parent 作为代表节点。
```

后序遍历只决定处理顺序，不决定代表节点。代表节点由具体折叠方向决定。

## parent 折叠进 child

这是普通 wrapper 链路的原有行为。parent 会折叠进 child，输出以 child 作为代表节点。

禁止折叠的条件：

- parent 或 child 是 preserve tag。
- parent 或 child 是 `fixed` / `sticky`。
- parent 或 child 是 `maybeScrollRegion`。
- parent 或 child 是 `isInvisibleOverflowBoundary`。
- parent.paintOrder > child.paintOrder。
- child 没有被 parent 的 visual bounds 完全包含。

preserve tags 包括媒体、表单、交互和嵌入类标签，例如：

```text
svg img video canvas iframe button a input select textarea form dialog ...
```

当 parent 可以折叠进 child：

```ts
child.collapsedDomNodeIds = [
  ...parent.collapsedDomNodeIds,
  parent.representativeDomNodeId,
  ...child.collapsedDomNodeIds,
];

child.ctParentId = parent.ctParentId;
```

同时：

- child 的 visual bounds 改成 parent 的 visual bounds。
- 如果 parent 有非 `static` 的 `position`，child 继承该 position。
- 如果 parent 有 `zIndex`，child 继承该 zIndex。

这样输出仍以 child 作为代表节点，但保留被折叠 wrapper 的 DOM id。

## child 折叠进 maybeScrollRegion parent

当 scroll/overflow 容器内部只有一个普通 wrapper 时，可以去掉这个中间 wrapper，但必须保留 scroll 容器本身作为代表节点。否则会丢失 scroll boundary 的 tag、bounds、`ownedOverflowScopeId` 等结构语义。

允许 child 折叠进 parent 的条件：

- parent 是 `maybeScrollRegion`。
- child 不是叶子节点，必须还有自己的 children。
- child 不是 preserve tag。
- child 不是 `maybeScrollRegion`。
- child 不是 `isInvisibleOverflowBoundary`。
- child 不是 `fixed` / `sticky`。
- parent.paintOrder <= child.paintOrder。
- child 被 parent 的 visual bounds 完全包含。

折叠行为：

```ts
parent.collapsedDomNodeIds = [
  ...parent.collapsedDomNodeIds,
  child.representativeDomNodeId,
  ...child.collapsedDomNodeIds,
];

parent.children = child.children;
```

parent 的代表身份和布局/overflow 元数据保持不变，包括：

```ts
representativeDomNodeId
tagName
ownBounds
visualBounds
position
zIndex
maybeScrollRegion
overflowX
overflowY
boxOverflowScopeId
ownedOverflowScopeId
isVisible
```

child 的 children 会提升为 parent 的 children，最后由 `normalizeCollapsedParents()` 统一修正 `ctParentId`。

不吸收叶子节点的原因是叶子通常承载文本或内容语义；把它并入 scroll 容器会改变代表节点含义。

## 不可见 Overflow Boundary

`isInvisibleOverflowBoundary` 节点不会被折叠，也不会吞掉它的 child。

原因是它虽然不可见，但是真实 DOM 节点，并且拥有 `ownedOverflowScopeId`。它作为结构性 overflow owner，需要保留在 collapsed tree 中，让后续 VCT 阶段可以识别该 scope 边界。

序列化阶段会输出短 tag：

```text
invisible-overflow-boundary
```

## 输出

Collapse 输出 `CollapsedTreeNode[]`。

每个节点包含：

- 代表 DOM id：`representativeDomNodeId`
- 被折叠 wrapper id：`collapsedDomNodeIds`
- 当前 collapsed tree parent：`ctParentId`
- 视觉 bounds：`visualBounds`
- 自身 bounds：`ownBounds`
- prepare 阶段传入的 overflow/visibility 元数据

后续 `buildVisualContainmentTree()` 会消费 collapsed tree，但当前 VCT parent resolution 尚未使用 `boxOverflowScopeId / ownedOverflowScopeId`。
