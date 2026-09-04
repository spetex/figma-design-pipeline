export const MAX_PLUGIN_READ_DEPTH = 20;
export const MAX_PLUGIN_READ_RESULTS = 1_000;
export const MAX_PLUGIN_READ_VISITS = 10_000;
export const MAX_PLUGIN_READ_SCALAR_BYTES = 4_000;
export const MAX_PLUGIN_SELECTION_METADATA = 100;
/** Shared cap for all inspect payloads returned by one figma_execute batch. */
export const MAX_PLUGIN_BATCH_INSPECTION_BYTES = 80_000;

export type InspectionSource = "auto" | "plugin" | "rest";
export type PluginReadRoot = "node" | "current-page" | "selection";
export type PluginReadOperation = "tree" | "find" | "components";
export type PluginReadTruncationReason = "result_limit" | "scan_limit" | "scalar_field_limit" | "response_byte_limit";

export interface PluginScalarTruncation {
  originalBytes: number;
  returnedBytes: number;
}

export type PluginTruncatedFields = Record<string, PluginScalarTruncation>;

export interface PluginReadContextNode {
  id: string;
  name: string;
  type: string;
  truncatedFields?: PluginTruncatedFields;
}

export interface PluginSelectionMetadata {
  offset: number;
  returned: number;
  total: number;
  omitted: number;
  nextOffset?: number;
}

export interface PluginReadFilters {
  name?: string;
  namePattern?: string;
  type?: string;
  classification?: string;
  textContent?: string;
  componentId?: string;
  hasChildren?: boolean;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
}

export interface PluginReadRequest {
  type: "read_request";
  requestId: string;
  operation: PluginReadOperation;
  fileKey: string;
  root: PluginReadRoot;
  nodeId?: string;
  depth: number;
  limit: number;
  scanLimit: number;
  selectionMetadataOffset?: number;
  filters?: PluginReadFilters;
}

/** A symbol-free allowlist of node properties safe to cross the plugin bridge. */
export interface PluginReadNode {
  id: string;
  name: string;
  type: string;
  classification: string;
  depth: number;
  visible?: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  textContent?: string;
  componentId?: string;
  componentKey?: string;
  description?: string;
  componentSetId?: string;
  layoutMode?: "HORIZONTAL" | "VERTICAL" | "GRID" | "NONE";
  itemSpacing?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  opacity?: number;
  rotation?: number;
  cornerRadius?: number | "mixed";
  topLeftRadius?: number;
  topRightRadius?: number;
  bottomRightRadius?: number;
  bottomLeftRadius?: number;
  layoutWrap?: string;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  layoutSizingHorizontal?: string;
  layoutSizingVertical?: string;
  fillStyleId?: string;
  strokeStyleId?: string;
  textStyleId?: string;
  effectStyleId?: string;
  fills?: unknown;
  strokes?: unknown;
  effects?: unknown;
  componentProperties?: unknown;
  componentPropertyDefinitions?: unknown;
  componentPropertyReferences?: unknown;
  boundVariables?: unknown;
  resolvedVariableModes?: unknown;
  css?: Record<string, string>;
  childCount: number;
  truncatedFields?: PluginTruncatedFields;
  children: PluginReadNode[];
}

/** The bounded payload attached to a same-batch `inspect` action result. */
export interface PluginBatchInspection {
  root?: PluginReadNode;
  totalScanned: number;
  returnedCount: number;
  omittedNodeCount: number;
  truncated: boolean;
  truncationReasons: PluginReadTruncationReason[];
  traversalDepth: number;
  resultLimit: number;
  scanLimit: number;
  scanLimitReached: boolean;
  truncatedFieldCount: number;
  omittedScalarBytes: number;
  omittedPropertyCount: number;
  responseBytes: number;
  rolledBack?: boolean;
}

export interface PluginComponentNode {
  id: string;
  name: string;
  type: "COMPONENT" | "COMPONENT_SET";
  key?: string;
  description?: string;
  componentSetId?: string;
  truncatedFields?: PluginTruncatedFields;
}

export interface PluginReadResponse {
  type: "read_response";
  requestId: string;
  operation: PluginReadOperation;
  fileKey: string;
  success: boolean;
  roots: PluginReadNode[];
  matches: PluginReadNode[];
  components: PluginComponentNode[];
  totalScanned: number;
  returnedCount: number;
  totalNodeCount?: number;
  truncated: boolean;
  truncationReasons: PluginReadTruncationReason[];
  traversalDepth: number;
  resultLimit: number;
  scanLimit: number;
  scanLimitReached: boolean;
  truncatedFieldCount: number;
  omittedScalarBytes: number;
  currentPage: PluginReadContextNode;
  selection?: PluginReadContextNode[];
  selectionCount?: number;
  selectionMetadata?: PluginSelectionMetadata;
  error?: string;
}
