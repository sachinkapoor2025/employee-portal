import { useEffect, useRef } from "react";

const PARTICLES = Array.from({ length: 28 }, (_, i) => ({
  id: i,
  left: `${(i * 29 + 7) % 100}%`,
  delay: `${(i % 10) * 0.85}s`,
  duration: `${12 + (i % 8) * 1.6}s`,
  size: 2 + (i % 4),
}));

/**
 * Premium ambient background with stronger mouse parallax + cursor glow.
 * Uses rAF interpolation for smooth ~60fps motion.
 */
export default function AmbientBackground() {
  const parallaxRef = useRef(null);
  const glowRef = useRef(null);

  useEffect(() => {
    const parallax = parallaxRef.current;
    const glow = glowRef.current;
    if (!parallax || !glow) return;

    let raf = 0;
    let targetX = 0;
    let targetY = 0;
    let currentX = 0;
    let currentY = 0;
    let glowTX = window.innerWidth * 0.5;
    let glowTY = window.innerHeight * 0.35;
    let glowX = glowTX;
    let glowY = glowTY;

    const onMove = (e) => {
      const { innerWidth, innerHeight } = window;
      targetX = ((e.clientX / innerWidth) - 0.5) * 48;
      targetY = ((e.clientY / innerHeight) - 0.5) * 36;
      glowTX = e.clientX;
      glowTY = e.clientY;
    };

    const tick = () => {
      // Smooth lerp — feels premium without jank
      currentX += (targetX - currentX) * 0.08;
      currentY += (targetY - currentY) * 0.08;
      glowX += (glowTX - glowX) * 0.12;
      glowY += (glowTY - glowY) * 0.12;

      parallax.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
      glow.style.transform = `translate3d(${glowX}px, ${glowY}px, 0) translate(-50%, -50%)`;

      raf = requestAnimationFrame(tick);
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    raf = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="dgv-bg" aria-hidden="true">
      <div className="dgv-bg__gradient" ref={parallaxRef}>
        <div className="dgv-bg__blob dgv-bg__blob--1" />
        <div className="dgv-bg__blob dgv-bg__blob--2" />
        <div className="dgv-bg__blob dgv-bg__blob--3" />
      </div>
      <div className="dgv-bg__glow" ref={glowRef} />
      <div className="dgv-bg__particles">
        {PARTICLES.map((p) => (
          <span
            key={p.id}
            className="dgv-bg__particle"
            style={{
              left: p.left,
              bottom: "-4px",
              width: p.size,
              height: p.size,
              animationDelay: p.delay,
              animationDuration: p.duration,
            }}
          />
        ))}
      </div>
    </div>
  );
}
