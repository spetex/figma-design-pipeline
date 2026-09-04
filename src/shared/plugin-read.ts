export const MAX_PLUGIN_READ_DEPTH = 20;
export const MAX_PLUGIN_READ_RESULTS = 1_000;

export type InspectionSource = "auto" | "plugin" | "rest";
export type PluginReadRoot = "node" | "current-page" | "selection";
export type PluginReadOperation = "tree" | "find" | "components";

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
  children: PluginReadNode[];
}

export interface PluginComponentNode {
  id: string;
  name: string;
  type: "COMPONENT" | "COMPONENT_SET";
  key?: string;
  description?: string;
  componentSetId?: string;
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
  traversalDepth: number;
  resultLimit: number;
  currentPage: { id: string; name: string };
  selection: Array<{ id: string; name: string; type: string }>;
  error?: string;
}
