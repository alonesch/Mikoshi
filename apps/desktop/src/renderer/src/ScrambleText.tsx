import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

const katakana = Array.from(
  "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモラリルレロワヲン",
);
const frames = 12;

interface ScrambleTextProps {
  text: string;
}

export function ScrambleText({ text }: ScrambleTextProps): JSX.Element {
  const [display, setDisplay] = useState(text);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const host = useRef<HTMLSpanElement>(null);

  function stop(): void {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setDisplay(text);
  }

  function start(): void {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    stop();
    const letters = Array.from(text);
    let frame = 0;
    timer.current = setInterval(() => {
      frame += 1;
      const revealed = Math.floor((frame / frames) * letters.length);
      setDisplay(
        letters
          .map((letter, index) =>
            index < revealed || !/\p{L}/u.test(letter)
              ? letter
              : katakana[Math.floor(Math.random() * katakana.length)],
          )
          .join(""),
      );
      if (frame >= frames) stop();
    }, 38);
  }

  useEffect(() => {
    stop();
    const parent = host.current?.parentElement;
    parent?.addEventListener("pointerenter", start);
    parent?.addEventListener("pointerleave", stop);
    parent?.addEventListener("focusin", start);
    parent?.addEventListener("focusout", stop);
    return () => {
      if (timer.current) clearInterval(timer.current);
      parent?.removeEventListener("pointerenter", start);
      parent?.removeEventListener("pointerleave", stop);
      parent?.removeEventListener("focusin", start);
      parent?.removeEventListener("focusout", stop);
    };
  }, [text]);

  return (
    <span aria-label={text} className="scramble-text" data-text={text} ref={host}>
      <span aria-hidden="true">{display}</span>
    </span>
  );
}
