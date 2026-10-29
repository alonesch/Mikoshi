import { useEffect, useState } from "react";
import type { JSX } from "react";

export function WindowControls(): JSX.Element {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void window.mikoshi.isWindowMaximized().then(setMaximized);
    return window.mikoshi.onWindowMaximized(setMaximized);
  }, []);

  return (
    <div
      className="window-chrome-controls"
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <button
        aria-label="Minimizar janela"
        onClick={() => void window.mikoshi.controlWindow("minimize")}
        title="Minimizar"
      >
        <svg aria-hidden="true" viewBox="0 0 20 20">
          <path d="M4 14h12" />
          <path d="M4 11.5v2.5" />
        </svg>
      </button>
      <button
        aria-label={maximized ? "Restaurar janela" : "Maximizar janela"}
        onClick={() => void window.mikoshi.controlWindow("maximize")}
        title={maximized ? "Restaurar" : "Maximizar"}
      >
        {maximized ? (
          <svg aria-hidden="true" viewBox="0 0 20 20">
            <path d="M7 5h9v9h-2" />
            <path d="M4 8h9v8H4z" />
            <path d="M4 10l2-2" />
          </svg>
        ) : (
          <svg aria-hidden="true" viewBox="0 0 20 20">
            <path d="M4 7l3-3h9v12H4z" />
            <path d="M4 7h3V4" />
          </svg>
        )}
      </button>
      <button
        aria-label="Fechar aplicação"
        className="window-control-close"
        onClick={() => void window.mikoshi.controlWindow("close")}
        title="Fechar"
      >
        <svg aria-hidden="true" viewBox="0 0 20 20">
          <path d="M5 5l10 10M15 5L5 15" />
          <path d="M4 7V4h3M13 4h3v3" />
        </svg>
      </button>
    </div>
  );
}
