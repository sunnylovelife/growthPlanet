import { useEffect, useMemo, useRef, useState } from "react";
import { api, flushEvents, track } from "./api";
import { RewardShow, type ClaimResult } from "./RewardShow";

interface Task {
  id: number;
  code: string;
  name: string;
  status: string;
  qualified: boolean | null;
  deadlineAt: string | null;
  previewReward: number;
  previewStreak: number;
  rewardAmount: number;
  periodStart: string;
  periodEnd: string;
}
interface Home {
  user: { id: number; nickname: string; outfitId: string; balance: number; displayRole: string };
  date: string;
  tasks: Task[];
  vocab: { name: string; hint: string };
  unclaimed: { id: number; amount: number; title: string; cardDraws: number }[];
  notices: { id: number; text: string }[];
  outfits: { id: string; name: string; tagline: string; mascot: string }[];
}
interface VideoItem {
  id: number;
  title: string;
  duration_seconds: number;
  quote: { freeReplay: boolean; price: number; dailyIndex?: number; long?: boolean; balance: number };
}
type Tab = "home" | "videos" | "album" | "me";

function statusText(task: Task) {
  if (task.status === "submitted") return "照片已交给家长";
  if (task.status === "skipped") return "这次没去";
  if (task.status === "done" && task.qualified) return `已达标 +${task.rewardAmount}`;
  if (task.status === "done") return "完成了，这次没有奖励";
  if (task.status === "missed") return "这次没赶上";
  if (task.code === "swim") return "今晚 20:00 自动确认";
  if (task.deadlineAt && task.status === "pending" && task.previewReward === 0) return "已经过了截止时间，现在完成没有奖励";
  if (task.deadlineAt) return `${task.deadlineAt.slice(11, 16)} 前完成可得 ${task.previewReward} 星币`;
  return `完成可得 ${task.previewReward} 星币`;
}

export function App() {
  const [user, setUser] = useState<Home["user"] | null>(null);
  const [home, setHome] = useState<Home | null>(null);
  const [tab, setTab] = useState<Tab>("home");
  const [error, setError] = useState("");
  const [offline, setOffline] = useState(false);
  const [reward, setReward] = useState<ClaimResult | null>(null);
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [album, setAlbum] = useState<{ name: string; owned: number; total: number; cards: { id: string; name: string; emoji: string; rarity: string; count: number; blurb: string }[] }[]>([]);
  const [quote, setQuote] = useState<{ video: VideoItem; text: string } | null>(null);
  const [playing, setPlaying] = useState<{ video: VideoItem; watchId: number; token: string } | null>(null);
  const [ledger, setLedger] = useState<{ amount: number; title: string; balanceAfter: number; createdAt: string }[]>([]);
  const [nickname, setNickname] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const standalone = useMemo(() => window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true, []);

  async function loadHome() {
    const data = await api<Home>("/api/home");
    setHome(data);
    setUser(data.user);
    setNickname(data.user.nickname);
  }

  useEffect(() => {
    api<{ user: Home["user"] }>("/api/auth/me").then((res) => {
      if (res.user.role === "child") return loadHome();
    }).catch(() => undefined);
    const onHide = () => { track("app_hidden"); void flushEvents(); };
    document.addEventListener("visibilitychange", onHide);
    let fails = 0;
    const timer = window.setInterval(async () => {
      try {
        const res = await fetch("/api/ping", { cache: "no-store" });
        if (!res.ok) throw new Error("ping");
        fails = 0;
        setOffline(false);
        void flushEvents();
      } catch {
        fails += 1;
        if (fails >= 2) setOffline(true);
      }
    }, 8000);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onHide); };
  }, []);

  useEffect(() => {
    if (offline) videoRef.current?.pause();
  }, [offline]);

  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError("");
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username: form.get("username"), password: form.get("password"), portal: "kid" }) });
      track("login");
      await loadHome();
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    }
  }

  async function claimNext() {
    if (!home?.unclaimed[0]) return;
    const result = await api<ClaimResult>(`/api/rewards/${home.unclaimed[0].id}/claim`, { method: "POST" });
    track("reward_claim", { amount: result.amount });
    setReward(result);
  }

  async function submitPhoto(taskId: number, file: File) {
    const body = new FormData();
    body.set("photo", file);
    const result = await api<{ duplicate: boolean }>(`/api/tasks/${taskId}/submit`, { method: "POST", body });
    if (result.duplicate) alert("这张照片以前交过，家长确认时会看到提示");
    await loadHome();
  }

  async function openVideos() {
    setTab("videos");
    const data = await api<{ videos: VideoItem[] }>("/api/videos");
    setVideos(data.videos);
  }

  async function buy(video: VideoItem) {
    const quoted = await api<VideoItem["quote"]>(`/api/videos/${video.id}/quote`);
    const text = quoted.freeReplay ? "再看一遍，不花星币" : `今天第 ${quoted.dailyIndex} 个，需要 ${quoted.price} 星币${quoted.long ? "（超过 10 分钟）" : ""}`;
    setQuote({ video, text });
  }

  async function confirmPlay() {
    if (!quote) return;
    const quoted = await api<VideoItem["quote"]>(`/api/videos/${quote.video.id}/quote`);
    const result = await api<{ watchId?: number; token?: string; reprice?: boolean; price?: number; balance?: number }>(`/api/videos/${quote.video.id}/play`, {
      method: "POST",
      body: JSON.stringify({ quotedPrice: quoted.price, idempotencyKey: crypto.randomUUID() }),
    });
    if (result.reprice) {
      setQuote({ ...quote, text: `价格变成 ${result.price} 星币了，再确认一次` });
      return;
    }
    setQuote(null);
    setPlaying({ video: quote.video, watchId: result.watchId!, token: result.token! });
    await loadHome();
  }

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      void api(`/api/watch/${playing.watchId}/heartbeat`, { method: "POST", body: JSON.stringify({ seconds: video.currentTime }) }).catch(() => setOffline(true));
    }, 10000);
    return () => window.clearInterval(timer);
  }, [playing]);

  async function stopPlay(reason: string) {
    if (!playing) return;
    const seconds = videoRef.current?.currentTime ?? 0;
    await api(`/api/watch/${playing.watchId}/end`, { method: "POST", body: JSON.stringify({ reason, seconds }) }).catch(() => undefined);
    setPlaying(null);
    await openVideos();
  }

  if (!user || !home) {
    return (
      <div className="login">
        <form onSubmit={login}>
          <h1>成长星球</h1>
          <p className="muted">把努力换成星币，再把星币换成想看的故事。</p>
          {!standalone && <p className="notice">想全屏像 App 一样用：点分享，选「添加到主屏幕」，再从主屏幕打开。</p>}
          <input name="username" placeholder="用户名" autoCapitalize="none" />
          <input name="password" placeholder="密码" type="password" />
          {error && <p className="error">{error}</p>}
          <button className="primary" type="submit">进入我的星球</button>
        </form>
      </div>
    );
  }

  return (
    <div className={`app theme-${home.user.outfitId}`}>
      <header className="top">
        <div>
          <p className="muted">{home.date} · {home.user.displayRole}</p>
          <h1>{home.user.nickname}</h1>
        </div>
        <div className={home.user.balance < 0 ? "balance neg" : "balance"}>
          <span>星币</span>
          <b>{home.user.balance}</b>
        </div>
      </header>

      {tab === "home" && (
        <>
          {home.notices.map((notice) => <div key={notice.id} className="notice" onClick={() => api("/api/notices/read", { method: "POST" }).then(loadHome)}>{notice.text}</div>)}
          {home.unclaimed.length > 0 && (
            <section className="panel">
              <h2>有 {home.unclaimed.length} 份奖励</h2>
              <p>{home.unclaimed[0].title} · {home.unclaimed[0].amount} 星币</p>
              <button className="primary wide" onClick={() => claimNext().catch((err) => setError(err.message))}>领取</button>
            </section>
          )}
          {home.tasks.map((task) => (
            <article className="task" key={task.id}>
              <div>
                <h2>{task.name}</h2>
                <p className="muted">{statusText(task)}{task.previewStreak > 0 && task.status === "pending" ? `，含连续 +${task.previewStreak}` : ""}</p>
              </div>
              {(task.code === "school_hw" || task.code === "houhai_hw") && (task.status === "pending" || task.status === "missed") && (
                <label className="ghost">
                  拍照告诉家长
                  <input hidden type="file" accept="image/*" capture="environment" onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void submitPhoto(task.id, file);
                  }} />
                </label>
              )}
            </article>
          ))}
          <article className="task">
            <div>
              <h2>{home.vocab.name}</h2>
              <p className="muted">{home.vocab.hint}</p>
            </div>
          </article>
          {error && <p className="error">{error}</p>}
        </>
      )}

      {tab === "videos" && (
        <>
          {videos.length === 0 && <p className="muted">家长还没有放上新视频。</p>}
          {videos.map((video) => (
            <article className="video" key={video.id}>
              <h2>{video.title}</h2>
              <p className="muted">{Math.ceil(video.duration_seconds / 60) || "不到 1"} 分钟 · {video.quote.freeReplay ? "可以再看一遍" : `今天第 ${video.quote.dailyIndex} 个 · ${video.quote.price} 星币`}</p>
              <button className="primary" onClick={() => buy(video).catch((err) => setError(err.message))}>看这个</button>
            </article>
          ))}
          {error && <p className="error">{error}</p>}
        </>
      )}

      {tab === "album" && (
        album.map((series) => (
          <section className="panel" key={series.name}>
            <h2>{series.name} {series.owned}/{series.total}</h2>
            <div className="grid">
              {series.cards.map((card) => (
                <div key={card.id} className={card.count ? "album-card panel" : "album-card panel locked"}>
                  <strong>{card.count ? card.emoji : "✦"}</strong>
                  <b>{card.count ? card.name : "未收集"}</b>
                  {card.count > 1 && <span className="tag">×{card.count}</span>}
                </div>
              ))}
            </div>
          </section>
        ))
      )}

      {tab === "me" && (
        <>
          <section className="panel">
            <h2>昵称</h2>
            <div className="row">
              <input value={nickname} onChange={(event) => setNickname(event.target.value)} />
              <button className="primary" onClick={() => api("/api/me", { method: "PATCH", body: JSON.stringify({ nickname }) }).then(loadHome)}>保存</button>
            </div>
          </section>
          <div className="grid">
            {home.outfits.map((outfit) => (
              <button key={outfit.id} className={home.user.outfitId === outfit.id ? "outfit on" : "outfit"} onClick={() => api("/api/me", { method: "PATCH", body: JSON.stringify({ outfitId: outfit.id }) }).then(loadHome)}>
                <div style={{ fontSize: 42 }}>{outfit.mascot}</div>
                <b>{outfit.name}</b>
                <span className="muted">{outfit.tagline}</span>
                <span className="tag">免费</span>
              </button>
            ))}
          </div>
          <section className="panel">
            <h2>账本</h2>
            {ledger.map((entry, index) => (
              <p key={index}>{entry.title} {entry.amount > 0 ? "+" : ""}{entry.amount} · 余 {entry.balanceAfter}</p>
            ))}
            {ledger.length === 0 && <button className="ghost" onClick={() => api<{ entries: typeof ledger }>("/api/wallet").then((res) => setLedger(res.entries))}>查看明细</button>}
          </section>
          <button className="ghost wide" onClick={() => api("/api/auth/logout", { method: "POST" }).then(() => { setUser(null); setHome(null); })}>退出</button>
        </>
      )}

      <nav className="nav">
        <button className={tab === "home" ? "on" : ""} onClick={() => { setTab("home"); void loadHome(); }}>星球</button>
        <button className={tab === "videos" ? "on" : ""} onClick={() => void openVideos()}>影院</button>
        <button className={tab === "album" ? "on" : ""} onClick={() => { setTab("album"); void api<{ series: typeof album }>("/api/album").then((res) => setAlbum(res.series)); }}>卡册</button>
        <button className={tab === "me" ? "on" : ""} onClick={() => setTab("me")}>我的</button>
      </nav>

      {quote && (
        <div className="offline">
          <div className="sheet panel">
            <h2>{quote.video.title}</h2>
            <p>{quote.text}</p>
            <button className="primary" onClick={() => confirmPlay().catch((err) => setError(err.message))}>确认</button>
            <button className="ghost" onClick={() => setQuote(null)}>先不看</button>
          </div>
        </div>
      )}
      {playing && (
        <div className="player">
          <div className="row" style={{ padding: 12 }}><button className="ghost" onClick={() => void stopPlay("closed")}>关闭</button><b>{playing.video.title}</b></div>
          <video ref={videoRef} src={`/media/videos/${playing.video.id}?t=${playing.token}`} playsInline controls autoPlay onEnded={() => void stopPlay("finished")} />
          <p className="muted" style={{ padding: 12 }}>看完或关闭后，同一次购买还能再看一遍。</p>
        </div>
      )}
      {reward && <RewardShow result={reward} onDone={() => { setReward(null); void loadHome(); }} />}
      {offline && <div className="offline"><div className="panel"><h2>网络断开了</h2><p>连上网络后才能继续，这样爸爸妈妈才能看到完整记录。</p></div></div>}
    </div>
  );
}
