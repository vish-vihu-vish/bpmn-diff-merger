import type {
  BpmnComparisonResult,
  ChangeKind,
  DiagramKind,
  FieldCategory,
  FieldDiff,
  FieldPathSegment,
  MergeChange
} from './types';

const BPMN_NS = 'http://www.omg.org/spec/BPMN/20100524/MODEL';
const BPMNDI_NS = 'http://www.omg.org/spec/BPMN/20100524/DI';
const parser = new DOMParser();
const serializer = new XMLSerializer();
const IGNORED_CHILDREN = new Set(['incoming', 'outgoing']);
const IDENTIFIER_ATTRIBUTES = ['name', 'target', 'source', 'key'];
const REFERENCE_ATTRIBUTES = new Set(['default', 'sourceRef', 'targetRef']);
const STYLE_ATTRIBUTES = new Set([
  'bioc:stroke',
  'bioc:fill',
  'color:background-color',
  'color:border-color'
]);

type ChildDescriptor = {
  child: Element;
  segment: FieldPathSegment;
  key: string;
};

function parseXml(xml: string): XMLDocument {
  return parser.parseFromString(xml, 'text/xml');
}

function getParseError(doc: XMLDocument): string | null {
  return doc.querySelector('parsererror')?.textContent ?? null;
}

function qName(node: Element | Attr): string {
  return node.prefix ? `${node.prefix}:${node.localName}` : node.localName;
}

function normalizeValue(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function getPrimaryProcessOrCollaboration(definitions: Element): Element | null {
  return (
    definitions.getElementsByTagNameNS(BPMN_NS, 'process')[0] ??
    definitions.getElementsByTagNameNS(BPMN_NS, 'collaboration')[0] ??
    null
  );
}

function getPlane(definitions: Element): Element | null {
  return definitions.getElementsByTagNameNS(BPMNDI_NS, 'BPMNPlane')[0] ?? null;
}

function getSemanticElements(parent: Element | null): Element[] {
  if (!parent) {
    return [];
  }

  return Array.from(parent.children).filter((child) => {
    return child.namespaceURI === BPMN_NS && child.hasAttribute('id');
  });
}

function getSemanticIndex(doc: XMLDocument): Map<string, Element> {
  return new Map(
    getSemanticElements(getPrimaryProcessOrCollaboration(doc.documentElement)).map((element) => [
      element.getAttribute('id')!,
      element
    ])
  );
}

function friendlyType(node: Element): string {
  return qName(node).replace(/^.*:/, '').replace(/([A-Z])/g, ' $1').trim();
}

function getElementDisplayName(index: Map<string, Element>, id: string | null): string {
  if (!id) {
    return 'Not connected';
  }

  const element = index.get(id);
  if (!element) {
    return id;
  }

  if (element.localName === 'sequenceFlow') {
    return describeFlowReference(index, id);
  }

  return element.getAttribute('name') ?? element.getAttribute('id') ?? id;
}

function describeFlowReference(index: Map<string, Element>, flowId: string | null): string {
  if (!flowId) {
    return 'No default flow';
  }

  const flow = index.get(flowId);
  if (!flow) {
    return flowId;
  }

  const source = getElementDisplayName(index, flow.getAttribute('sourceRef'));
  const target = getElementDisplayName(index, flow.getAttribute('targetRef'));
  return `${source} -> ${target}`;
}

function summarizeNode(node: Element | null): string | null {
  if (!node) {
    return null;
  }

  const lines = [friendlyType(node)];
  const attributes = Array.from(node.attributes)
    .filter((attr) => !attr.name.startsWith('xmlns:') && attr.name !== 'id')
    .map((attr) => `${attr.name}: ${attr.value}`);

  lines.push(...attributes);

  const text = getDirectText(node);
  if (text) {
    lines.push(`value: ${text}`);
  }

  return lines.join('\n');
}

function getComparableChildren(node: Element): ChildDescriptor[] {
  const descriptors: ChildDescriptor[] = [];
  const counters = new Map<string, number>();

  for (const child of Array.from(node.children)) {
    if (child.namespaceURI === BPMN_NS && IGNORED_CHILDREN.has(child.localName)) {
      continue;
    }

    const tag = qName(child);
    const matchAttribute = IDENTIFIER_ATTRIBUTES.find((name) => child.hasAttribute(name));
    const matchValue = matchAttribute ? child.getAttribute(matchAttribute) ?? undefined : undefined;
    const counterKey = matchAttribute ? `${tag}|${matchAttribute}|${matchValue}` : tag;
    const index = matchAttribute ? 0 : (counters.get(counterKey) ?? 0);
    counters.set(counterKey, index + 1);

    const segment: FieldPathSegment = {
      tag,
      index,
      ...(matchAttribute ? { matchAttribute } : {}),
      ...(matchValue ? { matchValue } : {})
    };

    descriptors.push({
      child,
      segment,
      key: segmentKey(segment)
    });
  }

  return descriptors;
}

function segmentKey(segment: FieldPathSegment): string {
  return [
    segment.tag,
    segment.matchAttribute ?? '',
    segment.matchValue ?? '',
    String(segment.index)
  ].join('|');
}

function pathKey(path: FieldPathSegment[]): string {
  return path.map(segmentKey).join('>');
}

function segmentLabel(segment: FieldPathSegment): string {
  const base = segment.tag.replace(/^.*:/, '').replace(/([A-Z])/g, ' $1').trim();
  if (segment.matchAttribute && segment.matchValue) {
    return `${base} (${segment.matchValue})`;
  }
  return base;
}

function buildFieldLabel(
  path: FieldPathSegment[],
  target: FieldDiff['target'],
  attributeName?: string
): string {
  const base = path.map(segmentLabel).join(' / ') || 'Element';
  if (target === 'layout') {
    return 'Diagram layout';
  }
  if (target === 'attribute' && attributeName) {
    return `${base} / ${attributeName.replace(/^.*:/, '')}`;
  }
  if (target === 'text') {
    return `${base} / value`;
  }
  return base;
}

function fieldLabelForReference(attributeName: string): string {
  switch (attributeName) {
    case 'sourceRef':
      return 'Flow start';
    case 'targetRef':
      return 'Flow end';
    case 'default':
      return 'Default path';
    default:
      return attributeName;
  }
}

function inferCategory(path: FieldPathSegment[], target: FieldDiff['target']): FieldCategory {
  if (target === 'layout') {
    return 'layout';
  }

  const joined = path.map((segment) => segment.tag.toLowerCase()).join('/');
  if (joined.includes('input')) {
    return 'input';
  }
  if (joined.includes('output')) {
    return 'output';
  }
  if (target === 'node') {
    return 'xml';
  }
  return 'property';
}

function getDirectText(element: Element): string | null {
  const parts = Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE)
    .map((node) => node.textContent ?? '')
    .join('');

  return normalizeValue(parts);
}

function buildNodeField(
  path: FieldPathSegment[],
  fromNode: Element | null,
  toNode: Element | null
): FieldDiff {
  return {
    key: `node:${pathKey(path) || '__element__'}`,
    label: buildFieldLabel(path, 'node'),
    category: inferCategory(path, 'node'),
    target: 'node',
    path,
    fromValue: summarizeNode(fromNode),
    toValue: summarizeNode(toNode),
    selectedSide: null
  };
}

function compareReferenceAttributes(
  fromNode: Element,
  toNode: Element,
  path: FieldPathSegment[],
  fromIndex: Map<string, Element>,
  toIndex: Map<string, Element>
): FieldDiff[] {
  const diffs: FieldDiff[] = [];

  for (const attributeName of REFERENCE_ATTRIBUTES) {
    const rawFromValue = normalizeValue(fromNode.getAttribute(attributeName));
    const rawToValue = normalizeValue(toNode.getAttribute(attributeName));

    let fromValue = rawFromValue;
    let toValue = rawToValue;

    if (attributeName === 'default') {
      fromValue = describeFlowReference(fromIndex, rawFromValue);
      toValue = describeFlowReference(toIndex, rawToValue);
    } else if (attributeName === 'sourceRef' || attributeName === 'targetRef') {
      fromValue = getElementDisplayName(fromIndex, rawFromValue);
      toValue = getElementDisplayName(toIndex, rawToValue);
    }

    if (fromValue === toValue) {
      continue;
    }

    diffs.push({
      key: `ref:${pathKey(path)}:${attributeName}`,
      label: `${buildFieldLabel(path, 'attribute')} / ${fieldLabelForReference(attributeName)}`,
      category: fromNode.localName === 'sequenceFlow' ? 'layout' : 'property',
      target: 'attribute',
      path,
      attributeName,
      fromValue,
      toValue,
      selectedSide: null
    });
  }

  return diffs;
}

function compareFields(
  fromNode: Element,
  toNode: Element,
  fromIndex: Map<string, Element>,
  toIndex: Map<string, Element>,
  path: FieldPathSegment[] = []
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const allAttributeNames = new Set<string>();

  for (const attr of Array.from(fromNode.attributes)) {
    if (attr.name !== 'id') {
      allAttributeNames.add(qName(attr));
    }
  }

  for (const attr of Array.from(toNode.attributes)) {
    if (attr.name !== 'id') {
      allAttributeNames.add(qName(attr));
    }
  }

  diffs.push(...compareReferenceAttributes(fromNode, toNode, path, fromIndex, toIndex));

  for (const attributeName of allAttributeNames) {
    if (REFERENCE_ATTRIBUTES.has(attributeName)) {
      continue;
    }

    const fromValue = normalizeValue(fromNode.getAttribute(attributeName));
    const toValue = normalizeValue(toNode.getAttribute(attributeName));

    if (fromValue === toValue) {
      continue;
    }

    diffs.push({
      key: `attr:${pathKey(path)}:${attributeName}`,
      label: buildFieldLabel(path, 'attribute', attributeName),
      category: inferCategory(path, 'attribute'),
      target: 'attribute',
      path,
      attributeName,
      fromValue,
      toValue,
      selectedSide: null
    });
  }

  const fromText = getDirectText(fromNode);
  const toText = getDirectText(toNode);
  if (fromText !== toText) {
    diffs.push({
      key: `text:${pathKey(path)}`,
      label: buildFieldLabel(path, 'text'),
      category: inferCategory(path, 'text'),
      target: 'text',
      path,
      fromValue: fromText,
      toValue: toText,
      selectedSide: null
    });
  }

  const fromChildren = new Map(getComparableChildren(fromNode).map((entry) => [entry.key, entry]));
  const toChildren = new Map(getComparableChildren(toNode).map((entry) => [entry.key, entry]));
  const childKeys = new Set([...fromChildren.keys(), ...toChildren.keys()]);

  for (const key of childKeys) {
    const fromChild = fromChildren.get(key);
    const toChild = toChildren.get(key);
    const nextPath = [...path, (fromChild ?? toChild)!.segment];

    if (!fromChild || !toChild) {
      diffs.push(buildNodeField(nextPath, fromChild?.child ?? null, toChild?.child ?? null));
      continue;
    }

    diffs.push(...compareFields(fromChild.child, toChild.child, fromIndex, toIndex, nextPath));
  }

  return diffs;
}

function getDiEntries(doc: XMLDocument, id: string): Element[] {
  const plane = getPlane(doc.documentElement);
  if (!plane) {
    return [];
  }

  return Array.from(plane.children).filter((child) => child.getAttribute('bpmnElement') === id);
}

function summarizeDiEntries(entries: Element[]): string | null {
  if (!entries.length) {
    return null;
  }

  const lines: string[] = [];

  for (const entry of entries) {
    if (entry.localName === 'BPMNShape') {
      const bounds = entry.getElementsByTagNameNS('*', 'Bounds')[0];
      if (bounds) {
        lines.push(
          `position: x=${bounds.getAttribute('x')}, y=${bounds.getAttribute('y')}, width=${bounds.getAttribute('width')}, height=${bounds.getAttribute('height')}`
        );
      }
    }

    if (entry.localName === 'BPMNEdge') {
      const points = Array.from(entry.getElementsByTagNameNS('*', 'waypoint')).map(
        (point) => `(${point.getAttribute('x')}, ${point.getAttribute('y')})`
      );
      if (points.length) {
        lines.push(`path: ${points.join(' -> ')}`);
      }
    }

    const styleBits = Array.from(entry.attributes)
      .filter((attribute) => STYLE_ATTRIBUTES.has(qName(attribute)))
      .map((attribute) => `${attribute.name}: ${attribute.value}`);

    lines.push(...styleBits);
  }

  return lines.join('\n') || 'Diagram styling changed';
}

function getBounds(entries: Element[]) {
  const shape = entries.find((entry) => entry.localName === 'BPMNShape');
  const bounds = shape?.getElementsByTagNameNS('*', 'Bounds')[0];

  if (!bounds) {
    return null;
  }

  return {
    x: Number(bounds.getAttribute('x') ?? 0),
    y: Number(bounds.getAttribute('y') ?? 0),
    width: Number(bounds.getAttribute('width') ?? 0),
    height: Number(bounds.getAttribute('height') ?? 0)
  };
}

function getWaypoints(entries: Element[]) {
  const edge = entries.find((entry) => entry.localName === 'BPMNEdge');
  if (!edge) {
    return [];
  }

  return Array.from(edge.getElementsByTagNameNS('*', 'waypoint')).map((point) => ({
    x: Number(point.getAttribute('x') ?? 0),
    y: Number(point.getAttribute('y') ?? 0)
  }));
}

function describeDirection(delta: number, positive: string, negative: string) {
  if (delta === 0) {
    return null;
  }

  return `${Math.abs(delta)}px ${delta > 0 ? positive : negative}`;
}

function describeLayoutAgainstOther(currentEntries: Element[], otherEntries: Element[], side: 'from' | 'to') {
  const lines: string[] = [];
  const currentBounds = getBounds(currentEntries);
  const otherBounds = getBounds(otherEntries);

  if (currentBounds && otherBounds) {
    const horizontal = describeDirection(
      currentBounds.x - otherBounds.x,
      'more to the right',
      'more to the left'
    );
    const vertical = describeDirection(
      currentBounds.y - otherBounds.y,
      'lower on the canvas',
      'higher on the canvas'
    );
    const width = describeDirection(currentBounds.width - otherBounds.width, 'wider', 'narrower');
    const height = describeDirection(currentBounds.height - otherBounds.height, 'taller', 'shorter');

    lines.push(
      side === 'from'
        ? 'Source placement preview'
        : 'Target placement preview'
    );

    if (horizontal) {
      lines.push(horizontal);
    }
    if (vertical) {
      lines.push(vertical);
    }
    if (width) {
      lines.push(width);
    }
    if (height) {
      lines.push(height);
    }
    if (!horizontal && !vertical && !width && !height) {
      lines.push('Same position and size');
    }
  }

  const currentWaypoints = getWaypoints(currentEntries);
  const otherWaypoints = getWaypoints(otherEntries);
  if (currentWaypoints.length || otherWaypoints.length) {
    if (JSON.stringify(currentWaypoints) !== JSON.stringify(otherWaypoints)) {
      lines.push(
        side === 'from'
          ? 'Uses the source connector path'
          : 'Uses the target connector path'
      );
    }
  }

  const currentSummary = summarizeDiEntries(currentEntries);
  const otherSummary = summarizeDiEntries(otherEntries);
  if (currentSummary !== otherSummary) {
    const currentStyles = currentSummary
      ?.split('\n')
      .filter((line) => line.includes('color') || line.includes('fill') || line.includes('stroke'));

    if (currentStyles?.length) {
      lines.push(...currentStyles);
    }
  }

  return lines.join('\n') || 'Layout preview available on canvas';
}

function compareLayout(id: string, fromDoc: XMLDocument, toDoc: XMLDocument): FieldDiff | null {
  const fromEntries = getDiEntries(fromDoc, id);
  const toEntries = getDiEntries(toDoc, id);
  const fromDi = describeLayoutAgainstOther(fromEntries, toEntries, 'from');
  const toDi = describeLayoutAgainstOther(toEntries, fromEntries, 'to');

  if (fromDi === toDi) {
    return null;
  }

  return {
    key: `layout:${id}`,
    label: 'Diagram layout',
    category: 'layout',
    target: 'layout',
    path: [],
    fromValue: normalizeValue(fromDi),
    toValue: normalizeValue(toDi),
    selectedSide: null
  };
}

function removeDiForId(doc: XMLDocument, id: string) {
  for (const entry of getDiEntries(doc, id)) {
    entry.remove();
  }
}

function upsertDiFromSource(targetDoc: XMLDocument, sourceDoc: XMLDocument, id: string) {
  const targetPlane = getPlane(targetDoc.documentElement);
  const sourceEntries = getDiEntries(sourceDoc, id);

  if (!targetPlane) {
    return;
  }

  removeDiForId(targetDoc, id);
  for (const entry of sourceEntries) {
    targetPlane.appendChild(entry.cloneNode(true));
  }
}

function removeSemanticElement(doc: XMLDocument, id: string) {
  const process = getPrimaryProcessOrCollaboration(doc.documentElement);
  if (!process) {
    return;
  }

  for (const child of Array.from(process.children)) {
    if (child.getAttribute('id') === id) {
      child.remove();
    }
  }

  removeDiForId(doc, id);
}

function removeDanglingSequenceFlows(doc: XMLDocument) {
  let removed = true;

  while (removed) {
    removed = false;
    const index = getSemanticIndex(doc);

    for (const element of index.values()) {
      if (element.localName !== 'sequenceFlow') {
        continue;
      }

      const sourceRef = element.getAttribute('sourceRef');
      const targetRef = element.getAttribute('targetRef');

      if (!sourceRef || !targetRef || !index.has(sourceRef) || !index.has(targetRef)) {
        removeSemanticElement(doc, element.getAttribute('id')!);
        removed = true;
      }
    }
  }
}

function replaceSemanticElement(targetDoc: XMLDocument, sourceDoc: XMLDocument, id: string) {
  const targetProcess = getPrimaryProcessOrCollaboration(targetDoc.documentElement);
  const sourceElement = getSemanticIndex(sourceDoc).get(id);

  if (!targetProcess || !sourceElement) {
    return;
  }

  const targetElement = getSemanticIndex(targetDoc).get(id);
  const sourceClone = sourceElement.cloneNode(true);

  if (targetElement) {
    targetElement.replaceWith(sourceClone);
  } else {
    targetProcess.appendChild(sourceClone);
  }

  upsertDiFromSource(targetDoc, sourceDoc, id);
}

function findNodeByPath(root: Element, path: FieldPathSegment[]): Element | null {
  let current: Element | null = root;

  for (const segment of path) {
    if (!current) {
      return null;
    }

    current =
      getComparableChildren(current).find((entry) => segmentKey(entry.segment) === segmentKey(segment))
        ?.child ?? null;
  }

  return current;
}

function ensureNodeByPath(targetRoot: Element, sourceRoot: Element, path: FieldPathSegment[]): Element | null {
  let targetCurrent: Element | null = targetRoot;
  let sourceCurrent: Element | null = sourceRoot;

  for (const segment of path) {
    if (!targetCurrent || !sourceCurrent) {
      return null;
    }

    const sourceDescriptor: ChildDescriptor | undefined = getComparableChildren(sourceCurrent).find(
      (entry) => segmentKey(entry.segment) === segmentKey(segment)
    );
    const targetDescriptor: ChildDescriptor | undefined = getComparableChildren(targetCurrent).find(
      (entry) => segmentKey(entry.segment) === segmentKey(segment)
    );

    if (!targetDescriptor && sourceDescriptor) {
      targetCurrent.appendChild(sourceDescriptor.child.cloneNode(true));
    }

    targetCurrent =
      getComparableChildren(targetCurrent).find((entry) => segmentKey(entry.segment) === segmentKey(segment))
        ?.child ?? null;
    sourceCurrent = sourceDescriptor?.child ?? null;
  }

  return targetCurrent;
}

function upsertNodeAtPath(targetRoot: Element, sourceRoot: Element, path: FieldPathSegment[]) {
  const parentPath = path.slice(0, -1);
  const targetParent = ensureNodeByPath(targetRoot, sourceRoot, parentPath);
  const sourceParent = findNodeByPath(sourceRoot, parentPath);
  const targetSegment = path[path.length - 1];

  if (!targetParent || !sourceParent || !targetSegment) {
    return;
  }

  const sourceNode = getComparableChildren(sourceParent).find(
    (entry) => segmentKey(entry.segment) === segmentKey(targetSegment)
  )?.child;

  if (!sourceNode) {
    return;
  }

  const targetNode = getComparableChildren(targetParent).find(
    (entry) => segmentKey(entry.segment) === segmentKey(targetSegment)
  )?.child;

  if (targetNode) {
    targetNode.replaceWith(sourceNode.cloneNode(true));
  } else {
    targetParent.appendChild(sourceNode.cloneNode(true));
  }
}

function removeNodeAtPath(targetRoot: Element, path: FieldPathSegment[]) {
  const parentPath = path.slice(0, -1);
  const parent = parentPath.length ? findNodeByPath(targetRoot, parentPath) : targetRoot;
  const segment = path[path.length - 1];

  if (!parent || !segment) {
    return;
  }

  const node = getComparableChildren(parent).find(
    (entry) => segmentKey(entry.segment) === segmentKey(segment)
  )?.child;
  node?.remove();
}

function applyFieldChange(
  mergedDoc: XMLDocument,
  fromDoc: XMLDocument,
  toDoc: XMLDocument,
  change: MergeChange,
  field: FieldDiff
) {
  if (!field.selectedSide) {
    return;
  }

  const selectedValue =
    field.selectedSide === 'from'
      ? (field.editedFromValue ?? field.fromValue)
      : (field.editedToValue ?? field.toValue);

  if (field.target === 'layout') {
    const sourceDoc = field.selectedSide === 'from' ? fromDoc : toDoc;
    upsertDiFromSource(mergedDoc, sourceDoc, change.id);
    return;
  }

  const mergedElement = getSemanticIndex(mergedDoc).get(change.id);
  const sourceElement = getSemanticIndex(field.selectedSide === 'from' ? fromDoc : toDoc).get(change.id);

  if (!mergedElement || !sourceElement) {
    return;
  }

  if (field.target === 'node') {
    const sourceNode = field.path.length ? findNodeByPath(sourceElement, field.path) : sourceElement;
    if (sourceNode) {
      if (!field.path.length) {
        replaceSemanticElement(mergedDoc, field.selectedSide === 'from' ? fromDoc : toDoc, change.id);
      } else {
        upsertNodeAtPath(mergedElement, sourceElement, field.path);
      }
    } else if (field.path.length) {
      removeNodeAtPath(mergedElement, field.path);
    }
    return;
  }

  const targetNode = ensureNodeByPath(mergedElement, sourceElement, field.path);

  if (!targetNode) {
    return;
  }

  if (field.target === 'attribute' && field.attributeName) {
    if (selectedValue === null || selectedValue === undefined) {
      targetNode.removeAttribute(field.attributeName);
    } else {
      targetNode.setAttribute(field.attributeName, selectedValue);
    }
    return;
  }

  if (field.target === 'text') {
    targetNode.textContent = selectedValue ?? '';
  }
}

function buildComparisonXml(fromDoc: XMLDocument, toDoc: XMLDocument): string {
  const comparisonDoc = parseXml(serializer.serializeToString(toDoc));
  const comparisonIndex = getSemanticIndex(comparisonDoc);
  const fromIndex = getSemanticIndex(fromDoc);

  for (const [id, element] of fromIndex.entries()) {
    if (comparisonIndex.has(id)) {
      continue;
    }

    const process = getPrimaryProcessOrCollaboration(comparisonDoc.documentElement);
    if (!process) {
      continue;
    }

    process.appendChild(element.cloneNode(true));
    upsertDiFromSource(comparisonDoc, fromDoc, id);
  }

  return serializer.serializeToString(comparisonDoc);
}

function applyResolvedChanges(
  mergedDoc: XMLDocument,
  fromDoc: XMLDocument,
  toDoc: XMLDocument,
  changes: MergeChange[]
) {
  for (const change of changes) {
    if (change.kind === 'added') {
      if (change.selectedSide === 'from') {
        removeSemanticElement(mergedDoc, change.id);
      }
      continue;
    }

    if (change.kind === 'removed') {
      if (change.selectedSide === 'from') {
        replaceSemanticElement(mergedDoc, fromDoc, change.id);
      } else if (change.selectedSide === 'to') {
        removeSemanticElement(mergedDoc, change.id);
      }
      continue;
    }

    for (const field of change.fieldDiffs) {
      applyFieldChange(mergedDoc, fromDoc, toDoc, change, field);
    }
  }

  removeDanglingSequenceFlows(mergedDoc);
}

function buildSummary(kind: ChangeKind, diffCount: number): string {
  if (kind === 'added') {
    return 'Exists only in the target BPMN.';
  }
  if (kind === 'removed') {
    return 'Exists only in the source BPMN.';
  }
  if (kind === 'layoutChanged') {
    return 'Only diagram layout changed.';
  }
  return `${diffCount} property changes detected.`;
}

export function detectDiagramKind(xml: string): DiagramKind {
  if (xml.includes('http://www.omg.org/spec/BPMN/20100524/MODEL')) {
    return 'bpmn';
  }

  if (xml.includes('https://www.omg.org/spec/DMN/')) {
    return 'dmn';
  }

  return 'unknown';
}

export function computeBpmnComparison(fromXml: string, toXml: string): BpmnComparisonResult {
  const fromDoc = parseXml(fromXml);
  const toDoc = parseXml(toXml);
  const fromError = getParseError(fromDoc);
  const toError = getParseError(toDoc);

  if (fromError) {
    throw new Error(`Unable to parse "from" BPMN XML: ${fromError}`);
  }

  if (toError) {
    throw new Error(`Unable to parse "to" BPMN XML: ${toError}`);
  }

  const fromIndex = getSemanticIndex(fromDoc);
  const toIndex = getSemanticIndex(toDoc);
  const ids = new Set([...fromIndex.keys(), ...toIndex.keys()]);
  const changes: MergeChange[] = [];

  for (const id of ids) {
    const fromElement = fromIndex.get(id) ?? null;
    const toElement = toIndex.get(id) ?? null;

    if (!toElement && fromElement) {
      changes.push({
        id,
        kind: 'removed',
        elementType: qName(fromElement),
        label: fromElement.getAttribute('name') ?? id,
        summary: buildSummary('removed', 1),
        selectedSide: null,
        fieldDiffs: [buildNodeField([], fromElement, null)]
      });
      continue;
    }

    if (!fromElement && toElement) {
      changes.push({
        id,
        kind: 'added',
        elementType: qName(toElement),
        label: toElement.getAttribute('name') ?? id,
        summary: buildSummary('added', 1),
        selectedSide: null,
        fieldDiffs: [buildNodeField([], null, toElement)]
      });
      continue;
    }

    if (!fromElement || !toElement) {
      continue;
    }

    const fieldDiffs = compareFields(fromElement, toElement, fromIndex, toIndex);
    const layoutDiff = compareLayout(id, fromDoc, toDoc);
    if (layoutDiff) {
      fieldDiffs.push(layoutDiff);
    }

    if (!fieldDiffs.length) {
      continue;
    }

    const kind: ChangeKind =
      fieldDiffs.length === 1 && fieldDiffs[0].target === 'layout' ? 'layoutChanged' : 'changed';

    changes.push({
      id,
      kind,
      elementType: qName(toElement),
      label: toElement.getAttribute('name') ?? fromElement.getAttribute('name') ?? id,
      summary: buildSummary(kind, fieldDiffs.length),
      selectedSide: null,
      fieldDiffs
    });
  }

  const order: Record<ChangeKind, number> = {
    changed: 0,
    removed: 1,
    added: 2,
    layoutChanged: 3
  };

  changes.sort((left, right) => {
    if (order[left.kind] !== order[right.kind]) {
      return order[left.kind] - order[right.kind];
    }
    return left.label.localeCompare(right.label);
  });

  return {
    changes,
    comparisonXml: buildComparisonXml(fromDoc, toDoc)
  };
}

export function buildPreviewBpmnXml(fromXml: string, toXml: string, changes: MergeChange[]): string {
  const fromDoc = parseXml(fromXml);
  const toDoc = parseXml(toXml);
  const previewDoc = parseXml(buildComparisonXml(fromDoc, toDoc));

  applyResolvedChanges(previewDoc, fromDoc, toDoc, changes);

  return serializer.serializeToString(previewDoc);
}

export function buildMergedBpmnXml(fromXml: string, toXml: string, changes: MergeChange[]): string {
  const fromDoc = parseXml(fromXml);
  const toDoc = parseXml(toXml);
  const mergedDoc = parseXml(toXml);

  applyResolvedChanges(mergedDoc, fromDoc, toDoc, changes);

  return serializer.serializeToString(mergedDoc);
}
