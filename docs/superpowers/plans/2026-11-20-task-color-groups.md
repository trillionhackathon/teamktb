# Task Color Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each manufacturing task a distinct color and repeat that color on every matching menu line in the order cards.

**Architecture:** `teamktb` assigns colors while building task notes, using a fixed accessible palette in task order. The dashboard derives a line-color lookup from each note's existing `parts` entries, so the API contract with `aiserver` does not change and mixed-menu orders can show more than one color.

**Tech Stack:** Next.js 16, React 19, TypeScript, CSS

**Spec:** `.claude/prds/work-card-clarity.prd.md`

## Global Constraints

- Keep task completion and order completion independent.
- Do not expose Zoro scores in the production UI.
- Do not add dependencies or change the `aiserver` response contract.
- Use color together with a visible border marker so grouping is not color-only.

## Review Focus

- A task shared by two orders must use the same color on both menu lines.
- Two different tasks must use different colors even when all orders belong to one Zoro order group.
- A mixed-menu order must color only the menu lines included in each task.
- Unmatched menu lines must remain uncolored.
- Completed lines must retain their task marker while showing the existing strike-through state.

---

### Task 1: Assign task colors

**Files:**
- Modify: `app/domain/review.ts`
- Modify: `app/server/order-store.ts`
- Test: `tests/order-store.test.ts`

**Interfaces:**
- Produces: `taskPalette: readonly string[]` and `Note.color` on every generated manufacturing task.

- [ ] Add assertions that SC-W task notes have different colors and that each note keeps one color across its `parts`.
- [ ] Run `npm test` and verify the new assertions fail.
- [ ] Add the fixed task palette and assign colors in task insertion order.
- [ ] Run `npm test` and verify it passes.

### Task 2: Connect task blocks to order menu lines

**Files:**
- Modify: `app/dashboard.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: task notes with `color` and `parts: { order_id, line_index, qty }[]`.
- Produces: colored task-card border and matching `.item-task` menu-line marker.

- [ ] Build a lookup keyed by `order_id:line_index` from visible task notes.
- [ ] Pass the lookup into the fixed-order menu list and apply the task color as a CSS custom property.
- [ ] Use the same custom property on each task block and replace whole-order green highlighting with neutral grouping labels.
- [ ] Render one legend chip per task color and run `npm run check`.

### Task 3: Verify the scenario

**Files:**
- Modify: `.claude/prds/work-card-clarity.prd.md`

**Interfaces:**
- Consumes: SC-W and the local Next.js server.
- Produces: documented, verified color behavior.

- [ ] Update the approved spec with the per-task color rule.
- [ ] Load SC-W and verify the rendered HTML contains distinct task colors, matching menu-line colors, and no visible Zoro score.
- [ ] Run `npm test`, `npm run check`, and `git diff --check`.
