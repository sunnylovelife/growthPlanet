import { useEffect, useRef, useState } from "react";

export interface ClaimResult {
  amount: number;
  title: string;
  breakdown: { base: number; streakBonus: number };
  newBalance: number;
  week: { label: string; qualified: boolean; status: string }[];
  streakLevelUp: "wed" | "fri" | null;
  perfectWeek: boolean;
  cards: { id: string; name: string; rarity: string; emoji: string; blurb: string; series: string; isNew: boolean }[];
  outfitId: string | null;
  nickname: string | null;
}

const rarityName: Record<string, string> = { common: "普通", rare: "稀有", epic: "史诗", legendary: "传说" };

function beep(ctx: AudioContext, freq: number, at: number, dur = 0.08) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = freq;
  osc.type = "triangle";
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.08, at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + dur);
}

export function RewardShow({ result, onDone }: { result: ClaimResult; onDone: () => void }) {
  const magic = result.outfitId === "magic";
  const [act, setAct] = useState(0);
  const [shown, setShown] = useState(0);
  const [cardIndex, setCardIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audio = useRef<AudioContext | null>(null);
  const maxAct = result.cards.length ? 3 : 2;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let frame = 0;
    const stars = Array.from({ length: 80 }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: Math.random() * 2 + 0.4,
      v: Math.random() * 0.4 + 0.1,
    }));
    let raf = 0;
    const draw = () => {
      const w = canvas.width = canvas.offsetWidth * devicePixelRatio;
      const h = canvas.height = canvas.offsetHeight * devicePixelRatio;
      ctx.clearRect(0, 0, w, h);
      for (const star of stars) {
        star.y -= star.v / 200;
        if (star.y < 0) star.y = 1;
        ctx.fillStyle = magic ? "rgba(255, 214, 234, 0.85)" : "rgba(255, 236, 190, 0.9)";
        ctx.beginPath();
        ctx.arc(star.x * w, star.y * h, star.r * devicePixelRatio, 0, Math.PI * 2);
        ctx.fill();
      }
      if (act === 1) {
        for (let i = 0; i < 18; i++) {
          const t = (frame / 40 + i / 18) % 1;
          ctx.fillStyle = magic ? "#ffd0e4" : "#ffd166";
          ctx.beginPath();
          ctx.arc(w * 0.5 + Math.sin(i) * w * 0.28 * t, h * 0.72 - t * h * 0.45, 6 * devicePixelRatio, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      frame++;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [act, magic]);

  useEffect(() => {
    if (act !== 1) return;
    let value = 0;
    const timer = window.setInterval(() => {
      value = Math.min(result.amount, value + Math.max(1, Math.ceil(result.amount / 12)));
      setShown(value);
      const ctx = audio.current;
      if (ctx) beep(ctx, 520 + value * 18, ctx.currentTime, 0.05);
      if (value >= result.amount) window.clearInterval(timer);
    }, 70);
    return () => window.clearInterval(timer);
  }, [act, result.amount]);

  function next() {
    if (!audio.current) audio.current = new AudioContext();
    void audio.current.resume();
    if (act === 3 && !flipped) {
      setFlipped(true);
      beep(audio.current, result.cards[cardIndex]?.rarity === "legendary" ? 880 : 660, audio.current.currentTime, 0.2);
      return;
    }
    if (act === 3 && cardIndex < result.cards.length - 1) {
      setCardIndex((i) => i + 1);
      setFlipped(false);
      return;
    }
    if (act >= maxAct) onDone();
    else setAct((value) => value + 1);
  }

  const card = result.cards[cardIndex];
  return (
    <div className={`reward theme-${magic ? "magic" : "rocket"}`} onClick={next}>
      <canvas ref={canvasRef} />
      <div className="reward-stage">
        {act === 0 && (
          <>
            <div className="mascot">{magic ? "✨" : "🚀"}</div>
            <h1>{result.nickname}，做到了</h1>
            <p>{result.title}</p>
            {result.perfectWeek && <div className="badge">完美一周</div>}
          </>
        )}
        {act === 1 && (
          <>
            <p>星币到账</p>
            <div className="amount">+{shown}</div>
            {result.breakdown.streakBonus > 0 && <div className="badge">连续加成 +{result.breakdown.streakBonus}</div>}
            {result.streakLevelUp && <div className="levelup">{result.streakLevelUp === "fri" ? "加成升级 +2" : "加成升级 +1"}</div>}
          </>
        )}
        {act === 2 && (
          <>
            <p>这一周</p>
            <div className="week">
              {result.week.map((day) => (
                <div key={day.label + day.status} className={day.qualified ? "on" : ""}>
                  <span>{day.label}</span>
                  <i>{day.qualified ? "★" : "·"}</i>
                </div>
              ))}
            </div>
            {!result.week.length && <p>这份奖励已经放进钱包</p>}
          </>
        )}
        {act === 3 && card && (
          <div className={`flip ${flipped ? "open" : ""} rarity-${card.rarity}`}>
            <div className="card-face back">?</div>
            <div className="card-face front">
              <small>{card.series} · {rarityName[card.rarity] || card.rarity}</small>
              <strong>{card.emoji}</strong>
              <b>{card.name}</b>
              <em>{card.blurb}</em>
              {card.isNew && <span>新卡</span>}
            </div>
          </div>
        )}
        <button type="button" className="ghost">{act >= maxAct && (act !== 3 || flipped) ? "放进背包" : "继续"}</button>
      </div>
    </div>
  );
}
