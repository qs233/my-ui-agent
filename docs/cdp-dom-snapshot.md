# CDP DOMSnapshot.captureSnapshot 数据结构

## 这是什么

`DOMSnapshot.captureSnapshot` 是 Chrome DevTools Protocol（CDP）提供的页面快照接口。它一次返回：

- 展平后的 DOM 树，包括 iframe、template 内容和导入文档。
- 具有 LayoutObject 的节点及其位置、文本和计算样式。
- 布局后的 inline text box 位置。
- 可选的绘制顺序、DOM 矩形和颜色信息。

它不是一份可直接遍历的嵌套 DOM JSON，而是为了减小传输体积设计的**列式数据**。字符串会被放进全局字符串表，少见属性会采用稀疏数组。因此，使用快照的第一步通常是解码。

协议参考：[Chrome DevTools Protocol - DOMSnapshot.captureSnapshot](https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/#method-captureSnapshot)。`DOMSnapshot` 域目前标记为 Experimental，字段应以项目使用的 Chromium/CDP 版本为准。

## 如何调用

```ts
const session = await page.context().newCDPSession(page);

const snapshot = await session.send("DOMSnapshot.captureSnapshot", {
  computedStyles: ["display", "visibility", "position", "z-index"],
  includePaintOrder: true,
  includeDOMRects: false,
  includeBlendedBackgroundColors: false,
  includeTextColorOpacities: false,
});
```

请求参数：

| 参数 | 类型 | 作用 |
| --- | --- | --- |
| `computedStyles` | `string[]` | 必填。指定需要返回的计算样式；顺序也决定 `layout.styles` 每一列的含义。传空数组表示不采集计算样式。 |
| `includePaintOrder` | `boolean?` | 是否返回 `layout.paintOrders`。 |
| `includeDOMRects` | `boolean?` | 是否返回 `offsetRects`、`scrollRects` 和 `clientRects`。 |
| `includeBlendedBackgroundColors` | `boolean?` | 是否返回元素与重叠背景混合后的背景色。 |
| `includeTextColorOpacities` | `boolean?` | 是否返回考虑重叠元素 opacity 后的最终文本透明度。 |

本项目的 [`captureSnapshot()`](../src/snapshot.ts) 请求 11 个计算样式并启用 `includePaintOrder`，没有启用其余可选项。

## 顶层结构

返回值可概括为：

```ts
interface CaptureSnapshotResult {
  documents: DocumentSnapshot[];
  strings: string[];
}
```

```text
CaptureSnapshotResult
├── strings[]                 所有文档共享的字符串表
└── documents[]
    └── DocumentSnapshot
        ├── nodes             DOM 节点表
        ├── layout            LayoutObject 表
        └── textBoxes         布局后的行内文本框表
```

`documents` 不应假定只有一项。主文档、iframe、template 等内容可能形成多份文档快照。文档之间通过 `nodes.contentDocumentIndex` 关联。

## 先理解三种索引

解析快照时最容易混淆的是三种不同的索引：

1. **字符串索引**：数字指向顶层 `strings`，例如 `strings[12] === "DIV"`。
2. **DOM 节点索引**：数字指向某一份文档的 `document.nodes` 行，例如 `parentIndex[7] === 3` 表示第 7 个 DOM 节点的父节点是第 3 个 DOM 节点。
3. **Layout 节点索引**：数字指向 `document.layout` 行。`layout.nodeIndex[i]` 再将该行关联到 DOM 节点索引。

此外，`contentDocumentIndex` 的值是第四种索引：它指向顶层 `documents` 数组，而不是当前文档的节点表。

## 为什么它看起来不像 DOM

常规数据可能写成：

```ts
[
  { nodeType: 9, nodeName: "#document", parentIndex: -1 },
  { nodeType: 1, nodeName: "HTML", parentIndex: 0 },
  { nodeType: 1, nodeName: "BODY", parentIndex: 1 },
]
```

快照会拆成并行数组，并把字符串替换成索引：

```ts
const strings = ["#document", "HTML", "BODY"];

const nodes = {
  nodeType:   [9, 1, 1],
  nodeName:   [0, 1, 2], // 指向 strings
  parentIndex: [-1, 0, 1],
};
```

`nodes` 的第 `i` 行由各字段的第 `i` 项共同组成。不要单独遍历 `nodeName` 后把数组下标当成 backend node id；数组下标只是本次快照、当前文档内的行号。

## 共享字符串表 strings

所有 `DocumentSnapshot` 共用顶层 `strings`。协议中标注为 `StringIndex` 的字段都不是字符串本身，而是这里的数组下标。

```ts
function readString(strings: string[], index: number | undefined): string {
  if (index === undefined || index < 0) return "";
  return strings[index] ?? "";
}
```

下面这些字段都需要查表：

- 文档的 URL、标题、语言、编码和 frame id。
- 节点名、节点值、属性名、属性值、表单值和伪元素类型。
- layout 文本、计算样式和颜色。

## DocumentSnapshot

每个 `documents[i]` 的完整结构如下：

```ts
interface DocumentSnapshot {
  documentURL: StringIndex;
  title: StringIndex;
  baseURL: StringIndex;
  contentLanguage: StringIndex;
  encodingName: StringIndex;
  publicId: StringIndex;
  systemId: StringIndex;
  frameId: StringIndex;

  nodes: NodeTreeSnapshot;
  layout: LayoutTreeSnapshot;
  textBoxes: TextBoxSnapshot;

  scrollOffsetX?: number;
  scrollOffsetY?: number;
  contentWidth?: number;
  contentHeight?: number;
}
```

| 字段 | 含义 |
| --- | --- |
| `documentURL` | Document 或 FrameOwner 指向的文档 URL，值为字符串索引。 |
| `title` | 文档标题，值为字符串索引。 |
| `baseURL` | 用于补全相对 URL 的 base URL，值为字符串索引。 |
| `contentLanguage` | 文档内容语言，值为字符串索引。 |
| `encodingName` | 字符编码，值为字符串索引。 |
| `publicId` / `systemId` | DocumentType 的 public id 和 system id，值为字符串索引。 |
| `frameId` | 文档或 frame owner 所属 frame 的 id，值为字符串索引。 |
| `nodes` | 当前文档的展平 DOM 节点表。 |
| `layout` | 当前文档中拥有 LayoutObject 的节点表。它通常只是 DOM 节点的子集。 |
| `textBoxes` | 布局后产生的 inline text box 表。一个 layout 文本节点可能对应多行、多个 box。 |
| `scrollOffsetX/Y` | 文档横向、纵向滚动偏移。 |
| `contentWidth/Height` | 文档内容尺寸。 |

## NodeTreeSnapshot：DOM 节点表

```ts
type StringIndex = number;

interface RareStringData {
  index: number[];       // DOM 节点索引
  value: StringIndex[];  // 与 index 一一对应
}

interface RareBooleanData {
  index: number[];       // 出现在这里就表示该节点值为 true
}

interface RareIntegerData {
  index: number[];       // DOM 节点索引
  value: number[];       // 与 index 一一对应
}

interface NodeTreeSnapshot {
  parentIndex?: number[];
  nodeType?: number[];
  shadowRootType?: RareStringData;
  nodeName?: StringIndex[];
  nodeValue?: StringIndex[];
  backendNodeId?: number[];
  attributes?: StringIndex[][];

  textValue?: RareStringData;
  inputValue?: RareStringData;
  inputChecked?: RareBooleanData;
  optionSelected?: RareBooleanData;
  contentDocumentIndex?: RareIntegerData;
  pseudoType?: RareStringData;
  pseudoIdentifier?: RareStringData;
  isClickable?: RareBooleanData;
  currentSourceURL?: RareStringData;
  originURL?: RareStringData;
}
```

### 普通并行字段

| 字段 | 含义 |
| --- | --- |
| `parentIndex[i]` | 节点 `i` 的父 DOM 节点索引。根节点通常为 `-1`。 |
| `nodeType[i]` | 标准 DOM `Node.nodeType`，常见值为 `1`（Element）、`3`（Text）、`8`（Comment）、`9`（Document）、`10`（DocumentType）。 |
| `nodeName[i]` | 节点名的字符串索引，例如 `DIV`、`#text`。 |
| `nodeValue[i]` | 节点值的字符串索引；元素通常为空，Text 节点通常包含原始文本。 |
| `backendNodeId[i]` | Chromium backend node id，可供其他 CDP DOM API 定位节点。它不是 `nodes` 数组索引。 |
| `attributes[i]` | Element 属性的扁平字符串索引数组，格式为 `[name1, value1, name2, value2, ...]`。非 Element 通常是空数组。 |

属性解码示例：

```ts
function decodeAttributes(strings: string[], encoded: number[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let i = 0; i < encoded.length; i += 2) {
    result.set(strings[encoded[i]] ?? "", strings[encoded[i + 1]] ?? "");
  }
  return result;
}
```

### 稀疏字段

以下信息只存在于少数节点，所以不使用与节点总数等长的数组：

| 字段 | 出现条件或含义 |
| --- | --- |
| `shadowRootType` | 节点所在 shadow root 的类型。返回的 DOM 树已经将 Shadow DOM 展平。 |
| `textValue` | `textarea` 的文本值。 |
| `inputValue` | `input` 的关联文本值。注意页面快照可能包含敏感表单数据。 |
| `inputChecked` | radio 或 checkbox 是否 checked。其 `index` 中出现某节点即表示 `true`。 |
| `optionSelected` | option 是否 selected。其 `index` 中出现某节点即表示 `true`。 |
| `contentDocumentIndex` | frame owner 等节点关联的子文档在顶层 `documents` 中的索引。 |
| `pseudoType` | 伪元素类型，例如 `before`、`after`。 |
| `pseudoIdentifier` | 具有 `pseudoType` 时的伪元素标识。 |
| `isClickable` | Chromium 判断节点可响应鼠标点击；既可能来自事件监听器，也可能来自链接的原生行为。 |
| `currentSourceURL` | 带 `srcset` 节点实际选中的 URL。 |
| `originURL` | 生成该节点的脚本 URL（如果有）。 |

三类稀疏数据的解码方式：

```ts
function decodeRareStrings(data: RareStringData, strings: string[]) {
  return new Map(data.index.map((nodeIndex, i) => [nodeIndex, strings[data.value[i]] ?? ""]));
}

function decodeRareBooleans(data: RareBooleanData) {
  return new Set(data.index); // has(nodeIndex) 即为 true
}

function decodeRareIntegers(data: RareIntegerData) {
  return new Map(data.index.map((nodeIndex, i) => [nodeIndex, data.value[i]]));
}
```

## LayoutTreeSnapshot：布局节点表

只有拥有 LayoutObject 的 DOM 节点才会进入 `layout`，所以不能假定 `layout` 与 `nodes` 等长，也不能用 layout 行号直接访问 nodes。

```ts
type Rectangle = number[]; // 实际格式为 [x, y, width, height]

interface LayoutTreeSnapshot {
  nodeIndex: number[];
  styles: StringIndex[][];
  bounds: Rectangle[];
  text: StringIndex[];
  stackingContexts: RareBooleanData;

  paintOrders?: number[];
  offsetRects?: Rectangle[];
  scrollRects?: Rectangle[];
  clientRects?: Rectangle[];
  blendedBackgroundColors?: StringIndex[];
  textColorOpacities?: number[];
}
```

对 layout 行 `i`：

| 字段 | 含义 |
| --- | --- |
| `nodeIndex[i]` | 对应的 DOM 节点在 `document.nodes` 中的索引。 |
| `styles[i]` | 计算样式值的字符串索引数组，与请求中的 `computedStyles` 按位置对应。 |
| `bounds[i]` | 绝对位置矩形 `[x, y, width, height]`，单位为 CSS px。 |
| `text[i]` | LayoutText 内容的字符串索引；没有文本时通常指向空字符串。它反映布局使用的文本，不应简单等同于 DOM `nodeValue`。 |
| `stackingContexts.index` | 哪些 layout 行创建了 stacking context。 |
| `paintOrders[i]` | 全局绘制顺序；只在请求 `includePaintOrder` 时返回。一起绘制的节点可能具有相同值。 |
| `offsetRects[i]` | offset rect；只在请求 `includeDOMRects` 时返回。 |
| `scrollRects[i]` | scroll rect；只在请求 `includeDOMRects` 时返回。 |
| `clientRects[i]` | client rect；只在请求 `includeDOMRects` 时返回。 |
| `blendedBackgroundColors[i]` | 混合后背景色的字符串索引；只在请求对应参数时返回。 |
| `textColorOpacities[i]` | 最终文本透明度；只在请求对应参数时返回。 |

计算样式解码时必须保留请求顺序：

```ts
const requestedStyles = ["display", "visibility", "position", "z-index"];

function decodeStyles(strings: string[], encoded: number[]): Map<string, string> {
  return new Map(
    requestedStyles.map((property, i) => [property, strings[encoded[i]] ?? ""]),
  );
}
```

## TextBoxSnapshot：行内文本框表

DOM Text 节点或 LayoutText 节点不一定对应一个连续矩形。文本可能换行，也可能被拆成多个布局后的片段。`textBoxes` 用来描述这些片段：

```ts
interface TextBoxSnapshot {
  layoutIndex: number[];
  bounds: Rectangle[];
  start: number[];
  length: number[];
}
```

对 text box 行 `i`：

| 字段 | 含义 |
| --- | --- |
| `layoutIndex[i]` | 拥有该 box 的节点在 `document.layout` 中的索引，不是 DOM 节点索引。 |
| `bounds[i]` | 该文本片段的绝对位置 `[x, y, width, height]`。 |
| `start[i]` | 片段在所属 layout 文本中的 UTF-16 起始下标。 |
| `length[i]` | 片段的 UTF-16 长度；代理对字符长度为 2。 |

例如一段文字换成两行时，通常会有两条 `textBoxes` 记录，并通过相同的 `layoutIndex` 指向同一个 layout 行。

## 从 layout 行恢复一个可用节点

下面的例子串起最常用的关联关系：

```ts
function decodeLayoutRow(
  snapshot: CaptureSnapshotResult,
  documentIndex: number,
  layoutIndex: number,
  requestedStyles: string[],
) {
  const document = snapshot.documents[documentIndex];
  const domIndex = document.layout.nodeIndex[layoutIndex];
  const encodedBounds = document.layout.bounds[layoutIndex];
  const [x, y, width, height] = encodedBounds;

  return {
    documentIndex,
    layoutIndex,
    domIndex,
    backendNodeId: document.nodes.backendNodeId?.[domIndex],
    nodeType: document.nodes.nodeType?.[domIndex],
    nodeName: readString(snapshot.strings, document.nodes.nodeName?.[domIndex]),
    nodeValue: readString(snapshot.strings, document.nodes.nodeValue?.[domIndex]),
    attributes: decodeAttributes(
      snapshot.strings,
      document.nodes.attributes?.[domIndex] ?? [],
    ),
    text: readString(snapshot.strings, document.layout.text[layoutIndex]),
    bounds: { x, y, width, height },
    styles: new Map(
      requestedStyles.map((name, i) => [
        name,
        readString(snapshot.strings, document.layout.styles[layoutIndex]?.[i]),
      ]),
    ),
    paintOrder: document.layout.paintOrders?.[layoutIndex],
  };
}
```

## iframe 和跨文档关系

处理 iframe 时需要同时保留文档索引和节点索引：

1. 在父文档 `documents[parentDocumentIndex].nodes.contentDocumentIndex` 中找到 frame owner DOM 行。
2. 读取同一稀疏项的 `value`，得到 `childDocumentIndex`。
3. 进入 `documents[childDocumentIndex]`，从它自己的 nodes/layout 表继续解析。
4. 结合父 iframe 元素位置、子文档滚动偏移等信息，将坐标统一到所需坐标系。

`frameId` 可辅助识别文档所属 frame，但不能代替 `contentDocumentIndex` 的直接关联。任何 DOM 节点索引都只在其所属 `DocumentSnapshot` 内有效，因此缓存键至少应使用 `{ documentIndex, nodeIndex }`。

## 常见误区

- **把所有数字都当成真实值**：大量数字其实是 `strings`、`nodes`、`layout` 或 `documents` 的索引。
- **把 layout 行号当 DOM 行号**：必须先读取 `layout.nodeIndex[layoutIndex]`。
- **假定只有主文档**：只读 `documents[0]` 会遗漏 iframe 等子文档内容。
- **把缺失的稀疏布尔值当未知**：`RareBooleanData.index` 中不存在通常表示 `false`。
- **用对象字段名猜 computed style**：`styles[i]` 只保存值，属性名来自请求时的 `computedStyles`，两者靠位置对应。
- **把 `nodeValue` 当页面最终显示文本**：最终布局文本应优先看 `layout.text`，精确到换行片段时再看 `textBoxes`。
- **把 `backendNodeId` 当长期稳定 id**：它适合在当前页面/CDP 会话中关联节点，不应作为跨导航、跨快照的业务主键。
- **忽略可选字段**：未启用对应请求参数时，`paintOrders`、DOM rect 和颜色字段可能不存在。
- **假定协议长期不变**：该域为 Experimental，应锁定并测试项目实际使用的 Chromium 版本。

## 与本项目类型的关系

当前 [`src/types.ts`](../src/types.ts) 中的 `SnapshotResponse` 是项目按现有处理流程定义的**最小字段子集**，主要包含：

- 顶层 `documents`、`strings`。
- `nodes` 中用于恢复元素、属性、父子关系和伪元素的字段。
- `layout` 中的位置、文本、样式和绘制顺序。

它没有声明 CDP 完整返回值中的文档元数据、`textBoxes`、表单状态、iframe 文档索引及可选 DOM rect 等字段。若后续要支持 iframe、精确文本框或更多语义信息，应先扩充项目类型，再实现相应解码，不能仅遍历现有接口中已声明的字段。
