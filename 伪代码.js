interface RawNode {
    id: string;
    x: number; y: number; width: number; height: number;
    area: number;
    paintOrder: number;
    domParentId: string | null;
    // 假设你有这些现成的基础判断方法
    isVisible: boolean;         // display: none、visibility: hidden、opacity: 0 以及 0宽高
    isInteractive: boolean;     // 输入dom节点判断其是否可交互
}

interface TreeNode extends RawNode {
    type: 'ENTITY' | 'ZONE';
    mergedDomIds: string[];    // 被合并进来的原始 DOM 节点 ID 列表
    children: TreeNode[];
}

// 漏洞 1 修复后的主建树流程
function buildSpatialTreeRobust(rawNodes: RawNode[]): TreeNode[] {
    // ==========================================
    // 阶段 1: 可见性初筛
    // ==========================================
    const visibleNodes = rawNodes.filter(n => n.isVisible && n.width > 0 && n.height > 0);
    
    // ==========================================
    // 阶段 2: DOM 孪生节点塌陷合并
    // ==========================================
    const map = buildDomTree(visibleNodes);

    const roots: TreeNode[] = [];

    // 找 root
    for (const node of map.values()) {
        if (!node.domParentId || !map.has(node.domParentId)) {
            roots.push(node);
        }
    }

    // 对每个 root 做后序 merge
    const result: TreeNode[] = [];

    for (const root of roots) {
        result.push(postOrderMerge(root));
    }

    result = mergedNodes;

    // ==========================================
    // 阶段 3: 混合式视觉包含树构建（基于方案一与近似包含）
    // ==========================================
    // 将合并后幸存的节点重新按面积【从大到小】排序
    const finalNodes = mergedNodes.sort((a, b) => b.area - a.area);
    const rootZones: TreeNode[] = [];
    const rtree = new RTree(); 
    const finalInsertedMap = new Map<string, TreeNode>();

    for (const node of finalNodes) {
        let foundVisualParent = false;

        // 【快路径：真正的自底向上溯源逻辑】
        let currentDomParentId = node.domParentId;

        while (currentDomParentId) {
            // 1. 找到该 ID 在阶段 2 坍陷合并后对应的存活代表
            const activeParent = findActiveRepresentative(currentDomParentId, nodeMap, isMerged);
            
            if (activeParent) {
                // 2. 情况 A：如果这个活祖先已经成功在空间树中安家了（被 finalInsertedMap 记录）
                if (finalInsertedMap.has(activeParent.id)) {
                    const potentialParent = finalInsertedMap.get(activeParent.id)!;                    
                    // =============================================================
                    // 【新增拦截器】：严防高层级/悬浮节点（弹窗/Fixed 栏）被快路径错误吞噬
                    // =============================================================
                    const isFixedOrSticky = node.position === 'fixed' || node.position === 'sticky';
                    const hasHighZIndex = node.zIndex !== undefined && node.zIndex > 0;
                    
                    // 如果满足悬浮特性，且当前遇到的父节点只是普通的块级流式容器（不是另一个悬浮Zone）
                    if ((isFixedOrSticky || hasHighZIndex) && potentialParent.position !== 'fixed') {
                        // 判定为“遮盖（Overlay）”关系，而不是“被包含”关系！
                        // 强制中断快路径，不认这个 DOM 树上的父节点，直接去慢路径（或去顶层建独立 Zone）
                        break; 
                    }

                    // 3. 校验空间包含与层级
                    if (isApproximatelyContained(node, potentialParent, 0.8) && 
                        potentialParent.paintOrder < node.paintOrder) {
                        
                        // 命中！挂载并彻底终结快慢路径
                        insertIntoTreeWithApprox(potentialParent, node);
                        finalInsertedMap.set(node.id, node);
                        foundVisualParent = true;
                        break; // 真正成功认亲，退出 while 循环
                    } else {
                        // 【断层阻断】：这个祖先已经入树，证明它有合法的视觉位置，但空间上竟然不包含我！
                        // 说明文档流在此处发生叛逆（如负margin、飘出边界的定位），继续往上找爷爷辈也毫无意义
                        // 必须立刻中断快路径，强制降级到 R-Tree 慢路径
                        break; 
                    }
                } 
                
                // 4. 情况 B：这个活祖先【还没有入树】
                // 为什么没入树？可能它面积和当前节点很接近，因为某种特定规则还没轮到它，或者它自己也是个离群节点。
                // 这时不能当成断层，而是应该允许它【继续向上循环】，寻找更高的、已经入树的宏观祖先。
                currentDomParentId = activeParent.domParentId; // 顺着它的父 ID 继续往上爬
                
            } else {
                // 5. 情况 C：如果连活着的祖先都找不到了（爬到了最顶层 body 以上），退出循环去慢路径
                break;
            }
        }

        // 【慢路径】：DOM 拓扑脱靶或中途遭遇断层降级
        if (!foundVisualParent) {
            const candidates = rtree.search({
                minX: node.x, minY: node.y, 
                maxX: node.x + node.width, maxY: node.y + node.height
            });

            // 过滤条件中使用的 isApproximatelyContained 已具备漏洞1防线
            const validContainers = candidates.filter(c => 
                isApproximatelyContained(node, c, 0.8) && c.paintOrder < node.paintOrder
            );

            if (validContainers.length > 0) {
                // 选择面积最小（最紧密包裹）的那个
                validContainers.sort((a, b) => a.area - b.area);
                const bestParent = validContainers[0];
                
                insertIntoTreeWithApprox(bestParent, node);
                finalInsertedMap.set(node.id, node);
            } else {
                rootZones.push(node);
                rtree.insert({
                    minX: node.x, minY: node.y, 
                    maxX: node.x + node.width, maxY: node.y + node.height,
                    ...node
                });
                finalInsertedMap.set(node.id, node);
            }
        }
    }
    return rootZones;
}

// ==========================================
// 辅助工具函数
// ==========================================

// 判断两个嵌套节点是否可以合并
function shouldMerge(child: TreeNode, parent: TreeNode): boolean {
    // 强制前提：嵌套节点的 paintOrder 必须满足：parent (容器/背景) 在 child (内容) 的下面
    if (parent.paintOrder > child.paintOrder) return false;

    // 计算边缘间距
    const deltaLeft = Math.abs(child.x - parent.x);
    const deltaTop = Math.abs(child.y - parent.y);
    const deltaRight = Math.abs((child.x + child.width) - (parent.x + parent.width));
    const deltaBottom = Math.abs((child.y + child.height) - (parent.y + parent.height));

    if (child.type === 'ENTITY' || parent.type === 'ENTITY') {
        // 规则 1：包含可交互元素（ENTITY），绝对像素阈值控制（例如间距小于 4 像素）
        const PIXEL_THRESHOLD = 4; 
        return deltaLeft <= PIXEL_THRESHOLD && 
               deltaTop <= PIXEL_THRESHOLD && 
               deltaRight <= PIXEL_THRESHOLD && 
               deltaBottom <= PIXEL_THRESHOLD;
    } else {
        // 规则 2：纯 ZONE 容器合并，按面积/尺寸百分比阈值控制（例如间距小于大容器宽高的 5%）
        const PERCENT_THRESHOLD = 0.05; 
        const threshX = parent.width * PERCENT_THRESHOLD;
        const threshY = parent.height * PERCENT_THRESHOLD;
        return deltaLeft <= threshX && 
               deltaTop <= threshY && 
               deltaRight <= threshX && 
               deltaBottom <= threshY;
    }
}

function isApproximatelyContained(nodeN: TreeNode, containerC: TreeNode, threshold = 0.8): boolean {
    // 【漏洞1核心防线】：如果子节点面积比母节点还大，绝对不可能是包含关系
    if (nodeN.area > containerC.area) return false;

    const interLeft = Math.max(nodeN.x, containerC.x);
    const interTop = Math.max(nodeN.y, containerC.y);
    const interRight = Math.min(nodeN.x + nodeN.width, containerC.x + containerC.width);
    const interBottom = Math.min(nodeN.y + nodeN.height, containerC.y + containerC.height);

    const interWidth = Math.max(0, interRight - interLeft);
    const interHeight = Math.max(0, interBottom - interTop);
    const overlapArea = interWidth * interHeight;

    if (overlapArea === 0) return false;

    // 计算相交面积占【子节点N】自身面积的比例
    const overlapRatio = overlapArea / nodeN.area;

    return overlapRatio >= threshold;
}

// 将子节点递归向下渗透插入到指定父节点子树中
function insertIntoTreeWithApprox(parent: TreeNode, node: TreeNode) {
    const nextParent = parent.children.find(child => isApproximatelyContained(node, child, 0.8));
    if (nextParent) {
        insertIntoTreeWithApprox(nextParent, node);
    } else {
        // 反向检查：新加入的 node 是否因 DOM 乱序原因，反而近似包含了 parent 现有的某些小孩子
        const subChildren = parent.children.filter(child => isApproximatelyContained(child, node, 0.8));
        if (subChildren.length > 0) {
            node.children.push(...subChildren);
            parent.children = parent.children.filter(child => !subChildren.includes(child));
        }
        parent.children.push(node);
    }
}

// 辅助函数：由于某些节点被合并消亡了，需要找到接管它的那个活着的祖先节点
function findActiveRepresentative(domId: string, nodeMap: Map<string, TreeNode>, isMerged: Set<string>): TreeNode | null {
    let curr = nodeMap.get(domId);
    while (curr && isMerged.has(curr.id)) {
        curr = curr.domParentId ? nodeMap.get(curr.domParentId) : undefined;
    }
    return curr || null;
}

function postOrderMerge(node: TreeNode): TreeNode {
    // 1. 后序处理 children
    const newChildren: TreeNode[] = [];

    for (const child of node.children) {
        const mergedChild = postOrderMerge(child);
        newChildren.push(mergedChild);
    }

    node.children = newChildren;

    // 2. 尝试 child -> parent merge
    const remaining: TreeNode[] = [];

    for (const child of node.children) {
        if (shouldMerge(child, node)) {
            // absorb child into parent
            node.mergedDomIds.push(...child.mergedDomIds);

            // type rule（保留你的设计）
            if (child.type === 'ENTITY') {
                node.type = 'ENTITY';
            }

            // bbox 如果你后面要用可以更新（可选）
            // node = mergeBBox(node, child);

        } else {
            remaining.push(child);
        }
    }

    node.children = remaining;

    return node;
}
//识别滑动区域
const isScrollable = (style) => {
  return ['auto', 'scroll'].includes(style.overflowY) || 
         ['auto', 'scroll'].includes(style.overflowX) || 
         ['auto', 'scroll'].includes(style.overflow);
};