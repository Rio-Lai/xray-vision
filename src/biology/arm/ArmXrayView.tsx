/**
 * React wrapper for the X-ray arm: a transparent three.js canvas (plus HTML labels with leader lines)
 * to lay over the video, like src/overlay/Overlay.tsx.
 *
 *   <ArmXrayView landmarks={frame} explode={1} layerFocus={2} highlight={{ 'forearm-flexors': 0.9 }}
 *                activity="typing" keystrokes={[...]} />
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { ArmXray, type ArmLabel } from './ArmXray';
import { loadArmTeardown, type Activity, type ArmFrame, type ArmTeardown, type Keystroke } from './types';

export interface ArmXrayProps {
  /** pose + hand landmarks for the current frame (from the live feed or a replayed trace) */
  landmarks: ArmFrame | null;
  /** 0 = on the arm, 1 = layers apart */
  explode: number;
  /** 1-6 or null */
  layerFocus: number | null;
  /** part id -> glow 0..1 */
  highlight: Record<string, number>;
  activity: Activity;
  keystrokes: Keystroke[];
  frozen?: boolean;
  side?: 'right' | 'left';
  showLabels?: boolean;
  /** called once the meshes are loaded and the first frame is drawn (previews) */
  onReady?: () => void;
  /**
   * Turn the arm in 3D about its own centre (yaw/pitch in radians, zoom factor). 0/0/1 keeps it lined up with
   * the real arm; anything else is for looking around it (e.g. /arm-demo drag-to-rotate).
   */
  view?: { yaw: number; pitch: number; zoom: number };
  /** layers not drawn at all (e.g. [1] = no skin) */
  hideLayers?: number[];
}

const FOV = 30;

/**
 * Anatomy-atlas style labels: one column to the right of the parts, sorted top to bottom, at least 26 px
 * apart, each joined to its part by a leader line. (Overlapping labels next to each part were unreadable.)
 */
function layoutLabels(list: ArmLabel[], w: number, h: number): ArmLabel[] {
  if (list.length === 0) return list;
  const right = Math.min(w - 240, Math.max(...list.map((l) => l.at[0])) + 90);
  const sorted = [...list].sort((a, b) => a.at[1] - b.at[1]);
  const GAP = 26;
  const ys: number[] = [];
  for (const l of sorted) ys.push(Math.max(l.at[1], (ys.length ? ys[ys.length - 1] : -Infinity) + GAP));
  // if the column runs off the bottom, shift it up
  const over = ys.length ? ys[ys.length - 1] - (h - 70) : 0;
  return sorted.map((l, i) => ({ ...l, label: [right, Math.max(70, ys[i] - Math.max(0, over))] as [number, number] }));
}

export function ArmXrayView(props: ArmXrayProps) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef(props);
  live.current = props;
  const [labels, setLabels] = useState<ArmLabel[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [td, setTd] = useState<ArmTeardown | null>(null);

  useEffect(() => {
    loadArmTeardown().then(setTd).catch((e) => console.error('[arm]', e));
  }, []);

  useEffect(() => {
    const el = host.current;
    if (!el || !td) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:0';
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.7;
    const key = new THREE.DirectionalLight(0xffffff, 1.8);
    key.position.set(-0.5, 1, 1.2);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xbfd8ff, 0.8);
    rim.position.set(1, -0.4, -0.6);
    scene.add(rim);

    const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 20000);
    const arm = new ArmXray(td);
    // pivot (at the arm's centre) -> offset (-centre) -> arm.root: rotating the pivot spins the arm in place
    const pivot = new THREE.Group();
    const offset = new THREE.Group();
    pivot.add(offset);
    offset.add(arm.root);
    scene.add(pivot);
    const centre = new THREE.Vector3();
    let centreSet = false;
    const userQ = new THREE.Quaternion();
    const euler = new THREE.Euler(0, 0, 0, 'YXZ');
    if (import.meta.env.DEV) (window as unknown as { __arm?: unknown }).__arm = { arm, scene, camera };
    let readySent = false;
    let w = 0;
    let h = 0;
    let dist = 1;
    // camera framing for the tour: ease towards the focused layer's offset
    const look = new THREE.Vector3();
    const lookTarget = new THREE.Vector3();
    let zoom = 1;
    // direction from the target to the camera; (0,0,1) = straight on, like the real camera
    const viewDir = new THREE.Vector3(0, 0, 1);
    const viewDirTarget = new THREE.Vector3(0, 0, 1);
    let userZoom = 1;

    let raf = 0;
    let lastLabels = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const W = el.clientWidth;
      const H = el.clientHeight;
      if (W !== w || H !== h) {
        w = W;
        h = H;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        // place the camera so the z = 0 plane maps 1:1 to canvas pixels (landmarks line up with the video)
        dist = h / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
        camera.near = dist * 0.05;
        camera.far = dist * 4;
        setSize({ w, h });
      }
      const p = live.current;
      const now = performance.now();
      const out = arm.update({
        frame: p.landmarks,
        width: w,
        height: h,
        explode: p.explode,
        layerFocus: p.layerFocus,
        highlight: new Map(Object.entries(p.highlight)),
        keystrokes: p.keystrokes,
        now,
        frozen: p.frozen,
        side: p.side,
        hideLayers: p.hideLayers,
      });
      // tour framing: when a layer is focused, drift slightly towards it and zoom in a little
      if (p.layerFocus && p.explode > 0.5) {
        const g = arm.root.children.find((c) => c.name === `layer-${p.layerFocus}`);
        if (g) lookTarget.copy(g.position).multiplyScalar(0.9).add(new THREE.Vector3(0, -0.06 * h, 0));
        zoom += (1.12 - zoom) * 0.06;
      } else if (p.explode > 0.5) {
        // fully exploded: centre the fanned-out stack (between the bones and the skin)
        const a = arm.root.children.find((c) => c.name === 'layer-1');
        if (a) lookTarget.copy(a.position).multiplyScalar(0.5);
        zoom += (0.8 - zoom) * 0.06;
      } else {
        lookTarget.set(0, 0, 0);
        zoom += (1 - zoom) * 0.06;
      }
      // Step 6 (bones): orbit round to look at the forearm from behind (posterior aspect), the classic view in
      // which the radius is seen crossing over the ulna in pronation. From the head camera the crossing is
      // front-to-back, so it would otherwise be invisible.
      const geo = arm.geometry;
      if (p.layerFocus === 6 && p.explode > 0.5 && geo) {
        const post = geo.elbowFrame.anterior.clone().negate();
        if (post.z < 0) post.negate();
        viewDirTarget.set(0, 0, 1).lerp(post, 0.7).normalize();
      } else viewDirTarget.set(0, 0, 1);
      viewDir.lerp(viewDirTarget, 0.05).normalize();
      look.lerp(lookTarget, 0.06);
      // user rotation about the arm's centre (shoulder/elbow/wrist/fingertips average), smoothed
      if (geo) {
        const c = geo.p.shoulder.clone().add(geo.p.elbow).add(geo.p.wrist).add(geo.p.hand[12]).multiplyScalar(0.25);
        if (!centreSet) centre.copy(c);
        else centre.lerp(c, 0.1);
        centreSet = true;
      }
      const v = p.view ?? { yaw: 0, pitch: 0, zoom: 1 };
      euler.set(v.pitch, v.yaw, 0);
      userQ.setFromEuler(euler);
      pivot.quaternion.slerp(userQ, 0.18);
      pivot.position.copy(centre);
      offset.position.copy(centre).negate();
      camera.position.copy(look).addScaledVector(viewDir, dist);
      camera.up.set(0, 1, 0);
      if (Math.abs(viewDir.y) > 0.9) camera.up.copy(geo ? geo.elbowFrame.axis : new THREE.Vector3(1, 0, 0));
      userZoom += ((p.view?.zoom ?? 1) - userZoom) * 0.15;
      camera.zoom = zoom * userZoom;
      camera.updateProjectionMatrix();
      camera.lookAt(look);
      arm.perspective = (z) => (dist / Math.max(1, dist - z)) * zoom;
      renderer.render(scene, camera);
      if (now - lastLabels > 60) {
        lastLabels = now;
        // project each label point with the real camera (it drifts, zooms and orbits during the tour)
        camera.updateMatrixWorld();
        setLabels(
          out.map((l) => {
            pivot.updateMatrixWorld(true);
            const v = arm.root.localToWorld(new THREE.Vector3(...l.world)).project(camera);
            const at: [number, number] = [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h];
            return { ...l, at, label: [at[0] + 70, at[1] - 34] };
          }),
        );
      }
      if (!readySent && out.length > 0) {
        readySent = true;
        arm.ready.then(() => setTimeout(() => live.current.onReady?.(), 400));
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      arm.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, [td]);

  const shown = props.showLabels === false ? [] : layoutLabels(labels.filter((l) => l.visible), size.w, size.h);
  return (
    <div ref={host} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      <svg width={size.w} height={size.h} style={{ position: 'absolute', inset: 0, overflow: 'visible', zIndex: 1 }}>
        {shown.map((l) => (
          <g key={l.id}>
            <line x1={l.at[0]} y1={l.at[1]} x2={l.label[0]} y2={l.label[1]} stroke={l.glow > 0.3 ? '#ffd27a' : 'rgba(230,247,255,0.75)'} strokeWidth={1.4} />
            <circle cx={l.at[0]} cy={l.at[1]} r={3} fill={l.glow > 0.3 ? '#ffd27a' : '#e6f7ff'} />
          </g>
        ))}
      </svg>
      {shown.map((l) => (
        <div
          key={l.id}
          style={{
            position: 'absolute',
            zIndex: 2,
            left: l.label[0] + 4,
            top: l.label[1] - 11,
            padding: '2px 8px',
            borderRadius: 6,
            font: '600 13px/1.4 -apple-system, Helvetica, sans-serif',
            color: l.glow > 0.3 ? '#1a1206' : '#e6f7ff',
            background: l.glow > 0.3 ? 'rgba(255,210,122,0.95)' : 'rgba(10,18,28,0.72)',
            whiteSpace: 'nowrap',
          }}
        >
          {l.name}
        </div>
      ))}
    </div>
  );
}
