import { useEffect, useState } from "react";
import { api } from "./api";

interface Task {
  id: number;
  code: string;
  name: string;
  status: string;
  qualified: boolean | null;
  deadlineAt: string | null;
  rewardAmount: number;
  previewReward: number;
  completedAt: string | null;
  duplicatePhoto: boolean;
  photoPath: string | null;
}
interface ChildToday {
  id: number;
  nickname: string;
  display_role: string;
  balance: number;
  tasks: Task[];
}
const VIDEO_STATUS: Record<string, string> = {
  queued: "排队中",
  downloading: "下载中",
  processing: "转码中",
  ready: "可以播放",
  failed: "失败",
};

interface VideoProgress { phase: "opening" | "downloading" | "transcoding"; received: number; total: number | null; etaSeconds: number | null; speedBps: number }
interface VideoRow {
  id: number;
  title: string;
  status: string;
  error: string | null;
  published: number;
  duration_seconds: number;
  source_url: string | null;
  progress?: VideoProgress | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function etaText(seconds: number | null): string {
  if (seconds == null) return "正在估算剩余时间";
  if (seconds < 5) return "快好了";
  if (seconds < 60) return `大约还要 ${Math.round(seconds)} 秒`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 60 ? `大约还要 ${minutes} 分钟` : `大约还要 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

function progressLine(video: VideoRow): { text: string; percent: number | null } | null {
  const job = video.progress;
  if (video.status === "queued" && !job) return { text: "排队中，开始后会显示进度和剩余时间", percent: null };
  if (!job) return null;
  if (job.phase === "opening") return { text: "正在打开抖音页面，这一步大约 10–20 秒", percent: null };
  if (job.phase === "downloading") {
    if (job.total) {
      const percent = Math.min(100, Math.round(job.received / job.total * 100));
      return { text: `下载 ${percent}% · ${formatBytes(job.received)} / ${formatBytes(job.total)} · ${etaText(job.etaSeconds)}`, percent };
    }
    const speed = job.speedBps > 0 ? ` · ${formatBytes(job.speedBps)}/秒` : "";
    return { text: `已下载 ${formatBytes(job.received)}${speed}，总大小未知`, percent: null };
  }
  if (job.total && job.total > 0) {
    const percent = Math.min(99, Math.round(job.received / job.total * 100));
    return { text: `转码 ${percent}% · ${etaText(job.etaSeconds)}`, percent };
  }
  return { text: "正在转码，这一步按视频长度大约要几分钟", percent: null };
}
interface UserRow { id: number; username: string; role: string; displayRole: string; status: string; nickname?: string }

export function App() {
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState<"today" | "video" | "book" | "data" | "account">("today");
  const [error, setError] = useState("");
  const [children, setChildren] = useState<ChildToday[]>([]);
  const [approvals, setApprovals] = useState<(Task & { child: { nickname: string } })[]>([]);
  const [videos, setVideos] = useState<VideoRow[]>([]);
  const [share, setShare] = useState("");
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [progress, setProgress] = useState("");
  const [bookChild, setBookChild] = useState<number | null>(null);
  const [entries, setEntries] = useState<{ title: string; amount: number; balanceAfter: number; createdAt: string }[]>([]);
  const [money, setMoney] = useState({ title: "", amount: "", kind: "income", childIds: [] as number[] });
  const [stats, setStats] = useState<{ child: { nickname: string }; balance: number; earned: number; spent: number; watchCount: number; watchSeconds: number }[]>([]);
  const [events, setEvents] = useState<{ id: number; type: string; serverTs: string; props: string; userId: number }[]>([]);
  const [logs, setLogs] = useState<{ id: number; action: string; createdAt: string; detail: string }[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [deadlines, setDeadlines] = useState<Record<number, string>>({});

  async function loadToday() {
    const data = await api<{ children: ChildToday[]; approvals: (Task & { child: { nickname: string } })[] }>("/api/admin/today");
    setChildren(data.children);
    setApprovals(data.approvals);
    setBookChild((current) => current ?? data.children[0]?.id ?? null);
    const next: Record<number, string> = {};
    for (const child of data.children) for (const task of child.tasks) if (task.deadlineAt) next[task.id] = task.deadlineAt.slice(0, 16);
    setDeadlines(next);
  }

  const videoBusy = videos.some((video) => video.status === "queued" || video.status === "downloading" || video.status === "processing");
  useEffect(() => {
    if (!authed || tab !== "video" || !videoBusy) return;
    const timer = window.setInterval(() => {
      void api<{ videos: VideoRow[] }>("/api/admin/videos").then((res) => setVideos(res.videos)).catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [authed, tab, videoBusy]);

  useEffect(() => {
    api<{ user: { role: string } }>("/api/auth/me").then((res) => {
      if (res.user.role !== "parent") return;
      setAuthed(true);
      return loadToday();
    }).catch(() => setAuthed(false));
  }, []);

  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError("");
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username: form.get("username"), password: form.get("password"), portal: "admin" }) });
      setAuthed(true);
      await loadToday();
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    }
  }

  async function act(path: string, body?: unknown) {
    setError("");
    await api(path, { method: "POST", body: JSON.stringify(body ?? {}) });
    await loadToday();
  }

  async function upload(file: File) {
    const chunkSize = 5 * 1024 * 1024;
    const parts = Math.max(1, Math.ceil(file.size / chunkSize));
    const created = await api<{ id: string }>("/api/admin/uploads", { method: "POST", body: JSON.stringify({ filename: file.name, parts }) });
    for (let i = 0; i < parts; i++) {
      const blob = file.slice(i * chunkSize, (i + 1) * chunkSize);
      const res = await fetch(`/api/admin/uploads/${created.id}/chunks/${i}`, { method: "PUT", credentials: "include", headers: { "content-type": "application/octet-stream" }, body: blob });
      if (!res.ok) throw new Error("上传中断了");
      setProgress(`${Math.round(((i + 1) / parts) * 100)}%`);
    }
    await api(`/api/admin/uploads/${created.id}/finish`, { method: "POST", body: "{}" });
    setProgress("上传完成，转码好之后记得上架");
    setVideos((await api<{ videos: VideoRow[] }>("/api/admin/videos")).videos);
  }

  if (!authed) {
    return (
      <div className="login">
        <form onSubmit={login}>
          <h1>家长后台</h1>
          <p className="muted">确认作业、放视频、记账。</p>
          <input name="username" placeholder="用户名" autoCapitalize="none" />
          <input name="password" type="password" placeholder="密码" />
          {error && <p className="error">{error}</p>}
          <button className="primary" type="submit">登录</button>
        </form>
      </div>
    );
  }

  return (
    <div className="app">
      <h1>成长星球</h1>
      {error && <p className="error">{error}</p>}
      {tab === "today" && (
        <>
          <section className="card">
            <h2>其他奖励 / 花费</h2>
            <div className="row" style={{ marginTop: 8 }}>
              {children.map((child) => (
                <label key={child.id}><input type="checkbox" checked={money.childIds.includes(child.id)} onChange={(event) => setMoney({ ...money, childIds: event.target.checked ? [...money.childIds, child.id] : money.childIds.filter((id) => id !== child.id) })} /> {child.nickname}</label>
              ))}
            </div>
            <div className="row">
              <button className={money.kind === "income" ? "primary" : "ghost"} type="button" onClick={() => setMoney({ ...money, kind: "income" })}>奖励</button>
              <button className={money.kind === "expense" ? "primary" : "ghost"} type="button" onClick={() => setMoney({ ...money, kind: "expense" })}>花费</button>
            </div>
            <input placeholder="事项，比如帮忙做家务" value={money.title} onChange={(event) => setMoney({ ...money, title: event.target.value })} />
            <input placeholder="星币数量" inputMode="numeric" value={money.amount} onChange={(event) => setMoney({ ...money, amount: event.target.value })} />
            <button className="primary" onClick={() => act("/api/admin/ledger/other", { ...money, amount: Number(money.amount) }).then(() => setMoney({ ...money, title: "", amount: "" })).catch((err) => setError(err.message))}>记一笔</button>
          </section>
          {approvals.length > 0 && <h2 style={{ marginTop: 18 }}>孩子交来的照片</h2>}
          {approvals.map((task) => (
            <article className="card" key={task.id}>
              <h2>{task.child.nickname} · {task.name}</h2>
              {task.duplicatePhoto && <p className="error">这张照片以前交过</p>}
              <img className="photo" alt="作业" src={`/api/admin/tasks/${task.id}/photo`} />
              <div className="row">
                <button className="primary" onClick={() => act(`/api/admin/tasks/${task.id}/complete`).catch((err) => setError(err.message))}>确认完成</button>
              </div>
            </article>
          ))}
          {children.map((child) => (
            <section key={child.id}>
              <h2 style={{ marginTop: 18 }}>{child.nickname} · {child.display_role} · {child.balance} 星币</h2>
              {child.tasks.map((task) => (
                <article className="card" key={task.id}>
                  <h2>{task.name}</h2>
                  <p className="muted">{task.status === "done" ? (task.qualified ? `已达标 +${task.rewardAmount}` : "完成了，没有奖励") : task.status === "skipped" ? "已标记没去" : task.status === "submitted" ? "等你看照片" : task.previewReward === 0 && task.deadlineAt ? "已经过了截止时间，点完成也没有奖励" : `现在点完成可得 ${task.previewReward}`}</p>
                  {task.code === "school_hw" && task.deadlineAt && (
                    <div className="row">
                      <input type="datetime-local" value={deadlines[task.id] || ""} onChange={(event) => setDeadlines({ ...deadlines, [task.id]: event.target.value })} />
                      <button className="ghost" onClick={() => api(`/api/admin/tasks/${task.id}/deadline`, { method: "PATCH", body: JSON.stringify({ deadlineAt: `${deadlines[task.id]}:00+08:00` }) }).then(loadToday).catch((err) => setError(err.message))}>改截止</button>
                    </div>
                  )}
                  <div className="row">
                    {task.status !== "done" && task.status !== "skipped" && <button className="primary" onClick={() => act(`/api/admin/tasks/${task.id}/complete`).catch((err) => setError(err.message))}>完成</button>}
                    {task.code === "swim" && task.status !== "skipped" && <button className="danger" onClick={() => act(`/api/admin/tasks/${task.id}/skip`).catch((err) => setError(err.message))}>没去</button>}
                    {task.status === "done" && <button className="ghost" onClick={() => act(`/api/admin/tasks/${task.id}/undo`).catch((err) => setError(err.message))}>撤销</button>}
                  </div>
                </article>
              ))}
            </section>
          ))}
        </>
      )}
      {tab === "video" && (
        <>
          <section className="card">
            <h2>粘贴抖音分享</h2>
            <textarea value={share} onChange={(event) => setShare(event.target.value)} placeholder="把抖音分享文字粘到这里" />
            <button className="primary" onClick={() => api("/api/admin/videos", { method: "POST", body: JSON.stringify({ shareText: share }) }).then(() => api<{ videos: VideoRow[] }>("/api/admin/videos")).then((res) => { setVideos(res.videos); setShare(""); }).catch((err) => setError(err.message))}>开始下载</button>
            <p className="muted">下载失败就从相册上传。海外服务器有时下不了抖音。</p>
            <input type="file" accept="video/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file).catch((err) => setError(err.message)); }} />
            {progress && <p className="ok">{progress}</p>}
          </section>
          {videos.map((video) => {
            const line = progressLine(video);
            return (
            <article className="card" key={video.id}>
              {video.status === "ready" && <img className="cover" src={`/api/admin/videos/${video.id}/cover`} alt="" onError={(event) => { event.currentTarget.style.display = "none"; }} />}
              <h2>{video.title}</h2>
              <p className="muted">{VIDEO_STATUS[video.status] ?? video.status} · {video.duration_seconds} 秒 {video.published ? "· 已上架" : "· 未上架"}</p>
              {line && (
                <>
                  <p className="ok">{line.text}</p>
                  {line.percent != null && <div className="bar"><span style={{ width: `${line.percent}%` }} /></div>}
                </>
              )}
              {video.error && <p className="error">{video.error}</p>}
              {playingId === video.id && <video className="preview" src={`/api/admin/videos/${video.id}/file`} controls playsInline autoPlay />}
              <div className="row">
                {video.status === "ready" && <button className="primary" onClick={() => setPlayingId(playingId === video.id ? null : video.id)}>{playingId === video.id ? "收起" : "播放"}</button>}
                <button className="ghost" onClick={() => api(`/api/admin/videos/${video.id}`, { method: "PATCH", body: JSON.stringify({ published: !video.published }) }).then(() => api<{ videos: VideoRow[] }>("/api/admin/videos")).then((res) => setVideos(res.videos))}>{video.published ? "下架" : "上架"}</button>
                {video.source_url && <button className="ghost" onClick={() => api(`/api/admin/videos/${video.id}/retry`, { method: "POST", body: "{}" })}>重试下载</button>}
                <button className="danger" onClick={() => api(`/api/admin/videos/${video.id}`, { method: "DELETE" }).then(() => setVideos(videos.filter((item) => item.id !== video.id)))}>删除</button>
              </div>
            </article>
            );
          })}
          {videos.length === 0 && <button className="ghost" onClick={() => api<{ videos: VideoRow[] }>("/api/admin/videos").then((res) => setVideos(res.videos))}>刷新视频</button>}
        </>
      )}
      {tab === "book" && (
        <section className="card">
          <select value={bookChild ?? ""} onChange={(event) => { const id = Number(event.target.value); setBookChild(id); void api<{ entries: typeof entries }>(`/api/admin/ledger?childId=${id}`).then((res) => setEntries(res.entries)); }}>
            {children.map((child) => <option key={child.id} value={child.id}>{child.nickname}</option>)}
          </select>
          <button className="ghost" onClick={() => bookChild && api<{ entries: typeof entries }>(`/api/admin/ledger?childId=${bookChild}`).then((res) => setEntries(res.entries))}>查看</button>
          {entries.map((entry, index) => <p key={index}>{entry.createdAt.slice(5, 16)} {entry.title} {entry.amount > 0 ? "+" : ""}{entry.amount} · 余 {entry.balanceAfter}</p>)}
        </section>
      )}
      {tab === "data" && (
        <>
          <button className="primary" onClick={() => Promise.all([
            api<{ children: typeof stats }>("/api/admin/stats/today"),
            api<{ events: typeof events }>("/api/admin/events"),
            api<{ logs: typeof logs }>("/api/admin/action-logs"),
          ]).then(([a, b, c]) => { setStats(a.children); setEvents(b.events); setLogs(c.logs); })}>刷新今天</button>
          {stats.map((item) => <article className="card" key={item.child.nickname}><h2>{item.child.nickname}</h2><p>余额 {item.balance} · 今天收入 {item.earned} · 支出 {item.spent}</p><p className="muted">视频 {item.watchCount} 次，看了 {item.watchSeconds} 秒</p></article>)}
          <section className="card"><h2>行为</h2>{events.map((event) => <p key={event.id}>{event.serverTs.slice(11, 16)} #{event.userId} {event.type}</p>)}</section>
          <section className="card"><h2>你的操作</h2>{logs.map((log) => <p key={log.id}>{log.createdAt.slice(5, 16)} {log.action}</p>)}</section>
        </>
      )}
      {tab === "account" && (
        <section className="card">
          <button className="ghost" onClick={() => api<{ users: UserRow[] }>("/api/admin/users").then((res) => setUsers(res.users))}>刷新账号</button>
          {users.map((user) => (
            <div key={user.id} className="row" style={{ marginTop: 10 }}>
              <b>{user.displayRole} {user.username}</b>
              <button className="ghost" onClick={() => { const password = prompt("新密码"); if (password) void api(`/api/admin/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ password }) }); }}>改密码</button>
            </div>
          ))}
          <button className="danger" onClick={() => api("/api/auth/logout", { method: "POST" }).then(() => setAuthed(false))}>退出</button>
        </section>
      )}
      <nav className="nav">
        <button className={tab === "today" ? "on" : ""} onClick={() => { setTab("today"); void loadToday(); }}>今天</button>
        <button className={tab === "video" ? "on" : ""} onClick={() => { setTab("video"); void api<{ videos: VideoRow[] }>("/api/admin/videos").then((res) => setVideos(res.videos)); }}>视频</button>
        <button className={tab === "book" ? "on" : ""} onClick={() => setTab("book")}>账本</button>
        <button className={tab === "data" ? "on" : ""} onClick={() => setTab("data")}>数据</button>
        <button className={tab === "account" ? "on" : ""} onClick={() => setTab("account")}>账号</button>
      </nav>
    </div>
  );
}
