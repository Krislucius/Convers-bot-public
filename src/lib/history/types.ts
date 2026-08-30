export type ChatProvider = "CHATGPT" | "GROK" | "GROK_BUILD" | "CLAUDE" | "UNKNOWN";

export type ImportMethod = "URL" | "FILE" | "PASTE";

export type AccessStatus =
  | "NOT_CHECKED"
  | "ACCESSIBLE"
  | "AUTH_REQUIRED"
  | "NOT_FOUND"
  | "UNSUPPORTED"
  | "FETCH_FAILED";

export type ImportStatus = "PENDING" | "IMPORTED" | "FAILED" | "ARCHIVED";

export type HistoryRole = "USER" | "ASSISTANT" | "SYSTEM" | "TOOL" | "UNKNOWN";

export type ChatSource = {
  id: string;
  projectId: string;
  provider: ChatProvider;
  title: string;
  sourceUrl: string | null;
  importMethod: ImportMethod;
  accessStatus: AccessStatus;
  importStatus: ImportStatus;
  rawContent: string;
  messageCount: number | null;
  characterCount: number;
  estimatedTokenCount: number | null;
  contentHash: string;
  createdAt: string;
  importedAt: string | null;
  lastAccessCheckAt: string | null;
  lastError: string | null;
  includeInMemory: boolean;
};

export type HistoryMessage = {
  id: string;
  chatSourceId: string;
  sequence: number;
  speaker: string;
  role: HistoryRole;
  content: string;
  timestamp: string | null;
};

export type ParsedTurn = {
  speaker: string;
  role: HistoryRole;
  content: string;
  timestamp: string | null;
};

export type AccessCheckResult = {
  ok: boolean;
  importAllowed: boolean;
  accessStatus: AccessStatus;
  provider: ChatProvider;
  requestedUrl: string;
  finalUrl: string;
  httpStatus: number | null;
  titleHint: string | null;
  message: string;
  lastError: string | null;
  detectedShare: boolean;
  fetchedBytes?: number | null;
  truncated?: boolean;
};

export type FetchedPage = {
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
  truncated: boolean;
  error?: string;
};

export type UrlFetcher = (url: string) => Promise<FetchedPage>;
