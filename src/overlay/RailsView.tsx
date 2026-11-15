/**
 * The "light-path rails" view (`?detail=1`, store.rails, shared/rails.ts): a flat, front-on comparison drawn
 * where the detail model is drawn (the right half beside a model on stage), in plain SVG and CSS. Two rails,
 * "iPhone" on top and "Eye" below, with the same stage of the light path in each of five columns; soft yellow
 * dots of light flow left to right along both all the time.
 *
 * When a step is lit (store.detailStep): this view's own pointer dot flies to the top part of that step's
 * column and pulses once; 450 ms later a dashed line draws down the column to the eye part, which pulses
 * once; everything outside the column dims. Nothing repeats. With no step lit everything is at full opacity
 * and there is no pointer.
 *
 * The app-wide pointer (src/overlay/pointer.ts) is not used: while this view is up it keeps the detail slot
 * fresh and empty every frame (pointerTarget.ts), so the app-wide pointer stays hidden; the slot is cleared
 * when it goes. Mounted by DetailStage.tsx; pointer events off; no three.js.
 */
import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useStore } from '../state/store';
import { railsStep, type RailsScene } from '../../shared/rails';
import { clearPointer, publishPointer } from './pointerTarget';

/** Where on the page the view goes (DetailStage's detailArea), in viewport px. */
export interface RailsArea {
  x: number;
  y: number;
  w: number;
  h: number;
}

/* ---------- layout (viewBox units: 1000 x 560) ---------- */

const VB_W = 1000;
const VB_H = 560;
/** The rails run from here to here; the rail names sit to the left of RAIL_X0. */
const RAIL_X0 = 120;
const RAIL_X1 = 980;
/** Top rail (iPhone) at 35 percent of the height, bottom rail (Eye) at 65 percent. */
const TOP_Y = Math.round(VB_H * 0.35);
const BOT_Y = Math.round(VB_H * 0.65);
/** A glyph reaches about this far above and below its rail. */
const GLYPH_HALF = 40;
const LABEL_SIZE = 22;
const PILL_H = 38;

/** The x of column i of n: evenly spaced, each in the middle of its share of the rail. */
export function columnX(i: number, n: number): number {
  const span = (RAIL_X1 - RAIL_X0) / Math.max(1, n);
  return RAIL_X0 + span * (i + 0.5);
}

/* ---------- timing ---------- */

const FLY_MS = 400;
const PULSE_MS = 700;
/** The link starts this long after the pulse starts. */
const LINK_AFTER_MS = 450;
const LINK_MS = 650;
const DIM_TO = 0.2;
/** Dots of light: this share of the rail length per second. */
const FLOW_SPEED = 0.22;
const DOTS_PER_RAIL = 7;

/* ---------- colours ---------- */

const C = {
  light: '#ffe08a',
  glass: '#a8d8ff',
  glassEdge: '#e8eef5',
  coil: '#e8742c',
  sensor: '#9fd3f0',
  sensorFrame: '#e2b84a',
  chip: '#a493f0',
  iris: '#7fa7d9',
  ciliary: '#d99a8a',
  retina: '#7fd1a1',
  nerve: '#f0d28a',
  accent: '#4DA3FF',
} as const;

const CSS = `
@keyframes bf-rails-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes bf-rails-pulse { 0% { opacity: 0.9; transform: scale(${(8 / 42).toFixed(3)}); } 100% { opacity: 0; transform: scale(1); } }
@keyframes bf-rails-draw { to { stroke-dashoffset: 0; } }
.bf-rails-pulse { opacity: 0; transform-box: fill-box; transform-origin: center; }
`;

/* ---------- glyphs: one per part, centred on (x, y) ---------- */

function iphoneGlyph(col: string, x: number, y: number): ReactNode {
  switch (col) {
    case 'window':
      // the sapphire cover: clear glass in an orange ring
      return (
        <>
          <circle cx={x} cy={y} r={30} fill={C.glass} fillOpacity={0.3} stroke={C.coil} strokeWidth={6} />
          <circle cx={x - 9} cy={y - 9} r={7} fill={C.glassEdge} fillOpacity={0.55} />
        </>
      );
    case 'opening':
      // a fixed opening: nothing to adjust
      return (
        <>
          <circle cx={x} cy={y} r={28} fill="none" stroke={C.glassEdge} strokeOpacity={0.7} strokeWidth={3} />
          <text x={x} y={y + 6} textAnchor="middle" fontSize={17} fill={C.glassEdge} fillOpacity={0.85}>
            fixed
          </text>
        </>
      );
    case 'focus': {
      // a stack of 7 lens elements inside an orange focus coil
      const lenses = Array.from({ length: 7 }, (_, i) => (
        <ellipse key={i} cx={x - 24 + i * 8} cy={y} rx={3.5} ry={i === 0 || i === 6 ? 20 : 26} fill={C.glass} fillOpacity={0.6} stroke={C.glassEdge} strokeOpacity={0.5} strokeWidth={1} />
      ));
      return (
        <>
          <rect x={x - 37} y={y - 37} width={74} height={74} rx={12} fill="none" stroke={C.coil} strokeWidth={5} strokeDasharray="7 4" />
          {lenses}
        </>
      );
    }
    case 'image':
      // the 48 MP sensor: blue with a yellow frame
      return (
        <>
          <rect x={x - 30} y={y - 30} width={60} height={60} rx={4} fill={C.sensor} stroke={C.sensorFrame} strokeWidth={6} />
          <path d={`M ${x - 10} ${y - 24} V ${y + 24} M ${x + 10} ${y - 24} V ${y + 24} M ${x - 24} ${y - 10} H ${x + 24} M ${x - 24} ${y + 10} H ${x + 24}`} stroke="#0d1a24" strokeOpacity={0.25} strokeWidth={2} />
        </>
      );
    case 'meaning': {
      // the A19 Pro chip: violet, with pins
      const pins: ReactNode[] = [];
      for (let i = -2; i <= 2; i++) {
        const o = i * 11;
        pins.push(<path key={`p${i}`} d={`M ${x + o} ${y - 38} V ${y - 30} M ${x + o} ${y + 30} V ${y + 38} M ${x - 38} ${y + o} H ${x - 30} M ${x + 30} ${y + o} H ${x + 38}`} stroke={C.chip} strokeWidth={3} />);
      }
      return (
        <>
          {pins}
          <rect x={x - 30} y={y - 30} width={60} height={60} rx={7} fill={C.chip} />
          <text x={x} y={y + 6} textAnchor="middle" fontSize={17} fontWeight={600} fill="#1b1530">
            A19
          </text>
        </>
      );
    }
    default:
      return null;
  }
}

function eyeGlyph(col: string, x: number, y: number): ReactNode {
  switch (col) {
    case 'window':
      // the cornea: a clear curved front, bulging towards the light (left)
      return <path d={`M ${x + 10} ${y - 36} Q ${x - 34} ${y} ${x + 10} ${y + 36}`} fill={C.glass} fillOpacity={0.25} stroke={C.glassEdge} strokeWidth={5} strokeLinecap="round" />;
    case 'opening':
      // the iris: two blue bars with the pupil gap between them
      return (
        <>
          <rect x={x - 7} y={y - 38} width={14} height={26} rx={4} fill={C.iris} />
          <rect x={x - 7} y={y + 12} width={14} height={26} rx={4} fill={C.iris} />
        </>
      );
    case 'focus':
      // the crystalline lens, with the ciliary muscle above and below it
      return (
        <>
          <ellipse cx={x} cy={y - 33} rx={14} ry={7} fill={C.ciliary} />
          <ellipse cx={x} cy={y + 33} rx={14} ry={7} fill={C.ciliary} />
          <ellipse cx={x} cy={y} rx={15} ry={24} fill={C.glass} fillOpacity={0.6} stroke={C.glassEdge} strokeWidth={2} />
        </>
      );
    case 'image':
      // the retina: a green arc at the back of the eye
      return <path d={`M ${x - 12} ${y - 36} A 40 40 0 0 1 ${x - 12} ${y + 36}`} fill="none" stroke={C.retina} strokeWidth={7} strokeLinecap="round" />;
    case 'meaning':
      // the optic nerve, on its way to the brain (right)
      return (
        <>
          <path d={`M ${x - 30} ${y} C ${x - 10} ${y - 14}, ${x + 6} ${y + 14}, ${x + 22} ${y}`} fill="none" stroke={C.nerve} strokeWidth={9} strokeLinecap="round" />
          <path d={`M ${x + 22} ${y - 12} L ${x + 38} ${y} L ${x + 22} ${y + 12} Z`} fill={C.nerve} />
        </>
      );
    default:
      return null;
  }
}

/* ---------- labels ---------- */

/** A frosted pill with its text, centred on x, kept inside the view. */
function Pill({ x, y, text }: { x: number; y: number; text: string }) {
  // a width estimate from the text length (no measuring: the view never moves its parts)
  const w = Math.round(text.length * LABEL_SIZE * 0.56 + 32);
  const left = Math.max(8, Math.min(VB_W - 8 - w, x - w / 2));
  return (
    <g style={{ animation: 'bf-rails-in 0.3s ease-out both' }}>
      <rect x={left} y={y} width={w} height={PILL_H} rx={PILL_H / 2} fill="rgba(16, 19, 24, 0.74)" stroke="rgba(255, 255, 255, 0.18)" strokeWidth={1.5} />
      <text x={left + w / 2} y={y + PILL_H / 2 + LABEL_SIZE * 0.36} textAnchor="middle" fontSize={LABEL_SIZE} fontWeight={600} fill="#fff">
        {text}
      </text>
    </g>
  );
}

/* ---------- dots of light ---------- */

function LightDots({ y }: { y: number }) {
  const len = RAIL_X1 - RAIL_X0;
  const dur = 1 / FLOW_SPEED;
  return (
    <g>
      {Array.from({ length: DOTS_PER_RAIL }, (_, i) => (
        <g key={i}>
          {/* SMIL: smooth in Chrome, no frames of our own; spread along the rail by a negative start */}
          <animateTransform attributeName="transform" type="translate" from="0 0" to={`${len} 0`} dur={`${dur}s`} begin={`${(-dur * i) / DOTS_PER_RAIL}s`} repeatCount="indefinite" />
          <circle cx={RAIL_X0} cy={y} r={11} fill={C.light} fillOpacity={0.16} />
          <circle cx={RAIL_X0} cy={y} r={5} fill={C.light} fillOpacity={0.85} />
        </g>
      ))}
    </g>
  );
}

/* ---------- the view ---------- */

function RailsSvg({ scene, step }: { scene: RailsScene; step: number | null }) {
  const n = scene.columns.length;
  const lit = step !== null ? railsStep(scene, step) : null;
  const litIndex = lit ? lit.index : -1;
  const dimOf = (i: number): CSSProperties => ({ opacity: litIndex >= 0 && i !== litIndex ? DIM_TO : 1, transition: 'opacity 0.4s ease' });
  const restDim: CSSProperties = { opacity: litIndex >= 0 ? DIM_TO : 1, transition: 'opacity 0.4s ease' };
  const px = litIndex >= 0 ? columnX(litIndex, n) : 0;
  const linkY0 = TOP_Y + GLYPH_HALF + 4;
  const linkY1 = BOT_Y - GLYPH_HALF - 4;
  const linkLen = linkY1 - linkY0;
  return (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style={{ overflow: 'visible', fontFamily: 'system-ui, -apple-system, "SF Pro Text", Inter, sans-serif' }} aria-hidden="true">
      <style>{CSS}</style>
      {/* the rails, their names and the light (dimmed with everything else outside the lit column) */}
      <g style={restDim}>
        {[
          { y: TOP_Y, label: scene.rails[0].label },
          { y: BOT_Y, label: scene.rails[1].label },
        ].map((r) => (
          <g key={r.label}>
            <line x1={RAIL_X0} y1={r.y} x2={RAIL_X1} y2={r.y} stroke="rgba(255, 255, 255, 0.22)" strokeWidth={2} />
            <text x={RAIL_X0 - 16} y={r.y + 8} textAnchor="end" fontSize={LABEL_SIZE} fontWeight={600} fill="rgba(255, 255, 255, 0.85)">
              {r.label}
            </text>
          </g>
        ))}
        <LightDots y={TOP_Y} />
        <LightDots y={BOT_Y} />
      </g>
      {/* the columns: iPhone part on top, eye part below */}
      {scene.columns.map((col, i) => {
        const x = columnX(i, n);
        return (
          <g key={col.id} style={dimOf(i)}>
            {iphoneGlyph(col.id, x, TOP_Y)}
            {eyeGlyph(col.id, x, BOT_Y)}
          </g>
        );
      })}
      {lit && (
        <>
          {/* the lit pair's labels: above the top rail, below the bottom rail */}
          <g key={`t${step}`}>
            <Pill x={px} y={TOP_Y - GLYPH_HALF - 14 - PILL_H} text={lit.column.iphone.label} />
          </g>
          <g key={`b${step}`}>
            <Pill x={px} y={BOT_Y + GLYPH_HALF + 14} text={lit.column.eye.label} />
          </g>
          {/* the dashed link down the column, drawn after the top part's pulse begins; the eye part pulses as it arrives */}
          <mask id={`bf-rails-link-${step}`} key={`m${step}`} maskUnits="userSpaceOnUse" x={0} y={0} width={VB_W} height={VB_H}>
            <line
              x1={px}
              y1={linkY0}
              x2={px}
              y2={linkY1}
              stroke="#fff"
              strokeWidth={10}
              strokeDasharray={`${linkLen} ${linkLen}`}
              strokeDashoffset={linkLen}
              style={{ animation: `bf-rails-draw ${LINK_MS}ms cubic-bezier(0.33, 1, 0.68, 1) ${FLY_MS + LINK_AFTER_MS}ms forwards` }}
            />
          </mask>
          <line key={`l${step}`} x1={px} y1={linkY0} x2={px} y2={linkY1} stroke={C.accent} strokeWidth={3} strokeDasharray="7 6" strokeLinecap="round" mask={`url(#bf-rails-link-${step})`} />
          <circle key={`pt${step}`} className="bf-rails-pulse" cx={px} cy={TOP_Y} r={42} fill="none" stroke={C.accent} strokeWidth={2} style={{ animation: `bf-rails-pulse ${PULSE_MS}ms ease-out ${FLY_MS}ms forwards` }} />
          <circle key={`pb${step}`} className="bf-rails-pulse" cx={px} cy={BOT_Y} r={42} fill="none" stroke={C.accent} strokeWidth={2} style={{ animation: `bf-rails-pulse ${PULSE_MS}ms ease-out ${FLY_MS + LINK_AFTER_MS + LINK_MS}ms forwards` }} />
          {/* this view's own pointer: flies to the top part of the lit column (no step: none) */}
          <g key="pointer" style={{ transform: `translate(${px}px, ${TOP_Y}px)`, transition: `transform ${FLY_MS}ms cubic-bezier(0.22, 1, 0.36, 1)` }}>
            <g style={{ animation: 'bf-rails-in 0.2s ease-out both' }}>
              <circle cx={0} cy={0} r={17} fill={C.accent} fillOpacity={0.18} />
              <circle cx={0} cy={0} r={6.5} fill={C.accent} />
            </g>
          </g>
        </>
      )}
    </svg>
  );
}

/** Mounted by DetailStage.tsx (`?detail=1`): nothing unless a checked rails view is up. */
export function RailsView({ areaOf }: { areaOf: (beside: boolean, vw: number, vh: number) => RailsArea }) {
  const rails = useStore((s) => s.rails);
  const step = useStore((s) => s.detailStep);
  const beside = useStore((s) => s.teardown !== null);
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Keep the detail pointer slot fresh and empty while this view is up, so the app-wide pointer stays hidden
  // (and never flies back to the main model's highlight); cleared when the view goes.
  useEffect(() => {
    if (!rails) return;
    let raf = 0;
    const hold = () => {
      publishPointer('detail', [], [], Math.max(1, window.innerWidth), Math.max(1, window.innerHeight));
      raf = requestAnimationFrame(hold);
    };
    hold();
    return () => {
      cancelAnimationFrame(raf);
      clearPointer('detail');
    };
  }, [rails]);

  if (!rails) return null;
  const a = areaOf(beside, Math.max(1, size.w), Math.max(1, size.h));
  return (
    <div
      key={rails.id}
      style={{
        position: 'absolute',
        left: a.x,
        top: a.y,
        width: a.w,
        height: a.h,
        pointerEvents: 'none',
        animation: 'bf-rails-in 0.35s ease-out both',
        // the same soft dark pool the 3D detail model has, so the glyphs read over a bright camera view
        background: 'radial-gradient(closest-side, rgba(8, 10, 14, 0.5), rgba(8, 10, 14, 0))',
      }}
    >
      <RailsSvg scene={rails} step={step} />
    </div>
  );
}

export default RailsView;
