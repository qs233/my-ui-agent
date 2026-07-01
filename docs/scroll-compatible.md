# OverflowCompatible 约束

本文用于记录 VCT 构建中对 overflow 边界一致性的约束。它替代早期的 `ScrollCompatible` 设计：滚动一致性和剪裁边界本质上都来自 `overflow` 容器，只是下游语义不同。

## 核心判断

VCT 的母子边必须满足：

> 子节点不能在对它生效的 overflow 边界之外，挂到一个不属于同一边界的候选母节点下面。

这里的 overflow 边界同时覆盖两类约束：

```text
1. 剪裁边界
   overflow: hidden / clip / auto / scroll 会限制普通子树的可见区域。

2. 滚动边界
   overflow: auto / scroll 的内部内容属于独立的滚动行为区域。
```

因此，母子关系不能只看当前快照中的几何包含，也不能只看 DOM 包含。对于 overflow 容器，用户会天然根据“谁被哪个容器剪裁、谁跟谁一起滚动”判断视觉归属。

## Effective Overflow Scope

一个 overflow 容器 `S` 同时有两种身份：

```text
1. S 自己的 box
   它是外层 overflow scope 里的一个普通节点。

2. S 内部的 content
   它创建了一个新的 overflow scope。
```

所以单个 `nearestOverflowBoundary` 容易产生歧义：对 `S` 自己来说，它属于外层 scope；但对 `S` 的内容来说，`S` 又是内容所属 scope 的 owner。

建议使用两个字段表达：

```ts
boxOverflowScopeId: string;
ownedOverflowScopeId?: string;
```

含义：

```text
boxOverflowScopeId
= 当前节点自己的视觉 box 属于哪个生效的 overflow scope。

ownedOverflowScopeId
= 如果当前节点创建 overflow boundary，它内部内容所属的新 overflow scope。
```

例子：

```text
viewport
  S(overflow container)
    A(normal item)
```

对应：

```ts
S.boxOverflowScopeId = "viewport";
S.ownedOverflowScopeId = "overflow:S";

A.boxOverflowScopeId = "overflow:S";
A.ownedOverflowScopeId = undefined;
```

## OverflowCompatible 条件

母节点 `P` 可以作为子节点 `C` 的 VCT parent，当且仅当 overflow scope 兼容：

```ts
function isOverflowCompatible(parent: VNode, child: VNode): boolean {
  return parent.boxOverflowScopeId === child.boxOverflowScopeId
      || parent.ownedOverflowScopeId === child.boxOverflowScopeId;
}
```

两条分支分别表示：

```text
parent.boxOverflowScopeId === child.boxOverflowScopeId
=> parent 和 child 是同一个 overflow content 里的同步节点。

parent.ownedOverflowScopeId === child.boxOverflowScopeId
=> parent 是 child 所属 overflow content 的容器本身。
```

这允许 `S` 内的节点既可以挂到 `S` 内同步滚动/同步剪裁的普通节点下面，也可以在找不到更紧母节点时直接挂到 `S` 本身下面。两类母子关系的相对运动可能不同，但都符合视觉归属。

## overflow scope 的创建条件

用于 VCT parent rule 的 scope 创建条件建议第一版统一为：

```ts
function createsOverflowScope(node: VNode): boolean {
  return node.overflowX === "hidden"
      || node.overflowX === "clip"
      || node.overflowX === "auto"
      || node.overflowX === "scroll"
      || node.overflowY === "hidden"
      || node.overflowY === "clip"
      || node.overflowY === "auto"
      || node.overflowY === "scroll";
}
```

理由：

- `hidden` / `clip` 至少创建剪裁边界，普通子树不能跨出它们去挂到外部节点下面。
- `auto` / `scroll` 同时创建剪裁边界和用户可感知的滚动边界。
- VCT 关心的是视觉归属边界，不只关心当前是否真的存在滚动条。

如果下游需要区分是否可滚动，可以另设字段：

```ts
isUserScrollableOverflow = overflow in ["auto", "scroll"];
```

这个字段可以用于序列化或交互提示，但不参与 VCT parent 的硬过滤。

## overflow 对节点是否生效

`createsOverflowScope(S)` 只说明 `S` 能创建 overflow boundary，不说明它一定约束任意后代 `N`。`absolute` / `fixed` 子树可能因为 containing block 跳到 `S` 外面，使 `S` 的剪裁和滚动边界都不再对它生效。

因此需要一个内部判断：

```ts
function isOverflowEffectiveForNode(container: VNode, node: VNode): boolean {
  if (!isAncestor(container, node)) return false;

  if (node.position === "fixed") {
    const containingBlock = findFixedContainingBlock(node);
    if (!containingBlock) return false;
    return container === containingBlock || isAncestor(container, containingBlock);
  }

  if (node.position === "absolute") {
    const containingBlock = findAbsoluteContainingBlock(node);
    if (!containingBlock) return false;
    return container === containingBlock || isAncestor(container, containingBlock);
  }

  return true;
}
```

这个函数只用于计算 scope，不作为 VCT parent rule 直接调用。最终 parent rule 仍只看 `isOverflowCompatible(parent, child)`。

## resolveOverflowScope

`boxOverflowScopeId` 的来源可以用下面的静态近似规则计算：

```ts
function resolveOverflowScope(node: VNode): OverflowScopeId {
  const owner = nearestEffectiveOverflowContainer(node);
  return owner?.ownedOverflowScopeId ?? VIEWPORT_SCOPE;
}

function nearestEffectiveOverflowContainer(node: VNode): VNode | undefined {
  for (const ancestor of ancestorsFromNearest(node)) {
    if (!createsOverflowScope(ancestor)) continue;
    if (!isOverflowEffectiveForNode(ancestor, node)) continue;
    return ancestor;
  }
  return undefined;
}
```

实现时不需要把 containing block 信息挂到每个 VCT 节点上。可以在过滤前基于完整 DOM/layout 元素图计算，最终只给 retained 节点保留 overflow scope 元信息：

```ts
interface OverflowScopeMeta {
  boxOverflowScopeId: string;
  ownedOverflowScopeId?: string;
}
```

containing block 相关函数可以作为中间计算：

```ts
findAbsoluteContainingBlock(node)
findFixedContainingBlock(node)
```

它们需要基于完整元素图，而不是只基于过滤后的 VCT/Collapsed Tree。原因是某些 0 尺寸、透明、或被折叠的 wrapper 仍可能影响 `absolute` / `fixed` 的 containing block 和 overflow 生效关系。

## 典型场景

普通子树在 `hidden` 内：

```text
S(overflow:hidden)
  A(normal item)
```

```ts
S.boxOverflowScopeId = "viewport";
S.ownedOverflowScopeId = "overflow:S";
A.boxOverflowScopeId = "overflow:S";
```

`A` 不能挂到 `S` 外部的普通节点下面，因为外部节点通常属于 `viewport` scope，与 `A` 不兼容。

`absolute` / `fixed` 因 containing block 跳出 `S`：

```text
outer(position:relative)
  S(overflow:hidden)
    A(position:absolute; containing block = outer)
```

如果 `S` 对 `A` 不生效：

```ts
S.ownedOverflowScopeId = "overflow:S";
A.boxOverflowScopeId = "viewport"; // 或外层 effective scope
```

此时 `S` 和 `A` 不兼容，`A` 不应该被挂到 `S` 下。

节点属于 `S` 的 effective overflow scope，但视觉 bounds 溢出 `S`：

```text
S(overflow:auto)
  A(large content)
```

```ts
A.boxOverflowScopeId = "overflow:S";
```

如果没有其他兼容节点满足几何包含，`A` 可以回退挂到 `S` 下并标记 `floating`，因为：

```ts
S.ownedOverflowScopeId === A.boxOverflowScopeId
```

## 嵌套 overflow

嵌套 overflow 不需要让外层 scope 直接兼容内层内容。

```text
outer-overflow
  section
    inner-overflow
      item
```

合理关系：

```text
outer-overflow -> section -> inner-overflow -> item
```

或：

```text
outer-overflow -> inner-overflow -> item
```

不合理关系：

```text
outer-overflow -> item
section -> item
```

因为 `item` 属于 `inner-overflow` 创建的内部 overflow content，不能跳过 `inner-overflow` 边界直接挂到外层 scope 的普通节点下面。

## 与几何条件的关系

`OverflowCompatible` 是 VCT parent 的硬过滤条件，不代替几何包含。

推荐顺序：

```text
1. 基于完整元素图计算 retained 节点的 boxOverflowScopeId / ownedOverflowScopeId
2. 过滤不满足 isOverflowCompatible(parent, child) 的候选
3. 在兼容候选中应用 soft geometry containment
4. 选择最紧的视觉 parent
5. 找不到候选时，回退到 child 所属 overflow scope 的 owner 或 viewport
```

`Visual Dominance` 和打分可以后置；第一版只需要保证 overflow 边界不被错误跨越。
