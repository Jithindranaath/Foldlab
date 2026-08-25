import { useEffect, useMemo, useRef, useState } from 'react';
import type { FoldSchedule } from '../core/types.ts';

interface Props {
  schedule: FoldSchedule;
}

const KIND_COLOR: Record<string, string> = { cut: 'var(--cut)', crease: 'var(--crease)', perf: 'var(--perf)' };

// Desired on-screen size for ruler ticks, in real CSS pixels — independent
// of the dieline's own millimetre scale or how wide the panel happens to
// render. The SVG's viewBox is sized in sheet millimetres (which can be a
// few dozen mm for a small carton or 1000+ for a large one), so a fixed
// user-unit font size looks fine on one dieline and is unreadably tiny (or
// comically huge) on another. Converting through a live px-per-unit ratio,
// measured off the actual rendered element, keeps tick text legible no
// matter what shape or size of sheet is loaded.
const TICK_FONT_PX = 10;
const TICK_STROKE_PX = 1;
const TICK_LENGTH_PX = 6;

export default function DielineView({ schedule }: Props) {
  const bounds = useMemo(() => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of schedule.panels) {
      minX = Math.min(minX, p.bbox.x);
      minY = Math.min(minY, p.bbox.y);
      maxX = Math.max(maxX, p.bbox.x + p.bbox.w);
      maxY = Math.max(maxY, p.bbox.y + p.bbox.h);
    }
    if (!isFinite(minX)) return { minX: 0, minY: 0, w: 100, h: 100 };
    return { minX, minY, w: maxX - minX, h: maxY - minY };
  }, [schedule.panels]);

  const toSvgY = (y: number) => bounds.h - (y - bounds.minY);
  const toSvgX = (x: number) => x - bounds.minX;

  const svgRef = useRef<SVGSVGElement>(null);
  const [pxPerUnit, setPxPerUnit] = useState(1);
  // Margin has to grow in user-units as the sheet's real-world size grows
  // (pxPerUnit shrinks), or the fixed-pixel tick marks/labels get clipped
  // by the viewBox edge on a large dieline — 16 is just the floor for
  // small sheets, matched to the original hand-picked value.
  const margin = Math.max(16, (TICK_LENGTH_PX + TICK_FONT_PX * 2.4) / pxPerUnit);
  const viewBoxWidth = bounds.w + margin * 2;
  const viewBoxHeight = bounds.h + margin * 2;

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const measure = () => {
      const renderedWidth = el.getBoundingClientRect().width;
      if (renderedWidth > 0 && viewBoxWidth > 0) setPxPerUnit(renderedWidth / viewBoxWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [viewBoxWidth]);

  // User-space sizes that resolve to a constant CSS pixel size once the SVG
  // scales them by pxPerUnit — see the comment on the *_PX constants above.
  const tickFontSize = TICK_FONT_PX / pxPerUnit;
  const tickStrokeWidth = TICK_STROKE_PX / pxPerUnit;
  const tickLength = TICK_LENGTH_PX / pxPerUnit;
  const tickLabelGap = tickLength + (TICK_FONT_PX * 0.35) / pxPerUnit;

  const ticks = useMemo(() => {
    const step = 50;
    const xs: number[] = [];
    for (let v = Math.ceil(bounds.minX / step) * step; v < bounds.minX + bounds.w; v += step) xs.push(v);
    const ys: number[] = [];
    for (let v = Math.ceil(bounds.minY / step) * step; v < bounds.minY + bounds.h; v += step) ys.push(v);
    return { xs, ys };
  }, [bounds]);

  return (
    <div>
      <div className="panel-section-title">Legend</div>
      <div className="legend-row">
        <span className="legend-swatch" style={{ background: 'var(--cut)' }} />
        Cut
      </div>
      <div className="legend-row">
        <span className="legend-swatch" style={{ background: 'var(--crease)' }} />
        Crease
      </div>
      <div className="legend-row">
        <span className="legend-swatch" style={{ background: 'var(--perf)' }} />
        Perforation
      </div>

      <div className="panel-section-title">Dieline</div>
      <div className="dieline-svg-wrap">
        <svg
          ref={svgRef}
          viewBox={`${-margin} ${-margin} ${viewBoxWidth} ${viewBoxHeight}`}
          role="img"
          aria-label="2D dieline"
        >
          {ticks.xs.map((v) => (
            <g key={`x${v}`}>
              <line
                x1={toSvgX(v)}
                y1={-tickLength}
                x2={toSvgX(v)}
                y2={0}
                stroke="var(--text-dim)"
                strokeWidth={tickStrokeWidth}
              />
              <text x={toSvgX(v)} y={-tickLabelGap} fontSize={tickFontSize} fill="var(--text-dim)" textAnchor="middle">
                {v}
              </text>
            </g>
          ))}
          {ticks.ys.map((v) => (
            <g key={`y${v}`}>
              <line
                x1={-tickLength}
                y1={toSvgY(v)}
                x2={0}
                y2={toSvgY(v)}
                stroke="var(--text-dim)"
                strokeWidth={tickStrokeWidth}
              />
              <text
                x={-tickLabelGap}
                y={toSvgY(v)}
                fontSize={tickFontSize}
                fill="var(--text-dim)"
                textAnchor="end"
                dominantBaseline="middle"
              >
                {v}
              </text>
            </g>
          ))}

          {schedule.segments.map((seg, i) => (
            <line
              key={i}
              x1={toSvgX(seg.a.x)}
              y1={toSvgY(seg.a.y)}
              x2={toSvgX(seg.b.x)}
              y2={toSvgY(seg.b.y)}
              stroke={KIND_COLOR[seg.kind]}
              strokeWidth={0.5}
              strokeLinecap="round"
              pointerEvents="none"
            />
          ))}
        </svg>
      </div>
    </div>
  );
}
