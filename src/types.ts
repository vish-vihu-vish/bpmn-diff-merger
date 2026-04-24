export type MergeSide = 'from' | 'to';

export type ChangeKind = 'added' | 'removed' | 'changed' | 'layoutChanged';

export type DiagramKind = 'bpmn' | 'dmn' | 'unknown';

export type FieldCategory = 'property' | 'input' | 'output' | 'layout' | 'xml';

export type FieldTarget = 'attribute' | 'text' | 'node' | 'layout';

export interface FieldPathSegment {
  tag: string;
  index: number;
  matchAttribute?: string;
  matchValue?: string;
}

export interface FieldDiff {
  key: string;
  label: string;
  category: FieldCategory;
  target: FieldTarget;
  path: FieldPathSegment[];
  attributeName?: string;
  fromValue: string | null;
  toValue: string | null;
  editedFromValue?: string | null;
  editedToValue?: string | null;
  selectedSide: MergeSide | null;
}

export interface MergeChange {
  id: string;
  kind: ChangeKind;
  elementType: string;
  label: string;
  summary: string;
  selectedSide: MergeSide | null;
  fieldDiffs: FieldDiff[];
}

export interface BpmnComparisonResult {
  changes: MergeChange[];
  comparisonXml: string;
}
