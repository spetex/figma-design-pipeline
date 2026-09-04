export const MAX_PLUGIN_READ_DEPTH = 20;
export const MAX_PLUGIN_READ_RESULTS = 1_000;
export const MAX_PLUGIN_READ_VISITS = 10_000;
export const MAX_PLUGIN_READ_SCALAR_BYTES = 4_000;
export const MAX_PLUGIN_SELECTION_METADATA = 100;

export type InspectionSource = "auto" | "plugin" | "rest";
export type PluginReadRoot = "node" | "current-page" | "selection";
export type PluginReadOperation = "tree" | "find" | "components";
export type PluginReadTruncationReason = "result_limit" | "scan_limit" | "scalar_field_limit";

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
  childCount: number;
  truncatedFields?: PluginTruncatedFields;
  children: PluginReadNode[];
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
