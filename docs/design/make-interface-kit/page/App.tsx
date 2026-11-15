import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Captions,
  FocusGlow,
  GestureHint,
  HandPlaceholder,
  LabelPill,
  ModelPlaceholder,
  ObjectLabel,
  PartCard,
  PartLabel,
  StageScrim,
  StatusPill,
  StepCard,
  TitlePill,
  VoicePill,
  layoutPartLabels,
  type VoiceState,
} from "./kit";

const BACKDROP_SRC =
  "https://images.unsplash.com/photo-1759156771079-6fef5b8d66c9?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwzfHxtaW5pbWFsJTIwd29vZGVuJTIwZGVzayUyMG9wZW4lMjBsYXB0b3AlMjBibGFuayUyMHNjcmVlbiUyMGNvZmZlZSUyMGNlcmFtaWMlMjBtdWclMjBvdmVyaGVhZCUyMHdvcmtzcGFjZSUyMG5vJTIwcGVvcGxlfGVufDF8fHx8MTc5NDY5NTQ5NXww&ixlib=rb-4.1.0&q=86&w=1920";

const states = [
  "Clean view",
  "Overlay on",
  "Looking",
  "Model on stage",
  "Part selected",
  "Step card",
  "Hand and arm",
  "Voice",
  "Error",
];

const objectLabels = [
  {
    name: "MacBook Air 13-inch",
    point: { x: 500, y: 460 },
    state: "focused" as const,
    pillPosition: "above" as const,
  },
  {
    name: "Phone",
    point: { x: 1115, y: 575 },
    state: "quiet" as const,
    pillPosition: "above" as const,
  },
  {
    name: "Notebook",
    point: { x: 1250, y: 930 },
    state: "quiet" as const,
    pillPosition: "above" as const,
  },
  {
    name: "Pen",
    point: { x: 1400, y: 700 },
    state: "quiet" as const,
    pillPosition: "above" as const,
  },
];

const laptopParts = layoutPartLabels([
  {
    name: "Display assembly",
    anchor: { x: 825, y: 350 },
  },
  {
    name: "Keyboard and top case",
    anchor: { x: 820, y: 570 },
  },
  {
    name: "Trackpad",
    anchor: { x: 920, y: 630 },
  },
  {
    name: "Logic board with M3 chip",
    anchor: { x: 1025, y: 608 },
  },
  {
    name: "Battery",
    anchor: { x: 1080, y: 670 },
  },
  {
    name: "Speakers",
    anchor: { x: 1180, y: 592 },
  },
]);

const muscleParts = layoutPartLabels([
  {
    name: "Extensor digitorum",
    anchor: { x: 1000, y: 650 },
    state: "active" as const,
  },
  {
    name: "Flexor digitorum superficialis (FDS)",
    anchor: { x: 900, y: 700 },
    state: "quiet" as const,
  },
  {
    name: "Flexor digitorum profundus (FDP)",
    anchor: { x: 940, y: 760 },
    state: "quiet" as const,
  },
  {
    name: "Interossei",
    anchor: { x: 1050, y: 520 },
    state: "quiet" as const,
  },
  {
    name: "Thenar muscles",
    anchor: { x: 850, y: 560 },
    state: "quiet" as const,
  },
]);

const voiceStates: VoiceState[] = [
  "off",
  "connecting",
  "listening",
  "thinking",
  "speaking",
  "hold",
];

function initialState() {
  const value = Number(window.location.hash.replace("#", ""));
  return value >= 1 && value <= 9 ? value : 1;
}

function useStageScale() {
  const frameRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const update = () => setScale(frame.clientWidth / 1920);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);
  return { frameRef, scale };
}

function SafeZones() {
  return (
    <div className="safe-zones" aria-hidden="true">
      <div className="safe-zones__middle">
        <span>Middle 60% — model only</span>
      </div>
      <div className="safe-zones__voice">
        <span>Voice zone · 760 × 120</span>
      </div>
    </div>
  );
}

function VoiceZone({
  state = "listening",
  caption,
}: {
  state?: VoiceState;
  caption?: { wearer?: string; blowfish: string };
}) {
  return (
    <div className="bf-voice-zone">
      {caption && <Captions {...caption} />}
      <VoicePill state={state} />
    </div>
  );
}

function LaptopModel({ state, aiEstimated }: { state: number; aiEstimated: boolean }) {
  const selected = state >= 5;
  return (
    <>
      <StageScrim />
      <TitlePill aiEstimated={state === 4 && aiEstimated}>MacBook Air 13-inch</TitlePill>
      <ModelPlaceholder batteryHighlighted={selected} />
      {laptopParts.map((part) => (
        <PartLabel
          key={part.name}
          {...part}
          state={selected && part.name === "Battery" ? "highlight" : "quiet"}
        />
      ))}
      <GestureHint>Pinch to turn it. Pull your hands apart to open it.</GestureHint>
      {selected && (
        <PartCard
          kicker="Part 7 of 12"
          name="Battery"
          summary="A multi-cell lithium-polymer battery, about 52.6 Wh, spread under the palm rest. It is held in place by stretch-release adhesive tabs."
          safety="Lithium battery: never puncture, bend or pry against the cells. A damaged cell can overheat and catch fire."
        />
      )}
      {state === 6 && (
        <StepCard kicker="Step 4 of 7">
          Disconnect the battery from the logic board before touching anything else.
        </StepCard>
      )}
    </>
  );
}

function StageContent({
  state,
  aiEstimated,
  voiceState,
  lookingKey,
}: {
  state: number;
  aiEstimated: boolean;
  voiceState: VoiceState;
  lookingKey: number;
}) {
  const [resolved, setResolved] = useState(false);
  useEffect(() => {
    if (state !== 3) return;
    setResolved(false);
    const timer = window.setTimeout(() => setResolved(true), 1200);
    return () => window.clearTimeout(timer);
  }, [state, lookingKey]);

  return (
    <div className="bf-root">
      {state === 2 && (
        <>
          <FocusGlow x={40} y={90} width={990} height={760} />
          {objectLabels.map((label) => (
            <ObjectLabel key={label.name} {...label} />
          ))}
        </>
      )}
      {state === 3 && (
        <div className={`looking-transition ${resolved ? "looking-transition--resolved" : ""}`}>
          <div className="looking-transition__status">
            <StatusPill variant="looking">Looking…</StatusPill>
          </div>
          <div className="looking-transition__label">
            <FocusGlow x={40} y={90} width={990} height={760} />
            <ObjectLabel
              name="MacBook Air 13-inch"
              point={{ x: 500, y: 460 }}
              state="focused"
              pillPosition="above"
            />
          </div>
        </div>
      )}
      {state >= 4 && state <= 6 && <LaptopModel state={state} aiEstimated={aiEstimated} />}
      {state === 7 && (
        <>
          <StageScrim />
          <TitlePill>Hand and finger muscles</TitlePill>
          <HandPlaceholder />
          {muscleParts.map((part) => (
            <PartLabel key={part.name} {...part} />
          ))}
        </>
      )}
      {state === 9 && (
        <StatusPill variant="error">
          Blowfish server is not running. Start it with npm run dev.
        </StatusPill>
      )}
      <VoiceZone
        state={state === 8 ? voiceState : "listening"}
        caption={
          state === 8
            ? {
                wearer: "Tell me about the battery.",
                blowfish: "This is the battery. It sits under the palm rest.",
              }
            : state === 7
              ? { blowfish: "Extensor digitorum lifts your finger off the key." }
              : undefined
        }
      />
    </div>
  );
}

export default function App() {
  const [state, setState] = useState(initialState);
  const [safeZones, setSafeZones] = useState(false);
  const [aiEstimated, setAiEstimated] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>("listening");
  const [lookingKey, setLookingKey] = useState(0);
  const { frameRef, scale } = useStageScale();

  const selectState = (next: number) => {
    setState(next);
    window.location.hash = String(next);
  };

  useEffect(() => {
    const onHashChange = () => setState(initialState());
    const onKeyDown = (event: KeyboardEvent) => {
      if (/^[1-9]$/.test(event.key)) selectState(Number(event.key));
    };
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <main className="app-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Voice-controlled X-ray vision</p>
          <h1>
            Blowfish <span>— interface kit</span>
          </h1>
        </div>
        <p className="state-readout">0{state} / 09</p>
      </header>

      <div className="showcase">
        <section className="viewer-section" aria-label={`Glasses view: ${states[state - 1]}`}>
          <div className="viewer-labels">
            <span>Glasses view</span>
            <span>1920 × 1080</span>
          </div>
          <div className="glasses-frame" ref={frameRef}>
            <div className="stage" style={{ transform: `scale(${scale})` }}>
              <div
                className="stage-backdrop"
                style={{ backgroundImage: `url("${BACKDROP_SRC}")` }}
              />
              <StageContent
                state={state}
                aiEstimated={aiEstimated}
                voiceState={voiceState}
                lookingKey={lookingKey}
              />
              {safeZones && <SafeZones />}
            </div>
          </div>
          <p className="photo-credit">Backdrop photo by Jakub Żerdzicki on Unsplash</p>
        </section>

        <aside className="controls">
          <div className="control-heading">
            <p className="control-kicker">States</p>
            <p>Press 1–9</p>
          </div>
          <nav className="state-list" aria-label="Interface states">
            {states.map((name, index) => (
              <button
                key={name}
                className={
                  state === index + 1 ? "state-button state-button--active" : "state-button"
                }
                onClick={() => selectState(index + 1)}
                aria-current={state === index + 1 ? "true" : undefined}
              >
                <span>{index + 1}</span>
                {name}
              </button>
            ))}
          </nav>

          <div className="options">
            <label className="toggle-row">
              <span>Show safe zones</span>
              <input
                type="checkbox"
                checked={safeZones}
                onChange={(event) => setSafeZones(event.target.checked)}
              />
              <i aria-hidden="true" />
            </label>
            {state === 4 && (
              <label className="toggle-row">
                <span>AI-estimated chip</span>
                <input
                  type="checkbox"
                  checked={aiEstimated}
                  onChange={(event) => setAiEstimated(event.target.checked)}
                />
                <i aria-hidden="true" />
              </label>
            )}
            {state === 3 && (
              <button className="replay-button" onClick={() => setLookingKey((value) => value + 1)}>
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path
                    d="M4.2 7.2A6.3 6.3 0 1 1 4 12.3M4.2 7.2V3.4M4.2 7.2H8"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                Replay looking
              </button>
            )}
          </div>

          {state === 8 && (
            <div className="voice-selector">
              <p className="control-kicker">Voice states</p>
              <div>
                {voiceStates.map((item) => (
                  <button
                    key={item}
                    onClick={() => setVoiceState(item)}
                    className={voiceState === item ? "active" : ""}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>
      <ComponentSheet />
      <TokensSheet />
    </main>
  );
}

function Specimen({
  caption,
  children,
  className = "",
}: {
  caption: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`specimen ${className}`}>
      <div className="specimen__content">{children}</div>
      <p>{caption}</p>
    </div>
  );
}

function ComponentSheet() {
  return (
    <section className="kit-sheet" aria-labelledby="components-title">
      <div className="section-heading">
        <p className="eyebrow">Reusable primitives</p>
        <h2 id="components-title">Components</h2>
        <p>Every state, shown on the camera surface it was designed for.</p>
      </div>
      <div className="component-strip" style={{ backgroundImage: `url("${BACKDROP_SRC}")` }}>
        <div className="component-strip__veil" />
        <div className="specimen-grid specimen-grid--pills">
          <Specimen caption="LabelPill · quiet">
            <LabelPill>Phone</LabelPill>
          </Specimen>
          <Specimen caption="LabelPill · focus">
            <LabelPill state="focused">MacBook Air 13-inch</LabelPill>
          </Specimen>
          <Specimen caption="ObjectLabel" className="component-object-stage">
            <ObjectLabel name="Phone" point={{ x: 120, y: 8 }} state="quiet" />
          </Specimen>
          <Specimen caption="TitlePill">
            <TitlePill>MacBook Air 13-inch</TitlePill>
          </Specimen>
          <Specimen caption="TitlePill · AI-estimated">
            <TitlePill aiEstimated>MacBook Air 13-inch</TitlePill>
          </Specimen>
          <Specimen caption="FocusGlow" className="component-focus-stage">
            <FocusGlow x={28} y={12} width={170} height={58} />
          </Specimen>
        </div>

        <div className="specimen-grid specimen-grid--leaders">
          <Specimen caption="PartLabel · quiet" className="component-leader-stage">
            <PartLabel
              name="Battery"
              anchor={{ x: 80, y: 62 }}
              label={{ x: 250, y: 62 }}
              side="right"
            />
          </Specimen>
          <Specimen caption="PartLabel · highlight" className="component-leader-stage">
            <PartLabel
              name="Battery"
              anchor={{ x: 80, y: 62 }}
              label={{ x: 250, y: 62 }}
              side="right"
              state="highlight"
            />
          </Specimen>
          <Specimen caption="PartLabel · active" className="component-leader-stage">
            <PartLabel
              name="Extensor digitorum"
              anchor={{ x: 80, y: 62 }}
              label={{ x: 250, y: 62 }}
              side="right"
              state="active"
            />
          </Specimen>
        </div>

        <div className="specimen-grid specimen-grid--status">
          <Specimen caption="StatusPill · looking">
            <StatusPill variant="looking">Looking…</StatusPill>
          </Specimen>
          <Specimen caption="StatusPill · info">
            <StatusPill variant="info">Part recognized</StatusPill>
          </Specimen>
          <Specimen caption="StatusPill · error">
            <StatusPill variant="error">Blowfish server is not running.</StatusPill>
          </Specimen>
        </div>

        <div className="voice-specimens">
          {voiceStates.map((item) => (
            <Specimen key={item} caption={`VoicePill · ${item}`}>
              <VoicePill state={item} />
            </Specimen>
          ))}
        </div>

        <div className="specimen-grid specimen-grid--content">
          <Specimen caption="Captions" className="component-captions">
            <Captions
              wearer="Tell me about the battery."
              blowfish="This is the battery. It sits under the palm rest."
            />
          </Specimen>
          <Specimen caption="GestureHint">
            <GestureHint>Pinch to turn it. Pull your hands apart to open it.</GestureHint>
          </Specimen>
        </div>

        <div className="specimen-grid specimen-grid--cards">
          <Specimen caption="PartCard">
            <PartCard
              kicker="Part 7 of 12"
              name="Battery"
              summary="A multi-cell lithium-polymer battery, about 52.6 Wh, spread under the palm rest. It is held in place by stretch-release adhesive tabs."
              safety="Lithium battery: never puncture, bend or pry against the cells. A damaged cell can overheat and catch fire."
            />
          </Specimen>
          <Specimen caption="StepCard">
            <StepCard kicker="Step 4 of 7">
              Disconnect the battery from the logic board before touching anything else.
            </StepCard>
          </Specimen>
        </div>
      </div>
    </section>
  );
}

const colorTokens = [
  ["--bf-color-white", "#FFFFFF"],
  ["--bf-color-text", "rgba(255,255,255,.96)"],
  ["--bf-color-text-quiet", "rgba(255,255,255,.85)"],
  ["--bf-color-text-muted", "rgba(255,255,255,.62)"],
  ["--bf-color-caption-user", "rgba(255,255,255,.78)"],
  ["--bf-color-glass", "rgba(22,25,30,.64)"],
  ["--bf-color-glass-quiet", "rgba(36,39,44,.5)"],
  ["--bf-color-glass-strong", "rgba(16,19,24,.78)"],
  ["--bf-color-glass-soft", "rgba(255,255,255,.1)"],
  ["--bf-color-border", "rgba(255,255,255,.22)"],
  ["--bf-color-border-quiet", "rgba(255,255,255,.14)"],
  ["--bf-color-line-strong", "rgba(255,255,255,.75)"],
  ["--bf-color-accent", "#4DA3FF"],
  ["--bf-color-accent-soft", "rgba(77,163,255,.28)"],
  ["--bf-color-focus-glow", "rgba(77,163,255,.18)"],
  ["--bf-color-warm", "#FF9F45"],
  ["--bf-color-warm-soft", "rgba(255,159,69,.2)"],
  ["--bf-color-coral", "#FF7A6B"],
  ["--bf-color-shadow", "rgba(0,0,0,.28)"],
  ["--bf-color-scrim", "rgba(8,10,13,.45)"],
  ["--bf-color-scrim-center", "rgba(4,6,9,.38)"],
  ["--bf-color-scrim-edge", "rgba(8,10,13,.14)"],
  ["--bf-color-caption-backing", "rgba(12,13,15,.55)"],
];

function TokensSheet() {
  return (
    <section className="tokens-sheet" aria-labelledby="tokens-title">
      <div className="section-heading">
        <p className="eyebrow">System foundations</p>
        <h2 id="tokens-title">Tokens</h2>
        <p>A quiet, constrained vocabulary for readable see-through interfaces.</p>
      </div>

      <div className="token-panel">
        <div className="token-group token-group--colors">
          <h3>Colour</h3>
          <div className="swatch-grid">
            {colorTokens.map(([name, value]) => (
              <div className="swatch" key={name}>
                <i style={{ background: `var(${name})` }} />
                <span>
                  <strong>{name}</strong>
                  <small>{value}</small>
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="token-group">
          <h3>Radius</h3>
          <div className="radius-row">
            {[
              ["--bf-radius-small", "12px"],
              ["--bf-radius-caption", "16px"],
              ["--bf-radius-card", "22px"],
              ["--bf-radius-focus", "28px"],
              ["--bf-radius-pill", "999px"],
            ].map(([name, value]) => (
              <div key={name} style={{ borderRadius: `var(${name})` }}>
                <span>{name}</span>
                <small>{value}</small>
              </div>
            ))}
          </div>
        </div>

        <div className="token-group">
          <h3>Elevation</h3>
          <div className="elevation-row">
            {[1, 2, 3].map((level) => (
              <div key={level} style={{ boxShadow: `var(--bf-shadow-${level})` }}>
                <span>Level {level}</span>
                <small>--bf-shadow-{level}</small>
              </div>
            ))}
          </div>
        </div>

        <div className="token-group token-group--type">
          <h3>Type</h3>
          {[
            ["--bf-font-size-kicker", "Kicker · 16"],
            ["--bf-font-size-label", "Label · 17"],
            ["--bf-font-size-caption", "Caption · 18"],
            ["--bf-font-size-error", "Error · 18"],
            ["--bf-font-size-body", "Body · 19"],
            ["--bf-font-size-title", "Title · 20"],
            ["--bf-font-size-caption-reply", "Caption reply · 20"],
            ["--bf-font-size-card-name", "Card name · 24"],
          ].map(([name, text]) => (
            <p key={name} style={{ fontSize: `var(${name})` }}>
              <span>{text}</span>
              <small>{name}</small>
            </p>
          ))}
        </div>

        <div className="token-group">
          <h3>Spacing</h3>
          <div className="spacing-row">
            {[1, 2, 3, 4, 6, 8, 12].map((step) => (
              <div key={step}>
                <i style={{ width: `var(--bf-space-${step})` }} />
                <span>--bf-space-{step}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="token-group">
          <h3>Motion</h3>
          <div className="motion-row">
            <span>
              <i className="motion-dot motion-dot--fast" />
              200ms<small>--bf-duration-fast</small>
            </span>
            <span>
              <i className="motion-dot motion-dot--normal" />
              240ms<small>--bf-duration-normal</small>
            </span>
            <span>
              <i className="motion-dot motion-dot--slow" />
              1200ms<small>--bf-duration-slow</small>
            </span>
            <span>
              Ease out<small>--bf-easing-out</small>
            </span>
            <span>
              Gentle<small>--bf-easing-gentle</small>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
