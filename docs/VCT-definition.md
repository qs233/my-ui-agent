# Visual Containment Tree (VCT) — Static HTML/CSS Model

## 1. Overview

VCT (Visual Containment Tree) is a static structure derived from **HTML + CSS only**, used to represent:

> Visual containment relationships between elements, not DOM hierarchy.

It models:
- visual region ownership
- spatial containment
- visibility under clipping
- simplified stacking semantics

It does NOT include runtime JS behavior (e.g. animation frames, event-driven DOM mutation).

---

## 2. Core Concept

VCT is a tree or forest where each node represents a **visual region (bounding box)**.

Each node describes:
- its computed visual bounding box
- visibility state (clipped or not)
- child visual regions it contains

---

## 3. Containment Rules

### 3.1 Spatial Containment (Primary Rule)

If a child's visual region is fully contained within a parent's region:

parent → child

This defines the primary parent-child relationship in VCT.

---

### 3.2 Motion Invariance (Static Approximation)

A child remains under the same parent if:

> Under static CSS interpretation (layout + positioning rules), it does not escape the parent's visual region.

If partial overflow exists, node may be marked as `floating`.

---

## 4. Position Model Mapping

### 4.1 static / relative

- participates in normal flow
- contained within parent layout box

---

### 4.2 absolute

- parent = nearest positioned ancestor (containing block)
- ignores DOM parent if different

---

### 4.3 fixed

- parent = viewport (or containing block ancestor)
- belongs to visual root layer
- detached from DOM containment

---

### 4.4 sticky

- parent = scroll container
- structurally stable in tree
- position changes within constraint boundary

---

## 5. Floating Nodes

Nodes slightly exceeding parent bounds but still visually belonging to parent are marked:

parent → child (floating = true)

Typical cases:
- badges
- shadows
- overflow decorations
- tooltips anchored to parent

---

## 6. Clipping Rule

### Fully clipped elements

If element has zero visible area after:

- overflow: hidden/scroll clipping
- clip-path
- masking

Then:

> It is excluded from VCT

---

### Partially visible elements

- retained in tree
- bounding box = visible intersection region

---

## 7. Stacking / Z-Index Semantics

VCT does NOT restructure tree based on z-index.

Instead:
- stacking context is stored as metadata
- used only for sibling visual ordering

---

## 8. Multi-root Structure

VCT can be a forest:

- viewport root (main visual tree)
- fixed layer root (floating UI layer)
- portal root (dialogs/modals)

Recommended simplification:

> unify under a single viewport-root with attached visual sub-roots

---

## 9. Definition Summary

VCT is a static visual abstraction that transforms HTML/CSS into:

- spatial containment hierarchy
- visibility-aware structure
- simplified positioning semantics

It ignores DOM hierarchy and runtime behavior.

---

## 10. One-line Definition

> VCT is a static visual containment structure derived from HTML/CSS, where nodes represent visual regions and edges represent spatial containment rather than DOM hierarchy, with optional floating and clipping-aware adjustments.

VCT is a static visual containment tree derived from HTML + CSS, where nodes are connected based on computed visual containment rather than DOM hierarchy. The parent of each node is determined by CSS layout rules: normal flow for static/relative elements, nearest positioned containing block for absolute elements, scroll container for sticky elements, and viewport or transformed containing block for fixed elements. Nodes that overflow slightly are marked as floating, and fully clipped nodes are excluded.
