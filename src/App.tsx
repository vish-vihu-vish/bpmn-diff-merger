import { useEffect, useMemo, useRef, useState } from 'react';
import DiagramViewer from './BpmnViewer';
import {
  buildMergedBpmnXml,
  buildPreviewBpmnXml,
  computeBpmnComparison,
  detectDiagramKind
} from './bpmnMerge';
import { sampleFromXml, sampleToXml } from './sample-bpmn';
import type { FieldDiff, MergeChange, MergeSide } from './types';

type DiffSideKind = 'same' | 'added' | 'removed' | 'changed' | 'empty';

type DiffRow = {
  fromLineNumber: number | null;
  toLineNumber: number | null;
  fromText: string;
  toText: string;
  fromKind: DiffSideKind;
  toKind: DiffSideKind;
};

type HistoryEntry = {
  changes: MergeChange[];
  activeId: string | null;
  canvasMode: 'comparison' | 'from' | 'to';
};

type TourStep = {
  key: string;
  title: string;
  body: string;
  getTarget: () => HTMLElement | null;
};

type TourRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

function cloneChanges(changes: MergeChange[]): MergeChange[] {
  return JSON.parse(JSON.stringify(changes)) as MergeChange[];
}

function prettyValue(value: string | null): string {
  if (value === null) {
    return 'Not present';
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return 'Not present';
  }

  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return value;
    }
  }

  return value;
}

function parseJsonLike(value: string | null): { prefix: string; parsed: unknown } | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  const body = trimmed.startsWith('=') ? trimmed.slice(1).trim() : trimmed;

  if (
    !((body.startsWith('{') && body.endsWith('}')) || (body.startsWith('[') && body.endsWith(']')))
  ) {
    return null;
  }

  try {
    return {
      prefix: trimmed.startsWith('=') ? '=' : '',
      parsed: JSON.parse(body)
    };
  } catch {
    return null;
  }
}

function formatJsonLike(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const parsed = parseJsonLike(value);
  if (!parsed) {
    return prettyValue(value);
  }

  return `${parsed.prefix}${JSON.stringify(parsed.parsed, null, 2)}`;
}

function buildJsonComparator(field: FieldDiff): DiffRow[] | null {
  const fromFormatted = formatJsonLike(field.editedFromValue ?? field.fromValue);
  const toFormatted = formatJsonLike(field.editedToValue ?? field.toValue);

  if (!fromFormatted && !toFormatted) {
    return null;
  }

  const fromLines = (fromFormatted ?? 'Not present').split('\n');
  const toLines = (toFormatted ?? 'Not present').split('\n');

  return buildAlignedDiffRows(fromLines, toLines);
}

function buildAlignedDiffRows(fromLines: string[], toLines: string[]): DiffRow[] {
  const m = fromLines.length;
  const n = toLines.length;
  const dp = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));

  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] =
        fromLines[i] === toLines[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;

  while (i < m && j < n) {
    if (fromLines[i] === toLines[j]) {
      rows.push({
        fromLineNumber: i + 1,
        toLineNumber: j + 1,
        fromText: fromLines[i],
        toText: toLines[j],
        fromKind: 'same',
        toKind: 'same'
      });
      i += 1;
      j += 1;
      continue;
    }

    if (dp[i + 1][j] === dp[i][j + 1]) {
      rows.push({
        fromLineNumber: i + 1,
        toLineNumber: j + 1,
        fromText: fromLines[i],
        toText: toLines[j],
        fromKind: 'changed',
        toKind: 'changed'
      });
      i += 1;
      j += 1;
      continue;
    }

    if (dp[i + 1][j] > dp[i][j + 1]) {
      rows.push({
        fromLineNumber: i + 1,
        toLineNumber: null,
        fromText: fromLines[i],
        toText: '',
        fromKind: 'removed',
        toKind: 'empty'
      });
      i += 1;
      continue;
    }

    rows.push({
      fromLineNumber: null,
      toLineNumber: j + 1,
      fromText: '',
      toText: toLines[j],
      fromKind: 'empty',
      toKind: 'added'
    });
    j += 1;
  }

  while (i < m) {
    rows.push({
      fromLineNumber: i + 1,
      toLineNumber: null,
      fromText: fromLines[i],
      toText: '',
      fromKind: 'removed',
      toKind: 'empty'
    });
    i += 1;
  }

  while (j < n) {
    rows.push({
      fromLineNumber: null,
      toLineNumber: j + 1,
      fromText: '',
      toText: toLines[j],
      fromKind: 'empty',
      toKind: 'added'
    });
    j += 1;
  }

  return rows;
}

function getReferencedElementIds(change: MergeChange): string[] {
  const combined = change.fieldDiffs
    .map((field) => `${field.fromValue ?? ''}\n${field.toValue ?? ''}`)
    .join('\n');

  const matches = Array.from(
    combined.matchAll(/(?:sourceRef|targetRef):\s*([A-Za-z0-9_:-]+)/g),
    (match) => match[1]
  );

  return [...new Set(matches)];
}

function autoResolveRelatedFlows(changes: MergeChange[], elementId: string, side: MergeSide): MergeChange[] {
  return changes.map((change) => {
    if (change.elementType.toLowerCase().includes('sequenceflow') && getReferencedElementIds(change).includes(elementId)) {
      if (change.kind === 'added' || change.kind === 'removed') {
        return {
          ...change,
          selectedSide: change.selectedSide ?? side
        };
      }
    }

    return change;
  });
}

function splitSummary(value: string | null): string[] {
  if (!value) {
    return ['Not present'];
  }

  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function getElementDecision(change: MergeChange): 'from' | 'to' | 'mixed' | 'unresolved' {
  if (change.kind === 'added' || change.kind === 'removed') {
    return change.selectedSide ?? 'unresolved';
  }

  if (change.fieldDiffs.some((field) => field.selectedSide === null)) {
    return 'unresolved';
  }

  const selectedSides = new Set(change.fieldDiffs.map((field) => field.selectedSide));
  if (selectedSides.size === 1) {
    return change.fieldDiffs[0]?.selectedSide ?? 'unresolved';
  }

  return 'mixed';
}

function isExcluded(change: MergeChange): boolean {
  return (
    (change.kind === 'added' && change.selectedSide === 'from') ||
    (change.kind === 'removed' && change.selectedSide === 'to')
  );
}

function isChangeResolved(change: MergeChange): boolean {
  if (change.kind === 'added' || change.kind === 'removed') {
    return change.selectedSide !== null;
  }

  return change.fieldDiffs.every((field) => field.selectedSide !== null);
}

function hasCustomMergeState(changes: MergeChange[]): boolean {
  return changes.some((change) => {
    if (change.selectedSide !== null) {
      return true;
    }

    return change.fieldDiffs.some(
      (field) =>
        field.selectedSide !== null ||
        field.editedFromValue !== undefined ||
        field.editedToValue !== undefined
    );
  });
}

export default function App() {
  const [fromXml, setFromXml] = useState(sampleFromXml);
  const [toXml, setToXml] = useState(sampleToXml);
  const [changes, setChanges] = useState<MergeChange[]>([]);
  const [comparisonXml, setComparisonXml] = useState(sampleToXml);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const [canvasMode, setCanvasMode] = useState<'comparison' | 'from' | 'to'>('comparison');
  const [error, setError] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<HistoryEntry[]>([]);
  const [tourOpen, setTourOpen] = useState(false);
  const [tourIndex, setTourIndex] = useState(0);
  const [tourRect, setTourRect] = useState<TourRect | null>(null);
  const heroRef = useRef<HTMLElement | null>(null);
  const tourButtonRef = useRef<HTMLButtonElement | null>(null);
  const sourceGridRef = useRef<HTMLElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const modeBarRef = useRef<HTMLDivElement | null>(null);
  const selectionToolbarRef = useRef<HTMLDivElement | null>(null);
  const viewerPanelRef = useRef<HTMLDivElement | null>(null);
  const changeListRef = useRef<HTMLDivElement | null>(null);
  const inspectorRef = useRef<HTMLElement | null>(null);
  const diffStackRef = useRef<HTMLDivElement | null>(null);

  const fromKind = useMemo(() => detectDiagramKind(fromXml), [fromXml]);
  const toKind = useMemo(() => detectDiagramKind(toXml), [toXml]);
  const canDiffBpmn = fromKind === 'bpmn' && toKind === 'bpmn';
  const isDmn = fromKind === 'dmn' && toKind === 'dmn';

  useEffect(() => {
    if (!canDiffBpmn) {
      setChanges([]);
      setComparisonXml(toXml);
      setActiveId(null);
      setCanvasMode('comparison');
      setUndoStack([]);
      setError(
        isDmn
          ? 'DMN support is the next layer. This build now focuses on the BPMN visual-merge interaction model.'
          : 'Paste two BPMN diagrams to start comparing them visually.'
      );
      return;
    }

    try {
      const result = computeBpmnComparison(fromXml, toXml);
      setChanges(result.changes);
      setComparisonXml(result.comparisonXml);
      setActiveId((current) =>
        current && result.changes.some((change) => change.id === current)
          ? current
          : (result.changes[0]?.id ?? null)
      );
      setCanvasMode('comparison');
      setUndoStack([]);
      setError(null);
    } catch (comparisonError) {
      setChanges([]);
      setComparisonXml(toXml);
      setActiveId(null);
      setCanvasMode('comparison');
      setUndoStack([]);
      setError(
        comparisonError instanceof Error
          ? comparisonError.message
          : 'Failed to compare the BPMN files.'
      );
    }
  }, [canDiffBpmn, fromXml, isDmn, toXml]);

  const previewXml = useMemo(() => {
    if (!canDiffBpmn) {
      return comparisonXml;
    }
    return buildPreviewBpmnXml(fromXml, toXml, changes);
  }, [canDiffBpmn, changes, comparisonXml, fromXml, toXml]);

  const mergedXml = useMemo(() => {
    if (!canDiffBpmn) {
      return toXml;
    }
    return buildMergedBpmnXml(fromXml, toXml, changes);
  }, [canDiffBpmn, changes, fromXml, toXml]);
  const unresolvedChanges = useMemo(() => changes.filter((change) => !isChangeResolved(change)), [changes]);
  const unresolvedFieldCount = useMemo(() => {
    return changes.reduce((count, change) => {
      if (change.kind === 'added' || change.kind === 'removed') {
        return count + (change.selectedSide === null ? 1 : 0);
      }

      return count + change.fieldDiffs.filter((field) => field.selectedSide === null).length;
    }, 0);
  }, [changes]);
  const resolvedFieldCount = useMemo(() => {
    return changes.reduce((count, change) => {
      if (change.kind === 'added' || change.kind === 'removed') {
        return count + (change.selectedSide !== null ? 1 : 0);
      }

      return count + change.fieldDiffs.filter((field) => field.selectedSide !== null).length;
    }, 0);
  }, [changes]);
  const canvasXml = useMemo(() => {
    if (canvasMode === 'from') {
      return fromXml;
    }

    if (canvasMode === 'to') {
      return toXml;
    }

    return previewXml;
  }, [canvasMode, fromXml, previewXml, toXml]);
  const activeChange = useMemo(
    () => changes.find((change) => change.id === activeId) ?? null,
    [activeId, changes]
  );
  const preferredTourChangeId = useMemo(
    () => unresolvedChanges[0]?.id ?? changes[0]?.id ?? null,
    [changes, unresolvedChanges]
  );
  const isUsingDemoXml = fromXml === sampleFromXml && toXml === sampleToXml;
  const hasTourDiscardState = !isUsingDemoXml || undoStack.length > 0 || hasCustomMergeState(changes);
  const preferredJsonTourChangeId = useMemo(
    () =>
      unresolvedChanges.find((change) => change.fieldDiffs.some((field) => buildJsonComparator(field)))?.id ??
      changes.find((change) => change.fieldDiffs.some((field) => buildJsonComparator(field)))?.id ??
      preferredTourChangeId,
    [changes, preferredTourChangeId, unresolvedChanges]
  );
  const focusRequest = useMemo(() => {
    if (!activeId || focusNonce === 0) {
      return null;
    }

    return { id: activeId, nonce: focusNonce };
  }, [activeId, focusNonce]);

  const markers = useMemo(() => {
    const map: Record<string, string[]> = {};

    for (const change of unresolvedChanges) {
      const markerClasses: string[] = [];

      if (change.kind === 'added') {
        markerClasses.push('merge-added');
      } else if (change.kind === 'removed') {
        markerClasses.push('merge-removed');
      } else if (change.kind === 'layoutChanged') {
        markerClasses.push('merge-layout');
      } else {
        markerClasses.push('merge-changed');
      }

      const decision = getElementDecision(change);
      if (decision === 'from') {
        markerClasses.push('merge-from-choice');
      }
      if (decision === 'mixed') {
        markerClasses.push('merge-mixed-choice');
      }
      if (isExcluded(change)) {
        markerClasses.push('merge-excluded');
      }

      map[change.id] = markerClasses;
    }

    return map;
  }, [unresolvedChanges]);

  const tourSteps = useMemo<TourStep[]>(() => [
    {
      key: 'tour',
      title: 'Guided Tour',
      body: 'Start this anytime to walk through the whole merge flow. The tour follows the same order you use while resolving BPMN diffs.',
      getTarget: () => tourButtonRef.current
    },
    {
      key: 'xml',
      title: 'From And To BPMN XML',
      body: 'Paste or edit the source BPMN on the left and the target BPMN on the right. Any XML update reruns the comparison and refreshes the visualizer.',
      getTarget: () => sourceGridRef.current
    },
    {
      key: 'colors',
      title: 'Diff Colors',
      body: 'White means no change, yellow means content change, light blue means layout-only change, red means deleted, and green means added. The lighter blue keeps layout changes visible without pulling attention away from more urgent merge decisions.',
      getTarget: () => toolbarRef.current?.querySelector<HTMLElement>('[data-tour="legend"]') ?? null
    },
    {
      key: 'toolbar',
      title: 'Undo, Count, And Export',
      body: 'This section lets you undo merge actions, shows how many decisions are still unresolved, and only unlocks export when every diff is resolved.',
      getTarget: () => toolbarRef.current?.querySelector<HTMLElement>('[data-tour="toolbar-actions"]') ?? null
    },
    {
      key: 'modes',
      title: 'Canvas Modes',
      body: 'Comparison is the live merge preview. From preview and To preview let you temporarily inspect either side without leaving the current merge session.',
      getTarget: () => modeBarRef.current
    },
    {
      key: 'selection',
      title: 'Element-Level Merge',
      body: 'When a BPMN element is selected, these actions let you include the whole block from one side or the other. Use this for entire added or removed workers and flows.',
      getTarget: () => selectionToolbarRef.current ?? viewerPanelRef.current
    },
    {
      key: 'viewer',
      title: 'Comparison Canvas',
      body: 'Click any task, gateway, event, or flow to inspect it. The canvas supports drag-to-pan, zoom controls, blinking highlights, and preview focusing for changed elements.',
      getTarget: () => viewerPanelRef.current
    },
    {
      key: 'changes',
      title: 'Change List',
      body: 'If a diagram is crowded, use the change list to jump directly to each unresolved diff. Clicking any row highlights and focuses that BPMN section.',
      getTarget: () => changeListRef.current
    },
    {
      key: 'selection',
      title: 'Include From Or To',
      body: 'These element-level actions are useful when an entire worker, gateway, event, or flow should come completely from one side.',
      getTarget: () =>
        selectionToolbarRef.current?.querySelector<HTMLElement>('[data-tour="selection-actions"]') ??
        selectionToolbarRef.current ??
        viewerPanelRef.current
    },
    {
      key: 'inspector',
      title: 'Accept All From Or To',
      body: 'The inspector lets you resolve the entire selected BPMN element at once with Accept all from or Accept all to.',
      getTarget: () =>
        inspectorRef.current?.querySelector<HTMLElement>('[data-tour="accept-all-actions"]') ?? inspectorRef.current
    },
    {
      key: 'field-actions',
      title: 'Use From Or Use To',
      body: 'Field-level actions let you merge property-by-property instead of taking the whole block. This is where precise worker input, output, and property decisions happen.',
      getTarget: () => diffStackRef.current?.querySelector<HTMLElement>('[data-tour="field-actions"]') ?? diffStackRef.current
    },
    {
      key: 'preview',
      title: 'Preview On Diagram',
      body: 'Preview jumps the canvas to the related BPMN component so you can inspect that exact worker, flow, or layout change before accepting it.',
      getTarget: () => diffStackRef.current?.querySelector<HTMLElement>('[data-tour="preview-button"]') ?? diffStackRef.current
    },
    {
      key: 'edit-json',
      title: 'Edit JSON',
      body: 'When a field contains JSON-like content, you can edit either side directly here, compare the result, preview the BPMN element, and then choose which edited version should land in the merge.',
      getTarget: () => diffStackRef.current?.querySelector<HTMLElement>('[data-tour="edit-json-button"]') ?? diffStackRef.current
    },
    {
      key: 'field',
      title: 'Inspector Diff Area',
      body: 'This area is the detailed merge workspace. It contains JSON comparison, layout summaries, preview actions, edit actions, and field-level merge controls.',
      getTarget: () =>
        diffStackRef.current?.querySelector<HTMLElement>('.field-card, .compact-empty') ?? diffStackRef.current
    }
  ], []);

  const currentTourStep = tourOpen ? tourSteps[tourIndex] ?? null : null;

  function pushUndoSnapshot() {
    setUndoStack((current) => [
      ...current.slice(-49),
      {
        changes: cloneChanges(changes),
        activeId,
        canvasMode
      }
    ]);
  }

  function undoLastAction() {
    setUndoStack((current) => {
      const snapshot = current[current.length - 1];

      if (!snapshot) {
        return current;
      }

      setChanges(snapshot.changes);
      setActiveId(snapshot.activeId);
      setCanvasMode(snapshot.canvasMode);
      setFocusNonce((focus) => focus + 1);

      return current.slice(0, -1);
    });
  }

  useEffect(() => {
    function handleUndoShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;

      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) {
        return;
      }

      if (event.key.toLowerCase() !== 'z' || undoStack.length === 0) {
        return;
      }

      if (target?.isContentEditable || tagName === 'TEXTAREA' || tagName === 'INPUT') {
        return;
      }

      event.preventDefault();
      undoLastAction();
    }

    window.addEventListener('keydown', handleUndoShortcut);
    return () => window.removeEventListener('keydown', handleUndoShortcut);
  }, [undoStack]);

  useEffect(() => {
    if (!tourOpen) {
      return;
    }

    function handleTourKeys(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setTourOpen(false);
        return;
      }

      if (event.key === 'ArrowRight' && tourIndex < tourSteps.length - 1) {
        setTourIndex((current) => current + 1);
      }

      if (event.key === 'ArrowLeft' && tourIndex > 0) {
        setTourIndex((current) => current - 1);
      }
    }

    window.addEventListener('keydown', handleTourKeys);
    return () => window.removeEventListener('keydown', handleTourKeys);
  }, [tourIndex, tourOpen, tourSteps.length]);

  useEffect(() => {
    if (!tourOpen) {
      setTourRect(null);
      return;
    }

    const tourStepKey = currentTourStep?.key;
    const desiredTourChangeId =
      tourStepKey === 'edit-json' || tourStepKey === 'preview'
        ? preferredJsonTourChangeId
        : preferredTourChangeId;

    if (desiredTourChangeId && activeId !== desiredTourChangeId) {
      setActiveId(desiredTourChangeId);
      setCanvasMode('comparison');
      setFocusNonce((current) => current + 1);
    }
  }, [activeId, currentTourStep, preferredJsonTourChangeId, preferredTourChangeId, tourOpen]);

  useEffect(() => {
    if (!currentTourStep) {
      return;
    }

    const step = currentTourStep;
    let cancelled = false;

    function scrollIntoViewIfNeeded(target: HTMLElement) {
      const rect = target.getBoundingClientRect();
      const verticalPadding = 48;
      const horizontalPadding = 24;
      const outsideViewport =
        rect.top < verticalPadding ||
        rect.bottom > window.innerHeight - verticalPadding ||
        rect.left < horizontalPadding ||
        rect.right > window.innerWidth - horizontalPadding;

      if (outsideViewport) {
        target.scrollIntoView({
          block: 'center',
          inline: 'center',
          behavior: 'smooth'
        });
      }
    }

    function updateTourRect() {
      const target = step.getTarget();

      if (!target) {
        setTourRect(null);
        return;
      }

      scrollIntoViewIfNeeded(target);
      const rect = target.getBoundingClientRect();

      if (cancelled) {
        return;
      }

      setTourRect({
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height
      });
    }

    const rafOne = window.requestAnimationFrame(() => {
      updateTourRect();
      window.requestAnimationFrame(updateTourRect);
    });

    window.addEventListener('resize', updateTourRect);
    window.addEventListener('scroll', updateTourRect, true);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafOne);
      window.removeEventListener('resize', updateTourRect);
      window.removeEventListener('scroll', updateTourRect, true);
    };
  }, [activeChange, currentTourStep, tourOpen]);

  function startTour() {
    if (hasTourDiscardState) {
      const shouldDiscard = window.confirm(
        'The tour only works with the demo BPMN XMLs. Starting the tour will discard your current changes and reset the screen to the demo files. Do you want to continue?'
      );

      if (!shouldDiscard) {
        return;
      }

      setFromXml(sampleFromXml);
      setToXml(sampleToXml);
      setCanvasMode('comparison');
      setUndoStack([]);
    }

    setTourIndex(0);
    setTourOpen(true);
  }

  function updateElementDecision(id: string, side: MergeSide) {
    pushUndoSnapshot();
    setCanvasMode('comparison');
    setChanges((current) =>
      autoResolveRelatedFlows(
        current.map((change) => {
        if (change.id !== id) {
          return change;
        }

        if (change.kind === 'added' || change.kind === 'removed') {
          return { ...change, selectedSide: side };
        }

        return {
          ...change,
          selectedSide: side,
          fieldDiffs: change.fieldDiffs.map((field) => ({ ...field, selectedSide: side }))
        };
      }),
        id,
        side
      )
    );
    setFocusNonce((current) => current + 1);
  }

  function updateFieldDecision(elementId: string, fieldKey: string, side: MergeSide) {
    pushUndoSnapshot();
    setCanvasMode('comparison');
    setChanges((current) =>
      autoResolveRelatedFlows(
        current.map((change) => {
        if (change.id !== elementId) {
          return change;
        }

        if (change.kind === 'added' || change.kind === 'removed') {
          return {
            ...change,
            selectedSide: side,
            fieldDiffs: change.fieldDiffs.map((field) =>
              field.key === fieldKey ? { ...field, selectedSide: side } : field
            )
          };
        }

        return {
          ...change,
          fieldDiffs: change.fieldDiffs.map((field) =>
            field.key === fieldKey ? { ...field, selectedSide: side } : field
          )
        };
      }),
        elementId,
        side
      )
    );
    setFocusNonce((current) => current + 1);
  }

  function beginFieldEdit() {
    pushUndoSnapshot();
  }

  function updateFieldEditedValue(
    elementId: string,
    fieldKey: string,
    side: MergeSide,
    value: string
  ) {
    setChanges((current) =>
      current.map((change) => {
        if (change.id !== elementId) {
          return change;
        }

        return {
          ...change,
          fieldDiffs: change.fieldDiffs.map((field) =>
            field.key !== fieldKey
              ? field
              : side === 'from'
                ? { ...field, editedFromValue: value }
                : { ...field, editedToValue: value }
          )
        };
      })
    );
  }

  function downloadMergedXml() {
    const blob = new Blob([mergedXml], { type: 'application/xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'merged.bpmn';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function focusChange(id: string) {
    setCanvasMode('comparison');
    setActiveId(id);
    setFocusNonce((current) => current + 1);
  }

  function previewChangeSide(id: string, side: 'from' | 'to') {
    setActiveId(id);
    setCanvasMode((current) => (current === side ? 'comparison' : side));
    setFocusNonce((current) => current + 1);
  }

  return (
    <div className="app-shell">
      <header ref={heroRef} className="hero">
        <div>
          <p className="eyebrow">Visual BPMN Merge</p>
          <h1>Click the workflow itself, inspect the worker diff, and choose what lands in output</h1>
          <p className="hero-copy">
            Worker colors from the BPMN are normalized in the viewer, so diff colors stay consistent:
            white for no change, yellow for content changes, blue for layout-only changes, red for deleted,
            and green for added.
          </p>
        </div>
        <div className="hero-side">
          <div className="hero-actions">
            <button ref={tourButtonRef} type="button" className="tour-button" onClick={startTour}>
              Tour
            </button>
          </div>
          <p className="tour-note">Demo XML only. Starting the tour resets current work.</p>
          <div className="hero-stats">
            <div>
              <span>Unresolved items</span>
              <strong>{unresolvedFieldCount}</strong>
            </div>
            <div>
              <span>Resolved</span>
              <strong>{resolvedFieldCount}</strong>
            </div>
          </div>
        </div>
      </header>

      <section ref={sourceGridRef} className="source-grid">
        <label className="xml-panel compact-panel">
          <span>From BPMN XML</span>
          <textarea value={fromXml} onChange={(event) => setFromXml(event.target.value)} />
        </label>
        <label className="xml-panel compact-panel">
          <span>To BPMN XML</span>
          <textarea value={toXml} onChange={(event) => setToXml(event.target.value)} />
        </label>
      </section>

      {error ? <section className="notice">{error}</section> : null}

      <section className="workspace-grid visual-layout">
        <div className="canvas-column">
          <div ref={toolbarRef} className="canvas-toolbar">
            <div data-tour="legend" className="legend">
              <span><i className="swatch swatch-white" /> No change</span>
              <span><i className="swatch swatch-yellow" /> Internal change</span>
              <span><i className="swatch swatch-blue" /> Layout only</span>
              <span><i className="swatch swatch-red" /> Deleted</span>
              <span><i className="swatch swatch-green" /> Added</span>
            </div>
            <div data-tour="toolbar-actions" className="toolbar-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={undoLastAction}
                disabled={undoStack.length === 0}
              >
                Undo {undoStack.length ? `(${undoStack.length})` : ''}
              </button>
              {unresolvedFieldCount === 0 ? (
                <button type="button" className="download" onClick={downloadMergedXml}>
                  Export merged BPMN
                </button>
              ) : (
                <div className="status-badge">{unresolvedFieldCount} decisions left before export</div>
              )}
            </div>
          </div>

          <div ref={modeBarRef} className="canvas-mode-bar">
            <span className={`mode-pill ${canvasMode === 'comparison' ? 'active' : ''}`}>Comparison</span>
            <span className={`mode-pill ${canvasMode === 'from' ? 'active' : ''}`}>From preview</span>
            <span className={`mode-pill ${canvasMode === 'to' ? 'active' : ''}`}>To preview</span>
            {canvasMode !== 'comparison' ? (
              <button type="button" onClick={() => setCanvasMode('comparison')}>
                Back to comparison
              </button>
            ) : null}
          </div>

          {activeChange ? (
            <div ref={selectionToolbarRef} className="selection-toolbar">
              <div>
                <p className="selection-kicker">Selected on diagram</p>
                <strong>{activeChange.label}</strong>
              </div>
              <div data-tour="selection-actions" className="selection-actions">
                <button
                  type="button"
                  className={getElementDecision(activeChange) === 'from' ? 'selected' : ''}
                  onClick={(event) => {
                    event.stopPropagation();
                    updateElementDecision(activeChange.id, 'from');
                  }}
                >
                  Include from
                </button>
                <button
                  type="button"
                  className={getElementDecision(activeChange) === 'to' ? 'selected' : ''}
                  onClick={(event) => {
                    event.stopPropagation();
                    updateElementDecision(activeChange.id, 'to');
                  }}
                >
                  Include to
                </button>
              </div>
            </div>
          ) : null}

          <div ref={viewerPanelRef}>
            <DiagramViewer
              xml={canvasXml}
              activeElementId={activeId}
              focusRequest={focusRequest}
              markers={markers}
              onElementClick={(id) => setActiveId(id)}
              title="Comparison Canvas"
            />
          </div>

          <div ref={changeListRef} className="change-list-card">
            <div className="change-list-header">
              <h3>Change List</h3>
              <span>{unresolvedChanges.length} unresolved</span>
            </div>
            <div className="change-list">
              {unresolvedChanges.map((change) => (
                <button
                  key={change.id}
                  type="button"
                  className={`change-list-item ${activeId === change.id ? 'active' : ''}`}
                  onClick={() => focusChange(change.id)}
                >
                  <span className={`kind kind-${change.kind}`}>{change.kind}</span>
                  <span className="change-list-copy">
                    <strong>{change.label}</strong>
                    <small>{change.summary}</small>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <aside ref={inspectorRef} className="inspector">
          {!activeChange ? (
            <div className="empty-inspector">
              {unresolvedFieldCount === 0 ? (
                <>
                  <h2>All merge decisions are resolved</h2>
                  <p>The visualizer already reflects your accepted changes. You can export the merged BPMN now.</p>
                </>
              ) : (
                <>
                  <h2>Select a changed task or flow</h2>
                  <p>The right panel will show the worker properties, variable changes, and accept buttons.</p>
                </>
              )}
            </div>
          ) : (
            <div className="inspector-scroll">
              <div className="inspector-header">
                <div>
                  <p className="inspector-type">{activeChange.elementType}</p>
                  <h2>{activeChange.label}</h2>
                  <p className="inspector-summary">{activeChange.summary}</p>
                </div>
                <span className={`kind kind-${activeChange.kind}`}>{activeChange.kind}</span>
              </div>

              <div data-tour="accept-all-actions" className="inspector-actions">
                <button
                  type="button"
                  className={getElementDecision(activeChange) === 'from' ? 'selected' : ''}
                  onClick={(event) => {
                    event.stopPropagation();
                    updateElementDecision(activeChange.id, 'from');
                  }}
                >
                  Accept all from
                </button>
                <button
                  type="button"
                  className={getElementDecision(activeChange) === 'to' ? 'selected' : ''}
                  onClick={(event) => {
                    event.stopPropagation();
                    updateElementDecision(activeChange.id, 'to');
                  }}
                >
                  Accept all to
                </button>
              </div>

              <div ref={diffStackRef} className="diff-stack">
                {activeChange.fieldDiffs.filter((field) => field.selectedSide === null).length ? (
                  activeChange.fieldDiffs
                    .filter((field) => field.selectedSide === null)
                    .map((field) => (
                      <FieldComparator
                        key={field.key}
                        change={activeChange}
                        field={field}
                        onChoose={(side) => updateFieldDecision(activeChange.id, field.key, side)}
                        onBeginEdit={beginFieldEdit}
                        onEdit={(side, value) => updateFieldEditedValue(activeChange.id, field.key, side, value)}
                        onHighlight={(side) =>
                          side ? previewChangeSide(activeChange.id, side) : focusChange(activeChange.id)
                        }
                        canvasMode={canvasMode}
                      />
                    ))
                ) : (
                  <div className="empty-inspector compact-empty">
                    <h2>No changes left for this component</h2>
                    <p>The selected BPMN element is fully resolved. You can stay here or pick another item from the change list.</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </aside>
      </section>

      {currentTourStep ? (
        <TourOverlay
          rect={tourRect}
          step={currentTourStep}
          stepIndex={tourIndex}
          totalSteps={tourSteps.length}
          onClose={() => setTourOpen(false)}
          onNext={() => {
            if (tourIndex === tourSteps.length - 1) {
              setTourOpen(false);
              return;
            }

            setTourIndex((current) => current + 1);
          }}
          onPrevious={() => setTourIndex((current) => Math.max(0, current - 1))}
        />
      ) : null}
    </div>
  );
}

function TourOverlay({
  rect,
  step,
  stepIndex,
  totalSteps,
  onClose,
  onNext,
  onPrevious
}: {
  rect: TourRect | null;
  step: TourStep;
  stepIndex: number;
  totalSteps: number;
  onClose: () => void;
  onNext: () => void;
  onPrevious: () => void;
}) {
  return (
    <div className="tour-overlay" role="dialog" aria-modal="true" aria-label="Product tour">
      <div className="tour-backdrop" onClick={onClose} />
      {rect ? (
        <div
          className="tour-spotlight"
          style={{
            top: rect.top - 10,
            left: rect.left - 10,
            width: rect.width + 20,
            height: rect.height + 20
          }}
        />
      ) : null}
      <aside className="tour-card">
        <p className="tour-step">Step {stepIndex + 1} of {totalSteps}</p>
        <h2>{step.title}</h2>
        <p>{step.body}</p>
        <div className="tour-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Skip
          </button>
          <div className="tour-nav">
            <button type="button" className="secondary-button" onClick={onPrevious} disabled={stepIndex === 0}>
              Back
            </button>
            <button type="button" className="download" onClick={onNext}>
              {stepIndex === totalSteps - 1 ? 'Finish' : 'Next'}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}

function FieldComparator({
  change,
  field,
  onChoose,
  onBeginEdit,
  onEdit,
  onHighlight,
  canvasMode
}: {
  change: MergeChange;
  field: FieldDiff;
  onChoose: (side: MergeSide) => void;
  onBeginEdit: () => void;
  onEdit: (side: MergeSide, value: string) => void;
  onHighlight: (side?: 'from' | 'to') => void;
  canvasMode: 'comparison' | 'from' | 'to';
}) {
  const jsonComparator = buildJsonComparator(field);
  const isLayoutField = field.category === 'layout';
  const isPresenceField = field.target === 'node';

  return (
    <article className="field-card">
      <div className="field-header">
        <div>
          <p className="field-category">{field.category}</p>
          <h3>{field.label}</h3>
        </div>
        <div data-tour="field-actions" className="field-actions">
          <button
            type="button"
            className={field.selectedSide === 'from' ? 'selected' : ''}
            onClick={(event) => {
              event.stopPropagation();
              onChoose('from');
            }}
          >
            Use from
          </button>
          <button
            type="button"
            className={field.selectedSide === 'to' ? 'selected' : ''}
            onClick={(event) => {
              event.stopPropagation();
              onChoose('to');
            }}
          >
            Use to
          </button>
        </div>
      </div>

      {jsonComparator ? (
        <JsonComparatorPane
          rows={jsonComparator}
          fromText={formatJsonLike(field.editedFromValue ?? field.fromValue) ?? 'Not present'}
          toText={formatJsonLike(field.editedToValue ?? field.toValue) ?? 'Not present'}
          canvasMode={canvasMode}
          onBeginEdit={onBeginEdit}
          onEdit={onEdit}
          onPreview={onHighlight}
        />
      ) : isLayoutField ? (
        <div className="layout-summary">
          <p>This change is already highlighted on the diagram. Choose which side's path or placement to keep.</p>
          <div className="layout-columns">
            <section className="summary-pane">
              <header>
                <span>From</span>
                <button data-tour="preview-button" type="button" onClick={() => onHighlight('from')}>
                  {canvasMode === 'from' ? 'Close preview' : 'Preview'}
                </button>
              </header>
              <ul>
                {splitSummary(field.fromValue).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
            <section className="summary-pane">
              <header>
                <span>To</span>
                <button type="button" onClick={() => onHighlight('to')}>
                  {canvasMode === 'to' ? 'Close preview' : 'Preview'}
                </button>
              </header>
              <ul>
                {splitSummary(field.toValue).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      ) : isPresenceField ? (
        <div className="layout-summary">
          <div className="layout-columns">
            <section className="summary-pane">
              <header>
                <span>From</span>
                <button data-tour="preview-button" type="button" onClick={() => onHighlight('from')}>
                  {canvasMode === 'from' ? 'Close preview' : 'Preview'}
                </button>
              </header>
              <ul>
                {splitSummary(field.fromValue).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
            <section className="summary-pane">
              <header>
                <span>To</span>
                <button type="button" onClick={() => onHighlight('to')}>
                  {canvasMode === 'to' ? 'Close preview' : 'Preview'}
                </button>
              </header>
              <ul>
                {splitSummary(field.toValue).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      ) : (
        <div className="comparator">
          <section className="compare-pane compare-from">
            <header>
              <span>From</span>
              <button type="button" onClick={() => onHighlight('from')}>
                {canvasMode === 'from' ? 'Close preview' : 'Preview'}
              </button>
            </header>
            <pre>{prettyValue(field.fromValue)}</pre>
          </section>
          <section className="compare-pane compare-to">
            <header>
              <span>To</span>
              <button type="button" onClick={() => onHighlight('to')}>
                {canvasMode === 'to' ? 'Close preview' : 'Preview'}
              </button>
            </header>
            <pre>{prettyValue(field.toValue)}</pre>
          </section>
        </div>
      )}

      {(change.kind === 'added' || change.kind === 'removed') && (
        <p className="field-note">
          This element exists on only one side, so your element-level choice controls whether it ends up in
          the output BPMN.
        </p>
      )}
    </article>
  );
}

function JsonComparatorPane({
  rows,
  fromText,
  toText,
  canvasMode,
  onBeginEdit,
  onEdit,
  onPreview
}: {
  rows: DiffRow[];
  fromText: string;
  toText: string;
  canvasMode: 'comparison' | 'from' | 'to';
  onBeginEdit: () => void;
  onEdit: (side: MergeSide, value: string) => void;
  onPreview: (side?: 'from' | 'to') => void;
}) {
  const fromRef = useRef<HTMLDivElement | null>(null);
  const toRef = useRef<HTMLDivElement | null>(null);
  const syncingRef = useRef(false);
  const [editingSide, setEditingSide] = useState<MergeSide | null>(null);

  function toggleEditing(side: MergeSide) {
    setEditingSide((current) => {
      if (current === side) {
        return null;
      }

      onBeginEdit();
      return side;
    });
  }

  function syncScroll(source: 'from' | 'to') {
    if (syncingRef.current) {
      return;
    }

    const sourceRef = source === 'from' ? fromRef.current : toRef.current;
    const targetRef = source === 'from' ? toRef.current : fromRef.current;

    if (!sourceRef || !targetRef) {
      return;
    }

    syncingRef.current = true;
    targetRef.scrollTop = sourceRef.scrollTop;
    targetRef.scrollLeft = sourceRef.scrollLeft;
    window.requestAnimationFrame(() => {
      syncingRef.current = false;
    });
  }

  return (
    <div className="json-comparator">
      <section className="compare-pane compare-from">
        <header>
          <span>From</span>
          <div className="pane-actions">
            <button data-tour="edit-json-button" type="button" onClick={() => toggleEditing('from')}>
              {editingSide === 'from' ? 'Done' : 'Edit'}
            </button>
            <button data-tour="preview-button" type="button" onClick={() => onPreview('from')}>
              {canvasMode === 'from' ? 'Close preview' : 'Preview'}
            </button>
          </div>
        </header>
        {editingSide === 'from' ? (
          <textarea
            className="json-edit-input"
            value={fromText}
            onChange={(event) => onEdit('from', event.target.value)}
            spellCheck={false}
          />
        ) : (
          <div ref={fromRef} className="json-diff-pane" onScroll={() => syncScroll('from')}>
            {rows.map((row, index) => (
              <div key={`from-${index}`} className={`json-diff-row row-${row.fromKind}`}>
                <span className="json-line-no">{row.fromLineNumber ?? ''}</span>
                <code>{row.fromText || ' '}</code>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="compare-pane compare-to">
        <header>
          <span>To</span>
          <div className="pane-actions">
            <button type="button" onClick={() => toggleEditing('to')}>
              {editingSide === 'to' ? 'Done' : 'Edit'}
            </button>
            <button type="button" onClick={() => onPreview('to')}>
              {canvasMode === 'to' ? 'Close preview' : 'Preview'}
            </button>
          </div>
        </header>
        {editingSide === 'to' ? (
          <textarea
            className="json-edit-input"
            value={toText}
            onChange={(event) => onEdit('to', event.target.value)}
            spellCheck={false}
          />
        ) : (
          <div ref={toRef} className="json-diff-pane" onScroll={() => syncScroll('to')}>
            {rows.map((row, index) => (
              <div key={`to-${index}`} className={`json-diff-row row-${row.toKind}`}>
                <span className="json-line-no">{row.toLineNumber ?? ''}</span>
                <code>{row.toText || ' '}</code>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
