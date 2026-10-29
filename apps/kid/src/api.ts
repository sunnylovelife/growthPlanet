export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await fetch(path, { ...init, headers, credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || "请求失败");
  return data as T;
}

export function track(type: string, props?: Record<string, unknown>) {
  const event = { clientEventId: crypto.randomUUID(), type, page: location.pathname, props, clientTs: new Date().toISOString() };
  const raw = sessionStorage.getItem("gp-events");
  const queue = raw ? JSON.parse(raw) as unknown[] : [];
  queue.push(event);
  sessionStorage.setItem("gp-events", JSON.stringify(queue.slice(-40)));
}

export async function flushEvents() {
  const raw = sessionStorage.getItem("gp-events");
  if (!raw) return;
  const events = JSON.parse(raw) as unknown[];
  if (!events.length) return;
  sessionStorage.removeItem("gp-events");
  try {
    await api("/api/events", { method: "POST", body: JSON.stringify({ events }) });
  } catch {
    sessionStorage.setItem("gp-events", JSON.stringify(events));
  }
}
