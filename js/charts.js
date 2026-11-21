/**
 * @fileoverview Pure SVG responsive data-visualization charts for NeuroScope-RANO.
 * Zero external dependencies; renders crisp clinical charts with interactive hover tooltips:
 *  - Longitudinal RANO 2.0 Trajectory Chart (dual-axis 3D Volume cm³ & 2D SPD mm² + Nadir line)
 *  - RANO-Resect EOR Pre-Op vs. Post-Op Compartment Comparison Chart
 *  - Multi-Region AI Segmentation QA Benchmark Chart (Dice, IoU, Sensitivity, Precision)
 *  - Whole-Tumor Compartment Proportion Bar
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const FONT_MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Consolas, monospace";
const FONT_SANS = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

/**
 * Create an SVG element with attributes.
 * @param {string} tag
 * @param {Record<string, string | number>} [attrs]
 * @param {string} [text]
 * @returns {SVGElement}
 */
function svgEl(tag, attrs = {}, text) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) {
      el.setAttribute(k, String(v));
    }
  }
  if (text !== undefined) {
    el.textContent = text;
  }
  return el;
}

/**
 * Escape HTML characters for safe tooltip rendering.
 * @param {string} str
 * @returns {string}
 */
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Compute a clean "nice" upper axis ceiling for positive numeric data.
 * @param {number} maxVal
 * @param {number} [minCeiling=1]
 * @returns {number}
 */
function niceCeiling(maxVal, minCeiling = 1) {
  const safe = Number.isFinite(maxVal) && maxVal > 0 ? maxVal : minCeiling;
  const padded = safe * 1.15;
  const exp = Math.floor(Math.log10(padded));
  const frac = padded / Math.pow(10, exp);
  let niceFrac;
  if (frac <= 1.2) niceFrac = 1.2;
  else if (frac <= 1.5) niceFrac = 1.5;
  else if (frac <= 2) niceFrac = 2;
  else if (frac <= 2.5) niceFrac = 2.5;
  else if (frac <= 3) niceFrac = 3;
  else if (frac <= 4) niceFrac = 4;
  else if (frac <= 5) niceFrac = 5;
  else if (frac <= 6) niceFrac = 6;
  else if (frac <= 8) niceFrac = 8;
  else niceFrac = 10;
  return Math.max(minCeiling, niceFrac * Math.pow(10, exp));
}

/**
 * Create and manage a floating tooltip element inside a chart container.
 * @param {HTMLElement} container
 */
function createTooltipController(container) {
  const tip = document.createElement('div');
  tip.className = 'chart-tooltip hidden';
  container.appendChild(tip);

  const show = (clientX, clientY, html) => {
    tip.innerHTML = html;
    tip.classList.remove('hidden');
    const rect = container.getBoundingClientRect();
    let x = clientX - rect.left;
    let y = clientY - rect.top;
    const tipW = tip.offsetWidth || 140;
    const halfW = tipW * 0.5 + 6;
    if (x < halfW) x = halfW;
    if (x > rect.width - halfW) x = Math.max(halfW, rect.width - halfW);
    if (y < 42) y = 42;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  };

  const hide = () => {
    tip.classList.add('hidden');
  };

  return { show, hide };
}

/**
 * Attach pointer/focus tooltip handlers to an SVG interactive hit element.
 * @param {SVGElement} el
 * @param {{ show: Function, hide: Function }} tip
 * @param {() => string} getHtml
 */
function bindSvgTooltip(el, tip, getHtml) {
  el.classList.add('svg-hit');
  el.addEventListener('pointerenter', (e) => tip.show(e.clientX, e.clientY, getHtml()));
  el.addEventListener('pointermove', (e) => tip.show(e.clientX, e.clientY, getHtml()));
  el.addEventListener('pointerleave', () => tip.hide());
  el.addEventListener('focus', () => {
    const r = el.getBoundingClientRect();
    tip.show(r.left + r.width * 0.5, r.top, getHtml());
  });
  el.addEventListener('blur', () => tip.hide());
}

/**
 * Format compact numeric tick labels.
 * @param {number} val
 * @param {number} [decimals=1]
 */
function fmtTick(val, decimals = 1) {
  if (!Number.isFinite(val)) return '0';
  if (Math.abs(val) >= 100 || Math.abs(val - Math.round(val)) < 1e-6) {
    return String(Math.round(val));
  }
  return val.toFixed(decimals);
}

// ============================================================================
// 1. Longitudinal RANO 2.0 Dual-Metric Trajectory Chart
// ============================================================================

/**
 * Render an interactive SVG longitudinal trajectory chart plotting 3D Volume (cm³)
 * and 2D Axial SPD (mm²) across timepoints with a horizontal Nadir reference line.
 *
 * @param {HTMLElement | null} container
 * @param {Array<{ id: string, label: string, date?: string, spdMm2: number, volumeCm3: number, includeInRano?: boolean, role?: string }>} timepoints
 * @param {Object | null} rano2Result - Output from computeRano2Response().
 */
export function renderLongitudinalChart(container, timepoints, rano2Result) {
  if (!container) return;
  container.innerHTML = '';

  if (!Array.isArray(timepoints) || timepoints.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'chart-empty';
    empty.textContent = 'Add longitudinal timepoints to visualize tumor trajectory.';
    container.appendChild(empty);
    return;
  }

  const W = 430;
  const H = 205;
  const padL = 44;
  const padR = 46;
  const padT = 28;
  const padB = 42;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const vols = timepoints.map((t) => Math.max(0, Number(t.volumeCm3) || 0));
  const spds = timepoints.map((t) => Math.max(0, Number(t.spdMm2) || 0));

  const maxVol = niceCeiling(Math.max(...vols, rano2Result?.nadir?.volumeCm3 || 0), 2);
  const maxSpd = niceCeiling(Math.max(...spds, rano2Result?.nadir?.spdMm2 || 0), 200);

  const n = timepoints.length;
  const xFor = (i) => (n === 1 ? padL + plotW * 0.5 : padL + (i / (n - 1)) * plotW);
  const yVol = (v) => padT + plotH - (Math.max(0, v) / maxVol) * plotH;
  const ySpd = (s) => padT + plotH - (Math.max(0, s) / maxSpd) * plotH;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': 'Longitudinal RANO 2.0 Tumor Volume and 2D SPD Trajectory',
  });

  // Gradient for Volume area fill
  const defs = svgEl('defs');
  const grad = svgEl('linearGradient', { id: 'ns-vol-area', x1: '0', y1: '0', x2: '0', y2: '1' });
  grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#38bdf8', 'stop-opacity': '0.24' }));
  grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#38bdf8', 'stop-opacity': '0.01' }));
  defs.appendChild(grad);
  svg.appendChild(defs);

  // Top Legend
  const legendY = 12;
  const legendItems = [
    { x: padL, color: '#38bdf8', dash: '', label: '3D Vol (cm³)' },
    { x: padL + 106, color: '#2dd4bf', dash: '4 2.5', label: '2D SPD (mm²)' },
    { x: padL + 214, color: '#f59e0b', dash: '2.5 2.5', label: 'Nadir Ref' },
  ];
  for (const item of legendItems) {
    svg.appendChild(svgEl('line', {
      x1: item.x,
      y1: legendY,
      x2: item.x + 14,
      y2: legendY,
      stroke: item.color,
      'stroke-width': 2,
      'stroke-dasharray': item.dash || undefined,
    }));
    svg.appendChild(svgEl('text', {
      x: item.x + 18,
      y: legendY + 3.5,
      fill: '#94a3b8',
      'font-size': 9.5,
      'font-family': FONT_SANS,
    }, item.label));
  }

  // Horizontal Gridlines & Dual Y-Axes Ticks
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const frac = i / ticks;
    const y = padT + plotH - frac * plotH;
    svg.appendChild(svgEl('line', {
      x1: padL,
      y1: y,
      x2: W - padR,
      y2: y,
      stroke: i === 0 ? 'rgba(148,163,184,0.28)' : 'rgba(148,163,184,0.11)',
      'stroke-width': 1,
    }));

    // Left axis: 3D Volume (cm³)
    svg.appendChild(svgEl('text', {
      x: padL - 6,
      y: y + 3,
      'text-anchor': 'end',
      fill: '#7dd3fc',
      'font-size': 9,
      'font-family': FONT_MONO,
    }, fmtTick(maxVol * frac, 1)));

    // Right axis: 2D SPD (mm²)
    svg.appendChild(svgEl('text', {
      x: W - padR + 6,
      y: y + 3,
      'text-anchor': 'start',
      fill: '#5eead4',
      'font-size': 9,
      'font-family': FONT_MONO,
    }, fmtTick(maxSpd * frac, 0)));
  }

  // Axis unit headers
  svg.appendChild(svgEl('text', {
    x: padL - 6,
    y: padT - 7,
    'text-anchor': 'end',
    fill: '#38bdf8',
    'font-size': 8.5,
    'font-weight': 700,
    'font-family': FONT_MONO,
  }, 'cm³'));
  svg.appendChild(svgEl('text', {
    x: W - padR + 6,
    y: padT - 7,
    'text-anchor': 'start',
    fill: '#2dd4bf',
    'font-size': 8.5,
    'font-weight': 700,
    'font-family': FONT_MONO,
  }, 'mm²'));

  // Identify indices of RANO-included points
  const includedIndices = [];
  timepoints.forEach((tp, idx) => {
    if (tp.includeInRano !== false) includedIndices.push(idx);
  });
  const firstRanoIdx = includedIndices.length > 0 ? includedIndices[0] : 0;

  // Optional Surgery / Baseline transition marker if index 0 is excluded Pre-Op
  if (firstRanoIdx > 0 && n > 1) {
    const splitX = 0.5 * (xFor(firstRanoIdx - 1) + xFor(firstRanoIdx));
    svg.appendChild(svgEl('line', {
      x1: splitX,
      y1: padT,
      x2: splitX,
      y2: padT + plotH,
      stroke: 'rgba(168, 85, 247, 0.36)',
      'stroke-width': 1,
      'stroke-dasharray': '3 3',
    }));
    svg.appendChild(svgEl('text', {
      x: splitX,
      y: padT + 9,
      'text-anchor': 'middle',
      fill: '#c084fc',
      'font-size': 8.2,
      'font-weight': 600,
      'font-family': FONT_SANS,
    }, 'Resection'));
  }

  // Nadir Reference Line (across RANO baseline..end span)
  if (rano2Result && rano2Result.nadir && includedIndices.length >= 2) {
    const nadirVolVal = rano2Result.nadir.volumeCm3;
    const ny = yVol(nadirVolVal);
    const xStart = xFor(firstRanoIdx);
    const xEnd = xFor(n - 1);

    svg.appendChild(svgEl('line', {
      x1: xStart,
      y1: ny,
      x2: xEnd,
      y2: ny,
      stroke: '#f59e0b',
      'stroke-width': 1.3,
      'stroke-dasharray': '3.5 3',
      opacity: 0.9,
    }));

    const labelText = `Nadir ${nadirVolVal.toFixed(2)} cm³`;
    const pillW = labelText.length * 5.2 + 10;
    const pillX = Math.max(padL + 2, xEnd - pillW - 2);
    const pillY = ny > padT + 18 ? ny - 16 : ny + 4;

    svg.appendChild(svgEl('rect', {
      x: pillX,
      y: pillY,
      width: pillW,
      height: 13.5,
      rx: 3.5,
      fill: 'rgba(11, 15, 23, 0.88)',
      stroke: 'rgba(245, 158, 11, 0.6)',
      'stroke-width': 0.9,
    }));
    svg.appendChild(svgEl('text', {
      x: pillX + 5,
      y: pillY + 9.5,
      fill: '#fde68a',
      'font-size': 8.5,
      'font-weight': 600,
      'font-family': FONT_MONO,
    }, labelText));
  }

  // Area fill under RANO Volume curve (or full curve if all included)
  const areaIndices = includedIndices.length >= 2 ? includedIndices : timepoints.map((_, i) => i);
  if (areaIndices.length >= 2) {
    const pts = areaIndices.map((i) => `${xFor(i).toFixed(1)},${yVol(vols[i]).toFixed(1)}`).join(' L ');
    const baseY = (padT + plotH).toFixed(1);
    const areaD = `M ${xFor(areaIndices[0]).toFixed(1)},${baseY} L ${pts} L ${xFor(areaIndices[areaIndices.length - 1]).toFixed(1)},${baseY} Z`;
    svg.appendChild(svgEl('path', { d: areaD, fill: 'url(#ns-vol-area)' }));
  }

  // Connect segments (muted pre-op bridge vs active RANO trajectory)
  for (let i = 0; i < n - 1; i++) {
    const isPreBridge = timepoints[i].includeInRano === false || timepoints[i + 1].includeInRano === false;
    // Volume line
    svg.appendChild(svgEl('line', {
      x1: xFor(i),
      y1: yVol(vols[i]),
      x2: xFor(i + 1),
      y2: yVol(vols[i + 1]),
      stroke: isPreBridge ? 'rgba(56, 189, 248, 0.35)' : '#38bdf8',
      'stroke-width': isPreBridge ? 1.5 : 2.2,
      'stroke-dasharray': isPreBridge ? '3 3' : undefined,
    }));
    // SPD line
    svg.appendChild(svgEl('line', {
      x1: xFor(i),
      y1: ySpd(spds[i]),
      x2: xFor(i + 1),
      y2: ySpd(spds[i + 1]),
      stroke: isPreBridge ? 'rgba(45, 212, 191, 0.32)' : '#2dd4bf',
      'stroke-width': isPreBridge ? 1.4 : 2.0,
      'stroke-dasharray': isPreBridge ? '2 3' : '5 3',
    }));
  }

  const tip = createTooltipController(container);

  // Data markers, X-axis labels, and hover hit targets
  for (let i = 0; i < n; i++) {
    const tp = timepoints[i];
    const cx = xFor(i);
    const cyV = yVol(vols[i]);
    const cyS = ySpd(spds[i]);
    const isExcluded = tp.includeInRano === false;
    const isLatestIncluded = includedIndices.length > 0 && i === includedIndices[includedIndices.length - 1];
    const isBaseline = includedIndices.length > 0 && i === includedIndices[0];

    // Subtle vertical guide tick
    svg.appendChild(svgEl('line', {
      x1: cx,
      y1: padT + plotH,
      x2: cx,
      y2: padT + plotH + 4,
      stroke: 'rgba(148,163,184,0.35)',
    }));

    // SPD Diamond marker
    const dSz = 4.2;
    svg.appendChild(svgEl('polygon', {
      points: `${cx},${cyS - dSz} ${cx + dSz},${cyS} ${cx},${cyS + dSz} ${cx - dSz},${cyS}`,
      fill: isExcluded ? '#0f172a' : '#2dd4bf',
      stroke: isExcluded ? 'rgba(45,212,191,0.55)' : '#0b0f17',
      'stroke-width': 1.4,
    }));

    // Volume Circle marker
    const volColor = isLatestIncluded && rano2Result?.severity === 'progression'
      ? '#f43f5e'
      : isLatestIncluded && rano2Result?.severity === 'warning'
        ? '#f59e0b'
        : isExcluded
          ? '#64748b'
          : '#38bdf8';

    svg.appendChild(svgEl('circle', {
      cx,
      cy: cyV,
      r: isLatestIncluded ? 5 : 4,
      fill: volColor,
      stroke: '#0b0f17',
      'stroke-width': 1.6,
    }));

    // X-axis compact label + date
    const shortLabel = tp.label.length > 15 ? `${tp.label.slice(0, 14)}…` : tp.label;
    svg.appendChild(svgEl('text', {
      x: cx,
      y: padT + plotH + 16,
      'text-anchor': 'middle',
      fill: isExcluded ? '#64748b' : '#cbd5e1',
      'font-size': 9.2,
      'font-weight': isBaseline || isLatestIncluded ? 600 : 400,
      'font-family': FONT_SANS,
    }, shortLabel));

    if (tp.date) {
      svg.appendChild(svgEl('text', {
        x: cx,
        y: padT + plotH + 28,
        'text-anchor': 'middle',
        fill: '#64748b',
        'font-size': 8.4,
        'font-family': FONT_MONO,
      }, tp.date));
    }

    // Generous invisible column hit zone for effortless tooltip inspection
    const hitW = n === 1 ? plotW * 0.5 : Math.max(26, plotW / (n * 1.2));
    const hitRect = svgEl('rect', {
      x: cx - hitW * 0.5,
      y: padT,
      width: hitW,
      height: plotH,
      fill: 'transparent',
      tabindex: 0,
      role: 'button',
      'aria-label': `${tp.label}: Volume ${vols[i].toFixed(2)} cm³, SPD ${spds[i].toFixed(1)} mm²`,
    });

    const roleTag = isExcluded
      ? 'Pre-Op Context (Excluded from RANO Baseline)'
      : isBaseline
        ? 'RANO 2.0 Baseline'
        : isLatestIncluded
          ? `Current Evaluation (${rano2Result?.shortCode || 'Active'})`
          : 'Intermediate Follow-Up';

    bindSvgTooltip(hitRect, tip, () => `
      <div class="tt-title">${escHtml(tp.label)}${tp.date ? ` · ${escHtml(tp.date)}` : ''}</div>
      <div style="color:#94a3b8;font-size:10px;margin-bottom:3px;">${escHtml(roleTag)}</div>
      <div class="tt-row"><span style="color:#38bdf8">3D ET Volume:</span><strong>${vols[i].toFixed(2)} cm³</strong></div>
      <div class="tt-row"><span style="color:#2dd4bf">2D Axial SPD:</span><strong>${spds[i].toFixed(1)} mm²</strong></div>
    `);
    svg.appendChild(hitRect);
  }

  container.appendChild(svg);
}

// ============================================================================
// 2. RANO-Resect EOR Pre-Op vs. Post-Op Bar Comparison Chart
// ============================================================================

/**
 * Render an interactive SVG grouped bar chart comparing Pre-Op vs. Post-Op
 * residual compartment volumes and surgical resection cavity.
 *
 * @param {HTMLElement | null} container
 * @param {Object | null} eorResult - Output from computeExtentOfResection().
 */
export function renderEorChart(container, eorResult) {
  if (!container) return;
  container.innerHTML = '';

  if (!eorResult) {
    const empty = document.createElement('div');
    empty.className = 'chart-empty';
    empty.textContent = 'Load Pre-Op and Post-Op masks to visualize resection volumes.';
    container.appendChild(empty);
    return;
  }

  const W = 420;
  const H = 172;
  const padL = 38;
  const padR = 12;
  const padT = 26;
  const padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const groups = [
    {
      label: 'Enhancing (CE)',
      pre: eorResult.preCeCm3,
      post: eorResult.residualCeCm3,
      preColor: '#38bdf8',
      postColor: '#2dd4bf',
      eorPct: eorResult.ceEorPct,
    },
    {
      label: 'Non-CE (NCR+ED)',
      pre: eorResult.preNonCeCm3,
      post: eorResult.residualNonCeCm3,
      preColor: '#f59e0b',
      postColor: '#fbbf24',
      eorPct: eorResult.nonCeEorPct,
    },
    {
      label: 'Whole Tumor',
      pre: eorResult.preWtCm3,
      post: eorResult.residualWtCm3,
      preColor: '#64748b',
      postColor: '#94a3b8',
      eorPct: eorResult.preWtCm3 > 0 ? Math.max(0, Math.min(100, ((eorResult.preWtCm3 - eorResult.residualWtCm3) / eorResult.preWtCm3) * 100)) : 0,
    },
    {
      label: 'Cavity (RC)',
      pre: null,
      post: eorResult.cavityCm3,
      preColor: '#a855f7',
      postColor: '#a855f7',
      eorPct: null,
    },
  ];

  const maxVal = niceCeiling(
    Math.max(...groups.flatMap((g) => [g.pre || 0, g.post || 0])),
    5
  );
  const yFor = (v) => padT + plotH - (Math.max(0, v) / maxVal) * plotH;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': 'Pre-operative versus post-operative compartment volumes bar chart',
  });

  // Top Legend
  svg.appendChild(svgEl('rect', { x: padL, y: 7, width: 9, height: 9, rx: 2, fill: '#38bdf8', opacity: 0.42, stroke: '#38bdf8', 'stroke-width': 1 }));
  svg.appendChild(svgEl('text', { x: padL + 13, y: 15, fill: '#94a3b8', 'font-size': 9.5, 'font-family': FONT_SANS }, 'Pre-Op'));

  svg.appendChild(svgEl('rect', { x: padL + 66, y: 7, width: 9, height: 9, rx: 2, fill: '#2dd4bf' }));
  svg.appendChild(svgEl('text', { x: padL + 79, y: 15, fill: '#94a3b8', 'font-size': 9.5, 'font-family': FONT_SANS }, 'Post-Op Residual'));

  svg.appendChild(svgEl('rect', { x: padL + 178, y: 7, width: 9, height: 9, rx: 2, fill: '#a855f7' }));
  svg.appendChild(svgEl('text', { x: padL + 191, y: 15, fill: '#94a3b8', 'font-size': 9.5, 'font-family': FONT_SANS }, 'Resection Cavity'));

  // Gridlines
  for (let i = 0; i <= 4; i++) {
    const frac = i / 4;
    const y = padT + plotH - frac * plotH;
    svg.appendChild(svgEl('line', {
      x1: padL,
      y1: y,
      x2: W - padR,
      y2: y,
      stroke: i === 0 ? 'rgba(148,163,184,0.28)' : 'rgba(148,163,184,0.10)',
    }));
    svg.appendChild(svgEl('text', {
      x: padL - 5,
      y: y + 3,
      'text-anchor': 'end',
      fill: '#64748b',
      'font-size': 9,
      'font-family': FONT_MONO,
    }, fmtTick(maxVal * frac, 1)));
  }

  const tip = createTooltipController(container);
  const groupW = plotW / groups.length;
  const barW = 24;
  const gap = 5;

  groups.forEach((g, idx) => {
    const cx = padL + idx * groupW + groupW * 0.5;

    if (g.pre !== null) {
      const preH = Math.max(1.5, padT + plotH - yFor(g.pre));
      const postH = Math.max(g.post > 0 ? 2 : 0.8, padT + plotH - yFor(g.post));
      const xPre = cx - barW - gap * 0.5;
      const xPost = cx + gap * 0.5;

      // Pre-op bar (translucent filled + bright outline)
      svg.appendChild(svgEl('rect', {
        x: xPre,
        y: padT + plotH - preH,
        width: barW,
        height: preH,
        rx: 3,
        fill: g.preColor,
        'fill-opacity': 0.34,
        stroke: g.preColor,
        'stroke-width': 1.2,
      }));
      svg.appendChild(svgEl('text', {
        x: xPre + barW * 0.5,
        y: padT + plotH - preH - 4,
        'text-anchor': 'middle',
        fill: '#94a3b8',
        'font-size': 8.5,
        'font-family': FONT_MONO,
      }, g.pre.toFixed(1)));

      // Post-op residual bar
      svg.appendChild(svgEl('rect', {
        x: xPost,
        y: padT + plotH - postH,
        width: barW,
        height: postH,
        rx: 3,
        fill: g.postColor,
      }));
      svg.appendChild(svgEl('text', {
        x: xPost + barW * 0.5,
        y: padT + plotH - postH - 4,
        'text-anchor': 'middle',
        fill: '#f1f5f9',
        'font-size': 8.5,
        'font-weight': 600,
        'font-family': FONT_MONO,
      }, g.post < 10 ? g.post.toFixed(2) : g.post.toFixed(1)));
    } else {
      // Single Cavity bar
      const postH = Math.max(g.post > 0 ? 2 : 0.8, padT + plotH - yFor(g.post));
      const xBar = cx - barW * 0.65;
      svg.appendChild(svgEl('rect', {
        x: xBar,
        y: padT + plotH - postH,
        width: barW * 1.3,
        height: postH,
        rx: 3,
        fill: g.postColor,
        'fill-opacity': 0.88,
      }));
      svg.appendChild(svgEl('text', {
        x: cx,
        y: padT + plotH - postH - 4,
        'text-anchor': 'middle',
        fill: '#e9d5ff',
        'font-size': 8.8,
        'font-weight': 600,
        'font-family': FONT_MONO,
      }, g.post.toFixed(1)));
    }

    // X-axis group label & EOR badge
    svg.appendChild(svgEl('text', {
      x: cx,
      y: padT + plotH + 14,
      'text-anchor': 'middle',
      fill: '#cbd5e1',
      'font-size': 9.2,
      'font-weight': 600,
      'font-family': FONT_SANS,
    }, g.label));

    if (g.eorPct !== null) {
      svg.appendChild(svgEl('text', {
        x: cx,
        y: padT + plotH + 26,
        'text-anchor': 'middle',
        fill: g.eorPct >= 95 ? '#2dd4bf' : '#94a3b8',
        'font-size': 8.6,
        'font-weight': 600,
        'font-family': FONT_MONO,
      }, `EOR ${g.eorPct.toFixed(1)}%`));
    } else {
      svg.appendChild(svgEl('text', {
        x: cx,
        y: padT + plotH + 26,
        'text-anchor': 'middle',
        fill: '#c084fc',
        'font-size': 8.6,
        'font-family': FONT_MONO,
      }, 'Post-Op Bed'));
    }

    // Hover hit zone
    const hit = svgEl('rect', {
      x: padL + idx * groupW + 2,
      y: padT,
      width: groupW - 4,
      height: plotH + 28,
      fill: 'transparent',
      tabindex: 0,
    });
    bindSvgTooltip(hit, tip, () => {
      if (g.pre === null) {
        return `
          <div class="tt-title">${escHtml(g.label)}</div>
          <div class="tt-row"><span style="color:#c084fc">Post-Op Volume:</span><strong>${g.post.toFixed(2)} cm³</strong></div>
        `;
      }
      return `
        <div class="tt-title">${escHtml(g.label)}</div>
        <div class="tt-row"><span>Pre-Op:</span><strong>${g.pre.toFixed(2)} cm³</strong></div>
        <div class="tt-row"><span>Residual:</span><strong>${g.post.toFixed(2)} cm³</strong></div>
        <div class="tt-row"><span style="color:#2dd4bf">EOR:</span><strong>${g.eorPct.toFixed(1)}%</strong></div>
      `;
    });
    svg.appendChild(hit);
  });

  container.appendChild(svg);
}

// ============================================================================
// 3. Multi-Region AI Segmentation Benchmark Chart
// ============================================================================

/**
 * Render a grouped SVG bar chart comparing Dice, IoU, Sensitivity, and Precision
 * across BraTS/Post-Op regions (`ET`, `TC`, `WT`, `RC`), with click-to-select region.
 *
 * @param {HTMLElement | null} container
 * @param {Object | null} evalResult - Output from evaluateSegmentation().
 * @param {string} [activeRegion='ET']
 * @param {(region: string) => void} [onSelectRegion]
 */
export function renderAiBenchmarkChart(container, evalResult, activeRegion = 'ET', onSelectRegion = null) {
  if (!container) return;
  container.innerHTML = '';

  if (!evalResult || !evalResult.regions) {
    const empty = document.createElement('div');
    empty.className = 'chart-empty';
    empty.textContent = 'Load Ground Truth and AI Prediction masks to run quantitative benchmark.';
    container.appendChild(empty);
    return;
  }

  const W = 420;
  const H = 172;
  const padL = 36;
  const padR = 10;
  const padT = 26;
  const padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const regionOrder = ['ET', 'TC', 'WT', 'RC'];
  const metricSeries = [
    { key: 'dice', label: 'Dice', color: '#22c55e' },
    { key: 'iou', label: 'IoU', color: '#38bdf8' },
    { key: 'sensitivity', label: 'Sens', color: '#2dd4bf' },
    { key: 'precision', label: 'Prec', color: '#a855f7' },
  ];

  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': 'AI segmentation benchmark metrics by region',
  });

  // Top Legend
  metricSeries.forEach((m, idx) => {
    const lx = padL + idx * 78;
    svg.appendChild(svgEl('rect', { x: lx, y: 7, width: 8, height: 8, rx: 2, fill: m.color }));
    svg.appendChild(svgEl('text', {
      x: lx + 12,
      y: 14.5,
      fill: '#94a3b8',
      'font-size': 9.2,
      'font-family': FONT_SANS,
    }, m.label));
  });

  // Y-axis gridlines (0.00 to 1.00)
  for (let i = 0; i <= 4; i++) {
    const frac = i / 4;
    const y = padT + plotH - frac * plotH;
    svg.appendChild(svgEl('line', {
      x1: padL,
      y1: y,
      x2: W - padR,
      y2: y,
      stroke: i === 0 ? 'rgba(148,163,184,0.28)' : 'rgba(148,163,184,0.10)',
    }));
    svg.appendChild(svgEl('text', {
      x: padL - 5,
      y: y + 3,
      'text-anchor': 'end',
      fill: '#64748b',
      'font-size': 8.8,
      'font-family': FONT_MONO,
    }, frac.toFixed(2)));
  }

  const tip = createTooltipController(container);
  const groupW = plotW / regionOrder.length;
  const barW = 13;
  const barGap = 3;
  const totalBarsW = metricSeries.length * barW + (metricSeries.length - 1) * barGap;

  regionOrder.forEach((region, idx) => {
    const m = evalResult.regions[region];
    if (!m) return;

    const gx = padL + idx * groupW;
    const cx = gx + groupW * 0.5;
    const isSelected = region === activeRegion;

    // Active region highlight frame
    if (isSelected) {
      svg.appendChild(svgEl('rect', {
        x: gx + 4,
        y: padT - 3,
        width: groupW - 8,
        height: plotH + 28,
        rx: 5,
        fill: 'rgba(56, 189, 248, 0.08)',
        stroke: 'rgba(56, 189, 248, 0.42)',
        'stroke-width': 1,
      }));
    }

    if (m.bothEmpty) {
      svg.appendChild(svgEl('text', {
        x: cx,
        y: padT + plotH * 0.52,
        'text-anchor': 'middle',
        fill: '#64748b',
        'font-size': 9.2,
        'font-family': FONT_MONO,
      }, 'Absent'));
      svg.appendChild(svgEl('text', {
        x: cx,
        y: padT + plotH * 0.52 + 12,
        'text-anchor': 'middle',
        fill: '#475569',
        'font-size': 8.2,
        'font-family': FONT_SANS,
      }, '(0 / 0 vox)'));
    } else {
      const startX = cx - totalBarsW * 0.5;
      metricSeries.forEach((s, sIdx) => {
        const val = Math.max(0, Math.min(1, Number(m[s.key]) || 0));
        const h = Math.max(1.5, val * plotH);
        const bx = startX + sIdx * (barW + barGap);
        const by = padT + plotH - h;

        svg.appendChild(svgEl('rect', {
          x: bx,
          y: by,
          width: barW,
          height: h,
          rx: 2.5,
          fill: s.color,
          'fill-opacity': isSelected ? 0.95 : 0.72,
        }));

        // Show exact Dice numeral above first bar for quick scanning
        if (sIdx === 0) {
          svg.appendChild(svgEl('text', {
            x: bx + barW * 0.5,
            y: Math.max(padT + 8, by - 3),
            'text-anchor': 'middle',
            fill: '#86efac',
            'font-size': 8.2,
            'font-weight': 700,
            'font-family': FONT_MONO,
          }, val.toFixed(2)));
        }
      });
    }

    // Region X-label
    svg.appendChild(svgEl('text', {
      x: cx,
      y: padT + plotH + 15,
      'text-anchor': 'middle',
      fill: isSelected ? '#38bdf8' : '#cbd5e1',
      'font-size': 10.5,
      'font-weight': 700,
      'font-family': FONT_MONO,
    }, region));

    // Interactive hit rect
    const hit = svgEl('rect', {
      x: gx + 3,
      y: padT - 3,
      width: groupW - 6,
      height: plotH + 28,
      fill: 'transparent',
      tabindex: 0,
      role: 'button',
      'aria-label': `Inspect ${region} AI evaluation metrics`,
    });

    if (typeof onSelectRegion === 'function') {
      hit.addEventListener('click', () => onSelectRegion(region));
      hit.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelectRegion(region);
        }
      });
    }

    bindSvgTooltip(hit, tip, () => {
      if (m.bothEmpty) {
        return `
          <div class="tt-title">${escHtml(region)} — Absent in GT &amp; Pred</div>
          <div class="tt-row"><span>Dice / IoU:</span><strong>1.000 (Both Empty)</strong></div>
        `;
      }
      const hd = m.hd95Mm === null ? 'N/A' : `${m.hd95Mm.toFixed(2)} mm`;
      const assd = m.assdMm === null ? 'N/A' : `${m.assdMm.toFixed(2)} mm`;
      const rve = m.rvePct === null ? 'N/A' : `${m.rvePct >= 0 ? '+' : ''}${m.rvePct.toFixed(1)}%`;
      return `
        <div class="tt-title">${escHtml(region)} Region QA Metrics</div>
        <div class="tt-row"><span style="color:#22c55e">Dice:</span><strong>${m.dice.toFixed(3)}</strong></div>
        <div class="tt-row"><span style="color:#38bdf8">IoU:</span><strong>${m.iou.toFixed(3)}</strong></div>
        <div class="tt-row"><span style="color:#2dd4bf">Sens / Prec:</span><strong>${m.sensitivity.toFixed(3)} / ${m.precision.toFixed(3)}</strong></div>
        <div class="tt-row"><span style="color:#f59e0b">HD95 / ASSD:</span><strong>${hd} / ${assd}</strong></div>
        <div class="tt-row"><span>RVE:</span><strong>${rve}</strong></div>
      `;
    });

    svg.appendChild(hit);
  });

  container.appendChild(svg);
}

// ============================================================================
// 4. Whole-Tumor Compartment Proportion Bar
// ============================================================================

/**
 * Render a sleek horizontal SVG stacked proportion bar for WT compartments
 * (Enhancing Tumor, Necrotic Core, Peritumoral Edema).
 *
 * @param {HTMLElement | null} container
 * @param {Object | null} volumetrics - Output from computeVolumetrics().
 */
export function renderCompartmentBar(container, volumetrics) {
  if (!container) return;
  container.innerHTML = '';

  const wtVol = volumetrics?.regions?.WT?.volumeCm3 || 0;
  const rcVol = volumetrics?.regions?.RC?.volumeCm3 || 0;

  if (!volumetrics || (wtVol <= 0 && rcVol <= 0)) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:11px;color:#64748b;text-align:center;padding:8px 0;';
    empty.textContent = 'No labeled tumor or cavity voxels in active mask.';
    container.appendChild(empty);
    return;
  }

  // Bar stretches to the panel width; the legend is HTML so its text never scales with the panel.
  const W = 420;
  const barH = 12;

  const segments = wtVol > 0
    ? [
        { code: 'ET', name: 'Enhancing Tumor', vol: volumetrics.labels[3].volumeCm3, color: '#38bdf8' },
        { code: 'NCR', name: 'Necrotic Core', vol: volumetrics.labels[1].volumeCm3, color: '#f43f5e' },
        { code: 'ED', name: 'Peritumoral Edema', vol: volumetrics.labels[2].volumeCm3, color: '#f59e0b' },
      ].filter((s) => s.vol > 0)
    : [{ code: 'RC', name: 'Surgical Cavity (No Residual WT)', vol: rcVol, color: '#a855f7' }];

  const total = wtVol > 0 ? wtVol : rcVol;
  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${barH}`,
    preserveAspectRatio: 'none',
    class: 'comp-bar-svg',
    role: 'img',
    'aria-label': 'Tumor compartment volume proportions',
  });

  // Rounded clip path for clean pill ends
  const defs = svgEl('defs');
  const clip = svgEl('clipPath', { id: 'ns-comp-clip' });
  clip.appendChild(svgEl('rect', { x: 0, y: 0, width: W, height: barH, rx: 6 }));
  defs.appendChild(clip);
  svg.appendChild(defs);

  const barGroup = svgEl('g', { 'clip-path': 'url(#ns-comp-clip)' });
  const tip = createTooltipController(container);
  const legend = document.createElement('div');
  legend.className = 'comp-legend';

  let curX = 0;

  segments.forEach((seg) => {
    const frac = seg.vol / total;
    const segW = Math.max(2, frac * W);
    const pct = frac * 100;

    const rect = svgEl('rect', {
      x: curX,
      y: 0,
      width: segW,
      height: barH,
      fill: seg.color,
    });
    bindSvgTooltip(rect, tip, () => `
      <div class="tt-title">${escHtml(seg.name)} (${escHtml(seg.code)})</div>
      <div class="tt-row"><span>Volume:</span><strong>${seg.vol.toFixed(2)} cm³</strong></div>
      <div class="tt-row"><span>Share:</span><strong>${pct.toFixed(1)}%</strong></div>
    `);
    barGroup.appendChild(rect);
    curX += segW;

    const item = document.createElement('span');
    item.className = 'comp-legend-item';
    const dot = document.createElement('span');
    dot.className = 'comp-legend-dot';
    dot.style.background = seg.color;
    item.appendChild(dot);
    item.appendChild(document.createTextNode(`${seg.code} ${pct.toFixed(0)}% (${seg.vol.toFixed(1)} cm³)`));
    item.title = seg.name;
    legend.appendChild(item);
  });

  svg.appendChild(barGroup);
  container.appendChild(svg);
  container.appendChild(legend);
}
