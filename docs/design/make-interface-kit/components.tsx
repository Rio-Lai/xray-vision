import type { CSSProperties, ReactNode } from "react";
import "./tokens.css";
import "./hud.css";

export type Point = { x: number; y: number };
export type LabelState = "quiet" | "focused" | "highlight" | "active";
export type VoiceState = "off" | "connecting" | "listening" | "thinking" | "speaking" | "hold";

const positioned = (point: Point): CSSProperties => ({ left: point.x, top: point.y });

export function LabelPill({
  children,
  state = "quiet",
  className = "",
}: {
  children: ReactNode;
  state?: LabelState;
  className?: string;
}) {
  return <span className={`bf-label-pill bf-label-pill--${state} ${className}`}>{children}</span>;
}

export function ObjectLabel({
  name,
  point,
  state = "quiet",
  pillPosition = "below",
}: {
  name: string;
  point: Point;
  state?: "quiet" | "focused";
  pillPosition?: "above" | "below";
}) {
  return (
    <div
      className={`bf-object-label bf-object-label--${pillPosition} bf-enter`}
      style={positioned(point)}
    >
      <span className={`bf-object-label__dot bf-object-label__dot--${state}`} />
      <span className="bf-object-label__stem" />
      <LabelPill state={state} className="bf-object-label__pill">
        {name}
      </LabelPill>
    </div>
  );
}

export function FocusGlow({
  x,
  y,
  width,
  height,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  return (
    <div
      className="bf-focus-glow bf-enter"
      style={{ left: x, top: y, width, height }}
      aria-hidden="true"
    />
  );
}

export function PartLabel({
  name,
  anchor,
  label,
  state = "quiet",
  side,
}: {
  name: string;
  anchor: Point;
  label: Point;
  state?: "quiet" | "highlight" | "active";
  side: "left" | "right";
}) {
  const direction = side === "left" ? 1 : -1;
  const lineEndX = label.x + direction * 6;
  const elbowX = label.x + direction * 32;
  return (
    <div className={`bf-part-label bf-part-label--${state} bf-enter`}>
      <svg className="bf-part-label__line" viewBox="0 0 1920 1080" aria-hidden="true">
        <path d={`M ${anchor.x} ${anchor.y} L ${elbowX} ${label.y} L ${lineEndX} ${label.y}`} />
      </svg>
      <span className="bf-part-label__dot" style={positioned(anchor)} />
      <span
        className={`bf-part-label__pill bf-part-label__pill--${side}`}
        style={positioned(label)}
      >
        <LabelPill state={state}>{name}</LabelPill>
      </span>
    </div>
  );
}

export function TitlePill({
  children,
  aiEstimated = false,
}: {
  children: ReactNode;
  aiEstimated?: boolean;
}) {
  return (
    <div className="bf-title-pill bf-glass bf-enter">
      {children}
      {aiEstimated && <span className="bf-title-pill__chip">AI-estimated</span>}
    </div>
  );
}

export function PartCard({
  kicker,
  name,
  summary,
  safety,
}: {
  kicker: string;
  name: string;
  summary: string;
  safety: string;
}) {
  return (
    <section className="bf-card bf-part-card bf-enter">
      <p className="bf-card__kicker">{kicker}</p>
      <h2 className="bf-card__name">{name}</h2>
      <p className="bf-card__body">{summary}</p>
      <p className="bf-card__safety">
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M10 2.4 18 17H2L10 2.4Z" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M10 7v4.5M10 14.2v.2"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
        <span>{safety}</span>
      </p>
    </section>
  );
}

export function StepCard({
  kicker,
  step = 4,
  total = 7,
  children,
}: {
  kicker: string;
  step?: number;
  total?: number;
  children: ReactNode;
}) {
  return (
    <section className="bf-card bf-step-card bf-enter">
      <p className="bf-card__kicker">{kicker}</p>
      <div className="bf-progress" aria-label={`${step} of ${total}`}>
        {Array.from({ length: total }, (_, index) => (
          <span
            key={index}
            className={`bf-progress__segment ${index === step - 1 ? "bf-progress__segment--active" : ""}`}
          />
        ))}
      </div>
      <p className="bf-card__body">{children}</p>
    </section>
  );
}

export function GestureHint({ children }: { children: ReactNode }) {
  return <p className="bf-gesture-hint bf-enter">{children}</p>;
}

export function StatusPill({
  children,
  variant,
}: {
  children: ReactNode;
  variant: "looking" | "info" | "error";
}) {
  return (
    <div className={`bf-status-pill bf-status-pill--${variant} bf-glass bf-enter`}>
      <span className="bf-pill-dot" />
      {children}
    </div>
  );
}

function VoiceIcon({ state }: { state: VoiceState }) {
  if (state === "connecting") return <span className="bf-spinner" />;
  if (state === "thinking")
    return (
      <span className="bf-thinking">
        <i />
        <i />
        <i />
      </span>
    );
  if (state === "speaking")
    return (
      <span className="bf-waveform">
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
    );
  if (state === "hold")
    return (
      <svg className="bf-mic" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <rect x="7" y="2.5" width="6" height="10" rx="3" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M4.8 9.8a5.2 5.2 0 0 0 10.4 0M10 15v2.5M7.2 17.5h5.6"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  return <span className={`bf-pill-dot ${state === "listening" ? "bf-pill-dot--accent" : ""}`} />;
}

const voiceLabels: Record<VoiceState, string> = {
  off: "Voice off",
  connecting: "Connecting",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  hold: "Hold to talk",
};

export function VoicePill({ state }: { state: VoiceState }) {
  return (
    <div className={`bf-voice-pill bf-voice-pill--${state} bf-glass bf-enter`}>
      <VoiceIcon state={state} />
      {voiceLabels[state]}
    </div>
  );
}

export function Captions({ wearer, blowfish }: { wearer?: string; blowfish: string }) {
  return (
    <div className="bf-captions bf-enter">
      {wearer && <p className="bf-captions__user">{wearer}</p>}
      <p className="bf-captions__reply">{blowfish}</p>
    </div>
  );
}

export function ModelPlaceholder({ batteryHighlighted = false }: { batteryHighlighted?: boolean }) {
  return (
    <svg
      className="bf-model bf-enter"
      viewBox="0 0 760 550"
      fill="none"
      aria-label="Exploded translucent laptop model"
    >
      <defs>
        <linearGradient
          id="bf-glass-model"
          x1="120"
          y1="40"
          x2="650"
          y2="500"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--bf-color-white)" stopOpacity=".5" />
          <stop offset=".48" stopColor="var(--bf-color-white)" stopOpacity=".2" />
          <stop offset="1" stopColor="var(--bf-color-accent)" stopOpacity=".09" />
        </linearGradient>
        <linearGradient id="bf-model-edge" x1="180" y1="100" x2="610" y2="460">
          <stop stopColor="var(--bf-color-white)" stopOpacity=".84" />
          <stop offset="1" stopColor="var(--bf-color-white)" stopOpacity=".56" />
        </linearGradient>
        <filter id="bf-model-shadow">
          <feGaussianBlur stdDeviation="18" />
        </filter>
        <filter id="bf-layer-glow">
          <feGaussianBlur stdDeviation="5" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>
      <ellipse
        cx="390"
        cy="505"
        rx="245"
        ry="25"
        fill="var(--bf-color-shadow-strong)"
        filter="url(#bf-model-shadow)"
      />
      <g stroke="url(#bf-model-edge)" strokeWidth="1.5" strokeLinejoin="round">
        <path d="M196 62 584 145 535 290 211 219Z" fill="url(#bf-glass-model)" />
        <path
          d="M218 81 560 154 520 268 232 207Z"
          fill="var(--bf-color-accent)"
          fillOpacity=".07"
        />
        <path
          d="m164 298 374 80 76-48-373-79-77 47Z"
          fill="url(#bf-glass-model)"
          filter="url(#bf-layer-glow)"
        />
        <g fill="var(--bf-color-white)" fillOpacity=".13" strokeOpacity=".3">
          {Array.from({ length: 5 }, (_, row) =>
            Array.from({ length: 10 }, (_, column) => (
              <path
                key={`${row}-${column}`}
                d={`m${248 + column * 27 - row * 7} ${277 + row * 13} 20 4 12-7-20-4-12 7Z`}
              />
            )),
          )}
        </g>
        <path
          d="m329 331 111 24 35-21-111-24-35 21Z"
          fill="var(--bf-color-white)"
          fillOpacity=".13"
        />
        <path d="m181 349 373 79 74-46-373-80-74 47Z" fill="url(#bf-glass-model)" />
        <path
          d="m258 346 147 31 68-41-147-31-68 41Z"
          fill="var(--bf-color-accent)"
          fillOpacity=".16"
        />
        <path d="m331 350 35 8 18-11-35-7-18 10Z" fill="var(--bf-color-accent)" fillOpacity=".42" />
        <g
          fill={batteryHighlighted ? "var(--bf-color-accent)" : "var(--bf-color-white)"}
          fillOpacity={batteryHighlighted ? ".25" : ".13"}
        >
          {[
            [430, 369],
            [485, 381],
            [540, 393],
            [413, 394],
            [468, 406],
            [523, 418],
          ].map(([x, y]) => (
            <rect
              key={`${x}-${y}`}
              x={x}
              y={y}
              width="50"
              height="22"
              rx="9"
              transform={`rotate(12 ${x} ${y})`}
            />
          ))}
        </g>
        <path d="m165 430 373 79 83-51-374-80-82 52Z" fill="url(#bf-glass-model)" />
      </g>
    </svg>
  );
}

export function HandPlaceholder() {
  return (
    <svg
      className="bf-hand bf-enter"
      viewBox="0 0 720 620"
      fill="none"
      aria-label="Translucent right forearm and hand model"
    >
      <defs>
        <linearGradient
          id="bf-hand-glass"
          x1="160"
          y1="560"
          x2="560"
          y2="80"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--bf-color-white)" stopOpacity=".16" />
          <stop offset=".55" stopColor="var(--bf-color-accent)" stopOpacity=".12" />
          <stop offset="1" stopColor="var(--bf-color-white)" stopOpacity=".12" />
        </linearGradient>
        <filter id="bf-warm-glow">
          <feGaussianBlur stdDeviation="22" />
        </filter>
      </defs>
      <path
        d="M285 620c5-74 8-135 15-183 4-30 4-50-8-68l-57-70c-13-17-10-36 5-47 15-10 32-6 45 8l45 50-12-132c-2-24 12-41 32-43 20-1 35 14 37 36l8 119 2-174c0-24 15-40 35-40 21 0 36 16 35 40l-6 177 22-154c4-23 21-37 40-34 20 3 32 21 28 44l-26 158 38-125c7-22 25-33 43-27 18 6 27 25 20 46l-47 157c-12 40-14 75-7 110 8 40 26 81 54 122l21 30H285Z"
        fill="url(#bf-hand-glass)"
        stroke="var(--bf-color-white)"
        strokeOpacity=".52"
        strokeWidth="2"
      />
      <g
        fill="none"
        stroke="var(--bf-color-white)"
        strokeOpacity=".2"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <path d="M326 351c24-13 46-15 67-5" />
        <path d="M397 328c23-11 45-10 65 2" />
        <path d="M463 337c20-7 39-3 55 11" />
        <path d="M330 391c58-24 119-20 181 12" />
      </g>
      <g
        fill="none"
        stroke="var(--bf-color-warm)"
        strokeLinecap="round"
        filter="url(#bf-warm-glow)"
      >
        <path d="M385 590c0-82 2-139 8-172 7-38 23-68 48-91" strokeOpacity=".48" strokeWidth="42" />
        <path
          d="M423 357 353 318M424 353l5-55M431 354l66-38"
          strokeOpacity=".34"
          strokeWidth="25"
        />
      </g>
      <g
        fill="none"
        stroke="var(--bf-color-warm)"
        strokeOpacity=".72"
        strokeWidth="6"
        strokeLinecap="round"
      >
        <path d="M385 590c0-82 2-139 8-172 7-38 23-68 48-91" />
        <path d="M423 357 353 318M424 353l5-55M431 354l66-38" />
      </g>
    </svg>
  );
}

export function StageScrim() {
  return <div className="bf-stage-scrim" />;
}
