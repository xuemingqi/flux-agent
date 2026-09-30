export type BackendMessage = { type: 'ready'; url: string } | { type: 'choose-directory'; id: string };

export type HostMessage =
  { type: 'shutdown' } | { type: 'directory-chosen'; id: string; path: string | null; failed?: boolean };
