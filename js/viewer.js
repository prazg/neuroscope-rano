/**
 * NeuroScope-RANO — Zero-Dependency Multi-Planar & 3D Volumetric Canvas Viewer
 *
 * Implements radiological orthogonal multi-planar rendering (Axial, Coronal, Sagittal)
 * with physical pixdim aspect-ratio correction, synchronized 3D crosshairs, interactive
 * Window/Level, BraTS + Post-Op multi-label overlays, TP/FP/FN AI error overlays,
 * RANO 2D perpendicular caliper vectors, and a 60fps pure-JS rotatable 3D viewport
 * supporting both depth-shaded volumetric tumor/error surface + glass brain silhouette
 * and multi-angle grayscale MRI + tumor Maximum Intensity Projection (MIP).
 *
 * Coordinate convention (RAS+):
 *   linear index = x + y * nx + z * nx * ny
 *   x: Left (0) -> Right (nx - 1)
 *   y: Posterior (0) -> Anterior (ny - 1)
 *   z: Inferior (0) -> Superior (nz - 1)
 *
 * Radiological display mapping:
 *   Axial    (XY at iz): Left=R (high x), Right=L (low x), Top=A (high y), Bottom=P (low y)
 *   Coronal  (XZ at iy): Left=R (high x), Right=L (low x), Top=S (high z), Bottom=I (low z)
 *   Sagittal (YZ at ix): Left=A (high y), Right=P (low y), Top=S (high z), Bottom=I (low z)
 */

export const LABEL_COLORS = Object.freeze({
  1: Object.freeze({
    id: 1,
    code: 'NCR',
    name: 'Necrotic / Non-Enhancing Core',
    hex: '#f43f5e',
    color: '#f43f5e',
    rgb: Object.freeze([244, 63, 94]),
  }),
  2: Object.freeze({
    id: 2,
    code: 'ED',
    name: 'Peritumoral Edema',
    hex: '#f59e0b',
    color: '#f59e0b',
    rgb: Object.freeze([245, 158, 11]),
  }),
  3: Object.freeze({
    id: 3,
    code: 'ET',
    name: 'Enhancing Tumor',
    hex: '#38bdf8',
    color: '#38bdf8',
    rgb: Object.freeze([56, 189, 248]),
  }),
  5: Object.freeze({
    id: 5,
    code: 'RC',
    name: 'Surgical Resection Cavity',
    hex: '#a855f7',
    color: '#a855f7',
    rgb: Object.freeze([168, 85, 247]),
  }),
});

export const ERROR_COLORS = Object.freeze({
  1: Object.freeze({
    id: 1,
    code: 'TP',
    name: 'True Positive',
    hex: '#22c55e',
    color: '#22c55e',
    rgb: Object.freeze([34, 197, 94]),
  }),
  2: Object.freeze({
    id: 2,
    code: 'FP',
    name: 'False Positive',
    hex: '#f43f5e',
    color: '#f43f5e',
    rgb: Object.freeze([244, 63, 94]),
  }),
  3: Object.freeze({
    id: 3,
    code: 'FN',
    name: 'False Negative',
    hex: '#38bdf8',
    color: '#38bdf8',
    rgb: Object.freeze([56, 189, 248]),
  }),
});

/**
 * Canonical BraTS + Post-Op label normalizer (maps legacy BraTS label 4 -> 3).
 * @param {number} v
 * @returns {0 | 1 | 2 | 3 | 5}
 */
export function normalizeLabel(v) {
  const r = Math.round(v);
  if (r === 4) return 3;
  if (r === 1 || r === 2 || r === 3 || r === 5) return r;
  return 0;
}

// Fast lookup tables indexed by canonical label (0..5) and error code (0..3)
const LABEL_RGB_LUT = [
  null,
  LABEL_COLORS[1].rgb,
  LABEL_COLORS[2].rgb,
  LABEL_COLORS[3].rgb,
  LABEL_COLORS[3].rgb,
  LABEL_COLORS[5].rgb,
];

const ERROR_RGB_LUT = [
  null,
  ERROR_COLORS[1].rgb,
  ERROR_COLORS[2].rgb,
  ERROR_COLORS[3].rgb,
];

const BG_COLOR = '#0b0f17';
const DEFAULT_YAW = -0.55;
const DEFAULT_PITCH = 0.25;
const FONT_SANS = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const FONT_MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Consolas, monospace";

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function drawRoundedRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export class NeuroViewer {
  /**
   * @param {{ axial?: HTMLCanvasElement, coronal?: HTMLCanvasElement, sagittal?: HTMLCanvasElement, mip3d?: HTMLCanvasElement }} canvases
   * @param {Object} [options]
   */
  constructor(canvases = {}, options = {}) {
    this._canvases = {
      axial: canvases.axial || null,
      coronal: canvases.coronal || null,
      sagittal: canvases.sagittal || null,
      mip3d: canvases.mip3d || canvases.view3d || canvases.canvas3d || canvases.render3d || canvases.vol3d || null,
    };

    this._ctxs = {
      axial: this._canvases.axial ? this._canvases.axial.getContext('2d') : null,
      coronal: this._canvases.coronal ? this._canvases.coronal.getContext('2d') : null,
      sagittal: this._canvases.sagittal ? this._canvases.sagittal.getContext('2d') : null,
      mip3d: this._canvases.mip3d ? this._canvases.mip3d.getContext('2d') : null,
    };

    // Callbacks
    this._onCrosshairChange = typeof options.onCrosshairChange === 'function' ? options.onCrosshairChange : null;
    this._onWindowLevelChange = typeof options.onWindowLevelChange === 'function' ? options.onWindowLevelChange : null;
    this._sliceListeners = [];
    if (typeof options.onSliceChange === 'function') {
      this._sliceListeners.push(options.onSliceChange);
    }

    // Visual & display options
    this._showCrosshairs = options.showCrosshairs !== undefined ? Boolean(options.showCrosshairs) : true;
    this._showCalipers = options.showCalipers !== undefined ? Boolean(options.showCalipers) : true;
    this._showOrientationLabels = options.showOrientationLabels !== undefined ? Boolean(options.showOrientationLabels) : true;
    const initOpacity = options.maskOpacity !== undefined ? options.maskOpacity : (options.opacity !== undefined ? options.opacity : 0.55);
    this._maskOpacity = clamp(Number.isFinite(initOpacity) ? initOpacity : 0.55, 0, 1);

    this._labelVisibility = { 1: true, 2: true, 3: true, 5: true };
    this._errorOverlayMode = false;
    this._overlayMode = 'mask'; // 'mask' | 'error' | 'none'
    this._errorRegion = 'ET';

    // Volume state
    this._volume = null;
    this._maskVol = null;
    this._normMask = null;
    this._maskDims = null;
    this._errorVolume = null;
    this._errorDims = null;
    this._ranoCalipers = null;
    this._caliperDims = null;

    // Crosshair voxel coordinates
    this._ix = 0;
    this._iy = 0;
    this._iz = 0;

    // Window / Level state
    this._windowWidth = 1000;
    this._windowLevel = 500;
    this._autoWindowWidth = 1000;
    this._autoWindowLevel = 500;
    this._p1 = 0;
    this._p995 = 1000;

    // 3D viewport state
    this._mode3d = options.mode3d === 'mip' ? 'mip' : 'tumor_surface';
    this._yaw = DEFAULT_YAW;
    this._pitch = DEFAULT_PITCH;
    this._isDragging3D = false;
    this._isDraggingWL = false;
    this._activeWLPlane = null;

    // Cached 3D sparse geometry
    this._brainSurface = null;
    this._brainMip = null;
    this._maskSurface = null;
    this._errorSurface = null;
    this._brainRadiusMm = 80;
    this._sceneRadiusMm = 80;

    // Per-plane layout rects & reusable offscreen buffers
    this._viewRects = {
      axial: null,
      coronal: null,
      sagittal: null,
    };
    this._offscreen = {
      axial: { canvas: null, ctx: null, imgData: null, w: 0, h: 0, labelScratch: null },
      coronal: { canvas: null, ctx: null, imgData: null, w: 0, h: 0, labelScratch: null },
      sagittal: { canvas: null, ctx: null, imgData: null, w: 0, h: 0, labelScratch: null },
    };

    // Reusable 3D rasterizer buffers (avoid GC churn during 60fps orbiting)
    this._off3d = {
      canvas: null,
      ctx: null,
      imgData: null,
      w: 0,
      h: 0,
      zBuf: null,
      colR: null,
      colG: null,
      colB: null,
      hasSolid: null,
      edZBuf: null,
      edShade: null,
      silFront: null,
      silBack: null,
      grayMip: null,
    };

    // Canvas CSS sizes & DPR tracking
    this._canvasMetrics = {
      axial: { cssW: 0, cssH: 0, dpr: 1 },
      coronal: { cssW: 0, cssH: 0, dpr: 1 },
      sagittal: { cssW: 0, cssH: 0, dpr: 1 },
      mip3d: { cssW: 0, cssH: 0, dpr: 1 },
    };

    // Scheduling & lifecycle
    this._destroyed = false;
    this._rafId = 0;
    this._dirty2D = false;
    this._dirty3D = false;
    this._cleanupFns = [];
    this._resizeObserver = null;

    this._initCanvasesAndEvents();
    this.resize();
  }

  // =========================================================================
  // Public API (ARCHITECTURE.md Section 4.3 + Compatibility Aliases)
  // =========================================================================

  /**
   * Load grayscale base MRI volume, center crosshair, auto-compute W/L, and render all 4 canvases.
   * @param {Object | null} niftiVol
   */
  setVolume(niftiVol) {
    if (this._destroyed) return;
    this._volume = niftiVol || null;

    if (!this._volume || !this._volume.dims || !this._volume.data) {
      this._volume = null;
      this._brainSurface = null;
      this._brainMip = null;
      this._updateSceneRadius();
      this._renderAllImmediate();
      return;
    }

    const [nx, ny, nz] = this._volume.dims;
    this._ix = Math.floor(nx / 2);
    this._iy = Math.floor(ny / 2);
    this._iz = Math.floor(nz / 2);

    this._computeAutoWindowLevel();
    this._windowWidth = this._autoWindowWidth;
    this._windowLevel = this._autoWindowLevel;

    this._buildBrainCaches();
    // Rebuild mask/error 3D caches when dims match, and clear stale mismatched surfaces
    if (this._normMask && this._maskMatchesVolume()) {
      this._maskSurface = this._buildSparseSurface(this._normMask, this._volume.dims, this._getPixdim());
    } else {
      this._maskSurface = null;
    }
    if (this._errorVolume && this._errorMatchesVolume()) {
      this._errorDims = [nx, ny, nz];
      this._errorSurface = this._buildSparseSurface(this._errorVolume, this._volume.dims, this._getPixdim());
    } else {
      this._errorSurface = null;
    }
    this._updateSceneRadius();

    this._renderAllImmediate();
    this._emitWindowLevel();
    this._emitCrosshair();
  }

  /** Alias for setVolume */
  setBaseVolume(vol) {
    this.setVolume(vol);
  }

  /**
   * Set multi-label segmentation mask volume (legacy BraTS label 4 auto-mapped to 3).
   * @param {Object | null} maskVol
   */
  setMask(maskVol) {
    if (this._destroyed) return;
    this._maskVol = maskVol || null;

    if (!maskVol || !maskVol.data || !maskVol.dims) {
      this._normMask = null;
      this._maskDims = null;
      this._maskSurface = null;
      this._updateSceneRadius();
      this._scheduleRender(true, true);
      if (this._volume) this._emitCrosshair();
      return;
    }

    const src = maskVol.data;
    const len = src.length;
    const norm = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      const v = src[i];
      if (v !== 0) {
        norm[i] = normalizeLabel(v);
      }
    }

    this._normMask = norm;
    this._maskDims = [maskVol.dims[0], maskVol.dims[1], maskVol.dims[2]];

    if (!this._volume || this._maskMatchesVolume()) {
      const pixdim = this._volume ? this._getPixdim() : (maskVol.pixdim || this._getPixdim());
      this._maskSurface = this._buildSparseSurface(norm, this._maskDims, pixdim);
    } else {
      this._maskSurface = null;
    }
    this._updateSceneRadius();

    this._scheduleRender(true, true);
    if (this._volume) this._emitCrosshair();
  }

  /** Alias for setMask */
  setMaskVolume(maskVol) {
    this.setMask(maskVol);
  }

  /**
   * Set 3D AI evaluation error volume (0=TN, 1=TP, 2=FP, 3=FN).
   * Supports both ARCHITECTURE.md signature: setErrorVolume(uint8Array | null, regionName = 'ET')
   * and dims signature: setErrorVolume(errUint8, dims, regionName?).
   * @param {Uint8Array | Object | null} uint8Array
   * @param {string | number[]} [regionNameOrDims='ET']
   * @param {string} [regionNameOpt]
   */
  setErrorVolume(uint8Array, regionNameOrDims = 'ET', regionNameOpt) {
    if (this._destroyed) return;

    if (!uint8Array) {
      this._errorVolume = null;
      this._errorDims = null;
      this._errorSurface = null;
      if (typeof regionNameOrDims === 'string') {
        this._errorRegion = regionNameOrDims;
      }
      this._updateSceneRadius();
      this._scheduleRender(true, true);
      if (this._volume) this._emitCrosshair();
      return;
    }

    let arr = uint8Array;
    let dims = null;

    if (!(uint8Array instanceof Uint8Array) && uint8Array.data) {
      arr = uint8Array.data instanceof Uint8Array ? uint8Array.data : Uint8Array.from(uint8Array.data);
      if (Array.isArray(uint8Array.dims)) {
        dims = [uint8Array.dims[0], uint8Array.dims[1], uint8Array.dims[2]];
      }
    }

    if (typeof regionNameOrDims === 'string') {
      this._errorRegion = regionNameOrDims;
    } else if (Array.isArray(regionNameOrDims) && regionNameOrDims.length >= 3) {
      dims = [regionNameOrDims[0], regionNameOrDims[1], regionNameOrDims[2]];
      if (typeof regionNameOpt === 'string') {
        this._errorRegion = regionNameOpt;
      }
    }

    if (!dims && this._volume) {
      const [nx, ny, nz] = this._volume.dims;
      if (arr.length === nx * ny * nz) {
        dims = [nx, ny, nz];
      }
    }

    this._errorVolume = arr;
    this._errorDims = dims;

    if (dims && arr.length === dims[0] * dims[1] * dims[2] && (!this._volume || this._errorMatchesVolume())) {
      this._errorSurface = this._buildSparseSurface(arr, dims, this._getPixdim());
    } else {
      this._errorSurface = null;
    }
    this._updateSceneRadius();

    this._scheduleRender(true, true);
    if (this._volume) this._emitCrosshair();
  }

  /**
   * Toggle between BraTS multi-label overlay (false) and AI TP/FP/FN error overlay (true).
   * @param {boolean} enabled
   */
  setErrorOverlayMode(enabled) {
    if (this._destroyed) return;
    this._errorOverlayMode = Boolean(enabled);
    this._overlayMode = this._errorOverlayMode ? 'error' : 'mask';
    this._scheduleRender(true, true);
  }

  /**
   * Switch overlay mode explicitly: 'mask' | 'error' | 'none'.
   * @param {'mask' | 'error' | 'none'} mode
   */
  setOverlayMode(mode) {
    if (this._destroyed) return;
    if (mode === 'error') {
      this._overlayMode = 'error';
      this._errorOverlayMode = true;
    } else if (mode === 'none') {
      this._overlayMode = 'none';
      this._errorOverlayMode = false;
    } else {
      this._overlayMode = 'mask';
      this._errorOverlayMode = false;
    }
    this._scheduleRender(true, true);
  }

  /**
   * Store automated axial RANO 2D perpendicular caliper geometry.
   * @param {Object | null} rano2d
   * @param {number[] | null} [dimsOpt=null]
   */
  setRanoCalipers(rano2d, dimsOpt = null) {
    if (this._destroyed) return;
    this._ranoCalipers = rano2d || null;
    if (!rano2d) {
      this._caliperDims = null;
    } else if (Array.isArray(dimsOpt) && dimsOpt.length >= 3) {
      this._caliperDims = [dimsOpt[0], dimsOpt[1], dimsOpt[2]];
    } else if (Array.isArray(rano2d.dims) && rano2d.dims.length >= 3) {
      this._caliperDims = [rano2d.dims[0], rano2d.dims[1], rano2d.dims[2]];
    } else if (this._maskDims) {
      this._caliperDims = [...this._maskDims];
    } else {
      this._caliperDims = null;
    }
    this._scheduleRender(true, false);
  }

  /** Alias for setRanoCalipers */
  setCaliper(caliperObj) {
    this.setRanoCalipers(caliperObj);
  }

  /**
   * Set synchronized 3D crosshair voxel indices.
   * @param {number} ix
   * @param {number} iy
   * @param {number} iz
   * @param {boolean} [emit=true]
   */
  setCrosshair(ix, iy, iz, emit = true) {
    if (this._destroyed || !this._volume) return;
    const [nx, ny, nz] = this._volume.dims;
    const vx = Number(ix);
    const vy = Number(iy);
    const vz = Number(iz);
    const cx = clamp(Math.round(Number.isFinite(vx) ? vx : this._ix), 0, nx - 1);
    const cy = clamp(Math.round(Number.isFinite(vy) ? vy : this._iy), 0, ny - 1);
    const cz = clamp(Math.round(Number.isFinite(vz) ? vz : this._iz), 0, nz - 1);

    this._ix = cx;
    this._iy = cy;
    this._iz = cz;

    this._scheduleRender(true, false);
    if (emit) {
      this._emitCrosshair();
    }
  }

  /**
   * Set a single orthogonal slice index by axis ('x'|'y'|'z'|'sagittal'|'coronal'|'axial').
   * @param {string} axis
   * @param {number} idx
   */
  setSlice(axis, idx) {
    if (this._destroyed || !this._volume) return;
    const a = String(axis || '').toLowerCase();
    let ix = this._ix;
    let iy = this._iy;
    let iz = this._iz;
    if (a === 'x' || a === 'sagittal') ix = idx;
    else if (a === 'y' || a === 'coronal') iy = idx;
    else if (a === 'z' || a === 'axial') iz = idx;
    else return;
    this.setCrosshair(ix, iy, iz, true);
  }

  /**
   * Register a listener for slice/crosshair updates. Returns an unsubscribe function.
   * @param {Function} cb
   * @returns {Function}
   */
  onSliceChange(cb) {
    if (typeof cb !== 'function') return () => {};
    this._sliceListeners.push(cb);
    return () => {
      const i = this._sliceListeners.indexOf(cb);
      if (i !== -1) this._sliceListeners.splice(i, 1);
    };
  }

  /**
   * Jump crosshair to a rounded 3D voxel centroid [cx, cy, cz] if non-null.
   * @param {number[] | {x: number, y: number, z: number} | null} centroid
   */
  jumpToCentroid(centroid) {
    if (this._destroyed || !centroid || !this._volume) return;
    let cx;
    let cy;
    let cz;
    if (Array.isArray(centroid) && centroid.length >= 3) {
      [cx, cy, cz] = centroid;
    } else if (typeof centroid === 'object') {
      cx = centroid.x;
      cy = centroid.y;
      cz = centroid.z;
    } else {
      return;
    }
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)) return;
    this.setCrosshair(Math.round(cx), Math.round(cy), Math.round(cz), true);
  }

  /**
   * Update radiology Window/Level.
   * @param {number} windowWidth
   * @param {number} windowLevel
   */
  setWindowLevel(windowWidth, windowLevel) {
    if (this._destroyed) return;
    const w = Number(windowWidth);
    const l = Number(windowLevel);
    if (!Number.isFinite(w) || !Number.isFinite(l)) return;
    this._windowWidth = Math.max(1e-3, w);
    this._windowLevel = l;
    this._scheduleRender(true, this._mode3d === 'mip');
  }

  /**
   * Restore smart auto-percentile Window/Level for the current volume.
   */
  resetWindowLevel() {
    if (this._destroyed) return;
    this._windowWidth = this._autoWindowWidth;
    this._windowLevel = this._autoWindowLevel;
    this._scheduleRender(true, true);
    this._emitWindowLevel();
  }

  /**
   * Reset Window/Level, recenter crosshair, and restore default 3D oblique right-anterior view.
   */
  resetView() {
    if (this._destroyed) return;
    this._yaw = DEFAULT_YAW;
    this._pitch = DEFAULT_PITCH;
    this._windowWidth = this._autoWindowWidth;
    this._windowLevel = this._autoWindowLevel;

    if (this._volume) {
      const [nx, ny, nz] = this._volume.dims;
      this._ix = Math.floor(nx / 2);
      this._iy = Math.floor(ny / 2);
      this._iz = Math.floor(nz / 2);
    }

    this._scheduleRender(true, true);
    this._emitWindowLevel();
    if (this._volume) this._emitCrosshair();
  }

  /**
   * Set segmentation / error overlay opacity [0..1].
   * @param {number} opacity
   */
  setMaskOpacity(opacity) {
    if (this._destroyed) return;
    const v = Number(opacity);
    if (!Number.isFinite(v)) return;
    this._maskOpacity = clamp(v, 0, 1);
    this._scheduleRender(true, true);
  }

  /** Alias for setMaskOpacity */
  setOpacity(val) {
    this.setMaskOpacity(val);
  }

  /**
   * Toggle visibility for canonical label 1, 2, 3 (or legacy 4), or 5.
   * @param {number | string} labelId
   * @param {boolean} visible
   */
  setLabelVisibility(labelId, visible) {
    if (this._destroyed) return;
    const norm = normalizeLabel(Number(labelId));
    if (norm === 0) return;
    this._labelVisibility[norm] = Boolean(visible);
    this._scheduleRender(true, true);
  }

  /**
   * Toggle orthogonal crosshair overlays.
   * @param {boolean} show
   */
  setShowCrosshairs(show) {
    if (this._destroyed) return;
    this._showCrosshairs = Boolean(show);
    this._scheduleRender(true, false);
  }

  /**
   * Toggle RANO 2D caliper vector overlay on Axial canvas.
   * @param {boolean} show
   */
  setShowCalipers(show) {
    if (this._destroyed) return;
    this._showCalipers = Boolean(show);
    this._scheduleRender(true, false);
  }

  /**
   * Switch 3D viewport mode: 'mip' or 'tumor_surface'.
   * @param {'mip' | 'tumor_surface' | 'surface'} mode
   */
  set3DMode(mode) {
    if (this._destroyed) return;
    if (mode === 'mip') {
      this._mode3d = 'mip';
    } else if (mode === 'tumor_surface' || mode === 'surface') {
      this._mode3d = 'tumor_surface';
    } else {
      return;
    }
    this._scheduleRender(false, true);
  }

  /**
   * Update 3D orbital camera angles in radians.
   * @param {number} yawRad
   * @param {number} pitchRad
   */
  set3DRotation(yawRad, pitchRad) {
    if (this._destroyed) return;
    if (Number.isFinite(yawRad)) this._yaw = yawRad;
    if (Number.isFinite(pitchRad)) this._pitch = clamp(pitchRad, -1.48, 1.48);
    this._scheduleRender(false, true);
  }

  /**
   * Return current viewer state snapshot.
   */
  getState() {
    return {
      ix: this._ix,
      iy: this._iy,
      iz: this._iz,
      windowWidth: this._windowWidth,
      windowLevel: this._windowLevel,
      autoWindowWidth: this._autoWindowWidth,
      autoWindowLevel: this._autoWindowLevel,
      maskOpacity: this._maskOpacity,
      labelVisibility: { ...this._labelVisibility },
      errorOverlayMode: this._errorOverlayMode,
      overlayMode: this._overlayMode,
      errorRegion: this._errorRegion,
      showCrosshairs: this._showCrosshairs,
      showCalipers: this._showCalipers,
      showOrientationLabels: this._showOrientationLabels,
      mode3d: this._mode3d,
      yaw: this._yaw,
      pitch: this._pitch,
    };
  }

  /**
   * Immediately render all 4 canvases synchronously, flushing any queued animation frame.
   */
  render() {
    if (this._destroyed) return;
    this._renderAllImmediate();
  }

  /**
   * Sync all 4 canvas backing stores to CSS layout size * devicePixelRatio and re-render.
   */
  resize() {
    if (this._destroyed) return;
    let changed = false;
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 3) : 1;

    for (const key of ['axial', 'coronal', 'sagittal', 'mip3d']) {
      const canvas = this._canvases[key];
      if (!canvas) continue;
      if (this._syncCanvasSize(key, canvas, dpr)) {
        changed = true;
      }
    }

    if (changed || this._volume) {
      this._scheduleRender(true, true);
    }
  }

  /**
   * Detach all event listeners, disconnect ResizeObserver, and cancel pending frames.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    if (this._rafId && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this._rafId);
      this._rafId = 0;
    }

    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    for (const fn of this._cleanupFns) {
      try {
        fn();
      } catch (_) {
        // Ignore teardown errors
      }
    }
    this._cleanupFns.length = 0;
    this._sliceListeners.length = 0;
  }

  // =========================================================================
  // Initialization & Event Wiring
  // =========================================================================

  _initCanvasesAndEvents() {
    for (const plane of ['axial', 'coronal', 'sagittal']) {
      const canvas = this._canvases[plane];
      if (!canvas) continue;
      canvas.style.touchAction = 'none';
      this._bindOrthoEvents(plane, canvas);
    }

    if (this._canvases.mip3d) {
      this._canvases.mip3d.style.touchAction = 'none';
      this._bind3DEvents(this._canvases.mip3d);
    }

    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => {
        if (!this._destroyed) this.resize();
      });
      const observed = new Set();
      for (const key of ['axial', 'coronal', 'sagittal', 'mip3d']) {
        const canvas = this._canvases[key];
        if (!canvas) continue;
        const target = canvas.parentElement || canvas;
        if (!observed.has(target)) {
          observed.add(target);
          this._resizeObserver.observe(target);
        }
        if (!observed.has(canvas)) {
          observed.add(canvas);
          this._resizeObserver.observe(canvas);
        }
      }
    }

    if (typeof window !== 'undefined') {
      const onWinResize = () => this.resize();
      window.addEventListener('resize', onWinResize);
      this._cleanupFns.push(() => window.removeEventListener('resize', onWinResize));
    }
  }

  _bindOrthoEvents(plane, canvas) {
    let dragMode = null; // 'crosshair' | 'wl'
    let activePointerId = null;
    let startX = 0;
    let startY = 0;
    let startWW = 1000;
    let startWL = 500;

    const getLocalPos = (e) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const onPointerDown = (e) => {
      if (!this._volume) return;
      if (e.button === 2 || (e.button === 0 && e.shiftKey)) {
        e.preventDefault();
        dragMode = 'wl';
        activePointerId = e.pointerId;
        startX = e.clientX;
        startY = e.clientY;
        startWW = this._windowWidth;
        startWL = this._windowLevel;
        this._isDraggingWL = true;
        this._activeWLPlane = plane;
        try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
        this._scheduleRender(true, false);
      } else if (e.button === 0) {
        e.preventDefault();
        dragMode = 'crosshair';
        activePointerId = e.pointerId;
        try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
        const pos = getLocalPos(e);
        this._updateCrosshairFromCanvas(plane, pos.x, pos.y);
      }
    };

    const onPointerMove = (e) => {
      if (!dragMode || e.pointerId !== activePointerId || !this._volume) return;
      if (dragMode === 'crosshair') {
        const pos = getLocalPos(e);
        this._updateCrosshairFromCanvas(plane, pos.x, pos.y);
      } else if (dragMode === 'wl') {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const scale = Math.max(1e-2, this._autoWindowWidth * 0.004);
        this._windowWidth = Math.max(1e-3, startWW + dx * scale);
        this._windowLevel = startWL + dy * scale;
        this._scheduleRender(true, this._mode3d === 'mip');
        this._emitWindowLevel();
      }
    };

    const endDrag = (e) => {
      if (!dragMode || (e && activePointerId !== null && e.pointerId !== activePointerId)) return;
      const wasWL = dragMode === 'wl';
      dragMode = null;
      if (activePointerId !== null) {
        try { canvas.releasePointerCapture(activePointerId); } catch (_) {}
      }
      activePointerId = null;
      if (wasWL) {
        this._isDraggingWL = false;
        this._activeWLPlane = null;
        this._scheduleRender(true, this._mode3d === 'mip');
      }
    };

    const onWheel = (e) => {
      if (!this._volume) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 1 : -1;
      if (plane === 'axial') {
        this.setCrosshair(this._ix, this._iy, this._iz + delta, true);
      } else if (plane === 'coronal') {
        this.setCrosshair(this._ix, this._iy + delta, this._iz, true);
      } else if (plane === 'sagittal') {
        this.setCrosshair(this._ix + delta, this._iy, this._iz, true);
      }
    };

    const onContextMenu = (e) => {
      e.preventDefault();
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenu);

    this._cleanupFns.push(() => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', endDrag);
      canvas.removeEventListener('pointercancel', endDrag);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
    });
  }

  _bind3DEvents(canvas) {
    let dragging = false;
    let activePointerId = null;
    let lastX = 0;
    let lastY = 0;

    const onPointerDown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      this._isDragging3D = true;
      activePointerId = e.pointerId;
      lastX = e.clientX;
      lastY = e.clientY;
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    };

    const onPointerMove = (e) => {
      if (!dragging || e.pointerId !== activePointerId) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;

      this._yaw -= dx * 0.0085;
      this._pitch = clamp(this._pitch + dy * 0.0085, -1.48, 1.48);
      this._scheduleRender(false, true);
    };

    const endDrag = (e) => {
      if (!dragging || (e && activePointerId !== null && e.pointerId !== activePointerId)) return;
      dragging = false;
      this._isDragging3D = false;
      if (activePointerId !== null) {
        try { canvas.releasePointerCapture(activePointerId); } catch (_) {}
      }
      activePointerId = null;
      // Full-quality settle render after orbiting ends
      this._scheduleRender(false, true);
    };

    const onDblClick = (e) => {
      e.preventDefault();
      this._yaw = DEFAULT_YAW;
      this._pitch = DEFAULT_PITCH;
      this._isDragging3D = false;
      this._scheduleRender(false, true);
    };

    const onContextMenu = (e) => {
      e.preventDefault();
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('contextmenu', onContextMenu);

    this._cleanupFns.push(() => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', endDrag);
      canvas.removeEventListener('pointercancel', endDrag);
      canvas.removeEventListener('dblclick', onDblClick);
      canvas.removeEventListener('contextmenu', onContextMenu);
    });
  }

  // =========================================================================
  // Scheduling & Sizing Helpers
  // =========================================================================

  _syncCanvasSize(key, canvas, dpr) {
    const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
    const cssW = Math.round(rect && rect.width > 0 ? rect.width : (canvas.clientWidth || canvas.width || 0));
    const cssH = Math.round(rect && rect.height > 0 ? rect.height : (canvas.clientHeight || canvas.height || 0));
    if (cssW <= 0 || cssH <= 0) return false;

    const targetW = Math.max(1, Math.round(cssW * dpr));
    const targetH = Math.max(1, Math.round(cssH * dpr));
    const m = this._canvasMetrics[key];
    const changed = canvas.width !== targetW || canvas.height !== targetH || m.cssW !== cssW || m.cssH !== cssH || m.dpr !== dpr;

    if (canvas.width !== targetW) canvas.width = targetW;
    if (canvas.height !== targetH) canvas.height = targetH;
    m.cssW = cssW;
    m.cssH = cssH;
    m.dpr = dpr;
    return changed;
  }

  _ensureCanvasReady(key) {
    const canvas = this._canvases[key];
    const ctx = this._ctxs[key];
    if (!canvas || !ctx) return null;

    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 3) : 1;
    const m = this._canvasMetrics[key];
    if (m.cssW <= 0 || m.cssH <= 0) {
      this._syncCanvasSize(key, canvas, dpr);
    }
    if (m.cssW <= 0 || m.cssH <= 0) return null;

    ctx.setTransform(m.dpr, 0, 0, m.dpr, 0, 0);
    return { ctx, cssW: m.cssW, cssH: m.cssH, dpr: m.dpr };
  }

  _scheduleRender(dirty2D, dirty3D) {
    if (this._destroyed) return;
    if (dirty2D) this._dirty2D = true;
    if (dirty3D) this._dirty3D = true;

    if (this._rafId) return;
    if (typeof requestAnimationFrame === 'function') {
      this._rafId = requestAnimationFrame(() => {
        this._rafId = 0;
        if (this._destroyed) return;
        const do2D = this._dirty2D;
        const do3D = this._dirty3D;
        this._dirty2D = false;
        this._dirty3D = false;
        if (do2D) {
          this._renderOrtho('axial');
          this._renderOrtho('coronal');
          this._renderOrtho('sagittal');
        }
        if (do3D) {
          this._render3D();
        }
      });
    } else {
      const do2D = this._dirty2D;
      const do3D = this._dirty3D;
      this._dirty2D = false;
      this._dirty3D = false;
      if (do2D) {
        this._renderOrtho('axial');
        this._renderOrtho('coronal');
        this._renderOrtho('sagittal');
      }
      if (do3D) {
        this._render3D();
      }
    }
  }

  _renderAllImmediate() {
    if (this._rafId && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this._rafId);
      this._rafId = 0;
    }
    this._dirty2D = false;
    this._dirty3D = false;
    this._renderOrtho('axial');
    this._renderOrtho('coronal');
    this._renderOrtho('sagittal');
    this._render3D();
  }

  // =========================================================================
  // Volume Analysis, Coordinate & Telemetry Helpers
  // =========================================================================

  _getPixdim() {
    if (this._volume && Array.isArray(this._volume.pixdim) && this._volume.pixdim.length >= 3) {
      return [
        Math.abs(this._volume.pixdim[0]) || 1.0,
        Math.abs(this._volume.pixdim[1]) || 1.0,
        Math.abs(this._volume.pixdim[2]) || 1.0,
      ];
    }
    return [1.0, 1.0, 1.0];
  }

  _maskMatchesVolume() {
    if (!this._volume || !this._normMask || !this._maskDims) return false;
    const [nx, ny, nz] = this._volume.dims;
    return this._maskDims[0] === nx && this._maskDims[1] === ny && this._maskDims[2] === nz;
  }

  _errorMatchesVolume() {
    if (!this._volume || !this._errorVolume) return false;
    const [nx, ny, nz] = this._volume.dims;
    if (this._errorDims) {
      return (
        this._errorDims[0] === nx &&
        this._errorDims[1] === ny &&
        this._errorDims[2] === nz &&
        this._errorVolume.length === nx * ny * nz
      );
    }
    return this._errorVolume.length === nx * ny * nz;
  }

  _calipersMatchVolume() {
    const r = this._ranoCalipers;
    if (!this._volume || !r || r.bestSliceZ === null || r.bestSliceZ === undefined) return false;
    const [nx, ny, nz] = this._volume.dims;

    const cDims = Array.isArray(r.dims) && r.dims.length >= 3 ? r.dims : this._caliperDims;
    if (cDims) {
      if (cDims[0] !== nx || cDims[1] !== ny || cDims[2] !== nz) return false;
    } else if (this._maskDims) {
      if (!this._maskMatchesVolume()) return false;
    }

    const z = Math.round(r.bestSliceZ);
    if (!Number.isFinite(z) || z < 0 || z >= nz) return false;

    if (r.majorLine) {
      const { x1, y1, x2, y2 } = r.majorLine;
      if (
        !Number.isFinite(x1) || !Number.isFinite(y1) ||
        !Number.isFinite(x2) || !Number.isFinite(y2) ||
        x1 < -0.5 || x1 > nx - 0.5 || x2 < -0.5 || x2 > nx - 0.5 ||
        y1 < -0.5 || y1 > ny - 0.5 || y2 < -0.5 || y2 > ny - 0.5
      ) {
        return false;
      }
    }
    if (r.minorLine) {
      const { x1, y1, x2, y2 } = r.minorLine;
      if (
        !Number.isFinite(x1) || !Number.isFinite(y1) ||
        !Number.isFinite(x2) || !Number.isFinite(y2)
      ) {
        return false;
      }
    }
    return true;
  }

  _voxelToMm(ix, iy, iz) {
    const [dx, dy, dz] = this._getPixdim();
    const hdr = this._volume && this._volume.header;
    if (hdr && hdr.sformCode > 0 && Array.isArray(hdr.sform) && hdr.sform.length === 3) {
      const r0 = hdr.sform[0];
      const r1 = hdr.sform[1];
      const r2 = hdr.sform[2];
      if (r0 && r1 && r2 && r0.length >= 4 && r1.length >= 4 && r2.length >= 4) {
        const mag =
          Math.abs(r0[0]) + Math.abs(r0[1]) + Math.abs(r0[2]) +
          Math.abs(r1[0]) + Math.abs(r1[1]) + Math.abs(r1[2]) +
          Math.abs(r2[0]) + Math.abs(r2[1]) + Math.abs(r2[2]);
        if (Number.isFinite(mag) && mag > 1e-8) {
          return {
            mmX: r0[0] * ix + r0[1] * iy + r0[2] * iz + r0[3],
            mmY: r1[0] * ix + r1[1] * iy + r1[2] * iz + r1[3],
            mmZ: r2[0] * ix + r2[1] * iy + r2[2] * iz + r2[3],
          };
        }
      }
    }
    return {
      mmX: ix * dx,
      mmY: iy * dy,
      mmZ: iz * dz,
    };
  }

  _computeAutoWindowLevel() {
    const vol = this._volume;
    const data = vol.data;
    const n = data.length;

    let minAll = Infinity;
    let maxAll = -Infinity;
    let minNz = Infinity;
    let maxNz = -Infinity;
    let nzCount = 0;

    for (let i = 0; i < n; i++) {
      const v = data[i];
      if (!Number.isFinite(v)) continue;
      if (v < minAll) minAll = v;
      if (v > maxAll) maxAll = v;
      if (v !== 0) {
        if (v < minNz) minNz = v;
        if (v > maxNz) maxNz = v;
        nzCount++;
      }
    }

    if (!Number.isFinite(minAll) || !Number.isFinite(maxAll)) {
      this._p1 = 0;
      this._p995 = 1;
      this._autoWindowWidth = 1;
      this._autoWindowLevel = 0.5;
      return;
    }

    const useNonZero = nzCount >= 16 && minNz < maxNz;
    const lo = useNonZero ? minNz : minAll;
    const hi = useNonZero ? maxNz : maxAll;

    if (hi - lo < 1e-6) {
      this._p1 = lo;
      this._p995 = hi;
      this._autoWindowWidth = Math.max(1, Math.abs(hi) * 0.1 || 1);
      this._autoWindowLevel = lo;
      return;
    }

    // Fast O(N) 2048-bin histogram percentile computation (handles 240x240x155 effortlessly)
    const BINS = 2048;
    const hist = new Uint32Array(BINS);
    const invSpan = (BINS - 1) / (hi - lo);
    let total = 0;

    for (let i = 0; i < n; i++) {
      const v = data[i];
      if (!Number.isFinite(v)) continue;
      if (useNonZero && v === 0) continue;
      const b = clamp(Math.floor((v - lo) * invSpan), 0, BINS - 1);
      hist[b]++;
      total++;
    }

    const targetLow = total * 0.01;
    const targetHigh = total * 0.995;
    let cum = 0;
    let binLow = 0;
    let binHigh = BINS - 1;
    let foundLow = false;

    for (let b = 0; b < BINS; b++) {
      cum += hist[b];
      if (!foundLow && cum >= targetLow) {
        binLow = b;
        foundLow = true;
      }
      if (cum >= targetHigh) {
        binHigh = b;
        break;
      }
    }

    const binW = (hi - lo) / (BINS - 1);
    const p1 = lo + binLow * binW;
    const p995 = lo + binHigh * binW;

    this._p1 = p1;
    this._p995 = p995;
    this._autoWindowWidth = Math.max(1e-3, p995 - p1);
    this._autoWindowLevel = 0.5 * (p1 + p995);
  }

  _emitCrosshair() {
    if (!this._volume) return;
    const [nx, ny] = this._volume.dims;
    const idx = this._ix + this._iy * nx + this._iz * nx * ny;
    const { mmX, mmY, mmZ } = this._voxelToMm(this._ix, this._iy, this._iz);
    const intensity = Number.isFinite(this._volume.data[idx]) ? this._volume.data[idx] : 0;
    const label = this._maskMatchesVolume() ? this._normMask[idx] : 0;
    const errorCode = this._errorMatchesVolume() ? this._errorVolume[idx] : 0;

    const payload = {
      ix: this._ix,
      iy: this._iy,
      iz: this._iz,
      mmX,
      mmY,
      mmZ,
      intensity,
      label,
      errorCode,
    };

    if (this._onCrosshairChange) {
      this._onCrosshairChange(payload);
    }
    for (const cb of this._sliceListeners) {
      cb(payload);
    }
  }

  _emitWindowLevel() {
    if (this._onWindowLevelChange) {
      this._onWindowLevelChange({
        windowWidth: this._windowWidth,
        windowLevel: this._windowLevel,
      });
    }
  }

  _updateCrosshairFromCanvas(plane, px, py) {
    const rect = this._viewRects[plane];
    if (!rect || !this._volume || rect.w <= 0 || rect.h <= 0) return;

    const [nx, ny, nz] = this._volume.dims;
    const uNorm = (px - rect.x) / rect.w;
    const vNorm = (py - rect.y) / rect.h;

    if (plane === 'axial') {
      const u = clamp(Math.floor(uNorm * nx), 0, nx - 1);
      const v = clamp(Math.floor(vNorm * ny), 0, ny - 1);
      const ix = (nx - 1) - u;
      const iy = (ny - 1) - v;
      if (ix !== this._ix || iy !== this._iy) {
        this.setCrosshair(ix, iy, this._iz, true);
      }
    } else if (plane === 'coronal') {
      const u = clamp(Math.floor(uNorm * nx), 0, nx - 1);
      const v = clamp(Math.floor(vNorm * nz), 0, nz - 1);
      const ix = (nx - 1) - u;
      const iz = (nz - 1) - v;
      if (ix !== this._ix || iz !== this._iz) {
        this.setCrosshair(ix, this._iy, iz, true);
      }
    } else if (plane === 'sagittal') {
      const u = clamp(Math.floor(uNorm * ny), 0, ny - 1);
      const v = clamp(Math.floor(vNorm * nz), 0, nz - 1);
      const iy = (ny - 1) - u;
      const iz = (nz - 1) - v;
      if (iy !== this._iy || iz !== this._iz) {
        this.setCrosshair(this._ix, iy, iz, true);
      }
    }
  }

  // =========================================================================
  // 2D Orthogonal Slice Rendering (Axial, Coronal, Sagittal)
  // =========================================================================

  _ensureOffscreenPlane(plane, imgW, imgH) {
    const slot = this._offscreen[plane];
    if (!slot.canvas && typeof document !== 'undefined') {
      slot.canvas = document.createElement('canvas');
      slot.ctx = slot.canvas.getContext('2d');
    }
    if (!slot.canvas || !slot.ctx) return null;

    if (slot.w !== imgW || slot.h !== imgH || !slot.imgData) {
      slot.canvas.width = imgW;
      slot.canvas.height = imgH;
      slot.imgData = slot.ctx.createImageData(imgW, imgH);
      slot.labelScratch = new Uint8Array(imgW * imgH);
      slot.w = imgW;
      slot.h = imgH;
    }
    return slot;
  }

  _computeFitRect(cssW, cssH, physW, physH) {
    const padX = cssW < 180 ? 12 : 20;
    const padTop = cssH < 180 ? 14 : 22;
    const padBottom = cssH < 180 ? 18 : 24;

    const availW = Math.max(16, cssW - padX * 2);
    const availH = Math.max(16, cssH - padTop - padBottom);
    const aspect = physW / Math.max(1e-6, physH);

    let w;
    let h;
    if (availW / availH > aspect) {
      h = availH;
      w = h * aspect;
    } else {
      w = availW;
      h = w / aspect;
    }

    const x = padX + (availW - w) * 0.5;
    const y = padTop + (availH - h) * 0.5;
    return { x, y, w, h };
  }

  _renderOrtho(plane) {
    const target = this._ensureCanvasReady(plane);
    if (!target) return;
    const { ctx, cssW, cssH } = target;

    // Clear dark radiology slate background
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, cssW, cssH);

    if (!this._volume) {
      this._viewRects[plane] = null;
      this._drawEmptyPlaceholder(ctx, cssW, cssH, plane.toUpperCase());
      return;
    }

    const [nx, ny, nz] = this._volume.dims;
    const [dx, dy, dz] = this._getPixdim();
    const volData = this._volume.data;
    const sliceStride = nx * ny;

    let imgW;
    let imgH;
    let physW;
    let physH;
    if (plane === 'axial') {
      imgW = nx;
      imgH = ny;
      physW = nx * dx;
      physH = ny * dy;
    } else if (plane === 'coronal') {
      imgW = nx;
      imgH = nz;
      physW = nx * dx;
      physH = nz * dz;
    } else {
      imgW = ny;
      imgH = nz;
      physW = ny * dy;
      physH = nz * dz;
    }

    const off = this._ensureOffscreenPlane(plane, imgW, imgH);
    if (!off) return;

    const rgba = off.imgData.data;
    const lblBuf = off.labelScratch;

    const showError = this._overlayMode === 'error' && this._errorMatchesVolume() && this._maskOpacity > 0;
    const showMask = this._overlayMode === 'mask' && this._maskMatchesVolume() && this._maskOpacity > 0;
    const overlayData = showError ? this._errorVolume : (showMask ? this._normMask : null);
    const vis = this._labelVisibility;

    const ww = Math.max(1e-3, this._windowWidth);
    const wl = this._windowLevel;
    const low = wl - ww * 0.5;
    const invWW = 255.0 / ww;
    const baseOpacity = this._maskOpacity;

    // Pass 1: Fill base grayscale pixels and record visible overlay code per pixel
    if (plane === 'axial') {
      const zOff = this._iz * sliceStride;
      for (let v = 0; v < imgH; v++) {
        const y = (ny - 1) - v;
        const rowOff = zOff + y * nx;
        const dstRow = v * imgW;
        for (let u = 0; u < imgW; u++) {
          const x = (nx - 1) - u;
          const vIdx = rowOff + x;
          const pIdx = dstRow + u;

          const val = volData[vIdx];
          let g = (val - low) * invWW;
          g = g <= 0 ? 0 : g >= 255 ? 255 : (g + 0.5) | 0;

          const o = pIdx * 4;
          rgba[o] = g;
          rgba[o + 1] = g;
          rgba[o + 2] = g;
          rgba[o + 3] = 255;

          if (overlayData) {
            const c = overlayData[vIdx];
            lblBuf[pIdx] = showError ? (c <= 3 ? c : 0) : (c && vis[c] ? c : 0);
          } else {
            lblBuf[pIdx] = 0;
          }
        }
      }
    } else if (plane === 'coronal') {
      const yOff = this._iy * nx;
      for (let v = 0; v < imgH; v++) {
        const z = (nz - 1) - v;
        const rowOff = z * sliceStride + yOff;
        const dstRow = v * imgW;
        for (let u = 0; u < imgW; u++) {
          const x = (nx - 1) - u;
          const vIdx = rowOff + x;
          const pIdx = dstRow + u;

          const val = volData[vIdx];
          let g = (val - low) * invWW;
          g = g <= 0 ? 0 : g >= 255 ? 255 : (g + 0.5) | 0;

          const o = pIdx * 4;
          rgba[o] = g;
          rgba[o + 1] = g;
          rgba[o + 2] = g;
          rgba[o + 3] = 255;

          if (overlayData) {
            const c = overlayData[vIdx];
            lblBuf[pIdx] = showError ? (c <= 3 ? c : 0) : (c && vis[c] ? c : 0);
          } else {
            lblBuf[pIdx] = 0;
          }
        }
      }
    } else {
      // Sagittal (YZ at ix)
      const xOff = this._ix;
      for (let v = 0; v < imgH; v++) {
        const z = (nz - 1) - v;
        const zOff = z * sliceStride + xOff;
        const dstRow = v * imgW;
        for (let u = 0; u < imgW; u++) {
          const y = (ny - 1) - u;
          const vIdx = zOff + y * nx;
          const pIdx = dstRow + u;

          const val = volData[vIdx];
          let g = (val - low) * invWW;
          g = g <= 0 ? 0 : g >= 255 ? 255 : (g + 0.5) | 0;

          const o = pIdx * 4;
          rgba[o] = g;
          rgba[o + 1] = g;
          rgba[o + 2] = g;
          rgba[o + 3] = 255;

          if (overlayData) {
            const c = overlayData[vIdx];
            lblBuf[pIdx] = showError ? (c <= 3 ? c : 0) : (c && vis[c] ? c : 0);
          } else {
            lblBuf[pIdx] = 0;
          }
        }
      }
    }

    // Pass 2: Composite multi-label / error colors with crisp contour margin enhancement
    if (overlayData) {
      const lut = showError ? ERROR_RGB_LUT : LABEL_RGB_LUT;
      const rimAlpha = Math.min(1.0, baseOpacity * 1.32);

      for (let v = 0; v < imgH; v++) {
        const rowOff = v * imgW;
        for (let u = 0; u < imgW; u++) {
          const pIdx = rowOff + u;
          const code = lblBuf[pIdx];
          if (code === 0) continue;
          const rgb = lut[code];
          if (!rgb) continue;

          // Subtle crisp boundary edge emphasis for clinical clarity
          const isEdge =
            u === 0 || u === imgW - 1 || v === 0 || v === imgH - 1 ||
            lblBuf[pIdx - 1] !== code ||
            lblBuf[pIdx + 1] !== code ||
            lblBuf[pIdx - imgW] !== code ||
            lblBuf[pIdx + imgW] !== code;

          const a = isEdge ? rimAlpha : baseOpacity;
          const invA = 1.0 - a;
          const o = pIdx * 4;
          const g = rgba[o];
          rgba[o] = (g * invA + rgb[0] * a + 0.5) | 0;
          rgba[o + 1] = (g * invA + rgb[1] * a + 0.5) | 0;
          rgba[o + 2] = (g * invA + rgb[2] * a + 0.5) | 0;
        }
      }
    }

    off.ctx.putImageData(off.imgData, 0, 0);

    // Compute aspect-ratio-preserving destination rectangle
    const rect = this._computeFitRect(cssW, cssH, physW, physH);
    this._viewRects[plane] = rect;

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(off.canvas, 0, 0, imgW, imgH, rect.x, rect.y, rect.w, rect.h);
    ctx.restore();

    // Subtle crisp image border
    ctx.save();
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(rect.x) + 0.5, Math.round(rect.y) + 0.5, Math.round(rect.w), Math.round(rect.h));
    ctx.restore();

    // Anatomical crosshairs
    if (this._showCrosshairs) {
      this._drawCrosshairs(ctx, plane, rect, imgW, imgH);
    }

    // RANO 2D calipers on best axial slice
    if (plane === 'axial' && this._showCalipers && this._ranoCalipers) {
      this._drawRanoCalipers(ctx, rect, cssW, cssH);
    }

    // Medical orientation labels (R/L, A/P, S/I)
    if (this._showOrientationLabels) {
      this._drawOrientationLabels(ctx, plane, cssW, cssH);
    }

    // Compact bottom HUD (slice index + mm coordinate + active W/L feedback)
    this._drawOrthoHud(ctx, plane, cssW, cssH);
  }

  _drawCrosshairs(ctx, plane, rect, imgW, imgH) {
    const [nx, ny, nz] = this._volume.dims;
    let u;
    let v;
    if (plane === 'axial') {
      u = (nx - 1) - this._ix;
      v = (ny - 1) - this._iy;
    } else if (plane === 'coronal') {
      u = (nx - 1) - this._ix;
      v = (nz - 1) - this._iz;
    } else {
      u = (ny - 1) - this._iy;
      v = (nz - 1) - this._iz;
    }

    const cx = Math.round(rect.x + ((u + 0.5) / imgW) * rect.w) + 0.5;
    const cy = Math.round(rect.y + ((v + 0.5) / imgH) * rect.h) + 0.5;
    const gap = 7;

    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();

    // Dark hairline halo for contrast over hyperintense enhancing tumor
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.lineWidth = 2.5;
    this._strokeCrosshairSegments(ctx, rect, cx, cy, gap);

    // Primary subtle medical cyan crosshair
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.62)';
    ctx.lineWidth = 1;
    this._strokeCrosshairSegments(ctx, rect, cx, cy, gap);

    ctx.restore();
  }

  _strokeCrosshairSegments(ctx, rect, cx, cy, gap) {
    ctx.beginPath();
    // Left arm
    if (cx - gap > rect.x) {
      ctx.moveTo(rect.x, cy);
      ctx.lineTo(cx - gap, cy);
    }
    // Right arm
    if (cx + gap < rect.x + rect.w) {
      ctx.moveTo(cx + gap, cy);
      ctx.lineTo(rect.x + rect.w, cy);
    }
    // Top arm
    if (cy - gap > rect.y) {
      ctx.moveTo(cx, rect.y);
      ctx.lineTo(cx, cy - gap);
    }
    // Bottom arm
    if (cy + gap < rect.y + rect.h) {
      ctx.moveTo(cx, cy + gap);
      ctx.lineTo(cx, rect.y + rect.h);
    }
    ctx.stroke();
  }

  _drawRanoCalipers(ctx, rect, cssW, cssH) {
    const r = this._ranoCalipers;
    if (!this._calipersMatchVolume()) return;
    if (Math.round(r.bestSliceZ) !== this._iz) return;

    const [nx, ny] = this._volume.dims;
    const toCanvas = (vx, vy) => ({
      x: rect.x + ((nx - 0.5 - vx) / nx) * rect.w,
      y: rect.y + ((ny - 0.5 - vy) / ny) * rect.h,
    });

    const drawCaliperLine = (line, color, dashed) => {
      if (!line) return null;
      const p1 = toCanvas(line.x1, line.y1);
      const p2 = toCanvas(line.x2, line.y2);
      const vx = p2.x - p1.x;
      const vy = p2.y - p1.y;
      const len = Math.hypot(vx, vy);
      if (len < 1e-3) return null;

      const tx = -vy / len;
      const ty = vx / len;
      const tick = 5;

      // Dark halo for legibility on bright T1ce ring
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.78)';
      ctx.lineWidth = 3.8;
      if (dashed) ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();

      // Colored main vector
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();

      // Solid perpendicular end-ticks
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.moveTo(p1.x - tx * tick, p1.y - ty * tick);
      ctx.lineTo(p1.x + tx * tick, p1.y + ty * tick);
      ctx.moveTo(p2.x - tx * tick, p2.y - ty * tick);
      ctx.lineTo(p2.x + tx * tick, p2.y + ty * tick);
      ctx.stroke();

      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(p1.x - tx * tick, p1.y - ty * tick);
      ctx.lineTo(p1.x + tx * tick, p1.y + ty * tick);
      ctx.moveTo(p2.x - tx * tick, p2.y - ty * tick);
      ctx.lineTo(p2.x + tx * tick, p2.y + ty * tick);
      ctx.stroke();

      // Crisp endpoint dots
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p1.x, p1.y, 2.2, 0, Math.PI * 2);
      ctx.arc(p2.x, p2.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      return { p1, p2, midX: (p1.x + p2.x) * 0.5, midY: (p1.y + p2.y) * 0.5, ux: vx / len, uy: vy / len };
    };

    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    const g1 = drawCaliperLine(r.majorLine, '#2dd4bf', false);
    const g2 = drawCaliperLine(r.minorLine, '#fde047', true);
    ctx.restore();

    const pills = [];
    const placePill = (text, color, anchorX, anchorY) => {
      ctx.save();
      ctx.font = `600 10.5px ${FONT_MONO}`;
      const tw = ctx.measureText(text).width;
      const pw = tw + 10;
      const ph = 17;
      let bx = clamp(anchorX - pw * 0.5, 6, cssW - pw - 6);
      let by = clamp(anchorY - ph * 0.5, 6, cssH - ph - 22);

      // Avoid overlap with previously placed caliper pills
      for (const prev of pills) {
        if (bx < prev.x + prev.w + 4 && bx + pw + 4 > prev.x && by < prev.y + prev.h + 4 && by + ph + 4 > prev.y) {
          by = prev.y + prev.h + 5;
          if (by + ph > cssH - 22) {
            by = Math.max(6, prev.y - ph - 5);
          }
        }
      }
      pills.push({ x: bx, y: by, w: pw, h: ph });

      drawRoundedRect(ctx, bx, by, pw, ph, 4);
      ctx.fillStyle = 'rgba(11, 15, 23, 0.88)';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, bx + 5, by + ph * 0.5 + 0.5);
      ctx.restore();
    };

    if (g1 && Number.isFinite(r.d1Mm) && r.d1Mm > 0) {
      // Pick endpoint closer to top/right of lesion to float badge cleanly outside
      const anchor = g1.p2.y <= g1.p1.y ? g1.p2 : g1.p1;
      const dir = anchor === g1.p2 ? 1 : -1;
      placePill(`d1 ${r.d1Mm.toFixed(1)}mm`, '#2dd4bf', anchor.x + dir * g1.ux * 22, anchor.y + dir * g1.uy * 22 - 8);
    }

    if (g2 && Number.isFinite(r.d2Mm) && r.d2Mm > 0) {
      const anchor = g2.p2.y >= g2.p1.y ? g2.p2 : g2.p1;
      const dir = anchor === g2.p2 ? 1 : -1;
      placePill(`d2 ${r.d2Mm.toFixed(1)}mm`, '#fde047', anchor.x + dir * g2.ux * 22, anchor.y + dir * g2.uy * 22 + 10);
    }
  }

  _drawOrientationLabels(ctx, plane, cssW, cssH) {
    let left;
    let right;
    let top;
    let bottom;
    if (plane === 'axial') {
      left = 'R'; right = 'L'; top = 'A'; bottom = 'P';
    } else if (plane === 'coronal') {
      left = 'R'; right = 'L'; top = 'S'; bottom = 'I';
    } else {
      left = 'A'; right = 'P'; top = 'S'; bottom = 'I';
    }

    ctx.save();
    ctx.font = `600 11px ${FONT_SANS}`;
    ctx.fillStyle = 'rgba(148, 163, 184, 0.88)';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
    ctx.shadowBlur = 3;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillText(top, cssW * 0.5, 11);
    ctx.fillText(bottom, cssW * 0.5, cssH - 11);
    ctx.fillText(left, 10, cssH * 0.5);
    ctx.fillText(right, cssW - 10, cssH * 0.5);
    ctx.restore();
  }

  _drawOrthoHud(ctx, plane, cssW, cssH) {
    const [nx, ny, nz] = this._volume.dims;
    const { mmX, mmY, mmZ } = this._voxelToMm(this._ix, this._iy, this._iz);

    let sliceText;
    if (plane === 'axial') {
      sliceText = `Z ${this._iz + 1}/${nz} · ${mmZ.toFixed(1)}mm`;
    } else if (plane === 'coronal') {
      sliceText = `Y ${this._iy + 1}/${ny} · ${mmY.toFixed(1)}mm`;
    } else {
      sliceText = `X ${this._ix + 1}/${nx} · ${mmX.toFixed(1)}mm`;
    }

    ctx.save();
    ctx.font = `500 10.5px ${FONT_MONO}`;
    const tw = ctx.measureText(sliceText).width;
    const pw = tw + 10;
    const ph = 17;
    const bx = 6;
    const by = cssH - ph - 5;

    drawRoundedRect(ctx, bx, by, pw, ph, 4);
    ctx.fillStyle = 'rgba(11, 15, 23, 0.78)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#cbd5e1';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(sliceText, bx + 5, by + ph * 0.5 + 0.5);

    // Bottom-right contextual badge: live W/L while adjusting, or RANO SPD on best axial slice
    let rightText = null;
    let rightAccent = 'rgba(148, 163, 184, 0.25)';
    let rightColor = '#cbd5e1';

    if (this._isDraggingWL && this._activeWLPlane === plane) {
      rightText = `W ${Math.round(this._windowWidth)} · L ${Math.round(this._windowLevel)}`;
      rightAccent = 'rgba(56, 189, 248, 0.55)';
      rightColor = '#38bdf8';
    } else if (
      plane === 'axial' &&
      this._showCalipers &&
      this._calipersMatchVolume() &&
      Math.round(this._ranoCalipers.bestSliceZ) === this._iz &&
      this._ranoCalipers.spdMm2 > 0
    ) {
      const tag = this._ranoCalipers.measurable ? 'SPD' : 'SPD (non-meas)';
      rightText = `${tag} ${Math.round(this._ranoCalipers.spdMm2)} mm²`;
      rightAccent = 'rgba(45, 212, 191, 0.5)';
      rightColor = '#2dd4bf';
    } else if (this._overlayMode === 'error' && this._errorMatchesVolume() && plane === 'axial') {
      rightText = `QA ${this._errorRegion} TP/FP/FN`;
      rightAccent = 'rgba(34, 197, 94, 0.45)';
      rightColor = '#86efac';
    }

    if (rightText && cssW > pw + 120) {
      const rtw = ctx.measureText(rightText).width;
      const rpw = rtw + 10;
      const rbx = cssW - rpw - 6;
      drawRoundedRect(ctx, rbx, by, rpw, ph, 4);
      ctx.fillStyle = 'rgba(11, 15, 23, 0.82)';
      ctx.fill();
      ctx.strokeStyle = rightAccent;
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = rightColor;
      ctx.fillText(rightText, rbx + 5, by + ph * 0.5 + 0.5);
    }

    ctx.restore();
  }

  _drawEmptyPlaceholder(ctx, cssW, cssH, label) {
    ctx.save();
    ctx.fillStyle = 'rgba(148, 163, 184, 0.45)';
    ctx.font = `500 11px ${FONT_MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${label} · No volume loaded`, cssW * 0.5, cssH * 0.5);
    ctx.restore();
  }

  // =========================================================================
  // 3D Sparse Geometry Precomputation (Brain Contour, MRI MIP, Tumor/Error)
  // =========================================================================

  _buildBrainCaches() {
    const vol = this._volume;
    if (!vol || !vol.dims || !vol.data) {
      this._brainSurface = null;
      this._brainMip = null;
      return;
    }

    const [nx, ny, nz] = vol.dims;
    const [dx, dy, dz] = this._getPixdim();
    const data = vol.data;
    const sliceStride = nx * ny;
    const cx = (nx - 1) * 0.5 * dx;
    const cy = (ny - 1) * 0.5 * dy;
    const cz = (nz - 1) * 0.5 * dz;

    const maxDim = Math.max(nx, ny, nz);
    const surfStride = maxDim <= 96 ? 1 : (maxDim <= 176 ? 2 : 3);
    const mipStride = maxDim <= 84 ? 1 : (maxDim <= 160 ? 2 : 3);

    // Threshold separating head/brain parenchyma from background air
    const span = Math.max(1e-3, (vol.max ?? this._p995) - (vol.min ?? 0));
    const brainThresh = (vol.min ?? 0) >= 0
      ? Math.max(this._p1 * 0.55, span * 0.045, 1e-4)
      : (this._p1 + (this._p995 - this._p1) * 0.08);

    const invDx = 1.0 / dx;
    const invDy = 1.0 / dy;
    const invDz = 1.0 / dz;

    // 1. Brain outer surface point cloud with smooth 3x3x3 binary occupancy normals
    const surfPos = [];
    const surfNorm = [];
    let maxR2 = 0;

    for (let z = 0; z < nz; z += surfStride) {
      const zOff = z * sliceStride;
      const pz = z * dz - cz;
      for (let y = 0; y < ny; y += surfStride) {
        const yOff = zOff + y * nx;
        const py = y * dy - cy;
        for (let x = 0; x < nx; x += surfStride) {
          const val = data[yOff + x];
          if (!(val >= brainThresh)) continue;

          // Check 6-connected strided neighbors for boundary
          const xm = x - surfStride;
          const xp = x + surfStride;
          const ym = y - surfStride;
          const yp = y + surfStride;
          const zm = z - surfStride;
          const zp = z + surfStride;

          const isBoundary =
            xm < 0 || data[yOff + xm] < brainThresh ||
            xp >= nx || data[yOff + xp] < brainThresh ||
            ym < 0 || data[zOff + ym * nx + x] < brainThresh ||
            yp >= ny || data[zOff + yp * nx + x] < brainThresh ||
            zm < 0 || data[zm * sliceStride + y * nx + x] < brainThresh ||
            zp >= nz || data[zp * sliceStride + y * nx + x] < brainThresh;

          if (!isBoundary) continue;

          const px = x * dx - cx;
          const r2 = px * px + py * py + pz * pz;
          if (r2 > maxR2) maxR2 = r2;

          // Smooth outward normal from 3x3x3 neighborhood occupancy
          let gx = 0;
          let gy = 0;
          let gz = 0;
          for (let oz = -1; oz <= 1; oz++) {
            const nzIdx = z + oz * surfStride;
            if (nzIdx < 0 || nzIdx >= nz) continue;
            const nzOff = nzIdx * sliceStride;
            for (let oy = -1; oy <= 1; oy++) {
              const nyIdx = y + oy * surfStride;
              if (nyIdx < 0 || nyIdx >= ny) continue;
              const nyOff = nzOff + nyIdx * nx;
              for (let ox = -1; ox <= 1; ox++) {
                if (ox === 0 && oy === 0 && oz === 0) continue;
                const nxIdx = x + ox * surfStride;
                if (nxIdx < 0 || nxIdx >= nx) continue;
                if (data[nyOff + nxIdx] >= brainThresh) {
                  gx -= ox * invDx;
                  gy -= oy * invDy;
                  gz -= oz * invDz;
                }
              }
            }
          }

          const gl = Math.hypot(gx, gy, gz);
          if (gl > 1e-6) {
            gx /= gl;
            gy /= gl;
            gz /= gl;
          } else {
            const rl = Math.sqrt(r2) || 1;
            gx = px / rl;
            gy = py / rl;
            gz = pz / rl;
          }

          surfPos.push(px, py, pz);
          surfNorm.push(gx, gy, gz);
        }
      }
    }

    this._brainSurface = {
      count: surfPos.length / 3,
      stride: surfStride,
      pos: new Float32Array(surfPos),
      norm: new Float32Array(surfNorm),
    };

    const diagHalf = 0.5 * Math.hypot(nx * dx, ny * dy, nz * dz);
    this._brainRadiusMm = maxR2 > 1 ? Math.sqrt(maxR2) : Math.max(10, diagHalf);

    // 2. Sparse MRI MIP voxel list (all voxels above air threshold)
    const mipPos = [];
    const mipVal = [];
    for (let z = 0; z < nz; z += mipStride) {
      const zOff = z * sliceStride;
      const pz = z * dz - cz;
      for (let y = 0; y < ny; y += mipStride) {
        const yOff = zOff + y * nx;
        const py = y * dy - cy;
        for (let x = 0; x < nx; x += mipStride) {
          const val = data[yOff + x];
          if (!(val >= brainThresh)) continue;
          mipPos.push(x * dx - cx, py, pz);
          mipVal.push(val);
        }
      }
    }

    this._brainMip = {
      count: mipVal.length,
      stride: mipStride,
      pos: new Float32Array(mipPos),
      val: new Float32Array(mipVal),
    };
  }

  /**
   * Extract 6-connected multi-subregion surface voxels with smooth 3x3x3 normals.
   * Preserves internal boundaries between adjacent labels (e.g. ET inside ED) so
   * toggling off any label reveals an intact solid interior 3D surface.
   */
  _buildSparseSurface(uint8Data, dims, pixdim) {
    const [nx, ny, nz] = dims;
    const [dx, dy, dz] = pixdim;
    const sliceStride = nx * ny;
    const cx = (nx - 1) * 0.5 * dx;
    const cy = (ny - 1) * 0.5 * dy;
    const cz = (nz - 1) * 0.5 * dz;
    const invDx = 1.0 / dx;
    const invDy = 1.0 / dy;
    const invDz = 1.0 / dz;

    const maxDim = Math.max(nx, ny, nz);
    const stride = maxDim <= 128 ? 1 : 2;

    const pos = [];
    const norm = [];
    const codes = [];
    let maxR2 = 0;

    for (let z = 0; z < nz; z += stride) {
      const zOff = z * sliceStride;
      const pz = z * dz - cz;
      for (let y = 0; y < ny; y += stride) {
        const yOff = zOff + y * nx;
        const py = y * dy - cy;
        for (let x = 0; x < nx; x += stride) {
          const code = uint8Data[yOff + x];
          if (code === 0) continue;

          const xm = x - stride;
          const xp = x + stride;
          const ym = y - stride;
          const yp = y + stride;
          const zm = z - stride;
          const zp = z + stride;

          const isBoundary =
            xm < 0 || uint8Data[yOff + xm] !== code ||
            xp >= nx || uint8Data[yOff + xp] !== code ||
            ym < 0 || uint8Data[zOff + ym * nx + x] !== code ||
            yp >= ny || uint8Data[zOff + yp * nx + x] !== code ||
            zm < 0 || uint8Data[zm * sliceStride + y * nx + x] !== code ||
            zp >= nz || uint8Data[zp * sliceStride + y * nx + x] !== code;

          if (!isBoundary) continue;

          const px = x * dx - cx;
          const r2 = px * px + py * py + pz * pz;
          if (r2 > maxR2) maxR2 = r2;

          // Smooth outward normal from 3x3x3 same-label neighborhood
          let gx = 0;
          let gy = 0;
          let gz = 0;
          for (let oz = -1; oz <= 1; oz++) {
            const nzIdx = z + oz * stride;
            if (nzIdx < 0 || nzIdx >= nz) continue;
            const nzOff = nzIdx * sliceStride;
            for (let oy = -1; oy <= 1; oy++) {
              const nyIdx = y + oy * stride;
              if (nyIdx < 0 || nyIdx >= ny) continue;
              const nyOff = nzOff + nyIdx * nx;
              for (let ox = -1; ox <= 1; ox++) {
                if (ox === 0 && oy === 0 && oz === 0) continue;
                const nxIdx = x + ox * stride;
                if (nxIdx < 0 || nxIdx >= nx) continue;
                if (uint8Data[nyOff + nxIdx] === code) {
                  gx -= ox * invDx;
                  gy -= oy * invDy;
                  gz -= oz * invDz;
                }
              }
            }
          }

          const gl = Math.hypot(gx, gy, gz);
          if (gl > 1e-6) {
            gx /= gl;
            gy /= gl;
            gz /= gl;
          } else {
            const rl = Math.sqrt(r2) || 1;
            gx = px / rl;
            gy = py / rl;
            gz = pz / rl;
          }

          pos.push(px, py, pz);
          norm.push(gx, gy, gz);
          codes.push(code);
        }
      }
    }

    return {
      count: codes.length,
      stride,
      maxRadiusMm: maxR2 > 0 ? Math.sqrt(maxR2) : 0,
      pos: new Float32Array(pos),
      norm: new Float32Array(norm),
      code: new Uint8Array(codes),
    };
  }

  _updateSceneRadius() {
    let r = this._volume ? (this._brainRadiusMm || 60) : 0;
    const maskValid = this._maskSurface && (!this._volume || this._maskMatchesVolume());
    const errorValid = this._errorSurface && (!this._volume || this._errorMatchesVolume());
    if (maskValid && this._maskSurface.maxRadiusMm > r) {
      r = this._maskSurface.maxRadiusMm;
    }
    if (errorValid && this._errorSurface.maxRadiusMm > r) {
      r = this._errorSurface.maxRadiusMm;
    }
    this._sceneRadiusMm = Math.max(10, r || 60);
  }

  // =========================================================================
  // 3D Volumetric Render / Multi-Angle MIP Engine (60fps Pure JS)
  // =========================================================================

  _ensureOffscreen3D(bufW, bufH) {
    const o = this._off3d;
    if (!o.canvas && typeof document !== 'undefined') {
      o.canvas = document.createElement('canvas');
      o.ctx = o.canvas.getContext('2d');
    }
    if (!o.canvas || !o.ctx) return null;

    if (o.w !== bufW || o.h !== bufH || !o.imgData) {
      const len = bufW * bufH;
      o.canvas.width = bufW;
      o.canvas.height = bufH;
      o.imgData = o.ctx.createImageData(bufW, bufH);
      o.zBuf = new Float32Array(len);
      o.colR = new Uint8Array(len);
      o.colG = new Uint8Array(len);
      o.colB = new Uint8Array(len);
      o.hasSolid = new Uint8Array(len);
      o.edZBuf = new Float32Array(len);
      o.edShade = new Float32Array(len);
      o.silFront = new Float32Array(len);
      o.silBack = new Float32Array(len);
      o.grayMip = new Float32Array(len);
      o.w = bufW;
      o.h = bufH;
    }
    return o;
  }

  _getCameraBasis() {
    const cy = Math.cos(this._yaw);
    const sy = Math.sin(this._yaw);
    const cp = Math.cos(this._pitch);
    const sp = Math.sin(this._pitch);

    // Orthonormal RAS+ camera frame:
    // At yaw=0, pitch=0: viewing from Anterior (+Y) toward Posterior (-Y),
    // Patient Right (+X) on Viewer Left, Superior (+Z) Up.
    // At yaw=-0.55, pitch=0.25: oblique Right-Anterior-Superior surgical view.
    return {
      rx: -cy,
      ry: -sy,
      rz: 0,
      ux: sp * sy,
      uy: -sp * cy,
      uz: cp,
      fx: -cp * sy,
      fy: cp * cy,
      fz: sp,
    };
  }

  _render3D() {
    const target = this._ensureCanvasReady('mip3d');
    if (!target) return;
    const { ctx, cssW, cssH } = target;

    // Subtle dark slate radial vignette backdrop for volumetric depth
    const grad = ctx.createRadialGradient(
      cssW * 0.5, cssH * 0.48, Math.min(cssW, cssH) * 0.08,
      cssW * 0.5, cssH * 0.5, Math.max(cssW, cssH) * 0.72
    );
    grad.addColorStop(0, '#111827');
    grad.addColorStop(1, BG_COLOR);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cssW, cssH);

    if (!this._volume && !this._maskSurface && !this._errorSurface) {
      this._drawEmptyPlaceholder(ctx, cssW, cssH, '3D VIEW');
      return;
    }

    // Adaptive internal rasterizer resolution (snappy while dragging, crisp on settle)
    const maxBuf = this._isDragging3D ? 196 : 300;
    const minSide = Math.max(64, Math.min(cssW, cssH));
    const bufScale = Math.min(1.0, maxBuf / Math.max(cssW, cssH));
    const bufW = Math.max(64, Math.round(cssW * bufScale));
    const bufH = Math.max(64, Math.round(cssH * bufScale));

    const off = this._ensureOffscreen3D(bufW, bufH);
    if (!off) return;

    const cam = this._getCameraBasis();
    const halfW = bufW * 0.5;
    const halfH = bufH * 0.5;
    const radiusMm = this._sceneRadiusMm;
    const pxPerMm = (0.42 * Math.min(bufW, bufH)) / radiusMm;
    const [dx, dy, dz] = this._getPixdim();
    const baseVoxMm = Math.max(dx, dy, dz);

    const len = bufW * bufH;
    const zBuf = off.zBuf;
    const colR = off.colR;
    const colG = off.colG;
    const colB = off.colB;
    const hasSolid = off.hasSolid;
    const edZBuf = off.edZBuf;
    const edShade = off.edShade;
    const silFront = off.silFront;
    const silBack = off.silBack;
    const grayMip = off.grayMip;

    zBuf.fill(-1e9);
    hasSolid.fill(0);
    edZBuf.fill(-1e9);
    edShade.fill(0);

    // Determine active overlay surface (BraTS mask vs TP/FP/FN error volume)
    const useError = this._overlayMode === 'error' && this._errorMatchesVolume() && this._errorSurface;
    const useMask = this._overlayMode === 'mask' && this._maskMatchesVolume() && this._maskSurface;
    const showOverlay = this._overlayMode !== 'none' && this._maskOpacity > 0 && (useError || useMask);
    const activeSurf = useError ? this._errorSurface : (useMask ? this._maskSurface : null);

    // Project depth-shaded 3D tumor or TP/FP/FN error surface into z-buffer
    if (showOverlay && activeSurf && activeSurf.count > 0) {
      this._splatOverlaySurface(
        activeSurf,
        Boolean(useError),
        cam,
        bufW,
        bufH,
        halfW,
        halfH,
        pxPerMm,
        baseVoxMm,
        radiusMm,
        zBuf,
        colR,
        colG,
        colB,
        hasSolid,
        edZBuf,
        edShade
      );
    }

    const rgba = off.imgData.data;

    if (this._mode3d === 'mip') {
      // --- Mode A: Multi-Angle Grayscale MRI MIP + Color Tumor/Error Overlay ---
      grayMip.fill(-1e9);

      if (this._brainMip && this._brainMip.count > 0) {
        const mip = this._brainMip;
        const pos = mip.pos;
        const vals = mip.val;
        const count = mip.count;
        const step = (this._isDragging3D && count > 24000) ? 2 : 1;
        const voxPx = mip.stride * baseVoxMm * pxPerMm;
        const rad = clamp(Math.ceil(voxPx * (step > 1 ? 0.85 : 0.62)), 1, 3);
        const { rx, ry, ux, uy, uz } = cam;

        for (let i = 0; i < count; i += step) {
          const i3 = i * 3;
          const px = pos[i3];
          const py = pos[i3 + 1];
          const pz = pos[i3 + 2];

          const sx = (halfW + (px * rx + py * ry) * pxPerMm + 0.5) | 0;
          const sy = (halfH - (px * ux + py * uy + pz * uz) * pxPerMm + 0.5) | 0;
          if (sx < -rad || sx >= bufW + rad || sy < -rad || sy >= bufH + rad) continue;

          const v = vals[i];
          const y0 = sy - rad < 0 ? 0 : sy - rad;
          const y1 = sy + rad >= bufH ? bufH - 1 : sy + rad;
          const x0 = sx - rad < 0 ? 0 : sx - rad;
          const x1 = sx + rad >= bufW ? bufW - 1 : sx + rad;

          for (let yy = y0; yy <= y1; yy++) {
            const row = yy * bufW;
            for (let xx = x0; xx <= x1; xx++) {
              const p = row + xx;
              if (v > grayMip[p]) grayMip[p] = v;
            }
          }
        }
      }

      const ww = Math.max(1e-3, this._windowWidth);
      const low = this._windowLevel - ww * 0.5;
      const invWW = 255.0 / ww;
      const solidAlpha = clamp(this._maskOpacity * 1.18, 0, 0.92);
      const edAlphaBase = clamp(this._maskOpacity * 0.56, 0, 0.55);
      const edRGB = LABEL_COLORS[2].rgb;

      for (let p = 0; p < len; p++) {
        const o = p * 4;
        const mv = grayMip[p];
        let baseR = 0;
        let baseG = 0;
        let baseB = 0;
        let baseA = 0;

        if (mv > -1e8) {
          let g = (mv - low) * invWW;
          g = g <= 0 ? 0 : g >= 255 ? 255 : g;
          // Subtle cool clinical tint on radiographic MIP
          baseR = g * 0.92;
          baseG = g * 0.96;
          baseB = Math.min(255, g * 1.03);
          baseA = clamp(g * 1.15, 25, 255);
        }

        let r = baseR;
        let g = baseG;
        let b = baseB;
        let a = baseA;

        if (hasSolid[p]) {
          const sa = solidAlpha;
          if (mv > -1e8) {
            const invSa = 1.0 - sa;
            r = r * invSa + colR[p] * sa;
            g = g * invSa + colG[p] * sa;
            b = b * invSa + colB[p] * sa;
            a = Math.max(a, 245);
          } else {
            r = colR[p];
            g = colG[p];
            b = colB[p];
            a = clamp(sa * 255, 0, 255);
          }
        }

        if (edShade[p] > 0) {
          const inFront = !hasSolid[p] || edZBuf[p] >= zBuf[p];
          const ea = inFront ? (hasSolid[p] ? edAlphaBase * 0.65 : edAlphaBase) : 0;
          if (ea > 0) {
            const sh = edShade[p];
            if (mv > -1e8 || hasSolid[p]) {
              const invEa = 1.0 - ea;
              r = r * invEa + edRGB[0] * sh * ea;
              g = g * invEa + edRGB[1] * sh * ea;
              b = b * invEa + edRGB[2] * sh * ea;
              a = Math.max(a, clamp(ea * 255 + 45, 0, 255));
            } else {
              r = edRGB[0] * sh;
              g = edRGB[1] * sh;
              b = edRGB[2] * sh;
              a = clamp(ea * 255, 0, 255);
            }
          }
        }

        rgba[o] = clamp((r + 0.5) | 0, 0, 255);
        rgba[o + 1] = clamp((g + 0.5) | 0, 0, 255);
        rgba[o + 2] = clamp((b + 0.5) | 0, 0, 255);
        rgba[o + 3] = clamp((a + 0.5) | 0, 0, 255);
      }
    } else {
      // --- Mode B: Translucent Glass Brain Contour Silhouette + Depth-Shaded 3D Tumor/Error ---
      silFront.fill(0);
      silBack.fill(0);

      if (this._brainSurface && this._brainSurface.count > 0) {
        const bs = this._brainSurface;
        const pos = bs.pos;
        const norm = bs.norm;
        const count = bs.count;
        const step = (this._isDragging3D && count > 14000) ? 2 : 1;
        const voxPx = bs.stride * baseVoxMm * pxPerMm;
        const rad = clamp(Math.ceil(voxPx * (step > 1 ? 0.75 : 0.58)), 1, 3);
        const { rx, ry, ux, uy, uz, fx, fy, fz } = cam;

        for (let i = 0; i < count; i += step) {
          const i3 = i * 3;
          const px = pos[i3];
          const py = pos[i3 + 1];
          const pz = pos[i3 + 2];

          const sx = (halfW + (px * rx + py * ry) * pxPerMm + 0.5) | 0;
          const sy = (halfH - (px * ux + py * uy + pz * uz) * pxPerMm + 0.5) | 0;
          if (sx < -rad || sx >= bufW + rad || sy < -rad || sy >= bufH + rad) continue;

          const depth = px * fx + py * fy + pz * fz;

          // View-space normal for Fresnel glass rim shading
          const nxv = norm[i3];
          const nyv = norm[i3 + 1];
          const nzv = norm[i3 + 2];
          const viewNz = nxv * fx + nyv * fy + nzv * fz;
          const fresnel = Math.pow(Math.max(0, 1.0 - Math.abs(viewNz)), 1.65);

          // Subtle upper-left specular glass sheen + depth attenuation
          const viewNx = nxv * rx + nyv * ry;
          const viewNy = -(nxv * ux + nyv * uy + nzv * uz);
          const sheen = Math.max(0, viewNx * -0.45 + viewNy * -0.55 + Math.abs(viewNz) * 0.65) * 0.22;
          const depthFactor = 0.72 + 0.28 * clamp((depth + radiusMm) / (2 * radiusMm), 0, 1);
          const rimVal = clamp((0.09 + fresnel * 0.62 + sheen) * depthFactor, 0, 0.72);

          const y0 = sy - rad < 0 ? 0 : sy - rad;
          const y1 = sy + rad >= bufH ? bufH - 1 : sy + rad;
          const x0 = sx - rad < 0 ? 0 : sx - rad;
          const x1 = sx + rad >= bufW ? bufW - 1 : sx + rad;
          const r2Lim = rad * rad + 0.5;

          for (let yy = y0; yy <= y1; yy++) {
            const dy2 = (yy - sy) * (yy - sy);
            const row = yy * bufW;
            for (let xx = x0; xx <= x1; xx++) {
              if ((xx - sx) * (xx - sx) + dy2 > r2Lim) continue;
              const p = row + xx;
              if (depth > zBuf[p]) {
                if (rimVal > silFront[p]) silFront[p] = rimVal;
              } else {
                if (rimVal > silBack[p]) silBack[p] = rimVal;
              }
            }
          }
        }
      }

      // Subtle 3x3 cross-filter smooth on silhouette buffers for silky glass cranium contour (settle frames)
      if (!this._isDragging3D && this._brainSurface && this._brainSurface.count > 0) {
        const smoothBuf = (buf) => {
          for (let y = 1; y < bufH - 1; y++) {
            const row = y * bufW;
            for (let x = 1; x < bufW - 1; x++) {
              const p = row + x;
              buf[p] = (buf[p] * 4 + buf[p - 1] + buf[p + 1] + buf[p - bufW] + buf[p + bufW]) * 0.125;
            }
          }
        };
        smoothBuf(silFront);
        smoothBuf(silBack);
      }

      const edRGB = LABEL_COLORS[2].rgb;
      const opFactor = clamp(0.45 + this._maskOpacity * 0.55, 0, 1);

      for (let p = 0; p < len; p++) {
        const o = p * 4;
        const sb = silBack[p];
        const sf = silFront[p];
        const solid = hasSolid[p] !== 0;
        const hasEd = edShade[p] > 0;

        if (!solid && !hasEd && sb <= 0 && sf <= 0) {
          rgba[o] = 0;
          rgba[o + 1] = 0;
          rgba[o + 2] = 0;
          rgba[o + 3] = 0;
          continue;
        }

        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;

        // 1. Back translucent glass brain shell behind tumor
        if (sb > 0) {
          const ba = sb * 0.58;
          r = 148 * ba;
          g = 186 * ba;
          b = 224 * ba;
          a = ba;
        }

        // 2. Solid depth-shaded core tumor / error surface (ET, NCR, RC, or TP/FP/FN)
        if (solid) {
          const sa = clamp(0.75 + this._maskOpacity * 0.25, 0, 1);
          const invSa = 1.0 - sa;
          r = r * invSa + colR[p] * sa;
          g = g * invSa + colG[p] * sa;
          b = b * invSa + colB[p] * sa;
          a = sa + a * invSa;
        }

        // 3. Translucent glowing amber Peritumoral Edema envelope around inner core
        if (hasEd) {
          const inFront = !solid || edZBuf[p] >= zBuf[p];
          if (inFront) {
            const sh = edShade[p];
            const ea = (solid ? 0.36 : 0.62) * opFactor;
            const invEa = 1.0 - ea;
            r = r * invEa + edRGB[0] * sh * ea;
            g = g * invEa + edRGB[1] * sh * ea;
            b = b * invEa + edRGB[2] * sh * ea;
            a = ea + a * invEa;
          }
        }

        // 4. Subtle front cranial glass silhouette over tumor so 3D anatomical containment reads immediately
        if (sf > 0) {
          const fa = solid ? sf * 0.30 : sf * 0.68;
          const invFa = 1.0 - fa;
          r = r * invFa + 168 * fa;
          g = g * invFa + 206 * fa;
          b = b * invFa + 240 * fa;
          a = fa + a * invFa;
        }

        // Convert premultiplied composite back to straight RGBA for Canvas ImageData
        if (a > 1e-4) {
          const invA = 1.0 / a;
          rgba[o] = clamp((r * invA + 0.5) | 0, 0, 255);
          rgba[o + 1] = clamp((g * invA + 0.5) | 0, 0, 255);
          rgba[o + 2] = clamp((b * invA + 0.5) | 0, 0, 255);
          rgba[o + 3] = clamp((a * 255 + 0.5) | 0, 0, 255);
        } else {
          rgba[o + 3] = 0;
        }
      }
    }

    off.ctx.putImageData(off.imgData, 0, 0);

    // Upscale smoothly onto HiDPI 3D canvas
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(off.canvas, 0, 0, bufW, bufH, 0, 0, cssW, cssH);
    ctx.restore();

    // Draw crisp HiDPI 3D orientation triad & compact HUD
    this._draw3DOrientationTriad(ctx, cam, cssW, cssH, minSide);
    this._draw3DHud(ctx, cssW, cssH, Boolean(useError));
  }

  _splatOverlaySurface(
    surf,
    isError,
    cam,
    bufW,
    bufH,
    halfW,
    halfH,
    pxPerMm,
    baseVoxMm,
    radiusMm,
    zBuf,
    colR,
    colG,
    colB,
    hasSolid,
    edZBuf,
    edShade
  ) {
    const pos = surf.pos;
    const norm = surf.norm;
    const codes = surf.code;
    const count = surf.count;
    const vis = this._labelVisibility;
    const lut = isError ? ERROR_RGB_LUT : LABEL_RGB_LUT;

    const voxPx = surf.stride * baseVoxMm * pxPerMm;
    const rad = clamp(Math.ceil(voxPx * 0.68), 1, 4);
    const r2Lim = rad * rad + 0.55;
    const { rx, ry, ux, uy, uz, fx, fy, fz } = cam;

    // Two-point studio lighting directions in camera space (key upper-left-front, fill right-front)
    const l1x = -0.42; const l1y = -0.52; const l1z = 0.743;
    const l2x = 0.65;  const l2y = 0.30;  const l2z = 0.698;
    // Blinn-Phong half-vector for key light + viewer (0, 0, 1)
    const hx = -0.226; const hy = -0.280; const hz = 0.933;

    const step = (this._isDragging3D && count > 28000) ? 2 : 1;

    for (let i = 0; i < count; i += step) {
      const code = codes[i];
      if (!isError && !vis[code]) continue;
      const rgb = lut[code];
      if (!rgb) continue;

      const i3 = i * 3;
      const px = pos[i3];
      const py = pos[i3 + 1];
      const pz = pos[i3 + 2];

      const sx = (halfW + (px * rx + py * ry) * pxPerMm + 0.5) | 0;
      const sy = (halfH - (px * ux + py * uy + pz * uz) * pxPerMm + 0.5) | 0;
      if (sx < -rad || sx >= bufW + rad || sy < -rad || sy >= bufH + rad) continue;

      const depth = px * fx + py * fy + pz * fz;

      // Rotate surface normal into camera space
      const nxw = norm[i3];
      const nyw = norm[i3 + 1];
      const nzw = norm[i3 + 2];
      let vnx = nxw * rx + nyw * ry;
      let vny = -(nxw * ux + nyw * uy + nzw * uz);
      let vnz = nxw * fx + nyw * fy + nzw * fz;

      // Two-sided flip so thin single-voxel enhancing rings never go dark on inner walls
      if (vnz < 0) {
        vnx = -vnx;
        vny = -vny;
        vnz = -vnz;
      }

      const diff1 = Math.max(0, vnx * l1x + vny * l1y + vnz * l1z);
      const diff2 = Math.max(0, vnx * l2x + vny * l2y + vnz * l2z);
      const depthCue = 0.78 + 0.26 * clamp((depth + radiusMm) / (2 * radiusMm), 0, 1);

      const y0 = sy - rad < 0 ? 0 : sy - rad;
      const y1 = sy + rad >= bufH ? bufH - 1 : sy + rad;
      const x0 = sx - rad < 0 ? 0 : sx - rad;
      const x1 = sx + rad >= bufW ? bufW - 1 : sx + rad;

      // In mask mode, render Edema (label 2) into the translucent halo buffer so core ET/NCR shines inside
      if (!isError && code === 2) {
        const fresnel = Math.pow(Math.max(0, 1.0 - vnz), 1.35);
        const shade = clamp((0.55 + diff1 * 0.42 + fresnel * 0.35) * depthCue, 0.35, 1.35);

        for (let yy = y0; yy <= y1; yy++) {
          const dy2 = (yy - sy) * (yy - sy);
          const row = yy * bufW;
          for (let xx = x0; xx <= x1; xx++) {
            if ((xx - sx) * (xx - sx) + dy2 > r2Lim) continue;
            const p = row + xx;
            if (depth > edZBuf[p]) {
              edZBuf[p] = depth;
              edShade[p] = shade;
            }
          }
        }
        continue;
      }

      // Solid Phong depth-buffered shading for ET (3), NCR (1), RC (5), and Error TP/FP/FN
      const ndoth = Math.max(0, vnx * hx + vny * hy + vnz * hz);
      const spec = Math.pow(ndoth, 18) * (isError && code !== 1 ? 0.38 : 0.28);
      const lit = (0.30 + diff1 * 0.68 + diff2 * 0.22) * depthCue;
      const specAdd = spec * 255;

      const sr = clamp((rgb[0] * lit + specAdd + 0.5) | 0, 0, 255);
      const sg = clamp((rgb[1] * lit + specAdd + 0.5) | 0, 0, 255);
      const sb = clamp((rgb[2] * lit + specAdd + 0.5) | 0, 0, 255);

      for (let yy = y0; yy <= y1; yy++) {
        const dy2 = (yy - sy) * (yy - sy);
        const row = yy * bufW;
        for (let xx = x0; xx <= x1; xx++) {
          if ((xx - sx) * (xx - sx) + dy2 > r2Lim) continue;
          const p = row + xx;
          if (depth > zBuf[p]) {
            zBuf[p] = depth;
            colR[p] = sr;
            colG[p] = sg;
            colB[p] = sb;
            hasSolid[p] = 1;
          }
        }
      }
    }
  }

  _draw3DOrientationTriad(ctx, cam, cssW, cssH, minSide) {
    if (minSide < 110) return;

    const arm = minSide < 190 ? 15 : 20;
    const cx = cssW - arm - 18;
    const cy = cssH - arm - 18;

    // Canonical RAS+ axes projected through camera basis
    const axes = [
      { label: 'R', color: '#f43f5e', sx: cam.rx, sy: -cam.ux, depth: cam.fx },
      { label: 'A', color: '#22c55e', sx: cam.ry, sy: -cam.uy, depth: cam.fy },
      { label: 'S', color: '#38bdf8', sx: cam.rz, sy: -cam.uz, depth: cam.fz },
    ];
    axes.sort((a, b) => a.depth - b.depth);

    ctx.save();
    // Subtle circular compass backing
    ctx.beginPath();
    ctx.arc(cx, cy, arm + 10, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(11, 15, 23, 0.58)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = `700 9.5px ${FONT_MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const a of axes) {
      const ex = cx + a.sx * arm;
      const ey = cy + a.sy * arm;

      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.depth >= 0 ? 1.8 : 1.1;
      ctx.globalAlpha = a.depth >= 0 ? 0.95 : 0.45;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ex, ey);
      ctx.stroke();

      ctx.fillStyle = a.color;
      ctx.beginPath();
      ctx.arc(ex, ey, 2.1, 0, Math.PI * 2);
      ctx.fill();

      const lx = cx + a.sx * (arm + 7);
      const ly = cy + a.sy * (arm + 7);
      ctx.globalAlpha = a.depth >= 0 ? 1.0 : 0.55;
      ctx.fillText(a.label, lx, ly);
    }

    ctx.restore();
  }

  _draw3DHud(ctx, cssW, cssH, isErrorMode) {
    const modeLabel = this._mode3d === 'mip' ? '3D MIP' : '3D SURFACE';
    const fullText = isErrorMode
      ? `${modeLabel} · QA ${this._errorRegion} (TP/FP/FN)`
      : `${modeLabel} · Drag to orbit · Dbl-click reset`;
    const medText = isErrorMode
      ? `${modeLabel} · QA ${this._errorRegion}`
      : `${modeLabel} · Drag to orbit`;

    ctx.save();
    ctx.font = `500 10px ${FONT_MONO}`;
    const maxW = Math.max(80, cssW - 76);
    let label = fullText;
    if (ctx.measureText(label).width + 12 > maxW) {
      label = medText;
    }
    if (ctx.measureText(label).width + 12 > maxW) {
      label = modeLabel;
    }

    const tw = ctx.measureText(label).width;
    const pw = tw + 10;
    const ph = 17;
    const bx = 6;
    const by = cssH - ph - 5;

    drawRoundedRect(ctx, bx, by, pw, ph, 4);
    ctx.fillStyle = 'rgba(11, 15, 23, 0.78)';
    ctx.fill();
    ctx.strokeStyle = isErrorMode ? 'rgba(34, 197, 94, 0.4)' : 'rgba(148, 163, 184, 0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = isErrorMode ? '#86efac' : '#cbd5e1';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + 5, by + ph * 0.5 + 0.5);
    ctx.restore();
  }
}
