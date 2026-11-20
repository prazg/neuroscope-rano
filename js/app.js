/**
 * @fileoverview NeuroScope-RANO Workstation Controller & Application State.
 * Zero external dependencies; wires niftiParser, metricsEngine, NeuroViewer, and pure SVG charts
 * into a 100% browser-local clinical neuroradiology & AI QA workbench.
 */

import {
  fetchNifti,
  loadNiftiFile,
  validateMatchingGeometry,
} from './niftiParser.js';

import {
  LABEL_META,
  ERROR_META,
  RANO_RESECT_CLASSES,
  computeVolumetrics,
  computeExtentOfResection,
  computeRano2Response,
  evaluateSegmentation,
  buildErrorVolume,
} from './metricsEngine.js';

import { NeuroViewer, COLORMAPS } from './viewer.js';

import {
  renderLongitudinalChart,
  renderEorChart,
  renderAiBenchmarkChart,
  renderCompartmentBar,
} from './charts.js';

// ============================================================================
// Formatting & Utility Helpers
// ============================================================================

const $ = (id) => document.getElementById(id);

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtNum(val, decimals = 2, fallback = '–') {
  if (val === null || val === undefined || !Number.isFinite(val)) return fallback;
  return val.toFixed(decimals);
}

function fmtSignedPct(val, decimals = 1, zeroEmergeLabel = 'New (>0)') {
  if (val === null) return zeroEmergeLabel;
  if (val === undefined || !Number.isFinite(val)) return '–';
  const sign = val > 0 ? '+' : '';
  return `${sign}${val.toFixed(decimals)}%`;
}

function basename(pathOrName) {
  if (!pathOrName) return 'None';
  const parts = String(pathOrName).split(/[\\/]/);
  return parts[parts.length - 1] || String(pathOrName);
}

function isoToday() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function triggerDownload(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(val) {
  const s = val === null || val === undefined ? '' : String(val);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ============================================================================
// Application State
// ============================================================================

const state = {
  manifest: null,
  activeCase: null,
  activePreset: 'preop_ai',
  activeTab: 'volumetrics',
  activeTimepointId: 'preop',

  /** Cache fetched sample NIfTI volumes by URL so switching scans is instant */
  volumeCache: new Map(),

  // Viewer active volumes
  baseVol: null,
  baseName: 'None',
  maskVol: null,
  maskName: 'None',
  secondaryName: 'None',
  volumetrics: null,

  // EOR & RANO-Resect pair
  eorPreVol: null,
  eorPreName: 'Not loaded',
  eorPostVol: null,
  eorPostName: 'Not loaded',
  eorResult: null,
  expandedResectTier: null,

  // Longitudinal RANO 2.0 series
  sampleTimepointSnapshots: [],
  longitudinalTimepoints: [],
  rano2Result: null,

  // AI Evaluator pair
  aiGtVol: null,
  aiGtName: 'Not loaded',
  aiPredVol: null,
  aiPredName: 'Not loaded',
  aiSourceTag: 'case01_preop',
  aiEvalResult: null,
  aiActiveRegion: 'ET',
  aiErrorOverlayOn: false,

  // Viewer control flags
  colormap: 'grayscale', // 'grayscale' | 'hot_metal' | 'cool_bone'
  overlayMode: 'mask', // 'mask' | 'error' | 'none'
  wlSyncingFromViewer: false,
  customScanCounter: 1,
  lastCrosshairPayload: null,
  activeModalId: null,
  modalReturnFocus: null,
};

/** @type {NeuroViewer | null} */
let viewer = null;

/** @type {Promise<void> | null} */
let backgroundHydrationPromise = null;

// ============================================================================
// Notifications & Alert Banner
// ============================================================================

function showToast(message, type = 'info', durationMs = 4200) {
  const container = $('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const span = document.createElement('span');
  span.textContent = message;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn-icon';
  closeBtn.setAttribute('aria-label', 'Close notification');
  closeBtn.textContent = '×';
  closeBtn.style.fontSize = '15px';
  closeBtn.style.padding = '0 4px';

  const dismiss = () => {
    if (toast.parentNode) toast.parentNode.removeChild(toast);
  };
  closeBtn.addEventListener('click', dismiss);

  toast.appendChild(span);
  toast.appendChild(closeBtn);
  container.appendChild(toast);

  if (durationMs > 0) {
    setTimeout(dismiss, durationMs);
  }
}

function showAlertBanner(message, isWarning = false) {
  const banner = $('alert-banner');
  const textEl = $('alert-banner-text');
  if (!banner || !textEl) return;
  textEl.textContent = message;
  banner.classList.toggle('alert-warn', Boolean(isWarning));
  banner.classList.remove('hidden');
}

function hideAlertBanner() {
  const banner = $('alert-banner');
  if (banner) banner.classList.add('hidden');
}

function setViewerLoading(visible, message = 'Loading NIfTI volumes…') {
  const el = $('viewer-loading');
  const txt = $('viewer-loading-text');
  if (txt && message) txt.textContent = message;
  if (el) el.classList.toggle('hidden', !visible);
}

// ============================================================================
// Cached Sample Fetching
// ============================================================================

async function fetchCachedNifti(url) {
  if (!url) return null;
  if (state.volumeCache.has(url)) {
    return state.volumeCache.get(url);
  }
  const vol = await fetchNifti(url);
  state.volumeCache.set(url, vol);
  return vol;
}

// ============================================================================
// Viewer Initialization & Synchronization
// ============================================================================

function initViewer() {
  viewer = new NeuroViewer(
    {
      axial: $('canvas-axial'),
      coronal: $('canvas-coronal'),
      sagittal: $('canvas-sagittal'),
      mip3d: $('canvas-3d'),
    },
    {
      colormap: state.colormap,
      showCrosshairs: true,
      showCalipers: true,
      showOrientationLabels: true,
      maskOpacity: 0.55,
      mode3d: 'tumor_surface',
      onCrosshairChange: handleCrosshairChange,
      onCursorChange: handleCursorHover,
      onWindowLevelChange: handleViewerWLChange,
    }
  );
}

function maskMatchesBaseDims() {
  if (!state.baseVol || !state.maskVol) return false;
  return validateMatchingGeometry(state.baseVol, state.maskVol).dimsMatch;
}

function getActiveRano2D(volumetrics = state.volumetrics) {
  if (!volumetrics) return null;
  if (
    volumetrics.rano2d &&
    volumetrics.rano2d.bestSliceZ !== null &&
    volumetrics.rano2d.bestSliceZ !== undefined
  ) {
    return volumetrics.rano2d;
  }
  if (
    volumetrics.rano2dNonEnhancing &&
    volumetrics.rano2dNonEnhancing.bestSliceZ !== null &&
    volumetrics.rano2dNonEnhancing.bestSliceZ !== undefined
  ) {
    return volumetrics.rano2dNonEnhancing;
  }
  return volumetrics.rano2d || null;
}

function renderTelemetryPill(payload) {
  if (!payload) return;
  const { ix, iy, iz, mmX, mmY, mmZ, coordSpace, intensity, label, errorCode, source } = payload;

  const pill = $('live-telemetry-pill');
  const modeBadge = $('tele-mode-badge');
  const teleVox = $('tele-voxel');
  const teleCoordTag = $('tele-coord-tag');
  const teleMm = $('tele-mm');
  const teleInt = $('tele-intensity');
  const teleDot = $('tele-label-dot');
  const teleTxt = $('tele-label-text');

  const isHover = source === 'cursor';
  if (pill) pill.classList.toggle('is-cursor-hover', isHover);
  if (modeBadge) modeBadge.textContent = isHover ? 'CURSOR' : 'CROSSHAIR';
  if (teleVox) teleVox.textContent = `(${ix}, ${iy}, ${iz})`;
  if (teleCoordTag) {
    const space = coordSpace === 'MNI' ? 'MNI (mm)' : coordSpace === 'TAL' ? 'TAL (mm)' : coordSpace === 'MM' ? 'Grid (mm)' : 'RAS (mm)';
    teleCoordTag.textContent = space;
  }
  if (teleMm) teleMm.textContent = `(${mmX.toFixed(1)}, ${mmY.toFixed(1)}, ${mmZ.toFixed(1)})`;
  if (teleInt) teleInt.textContent = Number.isFinite(intensity) ? intensity.toFixed(1) : '–';

  if (teleDot && teleTxt) {
    if (state.overlayMode === 'error' && state.aiEvalResult) {
      if (errorCode && ERROR_META[errorCode]) {
        const meta = ERROR_META[errorCode];
        teleDot.style.setProperty('--swatch', meta.color);
        teleTxt.textContent = `${meta.code} — ${meta.name} (${state.aiActiveRegion})`;
      } else {
        teleDot.style.setProperty('--swatch', '#475569');
        teleTxt.textContent = `TN — Background (${state.aiActiveRegion})`;
      }
    } else if (label && LABEL_META[label]) {
      const meta = LABEL_META[label];
      teleDot.style.setProperty('--swatch', meta.color);
      teleTxt.textContent = `${label} ${meta.code} — ${meta.name}`;
    } else {
      teleDot.style.setProperty('--swatch', '#475569');
      teleTxt.textContent = '0 — Background / Parenchyma';
    }
  }
}

function handleCursorHover(payload) {
  if (!state.baseVol) return;
  renderTelemetryPill(payload || state.lastCrosshairPayload);
}

function handleCrosshairChange(payload) {
  if (!state.baseVol) return;
  const [nx, ny, nz] = state.baseVol.dims;
  const { ix, iy, iz } = payload;
  state.lastCrosshairPayload = payload;

  // Update viewport slice sliders & badges
  const sz = $('slider-slice-z');
  const sy = $('slider-slice-y');
  const sx = $('slider-slice-x');
  if (sz) sz.value = String(iz);
  if (sy) sy.value = String(iy);
  if (sx) sx.value = String(ix);

  const bz = $('badge-slice-z');
  const by = $('badge-slice-y');
  const bx = $('badge-slice-x');
  if (bz) bz.textContent = `Z ${iz + 1}/${nz}`;
  if (by) by.textContent = `Y ${iy + 1}/${ny}`;
  if (bx) bx.textContent = `X ${ix + 1}/${nx}`;

  // Axial RANO max-slice indicator pill (supports ET or non-enhancing WT fallback on matching grid)
  const ranoBadge = $('badge-axial-rano');
  const activeR2d = getActiveRano2D();
  const bestZ = maskMatchesBaseDims() ? activeR2d?.bestSliceZ : null;
  if (ranoBadge) {
    const onBestSlice = bestZ !== null && bestZ !== undefined && Math.round(bestZ) === iz;
    ranoBadge.classList.toggle('hidden', !onBestSlice);
  }

  renderTelemetryPill(payload);
}

function configureWLSlidersForVolume(vol) {
  if (!vol || !viewer) return;
  const st = viewer.getState();
  const span = Math.max(1, vol.max - vol.min);
  const wwMax = Math.max(2, Math.ceil(span * 1.5));
  const wlMin = Math.floor(vol.min - span * 0.25);
  const wlMax = Math.ceil(vol.max + span * 0.25);
  const step = span <= 10 ? 0.05 : span <= 100 ? 0.5 : 1;

  const sWW = $('slider-ww');
  const sWL = $('slider-wl');
  if (sWW) {
    sWW.min = String(Math.max(step, span <= 10 ? 0.05 : 1));
    sWW.max = String(wwMax);
    sWW.step = String(step);
    sWW.value = String(st.windowWidth);
  }
  if (sWL) {
    sWL.min = String(wlMin);
    sWL.max = String(wlMax);
    sWL.step = String(step);
    sWL.value = String(st.windowLevel);
  }
  updateWLReadouts(st.windowWidth, st.windowLevel);
}

function updateWLReadouts(ww, wl) {
  const vWW = $('val-ww');
  const vWL = $('val-wl');
  const dec = Math.abs(ww) < 20 ? 1 : 0;
  if (vWW) vWW.textContent = Number.isFinite(ww) ? ww.toFixed(dec) : '–';
  if (vWL) vWL.textContent = Number.isFinite(wl) ? wl.toFixed(dec) : '–';
}

function handleViewerWLChange({ windowWidth, windowLevel }) {
  state.wlSyncingFromViewer = true;
  const sWW = $('slider-ww');
  const sWL = $('slider-wl');
  if (sWW) {
    if (windowWidth > Number(sWW.max)) sWW.max = String(Math.ceil(windowWidth * 1.2));
    sWW.value = String(windowWidth);
  }
  if (sWL) {
    if (windowLevel < Number(sWL.min)) sWL.min = String(Math.floor(windowLevel - 50));
    if (windowLevel > Number(sWL.max)) sWL.max = String(Math.ceil(windowLevel + 50));
    sWL.value = String(windowLevel);
  }
  updateWLReadouts(windowWidth, windowLevel);
  state.wlSyncingFromViewer = false;
}

function syncSliceSlidersRange(dims) {
  const [nx, ny, nz] = dims;
  const sx = $('slider-slice-x');
  const sy = $('slider-slice-y');
  const sz = $('slider-slice-z');
  if (sx) sx.max = String(Math.max(0, nx - 1));
  if (sy) sy.max = String(Math.max(0, ny - 1));
  if (sz) sz.max = String(Math.max(0, nz - 1));
}

function updateVolumeMetaUI() {
  const lblMri = $('label-file-mri');
  const lblMask = $('label-file-mask');
  const lblSec = $('label-file-secondary');
  const metaBadge = $('active-volume-meta');

  if (lblMri) lblMri.textContent = basename(state.baseName);
  if (lblMask) lblMask.textContent = basename(state.maskName);
  if (lblSec) lblSec.textContent = basename(state.secondaryName);

  if (metaBadge && state.baseVol) {
    const [nx, ny, nz] = state.baseVol.dims;
    const [dx, dy, dz] = state.baseVol.pixdim;
    const sp = Math.abs(dx - dy) < 1e-3 && Math.abs(dy - dz) < 1e-3
      ? `${dx.toFixed(1)}mm³`
      : `${dx.toFixed(1)}×${dy.toFixed(1)}×${dz.toFixed(1)}mm`;
    metaBadge.textContent = `${nx}×${ny}×${nz} · ${sp}`;
  }
}

function setColormapUI(colormapId) {
  const validId = COLORMAPS[colormapId] ? colormapId : 'grayscale';
  state.colormap = validId;
  if (viewer) {
    viewer.setColormap(validId);
  }
  document.querySelectorAll('button.seg-btn[data-colormap]').forEach((btn) => {
    const isActive = btn.dataset.colormap === validId;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });
}

function setOverlayModeUI(mode) {
  state.overlayMode = mode;
  state.aiErrorOverlayOn = mode === 'error';

  if (viewer) {
    viewer.setOverlayMode(mode);
  }

  document.querySelectorAll('button.seg-btn[data-overlay-mode]').forEach((btn) => {
    const isActive = btn.dataset.overlayMode === mode;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });

  const aiBtn = $('btn-ai-toggle-error-overlay');
  if (aiBtn) {
    aiBtn.classList.toggle('active', state.aiErrorOverlayOn);
    aiBtn.setAttribute('aria-pressed', String(state.aiErrorOverlayOn));
    const span = aiBtn.querySelector('span');
    if (span) {
      span.textContent = state.aiErrorOverlayOn
        ? `Hide 3D TP/FP/FN Error Overlay (${state.aiActiveRegion})`
        : `Show 3D TP/FP/FN Error Overlay (${state.aiActiveRegion})`;
    }
  }

  // Refresh telemetry label display
  if (viewer && state.baseVol) {
    const st = viewer.getState();
    viewer.setCrosshair(st.ix, st.iy, st.iz, true);
  }
}

function setActiveTab(tabId, focusTab = false) {
  state.activeTab = tabId;
  document.querySelectorAll('button.tab-btn[data-tab]').forEach((btn) => {
    const isActive = btn.dataset.tab === tabId;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
    btn.setAttribute('tabindex', isActive ? '0' : '-1');
    if (isActive && focusTab) btn.focus();
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `panel-${tabId}`);
  });
}

function setActivePresetUI(presetId) {
  state.activePreset = presetId;
  document.querySelectorAll('button.preset-btn[data-preset]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.preset === presetId);
  });
  const sel = $('preset-select');
  if (sel && sel.value !== presetId) {
    sel.value = presetId;
  }
}

function setActiveTimepointPillUI(tpId) {
  state.activeTimepointId = tpId;
  document.querySelectorAll('button.tp-pill[data-tp-id]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tpId === tpId);
  });
}

// ============================================================================
// Core Viewer Mounting & Geometry Validation
// ============================================================================

function mountViewerVolumes({ baseVol, baseName, maskVol, maskName, snapToTumor = true }) {
  hideAlertBanner();

  if (baseVol) {
    state.baseVol = baseVol;
    state.baseName = baseName || state.baseName;
    syncSliceSlidersRange(baseVol.dims);
    viewer.setVolume(baseVol);
    configureWLSlidersForVolume(baseVol);
    if (state.overlayMode === 'error' && state.aiGtVol) {
      const errGeom = validateMatchingGeometry(baseVol, state.aiGtVol);
      if (!errGeom.dimsMatch) {
        setOverlayModeUI('mask');
      }
    }
  }

  if (maskVol !== undefined) {
    state.maskVol = maskVol;
    state.maskName = maskName || (maskVol ? state.maskName : 'None');

    let maskDimsMatch = false;
    if (maskVol && state.baseVol) {
      const check = validateMatchingGeometry(state.baseVol, maskVol);
      maskDimsMatch = check.dimsMatch;
      if (!check.dimsMatch) {
        showAlertBanner(
          `Mask overlay skipped — ${check.message} Volumetrics are still computed in the mask's physical grid.`,
          false
        );
        showToast(check.message, 'error', 6000);
        viewer.setMask(null);
      } else {
        if (!check.pixdimMatch) {
          showAlertBanner(`Geometry warning: ${check.message}`, true);
          showToast(check.message, 'warning', 5000);
        }
        viewer.setMask(maskVol);
      }
    } else {
      viewer.setMask(maskVol || null);
    }

    recomputeVolumetrics();

    if (snapToTumor && state.baseVol && maskVol && maskDimsMatch) {
      snapCrosshairToBestTarget();
    }
  } else if (baseVol && state.maskVol) {
    const check = validateMatchingGeometry(state.baseVol, state.maskVol);
    if (!check.dimsMatch) {
      viewer.setMask(null);
      viewer.setRanoCalipers(null);
      $('badge-axial-rano')?.classList.add('hidden');
    } else {
      viewer.setMask(state.maskVol);
      const caliperTarget = getActiveRano2D(state.volumetrics);
      if (caliperTarget && caliperTarget.bestSliceZ !== null && caliperTarget.bestSliceZ !== undefined) {
        viewer.setRanoCalipers({ ...caliperTarget, dims: [...state.volumetrics.dims] });
      }
    }
    renderVolumetricsTab();
  }

  updateVolumeMetaUI();
}

function snapCrosshairToBestTarget() {
  if (!viewer || !state.baseVol || !state.volumetrics || !maskMatchesBaseDims()) return;
  const r2d = getActiveRano2D();
  const regions = state.volumetrics.regions;

  // Prefer axial RANO bestSliceZ (ET, or WT fallback when ET is absent) so calipers show immediately
  if (r2d && r2d.bestSliceZ !== null && r2d.bestSliceZ !== undefined) {
    const fallbackCentroid = r2d.region === 'WT' ? regions.WT.centroid : regions.ET.centroid;
    const cx = r2d.majorLine
      ? Math.round(0.5 * (r2d.majorLine.x1 + r2d.majorLine.x2))
      : fallbackCentroid
        ? Math.round(fallbackCentroid[0])
        : Math.floor(state.baseVol.dims[0] / 2);
    const cy = r2d.majorLine
      ? Math.round(0.5 * (r2d.majorLine.y1 + r2d.majorLine.y2))
      : fallbackCentroid
        ? Math.round(fallbackCentroid[1])
        : Math.floor(state.baseVol.dims[1] / 2);
    viewer.setCrosshair(cx, cy, Math.round(r2d.bestSliceZ), true);
    return;
  }

  // Fallback to WT or Cavity centroid
  const targetCentroid = regions.WT.centroid || regions.RC.centroid;
  if (targetCentroid) {
    viewer.jumpToCentroid(targetCentroid);
  }
}

// ============================================================================
// Tab 1: Volumetrics & Automated 2D RANO
// ============================================================================

function recomputeVolumetrics() {
  if (!state.maskVol) {
    state.volumetrics = null;
    if (viewer) viewer.setRanoCalipers(null);
    $('badge-axial-rano')?.classList.add('hidden');
    renderVolumetricsTab();
    return;
  }
  state.volumetrics = computeVolumetrics(state.maskVol);
  const caliperTarget = getActiveRano2D(state.volumetrics);
  const dimsMatch = maskMatchesBaseDims();
  if (viewer) {
    if (dimsMatch && caliperTarget && caliperTarget.bestSliceZ !== null && caliperTarget.bestSliceZ !== undefined) {
      viewer.setRanoCalipers({ ...caliperTarget, dims: [...state.volumetrics.dims] });
    } else {
      viewer.setRanoCalipers(null);
    }
  }
  if (!dimsMatch) {
    $('badge-axial-rano')?.classList.add('hidden');
  } else if (viewer && state.baseVol) {
    const st = viewer.getState();
    const bestZ = caliperTarget?.bestSliceZ;
    const onBestSlice = bestZ !== null && bestZ !== undefined && Math.round(bestZ) === st.iz;
    $('badge-axial-rano')?.classList.toggle('hidden', !onBestSlice);
  }
  renderVolumetricsTab();
}

function renderVolumetricsTab() {
  const v = state.volumetrics;
  const kpiWt = $('vol-kpi-wt');
  const kpiEt = $('vol-kpi-et');
  const kpiSpd = $('vol-kpi-spd');
  const kpiMeas = $('vol-kpi-meas');
  const r2Badge = $('vol-rano2d-badge');
  const r2D1 = $('vol-rano2d-d1');
  const r2D2 = $('vol-rano2d-d2');
  const r2Spd = $('vol-rano2d-spd');
  const r2Slice = $('vol-rano2d-slice');
  const r2Area = $('vol-rano2d-area');
  const r2Comps = $('vol-rano2d-comps');
  const r2Note = $('vol-rano2d-note');
  const jumpBtn = $('btn-jump-best-slice');
  const tbody = $('vol-table-body');

  if (!v) {
    if (kpiWt) kpiWt.textContent = '–';
    if (kpiEt) kpiEt.textContent = '–';
    if (kpiSpd) kpiSpd.textContent = '–';
    if (kpiMeas) kpiMeas.textContent = '–';
    if (r2Badge) {
      r2Badge.textContent = 'No Mask';
      r2Badge.className = 'status-pill pill-neutral';
    }
    if (r2D1) r2D1.textContent = '– mm';
    if (r2D2) r2D2.textContent = '– mm';
    if (r2Spd) r2Spd.textContent = '– mm²';
    if (r2Slice) r2Slice.textContent = '–';
    if (r2Area) r2Area.textContent = '– mm²';
    if (r2Comps) r2Comps.textContent = '–';
    if (r2Note) r2Note.classList.add('hidden');
    if (jumpBtn) jumpBtn.disabled = true;
    renderCompartmentBar($('vol-compartment-bar'), null);
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">Load a segmentation mask to compute 3D volumetrics.</td></tr>';
    return;
  }

  const r2 = v.rano2d;
  const fallback = v.rano2dNonEnhancing;
  const activeR2 = r2.bestSliceZ !== null ? r2 : (fallback || r2);

  if (kpiWt) kpiWt.textContent = fmtNum(v.regions.WT.volumeCm3, 2);
  if (kpiEt) kpiEt.textContent = fmtNum(v.regions.ET.volumeCm3, 2);
  if (kpiSpd) kpiSpd.textContent = r2.spdMm2 > 0 ? fmtNum(r2.spdMm2, 1) : '0.0';
  if (kpiMeas) {
    kpiMeas.textContent = r2.measurable ? 'Measurable' : (r2.spdMm2 > 0 ? 'Non-Meas' : 'No ET');
    kpiMeas.style.color = r2.measurable ? '#2dd4bf' : (r2.spdMm2 > 0 ? '#f59e0b' : '#94a3b8');
  }

  if (r2Badge) {
    if (r2.measurable) {
      r2Badge.textContent = 'Measurable (≥10×10mm)';
      r2Badge.className = 'status-pill pill-good';
    } else if (r2.spdMm2 > 0) {
      r2Badge.textContent = 'Non-Measurable (<10mm)';
      r2Badge.className = 'status-pill pill-warn';
    } else {
      r2Badge.textContent = 'No Enhancing Disease';
      r2Badge.className = 'status-pill pill-neutral';
    }
  }

  if (r2D1) r2D1.textContent = `${fmtNum(activeR2.d1Mm, 1)} mm`;
  if (r2D2) r2D2.textContent = `${fmtNum(activeR2.d2Mm, 1)} mm`;
  if (r2Spd) r2Spd.textContent = `${fmtNum(activeR2.spdMm2, 1)} mm²`;
  if (r2Slice) {
    r2Slice.textContent =
      activeR2.bestSliceZ !== null ? `Z = ${activeR2.bestSliceZ + 1} / ${v.dims[2]}` : 'None';
  }
  if (r2Area) r2Area.textContent = `${fmtNum(activeR2.sliceAreaMm2, 0)} mm²`;
  if (r2Comps) r2Comps.textContent = String(activeR2.componentCountOnSlice || 0);

  if (r2Note) {
    if (r2.bestSliceZ === null && fallback && fallback.bestSliceZ !== null) {
      r2Note.textContent = `No enhancing tumor (ET) detected; displaying non-enhancing Whole Tumor (WT) axial cross-section (${fallback.d1Mm.toFixed(1)} × ${fallback.d2Mm.toFixed(1)} mm = ${fallback.spdMm2.toFixed(1)} mm²) on slice Z=${fallback.bestSliceZ + 1}.`;
      r2Note.classList.remove('hidden');
    } else {
      r2Note.classList.add('hidden');
    }
  }

  if (jumpBtn) {
    const canNavigateMask = maskMatchesBaseDims();
    jumpBtn.disabled = activeR2.bestSliceZ === null || !canNavigateMask;
    jumpBtn.title =
      activeR2.bestSliceZ !== null && !canNavigateMask
        ? 'Mask dimensions do not match active base MRI'
        : '';
  }

  renderCompartmentBar($('vol-compartment-bar'), v);

  // Build compartment & BraTS composite regions table
  const wtVol = v.regions.WT.volumeCm3;
  const rows = [
    { key: 'ET', label: 'ET', sub: 'Enhancing Tumor (3)', color: LABEL_META[3].color, metrics: v.regions.ET, pctOfWt: true },
    { key: 'TC', label: 'TC', sub: 'Tumor Core (1+3)', color: '#fb7185', metrics: v.regions.TC, pctOfWt: true },
    { key: 'WT', label: 'WT', sub: 'Whole Tumor (1+2+3)', color: '#e2e8f0', metrics: v.regions.WT, pctOfWt: true },
    { key: 'NCR', label: 'NCR/NET', sub: 'Necrotic Core (1)', color: LABEL_META[1].color, metrics: v.labels[1], pctOfWt: true },
    { key: 'ED', label: 'Edema', sub: 'Peritumoral FLAIR (2)', color: LABEL_META[2].color, metrics: v.labels[2], pctOfWt: true },
    { key: 'RC', label: 'Cavity', sub: 'Resection Cavity (5)', color: LABEL_META[5].color, metrics: v.labels[5], pctOfWt: false },
  ];

  if (tbody) {
    tbody.innerHTML = rows
      .map((r) => {
        const m = r.metrics;
        const empty = m.voxelCount === 0;
        const pctStr = !r.pctOfWt
          ? 'excl.'
          : wtVol > 0
            ? `${((m.volumeCm3 / wtVol) * 100).toFixed(1)}%`
            : '0.0%';
        const centroidCell = m.centroid
          ? `<button type="button" class="centroid-btn" data-cx="${m.centroid[0].toFixed(2)}" data-cy="${m.centroid[1].toFixed(2)}" data-cz="${m.centroid[2].toFixed(2)}" title="Jump crosshair to ${escHtml(r.label)} centroid">(${Math.round(m.centroid[0])},${Math.round(m.centroid[1])},${Math.round(m.centroid[2])})</button>`
          : '<span class="mono" style="color:#64748b">–</span>';

        return `
          <tr class="${empty ? 'muted-row' : ''}">
            <td>
              <div class="region-cell">
                <span class="swatch" style="--swatch:${escHtml(r.color)}"></span>
                <span>${escHtml(r.label)}</span>
              </div>
              <div class="region-sub">${escHtml(r.sub)}</div>
            </td>
            <td class="num mono">${m.volumeCm3.toFixed(2)}</td>
            <td class="num mono">${pctStr}</td>
            <td class="num mono">${m.eqSphereDiamMm > 0 ? m.eqSphereDiamMm.toFixed(1) : '0.0'}</td>
            <td class="num">${centroidCell}</td>
          </tr>
        `;
      })
      .join('');
  }
}

// ============================================================================
// Tab 2: Extent of Resection (EOR) & RANO-Resect
// ============================================================================

function recomputeEor() {
  if (!state.eorPreVol || !state.eorPostVol) {
    state.eorResult = null;
  } else {
    state.eorResult = computeExtentOfResection(state.eorPreVol, state.eorPostVol);
  }
  renderEorTab();
}

function getResectHeroClass(ranoClass) {
  switch (ranoClass) {
    case 'Class 1':
    case 'Class 2A':
      return 'hero-favorable';
    case 'Class 2B':
      return 'hero-cyan';
    case 'Class 3A':
      return 'hero-warning';
    case 'Class 3B':
    case 'Class 4':
      return 'hero-progression';
    default:
      return 'hero-neutral';
  }
}

function renderEorTab() {
  const preLbl = $('eor-pre-label');
  const postLbl = $('eor-post-label');
  if (preLbl) preLbl.textContent = basename(state.eorPreName);
  if (postLbl) postLbl.textContent = basename(state.eorPostName);

  const e = state.eorResult;
  const heroCard = $('eor-hero-card');
  const heroClass = $('eor-hero-class');
  const heroName = $('eor-hero-name');
  const heroDesc = $('eor-hero-desc');
  const tabBadge = $('tab-badge-eor');

  if (!e) {
    if (heroCard) heroCard.className = 'hero-card hero-neutral';
    if (heroClass) heroClass.textContent = '–';
    if (heroName) heroName.textContent = 'Awaiting Pre-Op & Post-Op Masks';
    if (heroDesc) heroDesc.textContent = 'Load pre-operative and early post-operative (<72h) masks to classify resection per Karschnia et al. (2023).';
    if (tabBadge) tabBadge.classList.add('hidden');

    ['eor-kpi-ce-pct', 'eor-kpi-nonce-pct', 'eor-kpi-res-ce', 'eor-kpi-res-nonce', 'eor-kpi-pre-ce', 'eor-kpi-cavity'].forEach((id) => {
      const el = $(id);
      if (el) el.textContent = '–';
    });
    renderEorChart($('eor-chart-container'), null);
    const rat = $('eor-rationale-list');
    if (rat) rat.innerHTML = '';
    renderResectLegend(null);
    return;
  }

  if (heroCard) heroCard.className = `hero-card ${getResectHeroClass(e.ranoClass)}`;
  if (heroClass) heroClass.textContent = e.ranoClass;
  if (heroName) heroName.textContent = `— ${e.ranoClassName}`;
  if (heroDesc) heroDesc.textContent = e.ranoClassDescription;

  if (tabBadge) {
    const shortTier = e.ranoClass.replace('Class ', '');
    tabBadge.textContent = shortTier;
    tabBadge.className = `tab-mini-badge${
      e.ranoClass === 'Class 1' || e.ranoClass === 'Class 2A'
        ? ' badge-good'
        : e.ranoClass === 'Class 2B'
          ? ' badge-cyan'
          : e.ranoClass === 'Class 3A'
            ? ' badge-warn'
            : e.ranoClass === 'Class 3B' || e.ranoClass === 'Class 4'
              ? ' badge-bad'
              : ''
    }`;
  }

  const setTxt = (id, text) => {
    const el = $(id);
    if (el) el.textContent = text;
  };
  setTxt('eor-kpi-ce-pct', e.hasPreOpCe !== false ? `${e.ceEorPct.toFixed(1)}%` : 'N/A');
  setTxt('eor-kpi-nonce-pct', `${e.nonCeEorPct.toFixed(1)}%`);
  setTxt('eor-kpi-res-ce', `${e.residualCeCm3.toFixed(2)}`);
  setTxt('eor-kpi-res-nonce', `${e.residualNonCeCm3.toFixed(2)}`);
  setTxt('eor-kpi-pre-ce', `${e.preCeCm3.toFixed(2)}`);
  setTxt('eor-kpi-cavity', `${e.cavityCm3.toFixed(2)}`);

  renderEorChart($('eor-chart-container'), e);

  const rat = $('eor-rationale-list');
  if (rat) {
    rat.innerHTML = e.rationale.map((line) => `<li>${escHtml(line)}</li>`).join('');
  }

  renderResectLegend(e.ranoClass);
}

function renderResectLegend(activeClass) {
  const list = $('eor-legend-list');
  if (!list) return;

  const order = ['Class 1', 'Class 2A', 'Class 2B', 'Class 3A', 'Class 3B', 'Class 4'];
  list.innerHTML = order
    .map((tier) => {
      const meta = RANO_RESECT_CLASSES[tier];
      const isActive = tier === activeClass;
      const isExpanded = tier === state.expandedResectTier;
      return `
        <button type="button" class="resect-item ${isActive ? 'is-active' : ''} ${isExpanded ? 'is-expanded' : ''}" data-resect-tier="${escHtml(tier)}" aria-expanded="${String(isActive || isExpanded)}">
          <div class="resect-item-top">
            <span class="resect-item-title">
              <span class="resect-tier-code">${escHtml(meta.ranoClass)}</span>
              <span>${escHtml(meta.name)}</span>
            </span>
            ${isActive ? '<span class="resect-active-tag">✓ Matched</span>' : '<span style="font-size:10px;color:#64748b">Details ▾</span>'}
          </div>
          <p class="resect-item-desc">${escHtml(meta.description)}</p>
        </button>
      `;
    })
    .join('');
}

// ============================================================================
// Tab 3: Longitudinal RANO 2.0
// ============================================================================

function getActiveEvaluatedTimepoints() {
  return state.longitudinalTimepoints.filter((tp) => tp.includeInRano !== false);
}

function getLatestEvaluatedTimepoint() {
  const included = getActiveEvaluatedTimepoints();
  return included.length > 0 ? included[included.length - 1] : null;
}

function recomputeRano2() {
  const evalSeries = getActiveEvaluatedTimepoints();
  state.rano2Result = computeRano2Response(evalSeries);
  renderRano2Tab();
}

function renderRano2Tab() {
  const res = state.rano2Result;
  const heroCard = $('rano2-hero-card');
  const heroBadge = $('rano2-hero-badge');
  const heroTitle = $('rano2-hero-title');
  const heroSub = $('rano2-hero-sub');
  const pillsEl = $('rano2-criteria-pills');
  const tabBadge = $('tab-badge-rano2');

  const severityMap = {
    favorable: { hero: 'hero-favorable', mini: 'badge-good' },
    neutral: { hero: 'hero-neutral', mini: 'badge-cyan' },
    warning: { hero: 'hero-warning', mini: 'badge-warn' },
    progression: { hero: 'hero-progression', mini: 'badge-bad' },
  };

  if (res) {
    const style = severityMap[res.severity] || severityMap.neutral;
    if (heroCard) heroCard.className = `hero-card ${style.hero}`;
    if (heroBadge) heroBadge.textContent = res.shortCode === 'PRELIM_PD' ? 'PRELIM PD' : res.shortCode;

    const fullNames = {
      CR: 'Complete Response',
      PR: 'Partial Response',
      MR: 'Minor Response',
      SD: 'Stable Disease',
      PD: 'Progressive Disease',
      PRELIM_PD: 'Preliminary PD (Confirm ≥4 wks)',
      BASELINE: 'Baseline Only',
    };
    if (heroTitle) heroTitle.textContent = `— ${fullNames[res.shortCode] || res.category}`;
    if (heroSub) {
      heroSub.textContent =
        res.shortCode === 'BASELINE'
          ? 'At least two included longitudinal timepoints (baseline + follow-up) are needed for RANO 2.0 response.'
          : `Comparing "${res.current.label}" against baseline "${res.baseline.label}" and prior nadir.`;
    }

    if (tabBadge) {
      tabBadge.textContent = res.shortCode === 'PRELIM_PD' ? 'pPD' : res.shortCode === 'BASELINE' ? 'BASE' : res.shortCode;
      tabBadge.className = `tab-mini-badge ${style.mini}`;
    }

    // Triggered criteria pills
    if (pillsEl) {
      const c = res.criteriaTriggered;
      const pills = [];
      if (c.spdProgression) pills.push('<span class="crit-pill crit-alert">2D SPD ≥+25% vs Nadir</span>');
      if (c.volProgression) pills.push('<span class="crit-pill crit-alert">3D Vol ≥+40% vs Nadir</span>');
      if (c.newLesion) pills.push('<span class="crit-pill crit-alert">New Measurable Lesion</span>');
      if (c.clinicalDeterioration) pills.push('<span class="crit-pill crit-alert">Clinical Deterioration</span>');
      if (c.confirmationRequired) pills.push('<span class="crit-pill crit-warn">≤12w Post-RT Confirm ≥4 wks</span>');
      if (c.steroidBlockedResponse) {
        const steroidLabel =
          res.shortCode === 'PR'
            ? 'Therapeutic Steroids → CR Downgraded to PR'
            : 'Steroids Increased → Downgraded to SD';
        pills.push(`<span class="crit-pill crit-warn">${steroidLabel}</span>`);
      }
      if (pills.length === 0 && res.shortCode !== 'BASELINE') {
        pills.push(`<span class="crit-pill ${res.severity === 'favorable' ? 'crit-good' : ''}">No Progression Triggered</span>`);
      }
      pillsEl.innerHTML = pills.join('');
    }

    // Delta KPIs
    const setDelta = (id, pct, progThreshold) => {
      const el = $(id);
      if (!el) return;
      el.textContent = fmtSignedPct(pct, 1);
      if (pct === null || (Number.isFinite(pct) && progThreshold !== null && pct >= progThreshold)) {
        el.style.color = '#fda4af';
      } else if (Number.isFinite(pct) && pct <= -25) {
        el.style.color = '#86efac';
      } else {
        el.style.color = '#f1f5f9';
      }
    };

    setDelta('rano2-delta-spd-base', res.spdChangeVsBaselinePct, null);
    setDelta('rano2-delta-spd-nadir', res.spdChangeVsNadirPct, 25);
    setDelta('rano2-delta-vol-base', res.volChangeVsBaselinePct, null);
    setDelta('rano2-delta-vol-nadir', res.volChangeVsNadirPct, 40);

    const nadirSummary = $('rano2-nadir-summary');
    if (nadirSummary) {
      nadirSummary.textContent = `Nadir: ${res.nadir.volumeCm3.toFixed(2)} cm³ · ${res.nadir.spdMm2.toFixed(0)} mm²`;
    }

    const rat = $('rano2-rationale-list');
    if (rat) {
      rat.innerHTML = res.rationale.map((line) => `<li>${escHtml(line)}</li>`).join('');
    }
  }

  // Sync Clinical Co-Factor inputs with latest evaluated timepoint
  const latest = getLatestEvaluatedTimepoint();
  const targetLbl = $('rano2-eval-target-label');
  const selSteroids = $('rano2-steroids');
  const selClinical = $('rano2-clinical');
  const chkNew = $('rano2-new-lesion');
  const chk12w = $('rano2-within-12w');

  if (targetLbl) targetLbl.textContent = latest ? `Evaluating: ${latest.label}` : 'No active follow-up';
  if (selSteroids) {
    selSteroids.disabled = !latest;
    if (latest) selSteroids.value = latest.steroids || 'stable_or_decreased';
  }
  if (selClinical) {
    selClinical.disabled = !latest;
    if (latest) selClinical.value = latest.clinicalStatus || 'stable_or_improved';
  }
  if (chkNew) {
    chkNew.disabled = !latest;
    chkNew.checked = Boolean(latest?.newMeasurableLesion);
  }
  if (chk12w) {
    chk12w.disabled = !latest;
    chk12w.checked = Boolean(latest?.within12WeeksPostRT);
  }

  // Render interactive SVG trajectory chart
  renderLongitudinalChart($('rano2-chart-container'), state.longitudinalTimepoints, res);

  // Render editable multi-timepoint table
  renderRano2Table();
}

function renderRano2Table() {
  const tbody = $('rano2-table-body');
  if (!tbody) return;

  const includedIds = getActiveEvaluatedTimepoints().map((t) => t.id);
  const baseId = includedIds.length > 0 ? includedIds[0] : null;
  const currId = includedIds.length >= 2 ? includedIds[includedIds.length - 1] : null;

  tbody.innerHTML = state.longitudinalTimepoints
    .map((tp, idx) => {
      const isIncluded = tp.includeInRano !== false;
      const roleBadge = !isIncluded
        ? '<span class="tp-role-tag role-preop">Pre-Op Ref</span>'
        : tp.id === baseId
          ? '<span class="tp-role-tag role-base">Baseline</span>'
          : tp.id === currId
            ? '<span class="tp-role-tag role-current">Current</span>'
            : '';

      const viewBtn = tp.sampleTpId
        ? `<button type="button" class="btn-xs" data-tp-action="view" data-tp-idx="${idx}" title="Display this scan in the 4-pane viewer">View</button>`
        : '';
      const delBtn = tp.custom
        ? `<button type="button" class="btn-xs btn-xs-danger" data-tp-action="delete" data-tp-idx="${idx}" title="Remove custom timepoint">×</button>`
        : '';

      return `
        <tr class="${!isIncluded ? 'muted-row' : ''}">
          <td>
            <input type="checkbox" data-tp-field="includeInRano" data-tp-idx="${idx}" ${isIncluded ? 'checked' : ''} aria-label="Include ${escHtml(tp.label)} in RANO 2.0" />
          </td>
          <td>
            <div class="tp-name-wrap">
              <div class="tp-name-row">
                ${
                  tp.custom
                    ? `<input type="text" class="cell-input cell-input-label" data-tp-field="label" data-tp-idx="${idx}" value="${escHtml(tp.label)}" aria-label="Scan label" />`
                    : `<strong style="font-size:11px;">${escHtml(tp.label)}</strong>`
                }
                ${roleBadge}
              </div>
              <input type="date" class="cell-input cell-input-date" data-tp-field="date" data-tp-idx="${idx}" value="${escHtml(tp.date || '')}" aria-label="Scan date for ${escHtml(tp.label)}" />
            </div>
          </td>
          <td class="num">
            <input type="number" class="cell-input" step="0.1" min="0" data-tp-field="spdMm2" data-tp-idx="${idx}" value="${Number(tp.spdMm2 || 0).toFixed(1)}" aria-label="SPD mm² for ${escHtml(tp.label)}" />
          </td>
          <td class="num">
            <input type="number" class="cell-input" step="0.01" min="0" data-tp-field="volumeCm3" data-tp-idx="${idx}" value="${Number(tp.volumeCm3 || 0).toFixed(2)}" aria-label="Volume cm³ for ${escHtml(tp.label)}" />
          </td>
          <td class="num">
            <div class="tp-row-actions">${viewBtn}${delBtn}</div>
          </td>
        </tr>
      `;
    })
    .join('');
}

// ============================================================================
// Tab 4: AI Segmentation Evaluator
// ============================================================================

function recomputeAiEvaluation(options = {}) {
  const quietOnMismatch = Boolean(options.quietOnMismatch);

  if (!state.aiGtVol || !state.aiPredVol) {
    state.aiEvalResult = null;
    if (viewer) viewer.setErrorVolume(null, state.aiActiveRegion);
    if (state.overlayMode === 'error') setOverlayModeUI('mask');
    renderAiTab();
    return;
  }

  const check = validateMatchingGeometry(state.aiGtVol, state.aiPredVol);
  if (!check.dimsMatch) {
    state.aiEvalResult = null;
    if (!quietOnMismatch) {
      showAlertBanner(`AI Evaluation blocked — ${check.message}`, false);
      showToast(`AI Evaluation error: ${check.message}`, 'error', 6000);
    }
    if (viewer) viewer.setErrorVolume(null, state.aiActiveRegion);
    if (state.overlayMode === 'error') setOverlayModeUI('mask');
    renderAiTab();
    return;
  }

  try {
    state.aiEvalResult = evaluateSegmentation(state.aiGtVol, state.aiPredVol, {
      errorRegion: state.aiActiveRegion,
    });
    if (viewer) {
      viewer.setErrorVolume(state.aiEvalResult.errorVolume, state.aiGtVol.dims, state.aiActiveRegion);
    }
  } catch (err) {
    state.aiEvalResult = null;
    if (viewer) viewer.setErrorVolume(null, state.aiActiveRegion);
    if (state.overlayMode === 'error') setOverlayModeUI('mask');
    const msg = err instanceof Error ? err.message : String(err);
    showAlertBanner(`AI Evaluation failed: ${msg}`, false);
    showToast(msg, 'error', 5500);
  }

  renderAiTab();
}

function selectAiRegion(region) {
  if (!['ET', 'TC', 'WT', 'RC'].includes(region)) return;
  state.aiActiveRegion = region;

  document.querySelectorAll('#ai-region-selector button.region-pill').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.region === region);
  });

  if (state.aiGtVol && state.aiPredVol && state.aiEvalResult) {
    try {
      const errVol = buildErrorVolume(state.aiGtVol, state.aiPredVol, region);
      state.aiEvalResult.errorRegion = region;
      state.aiEvalResult.errorVolume = errVol;
      if (viewer) {
        viewer.setErrorVolume(errVol, state.aiGtVol.dims, region);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  // Update overlay toggle button label
  setOverlayModeUI(state.overlayMode);
  renderAiTab();
}

async function toggleAiErrorOverlay() {
  if (!state.aiEvalResult || !state.aiGtVol || !state.aiPredVol) {
    showToast('Load both Ground Truth and AI Prediction masks to enable the 3D TP/FP/FN overlay.', 'warning');
    return;
  }

  if (state.aiErrorOverlayOn) {
    setOverlayModeUI('mask');
    return;
  }

  // If AI eval is bound to Case 01 Pre-Op while the viewer is showing Post-Op/Follow-Up,
  // smoothly align the viewer's base MRI to Pre-Op so TP/FP/FN matches the anatomical scan!
  if (state.aiSourceTag === 'case01_preop' && state.activeTimepointId !== 'preop' && state.activeCase) {
    await switchSampleTimepoint('preop', { keepOverlayMode: true, quiet: true });
    showToast('Switched viewer MRI to Pre-Op so 3D TP/FP/FN error map aligns anatomically.', 'info', 3800);
  }

  // Re-validate GT vs Pred dims before building error volume
  if (!state.aiGtVol || !state.aiPredVol) {
    state.aiEvalResult = null;
    renderAiTab();
    showToast('Load both Ground Truth and AI Prediction masks to enable the 3D TP/FP/FN overlay.', 'warning');
    return;
  }
  const pairGeom = validateMatchingGeometry(state.aiGtVol, state.aiPredVol);
  if (!pairGeom.dimsMatch) {
    state.aiEvalResult = null;
    if (viewer) viewer.setErrorVolume(null, state.aiActiveRegion);
    renderAiTab();
    showAlertBanner(`Cannot render 3D TP/FP/FN error overlay — ${pairGeom.message}`, false);
    showToast(pairGeom.message, 'error', 5500);
    return;
  }

  // Validate dims against active viewer MRI
  if (state.baseVol && state.aiGtVol) {
    const geom = validateMatchingGeometry(state.baseVol, state.aiGtVol);
    if (!geom.dimsMatch) {
      showAlertBanner(`Cannot render 3D TP/FP/FN error overlay on current MRI — ${geom.message}`, false);
      showToast(geom.message, 'error', 5500);
      return;
    }
  }

  try {
    const errVol = buildErrorVolume(state.aiGtVol, state.aiPredVol, state.aiActiveRegion);
    viewer.setErrorVolume(errVol, state.aiGtVol.dims, state.aiActiveRegion);
    setOverlayModeUI('error');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showAlertBanner(`Cannot render 3D TP/FP/FN error overlay — ${msg}`, false);
    showToast(msg, 'error', 5500);
  }
}

function renderAiTab() {
  const gtLbl = $('ai-gt-label');
  const predLbl = $('ai-pred-label');
  if (gtLbl) gtLbl.textContent = basename(state.aiGtName);
  if (predLbl) predLbl.textContent = basename(state.aiPredName);

  const res = state.aiEvalResult;
  const tabBadge = $('tab-badge-ai');
  const sumDice = $('ai-summary-dice');
  const sumHd95 = $('ai-summary-hd95');
  const tbody = $('ai-table-body');

  document.querySelectorAll('#ai-region-selector button.region-pill').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.region === state.aiActiveRegion);
  });

  if (!res) {
    if (tabBadge) tabBadge.classList.add('hidden');
    if (sumDice) sumDice.textContent = '–';
    if (sumHd95) sumHd95.textContent = '–';
    ['ai-kpi-dice', 'ai-kpi-iou', 'ai-kpi-hd95', 'ai-kpi-assd', 'ai-kpi-sens', 'ai-kpi-prec', 'ai-kpi-rve', 'ai-kpi-voxels'].forEach((id) => {
      const el = $(id);
      if (el) el.textContent = '–';
    });
    renderAiBenchmarkChart($('ai-chart-container'), null);
    if (tbody) {
      const hasMismatch =
        state.aiGtVol &&
        state.aiPredVol &&
        !validateMatchingGeometry(state.aiGtVol, state.aiPredVol).dimsMatch;
      tbody.innerHTML = hasMismatch
        ? `<tr><td colspan="7" class="empty-cell">Ground Truth (${escHtml(state.aiGtVol.dims.join('×'))}) and AI Prediction (${escHtml(state.aiPredVol.dims.join('×'))}) dimensions do not match — load a matching prediction mask to evaluate.</td></tr>`
        : '<tr><td colspan="7" class="empty-cell">Load Ground Truth and AI Prediction masks to evaluate.</td></tr>';
    }
    return;
  }

  if (tabBadge) {
    tabBadge.textContent = res.summary.meanDiceActive.toFixed(2);
    tabBadge.className = `tab-mini-badge ${
      res.summary.meanDiceActive >= 0.85 ? 'badge-good' : res.summary.meanDiceActive >= 0.70 ? 'badge-warn' : 'badge-bad'
    }`;
  }

  if (sumDice) sumDice.textContent = res.summary.meanDiceActive.toFixed(3);
  if (sumHd95) {
    sumHd95.textContent = res.summary.meanHd95Mm !== null ? `${res.summary.meanHd95Mm.toFixed(2)} mm` : 'N/A';
  }

  const m = res.regions[state.aiActiveRegion] || res.regions.ET;
  const setTxt = (id, text) => {
    const el = $(id);
    if (el) el.textContent = text;
  };

  if (m.bothEmpty) {
    setTxt('ai-kpi-dice', '1.000*');
    setTxt('ai-kpi-iou', '1.000*');
    setTxt('ai-kpi-hd95', '0.00');
    setTxt('ai-kpi-assd', '0.00');
    setTxt('ai-kpi-sens', 'N/A');
    setTxt('ai-kpi-prec', 'N/A');
    setTxt('ai-kpi-rve', '0.0% (Both Empty)');
    setTxt('ai-kpi-voxels', 'TP 0 · FP 0 · FN 0');
  } else {
    setTxt('ai-kpi-dice', m.dice.toFixed(3));
    setTxt('ai-kpi-iou', m.iou.toFixed(3));
    setTxt('ai-kpi-hd95', m.hd95Mm !== null ? m.hd95Mm.toFixed(2) : 'N/A');
    setTxt('ai-kpi-assd', m.assdMm !== null ? m.assdMm.toFixed(2) : 'N/A');
    setTxt('ai-kpi-sens', m.sensitivity.toFixed(3));
    setTxt('ai-kpi-prec', m.precision.toFixed(3));
    setTxt('ai-kpi-rve', fmtSignedPct(m.rvePct, 1, 'Pred > 0 (GT=0)'));
    setTxt('ai-kpi-voxels', `TP ${m.tp.toLocaleString()} · FP ${m.fp.toLocaleString()} · FN ${m.fn.toLocaleString()}`);
  }

  renderAiBenchmarkChart($('ai-chart-container'), res, state.aiActiveRegion, (reg) => selectAiRegion(reg));

  if (tbody) {
    const order = [
      { key: 'ET', desc: 'Enhancing', color: LABEL_META[3].color },
      { key: 'TC', desc: 'Tumor Core', color: '#fb7185' },
      { key: 'WT', desc: 'Whole Tumor', color: '#e2e8f0' },
      { key: 'RC', desc: 'Cavity', color: LABEL_META[5].color },
    ];
    tbody.innerHTML = order
      .map((item) => {
        const rm = res.regions[item.key];
        const isSel = item.key === state.aiActiveRegion;
        return `
          <tr class="clickable-row ${isSel ? 'selected-row' : ''} ${rm.bothEmpty ? 'muted-row' : ''}" tabindex="0" data-ai-region="${escHtml(item.key)}" aria-label="Select ${escHtml(item.key)} (${escHtml(item.desc)}) region">
            <td>
              <div class="region-cell">
                <span class="swatch" style="--swatch:${escHtml(item.color)}"></span>
                <span>${escHtml(item.key)}</span>
              </div>
              <div class="region-sub">${escHtml(item.desc)}</div>
            </td>
            <td class="num mono">${rm.bothEmpty ? '–' : rm.dice.toFixed(3)}</td>
            <td class="num mono">${rm.bothEmpty ? '–' : rm.iou.toFixed(3)}</td>
            <td class="num mono">${rm.bothEmpty ? '–' : (rm.hd95Mm !== null ? rm.hd95Mm.toFixed(2) : 'N/A')}</td>
            <td class="num mono">${rm.bothEmpty ? '–' : (rm.assdMm !== null ? rm.assdMm.toFixed(2) : 'N/A')}</td>
            <td class="num mono">${rm.bothEmpty ? '–' : fmtSignedPct(rm.rvePct, 1, 'N/A')}</td>
            <td class="num mono">${rm.gtCm3.toFixed(1)}/${rm.predCm3.toFixed(1)}</td>
          </tr>
        `;
      })
      .join('');
  }
}

// ============================================================================
// Sample Dataset Workflows & Preset Switching
// ============================================================================

async function loadManifest() {
  const resp = await fetch('assets/samples/manifest.json');
  if (!resp.ok) {
    throw new Error(`Failed to fetch sample manifest (HTTP ${resp.status}).`);
  }
  state.manifest = await resp.json();
  state.activeCase = state.manifest?.cases?.[0] || null;
  if (!state.activeCase) {
    throw new Error('Sample manifest contains no cases.');
  }
}

function getSampleTimepointMeta(tpId) {
  return state.activeCase?.timepoints?.find((t) => t.id === tpId) || null;
}

async function switchSampleTimepoint(tpId, options = {}) {
  const tp = getSampleTimepointMeta(tpId);
  if (!tp) return;

  if (!options.quiet) {
    setViewerLoading(true, `Loading ${tp.label} (${basename(tp.t1ce)})…`);
  }

  try {
    const [mriVol, maskVol] = await Promise.all([
      fetchCachedNifti(tp.t1ce),
      fetchCachedNifti(tp.mask),
    ]);

    setActiveTimepointPillUI(tpId);

    if (!options.keepOverlayMode && state.overlayMode === 'error' && tpId !== 'preop') {
      setOverlayModeUI('mask');
    }

    mountViewerVolumes({
      baseVol: mriVol,
      baseName: tp.t1ce,
      maskVol,
      maskName: tp.mask,
      snapToTumor: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showToast(`Failed to load ${tp.label}: ${msg}`, 'error', 6000);
  } finally {
    if (!options.quiet) setViewerLoading(false);
  }
}

function buildDefaultLongitudinalSeries() {
  return state.sampleTimepointSnapshots.map((s) => ({ ...s }));
}

function hydrateBackgroundSampleClinicalModules() {
  if (backgroundHydrationPromise) return backgroundHydrationPromise;
  backgroundHydrationPromise = (async () => {
    if (!state.activeCase) return;
    const preTp = getSampleTimepointMeta('preop');
    const postTp = getSampleTimepointMeta('postop');
    const fuTp = getSampleTimepointMeta('followup');
    if (!preTp || !postTp || !fuTp) return;

    try {
      const [preMask, postMask, fuMask] = await Promise.all([
        fetchCachedNifti(preTp.mask),
        fetchCachedNifti(postTp.mask),
        fetchCachedNifti(fuTp.mask),
      ]);

      // Populate EOR & RANO-Resect (Pre-Op GT vs Post-Op Mask) only if user hasn't already loaded custom EOR masks
      if (!state.eorPreVol && !state.eorPostVol) {
        state.eorPreVol = preMask;
        state.eorPreName = preTp.mask;
        state.eorPostVol = postMask;
        state.eorPostName = postTp.mask;
        recomputeEor();
      }

      // Compute exact live volumetrics + 2D SPD from all 3 sample masks for Longitudinal RANO 2.0
      const preVolm = computeVolumetrics(preMask);
      const postVolm = computeVolumetrics(postMask);
      const fuVolm = computeVolumetrics(fuMask);

      state.sampleTimepointSnapshots = [
        {
          id: 'preop',
          sampleTpId: 'preop',
          label: preTp.label,
          date: preTp.date,
          role: preTp.role,
          includeInRano: false, // Pre-op context; standard RANO 2.0 baseline is post-RT MRI (~4 wks post-RT; Case 01 uses Early Post-Op as an illustrative pre-RT/surgical baseline)
          spdMm2: preVolm.rano2d.spdMm2,
          volumeCm3: preVolm.regions.ET.volumeCm3,
          steroids: preTp.steroids,
          clinicalStatus: preTp.clinicalStatus,
          newMeasurableLesion: preTp.newMeasurableLesion,
          within12WeeksPostRT: preTp.within12WeeksPostRT,
          custom: false,
        },
        {
          id: 'postop',
          sampleTpId: 'postop',
          label: postTp.label,
          date: postTp.date,
          role: postTp.role,
          includeInRano: true,
          spdMm2: postVolm.rano2d.spdMm2,
          volumeCm3: postVolm.regions.ET.volumeCm3,
          steroids: postTp.steroids,
          clinicalStatus: postTp.clinicalStatus,
          newMeasurableLesion: postTp.newMeasurableLesion,
          within12WeeksPostRT: postTp.within12WeeksPostRT,
          custom: false,
        },
        {
          id: 'followup',
          sampleTpId: 'followup',
          label: fuTp.label,
          date: fuTp.date,
          role: fuTp.role,
          includeInRano: true,
          spdMm2: fuVolm.rano2d.spdMm2,
          volumeCm3: fuVolm.regions.ET.volumeCm3,
          steroids: fuTp.steroids,
          clinicalStatus: fuTp.clinicalStatus,
          newMeasurableLesion: fuTp.newMeasurableLesion,
          within12WeeksPostRT: fuTp.within12WeeksPostRT,
          custom: false,
        },
      ];

      if (state.longitudinalTimepoints.length === 0) {
        state.longitudinalTimepoints = buildDefaultLongitudinalSeries();
        recomputeRano2();
      }
    } catch (err) {
      backgroundHydrationPromise = null;
      console.error('Background sample hydration failed:', err);
    }
  })();
  return backgroundHydrationPromise;
}

async function applySamplePreset(presetId) {
  if (!state.activeCase) return;
  setActivePresetUI(presetId);

  const preTp = getSampleTimepointMeta('preop');
  const postTp = getSampleTimepointMeta('postop');
  const fuTp = getSampleTimepointMeta('followup');

  if (presetId === 'preop_ai') {
    setViewerLoading(true, 'Loading Case 01 — Pre-Op GBM + AI Evaluation…');
    try {
      const [t1Vol, gtVol, predVol] = await Promise.all([
        fetchCachedNifti(preTp.t1ce),
        fetchCachedNifti(preTp.mask),
        fetchCachedNifti(preTp.predMask),
      ]);
      state.secondaryName = preTp.predMask;
      state.aiGtVol = gtVol;
      state.aiGtName = preTp.mask;
      state.aiPredVol = predVol;
      state.aiPredName = preTp.predMask;
      state.aiSourceTag = 'case01_preop';

      setActiveTimepointPillUI('preop');
      setOverlayModeUI('mask');
      mountViewerVolumes({
        baseVol: t1Vol,
        baseName: preTp.t1ce,
        maskVol: gtVol,
        maskName: preTp.mask,
        snapToTumor: true,
      });
      recomputeAiEvaluation();
      setActiveTab('volumetrics');
      showToast('Loaded Case 01 Pre-Op GBM with Ground Truth & AI Prediction.', 'success', 3200);
    } catch (err) {
      showToast(`Preset load failed: ${err instanceof Error ? err.message : String(err)}`, 'error', 6000);
    } finally {
      setViewerLoading(false);
    }
    return;
  }

  if (presetId === 'eor_pair') {
    setViewerLoading(true, 'Loading Case 01 — Pre/Post-Op EOR Pair…');
    try {
      const [preMask, postT1, postMask] = await Promise.all([
        fetchCachedNifti(preTp.mask),
        fetchCachedNifti(postTp.t1ce),
        fetchCachedNifti(postTp.mask),
      ]);
      state.eorPreVol = preMask;
      state.eorPreName = preTp.mask;
      state.eorPostVol = postMask;
      state.eorPostName = postTp.mask;
      state.secondaryName = postTp.mask;

      setActiveTimepointPillUI('postop');
      setOverlayModeUI('mask');
      mountViewerVolumes({
        baseVol: postT1,
        baseName: postTp.t1ce,
        maskVol: postMask,
        maskName: postTp.mask,
        snapToTumor: true,
      });
      recomputeEor();
      setActiveTab('eor');
      showToast(
        `EOR Pair ready — ${state.eorResult?.ranoClass} (${state.eorResult?.ceEorPct.toFixed(1)}% CE EOR).`,
        'success',
        3600
      );
    } catch (err) {
      showToast(`Preset load failed: ${err instanceof Error ? err.message : String(err)}`, 'error', 6000);
    } finally {
      setViewerLoading(false);
    }
    return;
  }

  if (presetId === 'longitudinal_rano2') {
    setViewerLoading(true, 'Loading Full 3-Timepoint Case 01 (RANO 2.0)…');
    try {
      if (state.sampleTimepointSnapshots.length < 3) {
        await hydrateBackgroundSampleClinicalModules();
      }
      const [fuT1, fuMask] = await Promise.all([
        fetchCachedNifti(fuTp.t1ce),
        fetchCachedNifti(fuTp.mask),
      ]);
      state.longitudinalTimepoints = buildDefaultLongitudinalSeries();
      state.secondaryName = fuTp.mask;

      setActiveTimepointPillUI('followup');
      setOverlayModeUI('mask');
      mountViewerVolumes({
        baseVol: fuT1,
        baseName: fuTp.t1ce,
        maskVol: fuMask,
        maskName: fuTp.mask,
        snapToTumor: true,
      });
      recomputeRano2();
      setActiveTab('rano2');
      showToast(
        `Loaded 3-timepoint Case 01 — RANO 2.0: ${state.rano2Result?.category}.`,
        'info',
        3800
      );
    } catch (err) {
      showToast(`Preset load failed: ${err instanceof Error ? err.message : String(err)}`, 'error', 6000);
    } finally {
      setViewerLoading(false);
    }
  }
}

// ============================================================================
// Local User NIfTI File Loading & Drag-and-Drop
// ============================================================================

async function handleLocalFileLoad(file, slot) {
  if (!file) return;
  setViewerLoading(true, `Parsing local NIfTI "${file.name}" in browser memory…`);
  try {
    const vol = await loadNiftiFile(file);

    if (slot === 'mri') {
      setActivePresetUI('custom');
      setActiveTimepointPillUI('custom');
      mountViewerVolumes({
        baseVol: vol,
        baseName: file.name,
        maskVol: state.maskVol,
        maskName: state.maskName,
        snapToTumor: false,
      });
      showToast(`Loaded Base MRI "${file.name}" (${vol.dims.join('×')}).`, 'success');
    } else if (slot === 'mask') {
      setActivePresetUI('custom');
      const wasErrorOverlay = state.overlayMode === 'error';
      mountViewerVolumes({
        maskVol: vol,
        maskName: file.name,
        snapToTumor: true,
      });
      // Sync as AI GT candidate and keep AI QA state consistent
      state.aiGtVol = vol;
      state.aiGtName = file.name;
      state.aiSourceTag = 'custom';
      recomputeAiEvaluation({ quietOnMismatch: state.activeTab !== 'ai' && !wasErrorOverlay });
      showToast(`Loaded Primary Mask "${file.name}".`, 'success');
    } else if (slot === 'secondary') {
      state.secondaryName = file.name;
      updateVolumeMetaUI();
      const lower = file.name.toLowerCase();
      const looksPostOp = state.activeTab === 'eor' || /post|resect|cavity/.test(lower);

      if (looksPostOp) {
        state.eorPostVol = vol;
        state.eorPostName = file.name;
        if (!state.eorPreVol && state.maskVol) {
          state.eorPreVol = state.maskVol;
          state.eorPreName = state.maskName;
        }
        recomputeEor();
        showToast(`Bound "${file.name}" as Post-Op Mask and updated RANO-Resect EOR.`, 'success');
      } else {
        state.aiPredVol = vol;
        state.aiPredName = file.name;
        state.aiSourceTag = 'custom';
        if (!state.aiGtVol && state.maskVol) {
          state.aiGtVol = state.maskVol;
          state.aiGtName = state.maskName;
        }
        recomputeAiEvaluation();
        showToast(`Bound "${file.name}" as AI Prediction and updated QA metrics.`, 'success');
      }
    } else if (slot === 'eor-pre') {
      state.eorPreVol = vol;
      state.eorPreName = file.name;
      recomputeEor();
      showToast(`Loaded Pre-Op Mask "${file.name}" for EOR.`, 'success');
    } else if (slot === 'eor-post') {
      state.eorPostVol = vol;
      state.eorPostName = file.name;
      state.secondaryName = file.name;
      updateVolumeMetaUI();
      recomputeEor();
      showToast(`Loaded Post-Op Mask "${file.name}" for EOR.`, 'success');
    } else if (slot === 'ai-gt') {
      state.aiGtVol = vol;
      state.aiGtName = file.name;
      state.aiSourceTag = 'custom';
      recomputeAiEvaluation();
      showToast(`Loaded Ground Truth "${file.name}" for AI QA.`, 'success');
    } else if (slot === 'ai-pred') {
      state.aiPredVol = vol;
      state.aiPredName = file.name;
      state.secondaryName = file.name;
      state.aiSourceTag = 'custom';
      updateVolumeMetaUI();
      recomputeAiEvaluation();
      showToast(`Loaded AI Prediction "${file.name}" for AI QA.`, 'success');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showAlertBanner(`Could not parse "${file.name}": ${msg}`, false);
    showToast(`Invalid NIfTI file: ${msg}`, 'error', 6500);
  } finally {
    setViewerLoading(false);
  }
}

function inferDropSlot(filename) {
  const lower = filename.toLowerCase();
  if (/pred|infer|ai_|model|output/.test(lower)) return 'secondary';
  if (/postop|post_op|resect/.test(lower)) return 'secondary';
  if (/mask|seg|label|gt|tumor|brats/.test(lower)) return 'mask';
  return 'mri';
}

// ============================================================================
// Report Exports: JSON, CSV, and Print Clinical Summary
// ============================================================================

function buildStructuredReportPayload() {
  const aiSummary = state.aiEvalResult
    ? {
        groundTruth: basename(state.aiGtName),
        prediction: basename(state.aiPredName),
        summary: state.aiEvalResult.summary,
        regions: state.aiEvalResult.regions,
      }
    : null;

  return {
    application: 'NeuroScope-RANO',
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    disclaimer:
      'Research & Educational Tool — Not FDA/CE Approved for Clinical Diagnosis. Processed 100% locally in browser memory.',
    activeStudy: {
      caseTitle: state.activeCase?.title || 'Local User Study',
      diagnosis: state.activeCase?.diagnosis || null,
      baseMri: basename(state.baseName),
      primaryMask: basename(state.maskName),
      dims: state.baseVol?.dims || null,
      pixdimMm: state.baseVol?.pixdim || null,
      colormap: COLORMAPS[state.colormap]?.name || 'Grayscale',
      windowLevel: viewer
        ? {
            windowWidth: Number(viewer.getState().windowWidth.toFixed(1)),
            windowLevel: Number(viewer.getState().windowLevel.toFixed(1)),
          }
        : null,
    },
    volumetrics: state.volumetrics,
    ranoResectEor: state.eorResult
      ? {
          preOpMask: basename(state.eorPreName),
          postOpMask: basename(state.eorPostName),
          ...state.eorResult,
        }
      : null,
    longitudinalRano2: {
      timepoints: state.longitudinalTimepoints.map(({ custom, sampleTpId, ...rest }) => rest),
      assessment: state.rano2Result,
    },
    aiSegmentationEvaluation: aiSummary,
  };
}

function exportJsonReport() {
  const payload = buildStructuredReportPayload();
  const filename = `neuroscope-rano-report-${isoToday()}.json`;
  triggerDownload(filename, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
  showToast(`Downloaded JSON report: ${filename}`, 'success', 3200);
}

function exportCsvSummary() {
  const rows = [
    ['Section', 'Item', 'Metric', 'Value', 'Unit / Notes'],
    ['Metadata', 'Application', 'Tool', 'NeuroScope-RANO v1.0', '100% Browser-Local'],
    ['Metadata', 'Generated', 'Date', new Date().toISOString(), 'Research & Educational Only'],
    ['Metadata', 'Active MRI', 'Filename', basename(state.baseName), state.baseVol ? state.baseVol.dims.join('x') : ''],
    ['Metadata', 'Active Mask', 'Filename', basename(state.maskName), state.baseVol ? state.baseVol.pixdim.join('x') + ' mm' : ''],
  ];

  if (state.volumetrics) {
    const v = state.volumetrics;
    const regionMap = [
      ['ET (Enhancing)', v.regions.ET],
      ['TC (Tumor Core)', v.regions.TC],
      ['WT (Whole Tumor)', v.regions.WT],
      ['NCR/NET (Label 1)', v.labels[1]],
      ['Edema (Label 2)', v.labels[2]],
      ['Cavity RC (Label 5)', v.labels[5]],
    ];
    for (const [name, m] of regionMap) {
      rows.push(['Volumetrics', name, 'Volume', m.volumeCm3.toFixed(3), 'cm³']);
      rows.push(['Volumetrics', name, 'Equivalent Diameter', m.eqSphereDiamMm.toFixed(2), 'mm']);
    }
    rows.push(['Axial RANO 2D', 'ET Major d1', 'Diameter', v.rano2d.d1Mm.toFixed(2), 'mm']);
    rows.push(['Axial RANO 2D', 'ET Minor d2', 'Diameter', v.rano2d.d2Mm.toFixed(2), 'mm']);
    rows.push(['Axial RANO 2D', 'Bidimensional SPD', 'Product', v.rano2d.spdMm2.toFixed(2), 'mm²']);
    rows.push([
      'Axial RANO 2D',
      'Measurability',
      'Status',
      v.rano2d.measurable ? 'Measurable' : 'Non-Measurable',
      v.rano2d.bestSliceZ !== null ? `Best Slice Z=${v.rano2d.bestSliceZ + 1}` : 'No ET',
    ]);
  }

  if (state.eorResult) {
    const e = state.eorResult;
    rows.push(['RANO-Resect EOR', 'Classification', 'Class', `${e.ranoClass} - ${e.ranoClassName}`, e.ranoClassDescription]);
    rows.push(['RANO-Resect EOR', 'Enhancing (CE)', 'EOR', e.hasPreOpCe !== false ? e.ceEorPct.toFixed(2) : 'N/A', '%']);
    rows.push(['RANO-Resect EOR', 'Enhancing (CE)', 'Residual Volume', e.residualCeCm3.toFixed(3), 'cm³']);
    rows.push(['RANO-Resect EOR', 'Non-CE (NCR+ED)', 'EOR', e.nonCeEorPct.toFixed(2), '%']);
    rows.push(['RANO-Resect EOR', 'Non-CE (NCR+ED)', 'Residual Volume', e.residualNonCeCm3.toFixed(3), 'cm³']);
    rows.push(['RANO-Resect EOR', 'Cavity (RC)', 'Volume', e.cavityCm3.toFixed(3), 'cm³']);
  }

  if (state.rano2Result) {
    const r = state.rano2Result;
    rows.push(['Longitudinal RANO 2.0', 'Response', 'Category', r.category, r.shortCode]);
    rows.push(['Longitudinal RANO 2.0', '2D SPD Change vs Nadir', 'Delta', r.spdChangeVsNadirPct === null ? 'Emergence from 0' : r.spdChangeVsNadirPct.toFixed(2), '%']);
    rows.push(['Longitudinal RANO 2.0', '3D Vol Change vs Nadir', 'Delta', r.volChangeVsNadirPct === null ? 'Emergence from 0' : r.volChangeVsNadirPct.toFixed(2), '%']);
    for (const tp of state.longitudinalTimepoints) {
      rows.push([
        'Longitudinal Series',
        `${tp.label} (${tp.date || 'No date'})`,
        tp.includeInRano === false ? 'Pre-Op Ref' : 'RANO Scan',
        `SPD ${Number(tp.spdMm2).toFixed(1)} mm² | Vol ${Number(tp.volumeCm3).toFixed(2)} cm³`,
        `${tp.steroids} | ${tp.clinicalStatus}`,
      ]);
    }
  }

  if (state.aiEvalResult) {
    const ai = state.aiEvalResult;
    rows.push(['AI Segmentation QA', 'Summary', 'Mean Active Dice', ai.summary.meanDiceActive.toFixed(4), 'ET/TC/WT']);
    rows.push(['AI Segmentation QA', 'Summary', 'Mean HD95', ai.summary.meanHd95Mm !== null ? ai.summary.meanHd95Mm.toFixed(3) : 'N/A', 'mm']);
    for (const reg of ['ET', 'TC', 'WT', 'RC']) {
      const m = ai.regions[reg];
      rows.push([
        'AI Segmentation QA',
        reg,
        'Dice / IoU / HD95 / ASSD / RVE',
        `${m.dice.toFixed(4)} / ${m.iou.toFixed(4)} / ${m.hd95Mm !== null ? m.hd95Mm.toFixed(2) : 'N/A'} / ${m.assdMm !== null ? m.assdMm.toFixed(2) : 'N/A'} / ${m.rvePct !== null ? m.rvePct.toFixed(1) + '%' : 'N/A'}`,
        `GT ${m.gtCm3.toFixed(2)} cm³ vs Pred ${m.predCm3.toFixed(2)} cm³`,
      ]);
    }
  }

  const csvText = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  const filename = `neuroscope-rano-summary-${isoToday()}.csv`;
  triggerDownload(filename, csvText, 'text/csv;charset=utf-8');
  showToast(`Downloaded CSV summary: ${filename}`, 'success', 3200);
}

function populateAndPrintReport() {
  const pr = $('print-report');
  if (!pr) {
    window.print();
    return;
  }

  // Ensure canvases are freshly drawn before capturing snapshots
  if (viewer) viewer.render();

  const capture = (id) => {
    const c = $(id);
    try {
      return c ? c.toDataURL('image/png') : '';
    } catch (_) {
      return '';
    }
  };

  const imgAx = capture('canvas-axial');
  const imgCor = capture('canvas-coronal');
  const imgSag = capture('canvas-sagittal');
  const img3d = capture('canvas-3d');

  const v = state.volumetrics;
  const e = state.eorResult;
  const r = state.rano2Result;
  const ai = state.aiEvalResult;

  const volRows = v
    ? [
        ['Enhancing Tumor (ET)', v.regions.ET],
        ['Tumor Core (TC)', v.regions.TC],
        ['Whole Tumor (WT)', v.regions.WT],
        ['Necrotic Core (NCR/NET)', v.labels[1]],
        ['Peritumoral Edema (ED)', v.labels[2]],
        ['Resection Cavity (RC)', v.labels[5]],
      ]
        .map(
          ([name, m]) => `
          <tr>
            <td>${escHtml(name)}</td>
            <td class="num">${m.volumeCm3.toFixed(2)} cm³</td>
            <td class="num">${m.eqSphereDiamMm.toFixed(1)} mm</td>
            <td class="num">${m.centroid ? `(${Math.round(m.centroid[0])}, ${Math.round(m.centroid[1])}, ${Math.round(m.centroid[2])})` : '–'}</td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="4">No segmentation mask loaded.</td></tr>';

  const aiRows = ai
    ? ['ET', 'TC', 'WT', 'RC']
        .map((reg) => {
          const m = ai.regions[reg];
          return `
            <tr>
              <td><strong>${escHtml(reg)}</strong></td>
              <td class="num">${m.bothEmpty ? 'Empty' : m.dice.toFixed(3)}</td>
              <td class="num">${m.bothEmpty ? '–' : m.iou.toFixed(3)}</td>
              <td class="num">${m.bothEmpty ? '–' : (m.hd95Mm !== null ? m.hd95Mm.toFixed(2) + ' mm' : 'N/A')}</td>
              <td class="num">${m.bothEmpty ? '–' : (m.assdMm !== null ? m.assdMm.toFixed(2) + ' mm' : 'N/A')}</td>
              <td class="num">${m.bothEmpty ? '–' : fmtSignedPct(m.rvePct, 1, 'N/A')}</td>
            </tr>`;
        })
        .join('')
    : '<tr><td colspan="6">No AI evaluation loaded.</td></tr>';

  const stView = viewer ? viewer.getState() : null;
  const cmapName = COLORMAPS[state.colormap]?.name || 'Grayscale';
  const wlMeta = stView ? `W ${Math.round(stView.windowWidth)} / L ${Math.round(stView.windowLevel)} · ${cmapName}` : cmapName;
  const renderPrintImg = (src, alt, cap) =>
    `<div class="pr-img-card">${
      src ? `<img src="${escHtml(src)}" alt="${escHtml(alt)}" />` : '<div style="padding:24px 6px;color:#94a3b8;text-align:center;font-size:9px;">No viewport image</div>'
    }<div class="pr-img-cap">${escHtml(cap)}</div></div>`;
  const activeR2Print = getActiveRano2D(v);

  pr.innerHTML = `
    <div class="pr-header">
      <div>
        <h1>NeuroScope-RANO — Quantitative Neuro-Oncology Summary</h1>
        <div style="font-size:10.5px;color:#334155;margin-top:2px;">
          ${escHtml(state.activeCase?.title || 'Local Browser Study')} · MRI: <code>${escHtml(basename(state.baseName))}</code> · Mask: <code>${escHtml(basename(state.maskName))}</code>
        </div>
        <div style="font-size:9.8px;color:#475569;margin-top:2px;">
          Display: ${escHtml(wlMeta)}${stView ? ` · Crosshair Voxel (${stView.ix}, ${stView.iy}, ${stView.iz})` : ''}
        </div>
      </div>
      <div class="pr-meta">
        <div>Generated: ${escHtml(new Date().toLocaleString())}</div>
        <div>100% Browser-Local · Zero Server Uploads</div>
      </div>
    </div>

    <div class="pr-disclaimer">
      <strong>Research &amp; Educational Tool — Not FDA/CE Approved for Clinical Diagnosis.</strong>
      Quantitative metrics are provided for research, surgical auditing, and educational demonstration only.
    </div>

    <div class="pr-images">
      ${renderPrintImg(imgAx, 'Axial view', 'Axial (XY)')}
      ${renderPrintImg(imgCor, 'Coronal view', 'Coronal (XZ)')}
      ${renderPrintImg(imgSag, 'Sagittal view', 'Sagittal (YZ)')}
      ${renderPrintImg(img3d, '3D projection', stView?.mode3d === 'mip' ? '3D MIP' : '3D Surface')}
    </div>

    <div class="pr-grid">
      <div class="pr-section">
        <h2>1. Volumetrics &amp; Automated Axial RANO 2D</h2>
        <div style="margin-bottom:6px;">
          Axial ${escHtml(activeR2Print?.region || 'ET')} Bidimensional:
          <span class="pr-badge">${activeR2Print ? `${activeR2Print.d1Mm.toFixed(1)} × ${activeR2Print.d2Mm.toFixed(1)} mm = ${activeR2Print.spdMm2.toFixed(1)} mm²` : 'N/A'}</span>
          ${activeR2Print?.bestSliceZ !== null && activeR2Print?.bestSliceZ !== undefined ? `(Slice Z=${activeR2Print.bestSliceZ + 1})` : ''}
        </div>
        <table class="pr-table">
          <thead><tr><th>Compartment</th><th class="num">Volume</th><th class="num">Eq. Ø</th><th class="num">Centroid</th></tr></thead>
          <tbody>${volRows}</tbody>
        </table>
      </div>

      <div class="pr-section">
        <h2>2. Extent of Resection &amp; RANO-Resect (Karschnia 2023)</h2>
        ${
          e
            ? `
          <div style="margin-bottom:6px;">
            Class: <span class="pr-badge">${escHtml(e.ranoClass)} — ${escHtml(e.ranoClassName)}</span>
          </div>
          <table class="pr-table">
            <tbody>
              <tr><td>CE EOR / Residual CE</td><td class="num">${e.hasPreOpCe !== false ? `${e.ceEorPct.toFixed(1)}%` : 'N/A'} / ${e.residualCeCm3.toFixed(2)} cm³</td></tr>
              <tr><td>Non-CE EOR / Residual Non-CE</td><td class="num">${e.nonCeEorPct.toFixed(1)}% / ${e.residualNonCeCm3.toFixed(2)} cm³</td></tr>
              <tr><td>Pre-Op CE / Post-Op Cavity (RC)</td><td class="num">${e.preCeCm3.toFixed(2)} cm³ / ${e.cavityCm3.toFixed(2)} cm³</td></tr>
            </tbody>
          </table>
          <ul class="pr-list">${e.rationale.map((x) => `<li>${escHtml(x)}</li>`).join('')}</ul>`
            : '<p>Pre-Op / Post-Op pair not loaded.</p>'
        }
      </div>
    </div>

    <div class="pr-grid">
      <div class="pr-section">
        <h2>3. Longitudinal RANO 2.0 Response (Wen 2023)</h2>
        ${
          r
            ? `
          <div style="margin-bottom:6px;">
            Response Category: <span class="pr-badge">${escHtml(r.category)}</span>
          </div>
          <table class="pr-table">
            <thead><tr><th>Scan</th><th>Date</th><th class="num">SPD (mm²)</th><th class="num">Vol (cm³)</th></tr></thead>
            <tbody>
              ${state.longitudinalTimepoints
                .map(
                  (tp) => `
                <tr>
                  <td>${escHtml(tp.label)}${tp.includeInRano === false ? ' (Pre-Op Ref)' : ''}</td>
                  <td>${escHtml(tp.date || '–')}</td>
                  <td class="num">${Number(tp.spdMm2).toFixed(1)}</td>
                  <td class="num">${Number(tp.volumeCm3).toFixed(2)}</td>
                </tr>`
                )
                .join('')}
            </tbody>
          </table>
          <ul class="pr-list">${r.rationale.map((x) => `<li>${escHtml(x)}</li>`).join('')}</ul>`
            : '<p>No longitudinal series available.</p>'
        }
      </div>

      <div class="pr-section">
        <h2>4. AI Segmentation QA (${escHtml(basename(state.aiGtName))} vs. ${escHtml(basename(state.aiPredName))})</h2>
        ${
          ai
            ? `<div style="margin-bottom:6px;">Mean Active Dice: <span class="pr-badge">${ai.summary.meanDiceActive.toFixed(3)}</span> · Mean HD95: <span class="pr-badge">${ai.summary.meanHd95Mm !== null ? ai.summary.meanHd95Mm.toFixed(2) + ' mm' : 'N/A'}</span></div>`
            : ''
        }
        <table class="pr-table">
          <thead><tr><th>Region</th><th class="num">Dice</th><th class="num">IoU</th><th class="num">HD95</th><th class="num">ASSD</th><th class="num">RVE</th></tr></thead>
          <tbody>${aiRows}</tbody>
        </table>
      </div>
    </div>
  `;

  window.print();
}

// ============================================================================
// UI Event Binding
// ============================================================================

function bindAllEvents() {
  // Preset buttons & compact dropdown
  document.querySelectorAll('button.preset-btn[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => applySamplePreset(btn.dataset.preset));
  });
  $('preset-select')?.addEventListener('change', (e) => {
    applySamplePreset(e.target.value);
  });

  // Active scan timepoint quick pills
  document.querySelectorAll('button.tp-pill[data-tp-id]').forEach((btn) => {
    btn.addEventListener('click', () => switchSampleTimepoint(btn.dataset.tpId));
  });

  // Alert banner dismiss
  $('btn-dismiss-alert')?.addEventListener('click', hideAlertBanner);

  // Exports
  $('btn-export-json')?.addEventListener('click', exportJsonReport);
  $('btn-export-csv')?.addEventListener('click', exportCsvSummary);
  $('btn-export-print')?.addEventListener('click', populateAndPrintReport);

  // Accessible Modal Dialog Controller (NiiVue info + Keyboard Shortcuts & RANO Quick-Reference)
  const openModalById = (modalId) => {
    const el = $(modalId);
    if (!el) return;
    // Close any other open modal first
    ['niivue-modal', 'shortcuts-modal'].forEach((id) => {
      if (id !== modalId) $(id)?.classList.add('hidden');
    });
    if (!state.activeModalId) {
      state.modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    state.activeModalId = modalId;
    el.classList.remove('hidden');
    const closeBtn = el.querySelector('button[id^="btn-close-"]') || el.querySelector('button, [href]');
    closeBtn?.focus();
  };

  const closeActiveModals = () => {
    let closedAny = false;
    ['niivue-modal', 'shortcuts-modal'].forEach((id) => {
      const el = $(id);
      if (el && !el.classList.contains('hidden')) {
        el.classList.add('hidden');
        closedAny = true;
      }
    });
    state.activeModalId = null;
    if (closedAny && state.modalReturnFocus && typeof state.modalReturnFocus.focus === 'function') {
      state.modalReturnFocus.focus();
      state.modalReturnFocus = null;
    }
    return closedAny;
  };

  $('btn-niivue-info')?.addEventListener('click', () => openModalById('niivue-modal'));
  $('btn-close-niivue-modal')?.addEventListener('click', closeActiveModals);
  $('niivue-modal')?.addEventListener('click', (e) => {
    if (e.target === $('niivue-modal')) closeActiveModals();
  });

  $('btn-shortcuts-help')?.addEventListener('click', () => {
    if (state.activeModalId === 'shortcuts-modal') {
      closeActiveModals();
    } else {
      openModalById('shortcuts-modal');
    }
  });
  $('btn-close-shortcuts-modal')?.addEventListener('click', closeActiveModals);
  $('shortcuts-modal')?.addEventListener('click', (e) => {
    if (e.target === $('shortcuts-modal')) closeActiveModals();
  });

  // Local file input pickers
  const bindInput = (id, slot) => {
    const inp = $(id);
    if (!inp) return;
    inp.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) handleLocalFileLoad(file, slot);
      inp.value = '';
    });
  };
  bindInput('input-file-mri', 'mri');
  bindInput('input-file-mask', 'mask');
  bindInput('input-file-secondary', 'secondary');
  bindInput('input-eor-pre', 'eor-pre');
  bindInput('input-eor-post', 'eor-post');
  bindInput('input-ai-gt', 'ai-gt');
  bindInput('input-ai-pred', 'ai-pred');

  // Shared stage drag-and-drop state so dropping on child .file-slot resets stage dragDepth
  const stage = $('viewer-stage');
  const dropOverlay = $('stage-drop-overlay');
  let dragDepth = 0;
  const resetStageDragOverlay = () => {
    dragDepth = 0;
    dropOverlay?.classList.add('hidden');
    document.querySelectorAll('.file-slot.drag-over').forEach((el) => el.classList.remove('drag-over'));
  };

  // Drag-and-drop on individual file slots
  document.querySelectorAll('.file-slot[data-slot]').forEach((slotEl) => {
    slotEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      slotEl.classList.add('drag-over');
    });
    slotEl.addEventListener('dragleave', () => slotEl.classList.remove('drag-over'));
    slotEl.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      resetStageDragOverlay();
      const file = e.dataTransfer?.files?.[0];
      if (file) handleLocalFileLoad(file, slotEl.dataset.slot);
    });
  });

  // Full-stage drag-and-drop with smart filename routing
  if (stage && dropOverlay) {
    stage.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      dragDepth++;
      dropOverlay.classList.remove('hidden');
    });
    stage.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
    });
    stage.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) dropOverlay.classList.add('hidden');
    });
    stage.addEventListener('drop', async (e) => {
      e.preventDefault();
      resetStageDragOverlay();
      const files = Array.from(e.dataTransfer?.files || []);
      for (const file of files) {
        const inferred = inferDropSlot(file.name);
        await handleLocalFileLoad(file, inferred);
      }
    });
    window.addEventListener('dragend', resetStageDragOverlay);
  }

  // Viewer W/L sliders
  const onWLSliderInput = () => {
    if (state.wlSyncingFromViewer || !viewer) return;
    const ww = Number($('slider-ww')?.value || 500);
    const wl = Number($('slider-wl')?.value || 250);
    updateWLReadouts(ww, wl);
    viewer.setWindowLevel(ww, wl);
  };
  $('slider-ww')?.addEventListener('input', onWLSliderInput);
  $('slider-wl')?.addEventListener('input', onWLSliderInput);
  $('btn-auto-wl')?.addEventListener('click', () => viewer?.resetWindowLevel());

  // MRI Base Colormap switcher
  document.querySelectorAll('button.seg-btn[data-colormap]').forEach((btn) => {
    btn.addEventListener('click', () => setColormapUI(btn.dataset.colormap));
  });

  // Opacity slider
  $('slider-opacity')?.addEventListener('input', (e) => {
    const pct = Number(e.target.value);
    const lbl = $('val-opacity');
    if (lbl) lbl.textContent = `${pct}%`;
    viewer?.setMaskOpacity(pct / 100);
  });

  // Label visibility chips
  document.querySelectorAll('button.label-chip[data-label]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const next = !chip.classList.contains('active');
      chip.classList.toggle('active', next);
      chip.setAttribute('aria-pressed', String(next));
      viewer?.setLabelVisibility(Number(chip.dataset.label), next);
    });
  });

  // Overlay mode segmented control
  document.querySelectorAll('button.seg-btn[data-overlay-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.overlayMode;
      if (mode === 'error') {
        if (!state.aiEvalResult) {
          showToast('Load Ground Truth & AI Prediction masks in Tab 4 (AI Eval) first.', 'warning');
          return;
        }
        toggleAiErrorOverlay();
      } else {
        setOverlayModeUI(mode);
      }
    });
  });

  // Crosshair, Caliper, Jump ET, Reset View toggles
  $('btn-toggle-crosshairs')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const next = !btn.classList.contains('active');
    btn.classList.toggle('active', next);
    btn.setAttribute('aria-pressed', String(next));
    viewer?.setShowCrosshairs(next);
  });

  $('btn-toggle-calipers')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const next = !btn.classList.contains('active');
    btn.classList.toggle('active', next);
    btn.setAttribute('aria-pressed', String(next));
    viewer?.setShowCalipers(next);
  });

  $('btn-jump-et')?.addEventListener('click', () => {
    if (!state.volumetrics) {
      showToast('Load a segmentation mask to jump to tumor centroid.', 'info');
      return;
    }
    if (!maskMatchesBaseDims()) {
      showToast('Cannot jump to centroid — mask dimensions do not match active base MRI.', 'warning');
      return;
    }
    const c =
      state.volumetrics.regions.ET.centroid ||
      state.volumetrics.regions.WT.centroid ||
      state.volumetrics.regions.RC.centroid;
    if (c) {
      viewer?.jumpToCentroid(c);
    } else {
      showToast('No labeled tumor or cavity voxels found in current mask.', 'warning');
    }
  });

  $('btn-reset-view')?.addEventListener('click', () => {
    viewer?.resetView();
    if (state.baseVol) configureWLSlidersForVolume(state.baseVol);
  });

  // Viewport slice sliders
  $('slider-slice-z')?.addEventListener('input', (e) => viewer?.setSlice('axial', Number(e.target.value)));
  $('slider-slice-y')?.addEventListener('input', (e) => viewer?.setSlice('coronal', Number(e.target.value)));
  $('slider-slice-x')?.addEventListener('input', (e) => viewer?.setSlice('sagittal', Number(e.target.value)));

  // 3D Mode buttons
  $('btn-3d-surface')?.addEventListener('click', () => {
    $('btn-3d-surface')?.classList.add('active');
    $('btn-3d-surface')?.setAttribute('aria-pressed', 'true');
    $('btn-3d-mip')?.classList.remove('active');
    $('btn-3d-mip')?.setAttribute('aria-pressed', 'false');
    viewer?.set3DMode('tumor_surface');
  });
  $('btn-3d-mip')?.addEventListener('click', () => {
    $('btn-3d-mip')?.classList.add('active');
    $('btn-3d-mip')?.setAttribute('aria-pressed', 'true');
    $('btn-3d-surface')?.classList.remove('active');
    $('btn-3d-surface')?.setAttribute('aria-pressed', 'false');
    viewer?.set3DMode('mip');
  });
  $('btn-3d-reset')?.addEventListener('click', () => {
    viewer?.set3DRotation(-0.55, 0.25);
  });

  // Workbench tabs (click + WAI-ARIA ArrowLeft/ArrowRight/Home/End navigation)
  const tabBtns = Array.from(document.querySelectorAll('button.tab-btn[data-tab]'));
  tabBtns.forEach((btn, idx) => {
    btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
    btn.addEventListener('keydown', (e) => {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      let nextIdx = idx;
      if (e.key === 'ArrowRight') nextIdx = (idx + 1) % tabBtns.length;
      else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + tabBtns.length) % tabBtns.length;
      else if (e.key === 'Home') nextIdx = 0;
      else if (e.key === 'End') nextIdx = tabBtns.length - 1;
      setActiveTab(tabBtns[nextIdx].dataset.tab, true);
    });
  });

  // Tab 1: Jump to Best Axial Slice + centroid click delegation
  $('btn-jump-best-slice')?.addEventListener('click', () => {
    if (!state.volumetrics || !viewer) return;
    if (!maskMatchesBaseDims()) {
      showToast('Cannot jump to RANO slice — mask dimensions do not match active base MRI.', 'warning');
      return;
    }
    const r2 = getActiveRano2D();
    if (!r2 || r2.bestSliceZ === null || r2.bestSliceZ === undefined) return;

    // Ensure calipers are turned ON so user immediately sees d1 & d2
    const calBtn = $('btn-toggle-calipers');
    if (calBtn && !calBtn.classList.contains('active')) {
      calBtn.classList.add('active');
      calBtn.setAttribute('aria-pressed', 'true');
    }
    viewer.setShowCalipers(true);

    const cx = r2.majorLine
      ? Math.round(0.5 * (r2.majorLine.x1 + r2.majorLine.x2))
      : viewer.getState().ix;
    const cy = r2.majorLine
      ? Math.round(0.5 * (r2.majorLine.y1 + r2.majorLine.y2))
      : viewer.getState().iy;
    viewer.setCrosshair(cx, cy, Math.round(r2.bestSliceZ), true);
  });

  $('vol-table-body')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button.centroid-btn');
    if (!btn || !viewer) return;
    if (!maskMatchesBaseDims()) {
      showToast('Cannot jump to centroid — mask dimensions do not match active base MRI.', 'warning');
      return;
    }
    viewer.jumpToCentroid([
      Number(btn.dataset.cx),
      Number(btn.dataset.cy),
      Number(btn.dataset.cz),
    ]);
  });

  // Tab 2: EOR sample pair button & interactive Karschnia legend
  $('btn-eor-load-sample')?.addEventListener('click', () => applySamplePreset('eor_pair'));
  $('eor-legend-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button.resect-item');
    if (!btn) return;
    const tier = btn.dataset.resectTier;
    state.expandedResectTier = state.expandedResectTier === tier ? null : tier;
    renderResectLegend(state.eorResult?.ranoClass || null);
  });

  // Tab 3: Longitudinal RANO 2.0 co-factors & editable table
  const updateLatestCofactor = (key, value) => {
    const latest = getLatestEvaluatedTimepoint();
    if (!latest) return;
    latest[key] = value;
    recomputeRano2();
  };

  $('rano2-steroids')?.addEventListener('change', (e) => updateLatestCofactor('steroids', e.target.value));
  $('rano2-clinical')?.addEventListener('change', (e) => updateLatestCofactor('clinicalStatus', e.target.value));
  $('rano2-new-lesion')?.addEventListener('change', (e) => updateLatestCofactor('newMeasurableLesion', e.target.checked));
  $('rano2-within-12w')?.addEventListener('change', (e) => updateLatestCofactor('within12WeeksPostRT', e.target.checked));

  $('rano2-table-body')?.addEventListener('change', (e) => {
    const target = e.target;
    const idx = Number(target.dataset.tpIdx);
    const field = target.dataset.tpField;
    if (!Number.isInteger(idx) || !field || !state.longitudinalTimepoints[idx]) return;

    const tp = state.longitudinalTimepoints[idx];
    if (field === 'includeInRano') {
      tp.includeInRano = Boolean(target.checked);
    } else if (field === 'spdMm2' || field === 'volumeCm3') {
      tp[field] = Math.max(0, Number(target.value) || 0);
    } else {
      tp[field] = target.value;
    }
    recomputeRano2();
  });

  $('rano2-table-body')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tp-action]');
    if (!btn) return;
    const idx = Number(btn.dataset.tpIdx);
    const tp = state.longitudinalTimepoints[idx];
    if (!tp) return;

    if (btn.dataset.tpAction === 'view' && tp.sampleTpId) {
      switchSampleTimepoint(tp.sampleTpId);
    } else if (btn.dataset.tpAction === 'delete') {
      state.longitudinalTimepoints.splice(idx, 1);
      recomputeRano2();
    }
  });

  $('btn-rano2-add')?.addEventListener('click', () => {
    const latest = getLatestEvaluatedTimepoint();
    const num = state.customScanCounter++;
    state.longitudinalTimepoints.push({
      id: `custom_${Date.now()}_${num}`,
      sampleTpId: null,
      label: `Follow-Up #${num + 1}`,
      date: isoToday(),
      role: 'followup',
      includeInRano: true,
      spdMm2: latest ? Math.max(0, Number((latest.spdMm2 * 0.45).toFixed(1))) : 100.0,
      volumeCm3: latest ? Math.max(0, Number((latest.volumeCm3 * 0.30).toFixed(2))) : 0.5,
      steroids: 'stable_or_decreased',
      clinicalStatus: 'stable_or_improved',
      newMeasurableLesion: false,
      within12WeeksPostRT: false,
      custom: true,
    });
    recomputeRano2();
    showToast('Added custom follow-up scan — edit SPD/Volume or co-factors to simulate RANO 2.0 criteria.', 'info', 3500);
  });

  $('btn-rano2-snapshot')?.addEventListener('click', () => {
    if (!state.volumetrics) {
      showToast('Load a segmentation mask first to snapshot its metrics.', 'warning');
      return;
    }
    const num = state.customScanCounter++;
    state.longitudinalTimepoints.push({
      id: `snap_${Date.now()}_${num}`,
      sampleTpId: null,
      label: basename(state.maskName).replace(/\.nii(\.gz)?$/i, '').slice(0, 18) || `Mask #${num}`,
      date: isoToday(),
      role: 'followup',
      includeInRano: true,
      spdMm2: Number(state.volumetrics.rano2d.spdMm2.toFixed(1)),
      volumeCm3: Number(state.volumetrics.regions.ET.volumeCm3.toFixed(2)),
      steroids: 'stable_or_decreased',
      clinicalStatus: 'stable_or_improved',
      newMeasurableLesion: false,
      within12WeeksPostRT: false,
      custom: true,
    });
    recomputeRano2();
    showToast('Snapshotted active mask SPD & ET volume into RANO 2.0 series.', 'success', 3200);
  });

  $('btn-rano2-reset')?.addEventListener('click', () => {
    if (state.sampleTimepointSnapshots.length > 0) {
      state.longitudinalTimepoints = buildDefaultLongitudinalSeries();
      recomputeRano2();
      showToast('Restored Case 01 longitudinal scan series.', 'info', 2500);
    }
  });

  // Tab 4: AI Evaluator controls
  $('btn-ai-load-sample')?.addEventListener('click', async () => {
    await applySamplePreset('preop_ai');
    setActiveTab('ai');
  });

  document.querySelectorAll('#ai-region-selector button.region-pill').forEach((btn) => {
    btn.addEventListener('click', () => selectAiRegion(btn.dataset.region));
  });

  $('btn-ai-toggle-error-overlay')?.addEventListener('click', toggleAiErrorOverlay);

  $('ai-table-body')?.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-ai-region]');
    if (!row) return;
    selectAiRegion(row.dataset.aiRegion);
  });

  $('ai-table-body')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('tr[data-ai-region]');
    if (!row) return;
    e.preventDefault();
    selectAiRegion(row.dataset.aiRegion);
  });

  // Keyboard shortcuts & modal focus trap (ignored while typing in form controls or with modifier keys)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!closeActiveModals()) {
        hideAlertBanner();
      }
      return;
    }

    // Trap Tab focus inside active modal dialog
    if (e.key === 'Tab' && state.activeModalId) {
      const modalEl = $(state.activeModalId);
      if (modalEl && !modalEl.classList.contains('hidden')) {
        const focusable = Array.from(
          modalEl.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')
        );
        if (focusable.length > 0) {
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
      return;
    }

    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || e.target?.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === '?') {
      e.preventDefault();
      if (state.activeModalId === 'shortcuts-modal') {
        closeActiveModals();
      } else {
        openModalById('shortcuts-modal');
      }
      return;
    }

    if (state.activeModalId) return;

    const k = e.key.toLowerCase();
    if (e.key === 'ArrowUp' && viewer && state.baseVol) {
      e.preventDefault();
      const st = viewer.getState();
      viewer.setCrosshair(st.ix, st.iy, st.iz + 1, true);
    } else if (e.key === 'ArrowDown' && viewer && state.baseVol) {
      e.preventDefault();
      const st = viewer.getState();
      viewer.setCrosshair(st.ix, st.iy, st.iz - 1, true);
    } else if (e.key === '1') {
      setColormapUI('grayscale');
    } else if (e.key === '2') {
      setColormapUI('hot_metal');
    } else if (e.key === '3') {
      setColormapUI('cool_bone');
    } else if (k === 'c') {
      $('btn-toggle-crosshairs')?.click();
    } else if (k === 'm') {
      $('btn-toggle-calipers')?.click();
    } else if (k === 'b') {
      $('btn-jump-best-slice')?.click();
    } else if (k === 'a') {
      $('btn-auto-wl')?.click();
    } else if (k === 'r') {
      $('btn-reset-view')?.click();
    } else if (k === 'e' && state.aiEvalResult) {
      toggleAiErrorOverlay();
    }
  });
}

// ============================================================================
// Bootstrap Startup Sequence
// ============================================================================

async function bootstrap() {
  initViewer();
  bindAllEvents();
  renderResectLegend(null);

  setViewerLoading(true, 'Loading Case 01 — Pre-Op GBM T1ce, Ground Truth & AI Prediction…');

  try {
    await loadManifest();
    const preTp = getSampleTimepointMeta('preop');
    if (!preTp) throw new Error('Case 01 preop timepoint missing from manifest.');

    // Fetch Pre-Op triplet in parallel so app opens immediately alive & interactive
    const [t1Vol, gtVol, predVol] = await Promise.all([
      fetchCachedNifti(preTp.t1ce),
      fetchCachedNifti(preTp.mask),
      fetchCachedNifti(preTp.predMask),
    ]);

    state.secondaryName = preTp.predMask;
    state.aiGtVol = gtVol;
    state.aiGtName = preTp.mask;
    state.aiPredVol = predVol;
    state.aiPredName = preTp.predMask;
    state.aiSourceTag = 'case01_preop';

    setActivePresetUI('preop_ai');
    setActiveTimepointPillUI('preop');

    mountViewerVolumes({
      baseVol: t1Vol,
      baseName: preTp.t1ce,
      maskVol: gtVol,
      maskName: preTp.mask,
      snapToTumor: true,
    });

    recomputeAiEvaluation();
    setViewerLoading(false);

    // Ensure HiDPI canvas sizing matches final painted grid dimensions
    requestAnimationFrame(() => viewer?.resize());

    // Hydrate EOR (Tab 2) & Longitudinal RANO 2.0 (Tab 3) in background (~2.6 KB masks)
    hydrateBackgroundSampleClinicalModules();
  } catch (err) {
    setViewerLoading(false);
    const msg = err instanceof Error ? err.message : String(err);
    showAlertBanner(
      `Sample autoload failed (${msg}). If opened via file://, serve statically (e.g. "python -m http.server") or drag-and-drop local .nii/.nii.gz files above.`,
      true
    );
    showToast(`Startup note: ${msg}`, 'warning', 7000);
  }
}

document.addEventListener('DOMContentLoaded', bootstrap);
