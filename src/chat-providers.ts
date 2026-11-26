import { useCallback, useEffect, useState } from "react";
import { post, request, type Peer } from "./api";
import type { AgentSession } from "./agent-sessions";

export type ChatProviderModel = {
  id: string;
  name: string;
  description?: string;
};

export type ChatProviderPreset = {
  id: string;
  name: string;
  kind: "api" | "local";
  protocol: "openai" | "anthropic";
  baseUrl: string;
  requiresKey: boolean;
  description: string;
};

export type ChatProvider = {
  id: string;
  preset: string;
  name: string;
  kind: "api" | "local";
  protocol: "openai" | "anthropic";
  baseUrl: string;
  hasKey: boolean;
  keyHint: string;
  requiresKey: boolean;
  fromEnv: boolean;
  autoDetected: boolean;
  configured: boolean;
  reachable: boolean | null;
  error: string;
  modelCount: number;
  models: ChatProviderModel[];
  defaultModel: string;
  description: string;
};

export type ChatProvidersResponse = {
  providers: ChatProvider[];
  presets: ChatProviderPreset[];
};

export function fetchChatProviders(peer: Peer, { refresh = false } = {}) {
  return request<ChatProvidersResponse>(
    peer,
    `/api/chat/providers${refresh ? "?refresh=1" : ""}`,
  );
}

export function saveChatProvider(
  peer: Peer,
  body: {
    id?: string;
    preset?: string;
    name?: string;
    kind?: "api" | "local";
    protocol?: "openai" | "anthropic";
    baseUrl: string;
    apiKey?: string;
    clearKey?: boolean;
    defaultModel?: string;
  },
) {
  return post<{ provider: ChatProvider }>(peer, "/api/chat/providers", body);
}

export function removeChatProvider(peer: Peer, id: string) {
  return request<{ removed: boolean }>(
    peer,
    `/api/chat/providers/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

export function testChatProvider(
  peer: Peer,
  body: {
    id?: string;
    preset?: string;
    protocol?: "openai" | "anthropic";
    baseUrl?: string;
    apiKey?: string;
  },
) {
  return post<{ ok: boolean; modelCount: number; models: ChatProviderModel[] }>(
    peer,
    "/api/chat/providers/test",
    body,
  );
}

export function startApiChat(
  peer: Peer,
  body: {
    providerId: string;
    model: string;
    text: string;
    images?: string[];
    systemPrompt?: string;
    temperature?: number;
    veniceWebSearch?: boolean;
  },
) {
  return post<{ threadId: string; turnId: null; session: AgentSession }>(
    peer,
    "/api/sessions",
    { agent: "api", ...body },
  );
}

export function useChatProviders(peer: Peer | null) {
  const [providers, setProviders] = useState<ChatProvider[]>([]);
  const [presets, setPresets] = useState<ChatProviderPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const key = peer ? `${peer.id}:${peer.url}:${peer.token}` : "";

  const reload = useCallback(
    async (refresh = false) => {
      if (!peer) return;
      setLoading(true);
      setError("");
      try {
        const res = await fetchChatProviders(peer, { refresh });
        setProviders(res.providers || []);
        setPresets(res.presets || []);
      } catch (e) {
        setError((e as Error).message || "Could not load chat providers.");
      } finally {
        setLoading(false);
      }
    },
    [key],
  );

  useEffect(() => {
    void reload(false);
  }, [reload]);

  return { providers, presets, loading, error, reload };
}
