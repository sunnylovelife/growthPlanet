export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await fetch(path, { ...init, headers, credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || "请求失败");
  return data as T;
}

// crypto.randomUUID 只在 HTTPS / localhost 下存在，家里局域网用 http://IP 访问时没有
export function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function track(type: string, props?: Record<string, unknown>) {
  const event = { clientEventId: newId(), type, page: location.pathname, props, clientTs: new Date().toISOString() };
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
