import type { LabelState, Point } from "./components";

export type PartAnchor = {
  name: string;
  anchor: Point;
  state?: Exclude<LabelState, "focused">;
};

export type LaidOutPartLabel = PartAnchor & {
  label: Point;
  side: "left" | "right";
};

const STAGE_MIDPOINT = 960;
const LEFT_COLUMN_EDGE = 600;
const RIGHT_COLUMN_EDGE = 1320;
const COLUMN_CENTER_Y = 520;
const LABEL_PITCH = 64;
const LEADER_ELBOW = 32;
const LEADER_GAP = 6;
const MAX_UNTANGLE_ITERATIONS = 50;

type Segment = [Point, Point];

function leaderSegments(label: LaidOutPartLabel): Segment[] {
  const direction = label.side === "left" ? 1 : -1;
  const elbow = {
    x: label.label.x + direction * LEADER_ELBOW,
    y: label.label.y,
  };
  const end = {
    x: label.label.x + direction * LEADER_GAP,
    y: label.label.y,
  };
  return [
    [label.anchor, elbow],
    [elbow, end],
  ];
}

function orientation(a: Point, b: Point, c: Point) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: Point, b: Point, point: Point) {
  return (
    point.x >= Math.min(a.x, b.x) &&
    point.x <= Math.max(a.x, b.x) &&
    point.y >= Math.min(a.y, b.y) &&
    point.y <= Math.max(a.y, b.y)
  );
}

function segmentsIntersect([a, b]: Segment, [c, d]: Segment) {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);

  if (abC > 0 !== abD > 0 && cdA > 0 !== cdB > 0) return true;
  if (abC === 0 && onSegment(a, b, c)) return true;
  if (abD === 0 && onSegment(a, b, d)) return true;
  if (cdA === 0 && onSegment(c, d, a)) return true;
  if (cdB === 0 && onSegment(c, d, b)) return true;
  return false;
}

function leadersIntersect(a: LaidOutPartLabel, b: LaidOutPartLabel) {
  return leaderSegments(a).some((aSegment) =>
    leaderSegments(b).some((bSegment) => segmentsIntersect(aSegment, bSegment)),
  );
}

function untangleLabels(labels: LaidOutPartLabel[]) {
  for (let iteration = 0; iteration < MAX_UNTANGLE_ITERATIONS; iteration += 1) {
    let crossing: [number, number] | undefined;

    for (let first = 0; first < labels.length && !crossing; first += 1) {
      for (let second = first + 1; second < labels.length; second += 1) {
        if (leadersIntersect(labels[first], labels[second])) {
          crossing = [first, second];
          break;
        }
      }
    }

    if (!crossing) break;
    const [first, second] = crossing;
    [labels[first].label.y, labels[second].label.y] = [
      labels[second].label.y,
      labels[first].label.y,
    ];
  }

  return labels;
}

/**
 * Creates two stable label columns, then swaps intersecting label slots until
 * their complete polylines no longer cross.
 */
export function layoutPartLabels(anchors: PartAnchor[]): LaidOutPartLabel[] {
  const layoutColumn = (side: "left" | "right") => {
    const items = anchors
      .filter(({ anchor }) =>
        side === "left" ? anchor.x < STAGE_MIDPOINT : anchor.x >= STAGE_MIDPOINT,
      )
      .sort((a, b) => a.anchor.y - b.anchor.y);
    const firstY = COLUMN_CENTER_Y - ((items.length - 1) * LABEL_PITCH) / 2;

    return untangleLabels(
      items.map((item, index) => ({
        ...item,
        side,
        label: {
          x: side === "left" ? LEFT_COLUMN_EDGE : RIGHT_COLUMN_EDGE,
          y: firstY + index * LABEL_PITCH,
        },
      })),
    );
  };

  return [...layoutColumn("left"), ...layoutColumn("right")];
}
