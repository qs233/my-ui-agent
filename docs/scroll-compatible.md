# ScrollCompatible 约束

本文用于记录 VCT 构建中对滚动行为一致性的约束，避免以后把它误解成简单的 `parent.motionGroup == child.motionGroup`。

## 核心判断

VCT 的父子边必须满足：

> 子节点在滚动行为下，不能逃出候选父节点所代表的视觉归属区域。

因此，父子关系不是只看当前快照中的几何包含，也不能只看 DOM 包含。对于滚动区域，用户会天然根据“谁跟谁一起滚、谁被哪个滚动区域约束”判断归属。

## 两种 scroll scope 身份

一个滚动容器 `S` 同时有两种身份：

```text
1. S 自己的 box
   它是外层 scroll scope 里的一个普通节点。

2. S 内部的 scroll content
   它创建了一个新的 scroll scope。
```

所以单个 `nearestScrollBoundary` 容易产生歧义：对 `S` 自己来说，它属于外层 scope；但对 `S` 的内容来说，`S` 又是内容所属 scope 的 owner。

建议使用两个字段表达：

```ts
boxScrollScopeId: string;
ownedScrollScopeId?: string;
```

含义：

```text
boxScrollScopeId
= 当前节点自己的视觉 box 跟随哪个滚动内容坐标系移动。

ownedScrollScopeId
= 如果当前节点是 scroll container，它内部内容所属的新 scroll scope。
```

例子：

```text
viewport
  S(scroll container)
    A(normal item)
```

对应：

```ts
S.boxScrollScopeId = "viewport";
S.ownedScrollScopeId = "scroll:S";

A.boxScrollScopeId = "scroll:S";
A.ownedScrollScopeId = undefined;
```

## ScrollCompatible 条件

父节点 `P` 可以作为子节点 `C` 的 VCT parent，当且仅当滚动 scope 兼容：

```ts
function isScrollCompatible(parent: VNode, child: VNode): boolean {
  return parent.boxScrollScopeId === child.boxScrollScopeId
      || parent.ownedScrollScopeId === child.boxScrollScopeId;
}
```

两条分支分别表示：

```text
parent.boxScrollScopeId === child.boxScrollScopeId
=> parent 和 child 是同一个 scroll content 里的同步滚动节点。

parent.ownedScrollScopeId === child.boxScrollScopeId
=> parent 是 child 所属 scroll content 的滚动容器本身。
```

这允许 `S` 内的节点既可以挂到 `S` 内同步滚动的普通节点下面，也可以直接挂到 `S` 本身下面。两类父子关系的相对运动不同，但都符合视觉归属。

## resolveScrollScope

`boxScrollScopeId` 的来源可以用下面的静态近似规则计算：

```ts
function resolveScrollScope(node: VNode): ScrollScopeId {
  if (node.position === "fixed") {
    const containingBlock = findFixedContainingBlock(node);
    if (containingBlock) return resolveScrollScope(containingBlock);
    return VIEWPORT_SCOPE;
  }

  if (node.position === "sticky") {
    return nearestScrollContainerScope(node) ?? VIEWPORT_SCOPE;
  }

  if (node.position === "absolute") {
    const containingBlock = findAbsoluteContainingBlock(node);
    if (containingBlock) return resolveScrollScope(containingBlock);
    return nearestScrollContainerScope(node) ?? VIEWPORT_SCOPE;
  }

  return nearestScrollContainerScope(node) ?? VIEWPORT_SCOPE;
}
```

其中：

- `fixed` 如果没有 fixed containing block，属于 viewport scope。
- `fixed` 如果存在 fixed containing block，则跟随 containing block 的 scope。
- `absolute` 不直接按 DOM parent 判断，而是跟随 absolute containing block 的 scope。
- `sticky` 属于最近 scroll container 或 viewport；它在 scope 内的运动轨迹特殊，但仍受该 scroll container 约束。
- `static` / `relative` 默认属于最近 scroll container 或 viewport。

## 嵌套 scroll

嵌套滚动不需要让外层 scope 直接兼容内层内容。

```text
outer-scroll
  section
    inner-scroll
      item
```

合理关系：

```text
outer-scroll -> section -> inner-scroll -> item
```

或：

```text
outer-scroll -> inner-scroll -> item
```

不合理关系：

```text
outer-scroll -> item
section -> item
```

因为 `item` 属于 `inner-scroll` 创建的内部 scroll content，不能跳过 `inner-scroll` 边界直接挂到外层 scope 的普通节点下面。

## 与几何条件的关系

`ScrollCompatible` 是 VCT parent 的硬过滤条件，不代替几何包含。

推荐顺序：

```text
1. 计算 boxScrollScopeId / ownedScrollScopeId
2. 过滤不满足 isScrollCompatible(parent, child) 的候选
3. 在兼容候选中应用 soft geometry containment
4. 选择最紧的视觉 parent
5. 找不到候选时，回退到 child 所属 scroll scope 的 owner 或 viewport
```

`Visual Dominance` 和打分可以后置；第一版只需要保证滚动边界不被错误跨越。
