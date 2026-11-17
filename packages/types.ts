export type ChatStatus =
  | 'idle'
  | 'running'
  | 'queued'
  | 'waiting_approval'
  | 'waiting_input'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'interrupted';
export interface Chat {
  id: string;
  nativeId?: string;
  title: string;
  cwd: string;
  model: string | null;
  status: ChatStatus;
  turnId: string | null;
  createdAt: number;
  updatedAt: number;
  error: string | null;
}
export interface Entry {
  id: string;
  chatId: string;
  turnId: string | null;
  kind: 'user' | 'assistant' | 'tool' | 'change' | 'info';
  title: string;
  text: string;
  status: string;
  createdAt: number;
  order?: number;
}
export interface PendingRequest {
  id: string;
  chatId: string;
  turnId: string | null;
  method: string;
  kind: 'approval' | 'question';
  prompt: string;
  params: Record<string, any>;
  status: 'pending' | 'resolved' | 'expired';
  createdAt: number;
}
export interface HostInfo {
  id: string;
  name: string;
  version: string;
}
export interface Snapshot {
  host: HostInfo;
  chats: Chat[];
  requests: PendingRequest[];
  cursor: number;
  ready: boolean;
  error: string | null;
}
export interface SavedHost {
  name: string;
  url: string;
}
export interface PocketEvent {
  seq: number;
  type: string;
  chatId: string | null;
  data: any;
}
