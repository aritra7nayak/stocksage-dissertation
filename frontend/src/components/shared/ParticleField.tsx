import { useEffect, useRef } from "react";
import { useTheme } from "../../lib/theme";

/**
 * Lightweight canvas particle network — drifting nodes that link when close.
 * Sits behind all content (z -1). Pauses if prefers-reduced-motion.
 */
export default function ParticleField() {
  const ref = useRef<HTMLCanvasElement>(null);
  const resolved = useTheme((s) => s.resolved);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    let w = 0, h = 0;
    const DPR = Math.min(window.devicePixelRatio || 1, 2);

    const count = Math.min(70, Math.floor(window.innerWidth / 22));
    const pts = Array.from({ length: count }, () => ({
      x: Math.random(), y: Math.random(),
      vx: (Math.random() - 0.5) * 0.0006,
      vy: (Math.random() - 0.5) * 0.0006,
    }));

    const resize = () => {
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = w * DPR; canvas.height = h * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      const dark = resolved === "dark";
      const dot = dark ? "rgba(120,160,255,0.55)" : "rgba(70,110,200,0.45)";
      const line = dark ? "120,160,255" : "70,110,200";
      for (const p of pts) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > 1) p.vx *= -1;
        if (p.y < 0 || p.y > 1) p.vy *= -1;
      }
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const ax = a.x * w, ay = a.y * h;
        ctx.beginPath();
        ctx.arc(ax, ay, 1.6, 0, Math.PI * 2);
        ctx.fillStyle = dot;
        ctx.fill();
        for (let j = i + 1; j < pts.length; j++) {
          const b = pts[j];
          const dx = (a.x - b.x) * w, dy = (a.y - b.y) * h;
          const dist = Math.hypot(dx, dy);
          if (dist < 120) {
            ctx.strokeStyle = `rgba(${line},${(1 - dist / 120) * 0.18})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(b.x * w, b.y * h);
            ctx.stroke();
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); };
  }, [resolved]);

  return (
    <canvas
      ref={ref}
      className="pointer-events-none fixed inset-0 -z-10 h-full w-full"
      style={{ width: "100%", height: "100%" }}
    />
  );
}
