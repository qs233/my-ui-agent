# Prepare 阶段

本文记录 `visibleNodesFromSnapshot()` 当前的准备阶段逻辑。Prepare 阶段只负责把 CDP `SnapshotResponse` 转成 retained `DomNodeRecord[]`。

## 输入与候选

当前只读取 `snapshot.documents[0]`。候选来自 `document.layout`：

- 元素候选：真实 element layout node，跳过 pseudo element，必须有 `backendNodeId`、标签名和有效 bounds。
- 文本候选：text layout node，或带文本的 pseudo element layout node。

元素候选会保存：

```ts
nodeIndex
backendNodeId
tagName
attributes
styles
bounds
paintOrder
```

样式来自 `COMPUTED_STYLES`，其中 overflow 使用 CSS 属性名：

```text
overflow
overflow-x
overflow-y
```

prepare 内部会归一化成：

```ts
overflowX = overflow-x || overflow || "visible"
overflowY = overflow-y || overflow || "visible"
```

## Overflow Scope 元数据

每个元素候选先转换成内部 `LayoutElementMeta`。这个结构只在 prepare 阶段使用，不对外暴露。

核心字段：

```ts
createsOverflowScope: boolean;
ownedOverflowScopeId?: string;
boxOverflowScopeId: string;
normallyRetained: boolean;
retained: boolean;
isInvisibleOverflowBoundary: boolean;
```

`createsOverflowScope` 表示节点自身是否创建 overflow boundary：

```text
overflow-x/y in hidden | clip | auto | scroll
```

如果创建，则：

```ts
ownedOverflowScopeId = `overflow:${backendNodeId}`
```

`boxOverflowScopeId` 表示节点自己的 box 属于哪个 overflow scope。默认是 `viewport`，再根据 DOM ancestor 和 containing block 规则修正。

### CB-aware scope

普通节点：

```text
static / relative / sticky
=> 使用最近 DOM ancestor overflow scope，否则 viewport
```

`absolute` 节点：

```text
1. 找最近 position !== static 的 ancestor 作为 absolute containing block。
2. 如果找到 CB，只允许 CB 自身或 CB 的 ancestor overflow scope 对该节点生效。
3. 找不到 CB 时，回到普通 ancestor overflow scope。
```

`fixed` 节点：

```text
1. 默认属于 viewport。
2. 如果遇到 fixed containing block，则按该 CB 所属的 effective overflow scope 计算。
```

第一版 fixed containing block 只识别常见样式：

```text
transform != none
filter != none
perspective != none
contain contains layout | paint | strict | content
will-change contains transform | filter | perspective
```

## Retain 规则

Prepare 分两类 retained 节点。

### Normally retained

正常可见节点必须满足：

- `width > 0 && height > 0`
- `display !== "none"`
- `visibility` 不是 `hidden` / `collapse`
- 自身和 ancestor 没有 `opacity: 0`
- 自身和 ancestor 没有 `content-visibility: hidden`
- 与 viewport filter 和 overflow clipping 后的 visible clip 有交集

`isVisible = true`，`isInvisibleOverflowBoundary = false`。

### Invisible overflow boundary

这是一类严格放水保留的真实 DOM 节点，用来表达不可见但真实存在的 overflow owner。

条件：

```text
createsOverflowScope
width > 0 && height > 0
display !== none
visibility === hidden
opacity !== 0
content-visibility !== hidden
owned overflow scope 下存在 normally retained descendant
```

命中后：

```ts
retained = true
isVisible = false
isInvisibleOverflowBoundary = true
text = ""
```

明确不放水：

- `display:none`
- `opacity:0` 影响下的子树
- `content-visibility:hidden`
- 0 尺寸 overflow owner

## 文本归属

文本候选必须：

- 归一化后非空
- bounds 有正尺寸
- 与 visible clip 有交集
- 没有被 text owner 的 visibility / opacity / content-visibility 阻断

文本归属到最近 retained ancestor。`isInvisibleOverflowBoundary` 节点自身不输出文本；其可见 descendant 正常承接文本。

## 输出 DomNodeRecord

最终输出只包含 retained 元素。`parentId` 会重写为最近 retained ancestor，`childIds` 根据重写后的 parent 重新填充。

新增 overflow/可见性字段会写入 `DomNodeRecord`：

```ts
overflowX: string;
overflowY: string;
boxOverflowScopeId: string;
ownedOverflowScopeId?: string;
isVisible: boolean;
isInvisibleOverflowBoundary: boolean;
```

`maybeScrollRegion` 仍保持旧语义：

```text
overflow-x/y in auto | scroll | hidden
```

`clip` 会创建 overflow scope，但不会标记 `maybe-scroll`。
