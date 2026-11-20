/**
 * @fileoverview Core neuro-oncology quantitative metrics engine for NeuroScope-RANO.
 * Zero external dependencies; pure ES Module implementing:
 *  - BraTS 2023/2024 + post-op canonical label normalization (legacy label 4 -> 3 ET)
 *  - 3D per-label and composite-region volumetrics, centroids, bounding boxes, and
 *    equivalent spherical diameters
 *  - Automated axial 2D RANO maximal cross-sectional perpendicular diameters (d1, d2, SPD)
 *    with physical-space caliper endpoints
 *  - RANO-Resect Extent of Resection (EOR) and 6-tier surgical resection classification
 *    (Karschnia et al., Neuro-Oncology 2023)
 *  - RANO 2.0 longitudinal neuro-oncology response assessment including baseline/nadir
 *    tracking, steroid gating, and <=12-week post-RT pseudoprogression confirmation guard
 *    (Wen et al., JCO 2023)
 *  - AI segmentation quality assurance (Dice, IoU, Sensitivity, Precision, RVE%,
 *    exact anisotropic 3D Felzenszwalb-Huttenlocher EDT HD95 & ASSD, and 3D TP/FP/FN
 *    error overlay generation)
 *
 * Voxel indexing convention (NIfTI Fortran / column-major order):
 *   idx = x + y * nx + z * nx * ny
 *   where 0 <= x < nx, 0 <= y < ny, 0 <= z < nz.
 */

/** Floating-point epsilon used for zero-volume and tie comparisons. */
const EPS = 1e-6;

/**
 * Canonical BraTS 2023/2024 + Post-Op segmentation label metadata.
 * @type {Readonly<Record<1 | 2 | 3 | 5, { code: string, name: string, color: string, rgb: readonly [number, number, number] }>>}
 */
export const LABEL_META = Object.freeze({
  1: Object.freeze({
    code: 'NCR',
    name: 'Necrotic / Non-Enhancing Tumor Core',
    color: '#f43f5e',
    rgb: Object.freeze([244, 63, 94]),
  }),
  2: Object.freeze({
    code: 'ED',
    name: 'Peritumoral Edema / Infiltrated FLAIR',
    color: '#f59e0b',
    rgb: Object.freeze([245, 158, 11]),
  }),
  3: Object.freeze({
    code: 'ET',
    name: 'Enhancing Tumor',
    color: '#38bdf8',
    rgb: Object.freeze([56, 189, 248]),
  }),
  5: Object.freeze({
    code: 'RC',
    name: 'Surgical Resection Cavity',
    color: '#a855f7',
    rgb: Object.freeze([168, 85, 247]),
  }),
});

/**
 * 3D AI Segmentation QA error overlay metadata (`0 = TN` is transparent).
 * @type {Readonly<Record<1 | 2 | 3, { code: string, name: string, color: string, rgb: readonly [number, number, number] }>>}
 */
export const ERROR_META = Object.freeze({
  1: Object.freeze({
    code: 'TP',
    name: 'True Positive',
    color: '#22c55e',
    rgb: Object.freeze([34, 197, 94]),
  }),
  2: Object.freeze({
    code: 'FP',
    name: 'False Positive',
    color: '#f43f5e',
    rgb: Object.freeze([244, 63, 94]),
  }),
  3: Object.freeze({
    code: 'FN',
    name: 'False Negative',
    color: '#38bdf8',
    rgb: Object.freeze([56, 189, 248]),
  }),
});

/**
 * Reference definitions for the 6-tier RANO-Resect classification
 * (Karschnia et al., Neuro-Oncology 2023).
 */
export const RANO_RESECT_CLASSES = Object.freeze({
  'Class 1': Object.freeze({
    ranoClass: 'Class 1',
    name: 'Supramaximal CE Resection',
    description: '0 cm³ residual CE tumor AND ≤5.0 cm³ residual non-CE tumor.',
  }),
  'Class 2A': Object.freeze({
    ranoClass: 'Class 2A',
    name: 'Complete CE Resection',
    description: '0 cm³ residual CE tumor with >5.0 cm³ residual non-CE tumor.',
  }),
  'Class 2B': Object.freeze({
    ranoClass: 'Class 2B',
    name: 'Near-Total CE Resection',
    description: '>0 to ≤1.0 cm³ residual CE tumor (requires pre-op CE tumor and ≥10% CE reduction).',
  }),
  'Class 3A': Object.freeze({
    ranoClass: 'Class 3A',
    name: 'Subtotal CE Resection',
    description: '>1.0 to ≤5.0 cm³ residual CE tumor (requires pre-op CE tumor and ≥10% CE reduction).',
  }),
  'Class 3B': Object.freeze({
    ranoClass: 'Class 3B',
    name: 'Partial CE Resection',
    description: '>5.0 cm³ residual CE tumor (with ≥10% CE reduction).',
  }),
  'Class 4': Object.freeze({
    ranoClass: 'Class 4',
    name: 'Biopsy',
    description: '<10% reduction of CE tumor volume; biopsy / diagnostic sampling.',
  }),
});

/**
 * @typedef {Object} BoundingBox3D
 * @property {number} minX
 * @property {number} maxX
 * @property {number} minY
 * @property {number} maxY
 * @property {number} minZ
 * @property {number} maxZ
 */

/**
 * @typedef {Object} RegionMetrics
 * @property {number} voxelCount - Number of voxels in the label or composite region.
 * @property {number} volumeMm3 - Physical volume in mm³.
 * @property {number} volumeCm3 - Physical volume in cm³ (mL).
 * @property {[number, number, number] | null} centroid - Mean voxel coordinates [cx, cy, cz], or null if empty.
 * @property {BoundingBox3D | null} bbox - Axis-aligned voxel bounding box, or null if empty.
 * @property {number} eqSphereDiamMm - Equivalent spherical diameter in mm (0 if empty).
 */

/**
 * @typedef {Object} LineSegment2D
 * @property {number} x1
 * @property {number} y1
 * @property {number} x2
 * @property {number} y2
 */

/**
 * @typedef {Object} Point2D
 * @property {number} x
 * @property {number} y
 */

/**
 * @typedef {Object} Rano2DResult
 * @property {string} region - Target region measured (default 'ET').
 * @property {number} d1Mm - Maximal axial cross-sectional diameter in mm.
 * @property {number} d2Mm - Maximal perpendicular axial diameter in mm.
 * @property {number} spdMm2 - Sum/product of perpendicular diameters (d1Mm * d2Mm) in mm².
 * @property {number | null} bestSliceZ - Axial slice index z maximizing SPD, or null if empty.
 * @property {boolean} measurable - True per RANO 2.0 iff d1Mm >= 10 mm AND d2Mm >= 10 mm.
 * @property {LineSegment2D | null} majorLine - Major axis caliper endpoints in voxel coordinates.
 * @property {LineSegment2D | null} minorLine - Orthogonal minor axis caliper endpoints in voxel coordinates.
 * @property {Point2D | null} p1 - First major-axis endpoint `{ x, y }` in voxel coordinates.
 * @property {Point2D | null} p2 - Second major-axis endpoint `{ x, y }` in voxel coordinates.
 * @property {Point2D | null} q1 - First minor-axis endpoint `{ x, y }` in voxel coordinates.
 * @property {Point2D | null} q2 - Second minor-axis endpoint `{ x, y }` in voxel coordinates.
 * @property {number} sliceAreaMm2 - Total area of `region` on `bestSliceZ` in mm².
 * @property {number} componentCountOnSlice - Number of 8-connected components of `region` on `bestSliceZ`.
 */

/**
 * @typedef {Object} VolumetricsResult
 * @property {[number, number, number]} dims
 * @property {[number, number, number]} pixdim
 * @property {number} voxelVolumeMm3
 * @property {{ 1: RegionMetrics, 2: RegionMetrics, 3: RegionMetrics, 5: RegionMetrics }} labels
 * @property {{ WT: RegionMetrics, TC: RegionMetrics, ET: RegionMetrics, RC: RegionMetrics, nonCE: RegionMetrics }} regions
 * @property {Rano2DResult} rano2d
 * @property {Rano2DResult | null} rano2dNonEnhancing - Optional WT 2D measurement populated when ET is absent and WT > 0.
 */

/**
 * @typedef {Object} EorResult
 * @property {number} preCeCm3
 * @property {number} preNonCeCm3
 * @property {number} preWtCm3
 * @property {number} residualCeCm3
 * @property {number} residualNonCeCm3
 * @property {number} residualWtCm3
 * @property {number} cavityCm3
 * @property {number} ceEorPct
 * @property {number} nonCeEorPct
 * @property {boolean} hasPreOpCe
 * @property {boolean} ranoResectApplicable
 * @property {'Class 1' | 'Class 2A' | 'Class 2B' | 'Class 3A' | 'Class 3B' | 'Class 4' | 'N/A'} ranoClass
 * @property {string} ranoClassName
 * @property {string} ranoClassDescription
 * @property {string[]} rationale
 */

/**
 * @typedef {Object} Rano2Timepoint
 * @property {string} [id]
 * @property {string} label
 * @property {string} [date]
 * @property {number} spdMm2
 * @property {number} volumeCm3
 * @property {'none_or_physiologic' | 'stable_or_decreased' | 'increased'} [steroids='stable_or_decreased']
 * @property {'stable_or_improved' | 'deteriorated'} [clinicalStatus='stable_or_improved']
 * @property {boolean} [newMeasurableLesion=false]
 * @property {boolean} [within12WeeksPostRT=false]
 */

/**
 * @typedef {Object} Rano2Result
 * @property {'CR' | 'PR' | 'MR' | 'SD' | 'PD' | 'Preliminary PD (Confirm >=4 wks)' | 'Baseline Only'} category
 * @property {'CR' | 'PR' | 'MR' | 'SD' | 'PD' | 'PRELIM_PD' | 'BASELINE'} shortCode
 * @property {'favorable' | 'neutral' | 'warning' | 'progression'} severity
 * @property {{ label: string, spdMm2: number, volumeCm3: number }} baseline
 * @property {{ spdMm2: number, volumeCm3: number, spdLabel: string, volumeLabel: string }} nadir
 * @property {{ label: string, spdMm2: number, volumeCm3: number, steroids: string, clinicalStatus: string, newMeasurableLesion: boolean, within12WeeksPostRT: boolean }} current
 * @property {number | null} spdChangeVsBaselinePct
 * @property {number | null} spdChangeVsNadirPct
 * @property {number | null} volChangeVsBaselinePct
 * @property {number | null} volChangeVsNadirPct
 * @property {{ spdProgression: boolean, volProgression: boolean, newLesion: boolean, clinicalDeterioration: boolean, steroidBlockedResponse: boolean, confirmationRequired: boolean }} criteriaTriggered
 * @property {string[]} rationale
 */

/**
 * @typedef {Object} RegionEvalMetrics
 * @property {number} tp
 * @property {number} fp
 * @property {number} fn
 * @property {number} gtCm3
 * @property {number} predCm3
 * @property {number} dice
 * @property {number} iou
 * @property {number | null} hd95Mm
 * @property {number | null} assdMm
 * @property {number} sensitivity
 * @property {number} precision
 * @property {number | null} rvePct
 * @property {boolean} bothEmpty
 */

/**
 * @typedef {Object} SegmentationEvalResult
 * @property {{ ET: RegionEvalMetrics, TC: RegionEvalMetrics, WT: RegionEvalMetrics, RC: RegionEvalMetrics }} regions
 * @property {{ meanDiceActive: number, meanHd95Mm: number | null }} summary
 * @property {'ET' | 'TC' | 'WT' | 'RC'} errorRegion
 * @property {Uint8Array} errorVolume - Flat array of length nx*ny*nz (0=TN, 1=TP, 2=FP, 3=FN).
 */

/**
 * Normalize a raw segmentation mask voxel value into the canonical BraTS 2023/2024 + Post-Op
 * label set (`0`, `1`, `2`, `3`, `5`). Automatically maps legacy BraTS Enhancing Tumor
 * label `4` to canonical label `3`.
 *
 * @param {number} v - Raw mask voxel value.
 * @returns {0 | 1 | 2 | 3 | 5} Canonical integer label.
 */
export function normalizeLabel(v) {
  if (!Number.isFinite(v)) return 0;
  const r = Math.round(v);
  if (r === 4) return 3;
  if (r === 1 || r === 2 || r === 3 || r === 5) return r;
  return 0;
}

/**
 * Test whether a normalized canonical label belongs to a named BraTS/RANO region.
 *
 * @param {number} normLabel - Canonical label returned by `normalizeLabel()`.
 * @param {string} region - Region code: `'ET'`, `'TC'`, `'WT'`, `'RC'`, `'nonCE'` (or aliases `'CE'`, `'NCR'`, `'ED'`).
 * @returns {boolean} True if `normLabel` is a member of `region`.
 */
export function isInRegion(normLabel, region) {
  switch (region) {
    case 'ET':
    case 'CE':
      return normLabel === 3;
    case 'TC':
      return normLabel === 1 || normLabel === 3;
    case 'WT':
      return normLabel === 1 || normLabel === 2 || normLabel === 3;
    case 'RC':
      return normLabel === 5;
    case 'nonCE':
      return normLabel === 1 || normLabel === 2;
    case 'NCR':
      return normLabel === 1;
    case 'ED':
      return normLabel === 2;
    default:
      return false;
  }
}

/**
 * Validate volume geometry metadata and extract sanitized `[nx, ny, nz]`, `[dx, dy, dz]`,
 * and `voxelVolumeMm3`.
 *
 * @param {Object} vol
 * @param {string} name
 * @returns {{ nx: number, ny: number, nz: number, dx: number, dy: number, dz: number, voxelVolumeMm3: number, data: ArrayLike<number> }}
 */
function extractVolumeSpec(vol, name = 'volume') {
  if (!vol || !Array.isArray(vol.dims) || vol.dims.length < 3 || !vol.data) {
    throw new TypeError(`Invalid ${name}: expected an object with dims [nx, ny, nz] and data array.`);
  }
  const nx = vol.dims[0] | 0;
  const ny = vol.dims[1] | 0;
  const nz = vol.dims[2] | 0;
  if (nx <= 0 || ny <= 0 || nz <= 0) {
    throw new RangeError(`Invalid ${name} dims: [${nx}, ${ny}, ${nz}].`);
  }
  const total = nx * ny * nz;
  if (vol.data.length < total) {
    throw new RangeError(
      `Invalid ${name} data length: expected at least ${total} voxels for [${nx}×${ny}×${nz}], got ${vol.data.length}.`
    );
  }
  const rawPix = Array.isArray(vol.pixdim) && vol.pixdim.length >= 3 ? vol.pixdim : [1.0, 1.0, 1.0];
  const dx = Number.isFinite(rawPix[0]) && rawPix[0] !== 0 ? Math.abs(rawPix[0]) : 1.0;
  const dy = Number.isFinite(rawPix[1]) && rawPix[1] !== 0 ? Math.abs(rawPix[1]) : 1.0;
  const dz = Number.isFinite(rawPix[2]) && rawPix[2] !== 0 ? Math.abs(rawPix[2]) : 1.0;
  const voxelVolumeMm3 =
    Number.isFinite(vol.voxelVolumeMm3) && vol.voxelVolumeMm3 > 0
      ? vol.voxelVolumeMm3
      : dx * dy * dz;

  return { nx, ny, nz, dx, dy, dz, voxelVolumeMm3, data: vol.data };
}

/**
 * Clamp a numeric value to `[lo, hi]`.
 * @param {number} value
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * Create a mutable voxel accumulator for single-pass volumetric statistics.
 */
function createRegionAccumulator() {
  return {
    count: 0,
    sumX: 0,
    sumY: 0,
    sumZ: 0,
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };
}

/**
 * Merge multiple disjoint label accumulators into a composite accumulator.
 * @param {...ReturnType<typeof createRegionAccumulator>} accs
 */
function mergeAccumulators(...accs) {
  const out = createRegionAccumulator();
  for (let i = 0; i < accs.length; i++) {
    const a = accs[i];
    if (a.count === 0) continue;
    out.count += a.count;
    out.sumX += a.sumX;
    out.sumY += a.sumY;
    out.sumZ += a.sumZ;
    if (a.minX < out.minX) out.minX = a.minX;
    if (a.maxX > out.maxX) out.maxX = a.maxX;
    if (a.minY < out.minY) out.minY = a.minY;
    if (a.maxY > out.maxY) out.maxY = a.maxY;
    if (a.minZ < out.minZ) out.minZ = a.minZ;
    if (a.maxZ > out.maxZ) out.maxZ = a.maxZ;
  }
  return out;
}

/**
 * Finalize a region accumulator into a `RegionMetrics` summary object.
 * @param {ReturnType<typeof createRegionAccumulator>} acc
 * @param {number} voxelVolumeMm3
 * @returns {RegionMetrics}
 */
function finalizeRegionMetrics(acc, voxelVolumeMm3) {
  if (acc.count === 0) {
    return {
      voxelCount: 0,
      volumeMm3: 0,
      volumeCm3: 0,
      centroid: null,
      bbox: null,
      eqSphereDiamMm: 0,
    };
  }
  const volumeMm3 = acc.count * voxelVolumeMm3;
  const volumeCm3 = volumeMm3 / 1000.0;
  const eqSphereDiamMm = 2.0 * Math.cbrt((3.0 * volumeMm3) / (4.0 * Math.PI));
  return {
    voxelCount: acc.count,
    volumeMm3,
    volumeCm3,
    centroid: [acc.sumX / acc.count, acc.sumY / acc.count, acc.sumZ / acc.count],
    bbox: {
      minX: acc.minX,
      maxX: acc.maxX,
      minY: acc.minY,
      maxY: acc.maxY,
      minZ: acc.minZ,
      maxZ: acc.maxZ,
    },
    eqSphereDiamMm,
  };
}

/**
 * Compute exact 2D convex hull vertices (in counter-clockwise order) of a unique integer
 * grid point set using Andrew's monotone chain algorithm. Because positive voxel scaling
 * `(dx, dy)` preserves orientation and convexity, integer cross products yield the exact
 * physical-space extreme vertices with zero floating-point degeneracy.
 *
 * @param {Int32Array} xs
 * @param {Int32Array} ys
 * @param {number} count
 * @returns {Int32Array} Indices into `xs`/`ys` forming the convex hull vertices.
 */
function computeConvexHullIndices(xs, ys, count) {
  const order = new Int32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  order.sort((a, b) => (xs[a] - xs[b]) || (ys[a] - ys[b]));

  const lower = new Int32Array(count);
  let lLen = 0;
  for (let i = 0; i < count; i++) {
    const idx = order[i];
    const px = xs[idx];
    const py = ys[idx];
    while (lLen >= 2) {
      const a = lower[lLen - 2];
      const b = lower[lLen - 1];
      const cross = (xs[b] - xs[a]) * (py - ys[a]) - (ys[b] - ys[a]) * (px - xs[a]);
      if (cross <= 0) {
        lLen--;
      } else {
        break;
      }
    }
    lower[lLen++] = idx;
  }

  const upper = new Int32Array(count);
  let uLen = 0;
  for (let i = count - 1; i >= 0; i--) {
    const idx = order[i];
    const px = xs[idx];
    const py = ys[idx];
    while (uLen >= 2) {
      const a = upper[uLen - 2];
      const b = upper[uLen - 1];
      const cross = (xs[b] - xs[a]) * (py - ys[a]) - (ys[b] - ys[a]) * (px - xs[a]);
      if (cross <= 0) {
        uLen--;
      } else {
        break;
      }
    }
    upper[uLen++] = idx;
  }

  const hullLen = Math.max(0, lLen - 1) + Math.max(0, uLen - 1);
  if (hullLen === 0) {
    return new Int32Array([order[0]]);
  }
  const hull = new Int32Array(hullLen);
  let h = 0;
  for (let i = 0; i < lLen - 1; i++) hull[h++] = lower[i];
  for (let i = 0; i < uLen - 1; i++) hull[h++] = upper[i];
  return hull;
}

/**
 * Compute automated axial 2D RANO maximal cross-sectional perpendicular diameters (`d1`, `d2`,
 * and bidimensional product `SPD = d1 * d2`) across all axial slices of a mask volume.
 *
 * Algorithm:
 * 1. For each axial slice `z`, partitions voxels in `region` into 8-connected 2D components
 *    (avoiding empty-parenchyma spanning across multifocal lesions).
 * 2. Extracts 4-connected boundary pixels of each component and computes exact farthest
 *    physical boundary pair `(p1, p2)` via 2D convex hull reduction.
 * 3. Projects all component boundary points onto the unit major axis `u` and orthogonal axis `v`,
 *    binning along `u` at width `max(dx, dy)` (with 0 and half-bin phase offsets) to determine
 *    the maximal local perpendicular cross-section `d2` without concavity inflation.
 * 4. Includes half-voxel physical extent on both ends (`hypot(ux*dx, uy*dy)` and
 *    `hypot(vx*dx, vy*dy)`) and projects minor caliper endpoints onto the exact perpendicular
 *    line at `tMid` for orthogonal visual rendering.
 * 5. Selects the slice & component maximizing `spdMm2` (tie-breaking by `d1Mm`, then pixel count).
 *
 * @param {import('./niftiParser.js').NiftiVolume} maskVol - Parsed segmentation mask volume.
 * @param {'ET' | 'WT' | 'TC' | 'RC' | 'nonCE'} [region='ET'] - Target region to measure.
 * @returns {Rano2DResult} Maximal axial 2D bidimensional measurement and caliper geometry.
 */
export function computeAxial2DDiameters(maskVol, region = 'ET') {
  const { nx, ny, nz, dx, dy, data } = extractVolumeSpec(maskVol, 'maskVol');
  const sliceSize = nx * ny;
  const pixelAreaMm2 = dx * dy;
  const binW = Math.max(dx, dy);

  // Reusable per-slice typed work buffers to eliminate GC pressure across slices
  const sliceMask = new Uint8Array(sliceSize);
  const visited = new Uint8Array(sliceSize);
  const bfsQueue = new Int32Array(sliceSize);
  const compX = new Int32Array(sliceSize);
  const compY = new Int32Array(sliceSize);
  const boundX = new Int32Array(sliceSize);
  const boundY = new Int32Array(sliceSize);
  const projT = new Float64Array(sliceSize);
  const projS = new Float64Array(sliceSize);

  // Dynamic bin scratch buffers (sized on demand)
  let binCap = 256;
  let binHas = new Uint8Array(binCap);
  let binMinS = new Float64Array(binCap);
  let binMaxS = new Float64Array(binCap);
  let binMinT = new Float64Array(binCap);
  let binMaxT = new Float64Array(binCap);

  const ensureBinCapacity = (needed) => {
    if (needed <= binCap) return;
    while (binCap < needed) binCap *= 2;
    binHas = new Uint8Array(binCap);
    binMinS = new Float64Array(binCap);
    binMaxS = new Float64Array(binCap);
    binMinT = new Float64Array(binCap);
    binMaxT = new Float64Array(binCap);
  };

  // 8-connected neighbor offsets
  const dx8 = [-1, 0, 1, -1, 1, -1, 0, 1];
  const dy8 = [-1, -1, -1, 0, 0, 1, 1, 1];

  let best = null;

  for (let z = 0; z < nz; z++) {
    const zOffset = z * sliceSize;
    let sliceTargetCount = 0;
    let minY = ny;
    let maxY = -1;
    let minX = nx;
    let maxX = -1;

    for (let y = 0; y < ny; y++) {
      const rowOff = y * nx;
      const volRowOff = zOffset + rowOff;
      for (let x = 0; x < nx; x++) {
        const norm = normalizeLabel(data[volRowOff + x]);
        if (isInRegion(norm, region)) {
          sliceMask[rowOff + x] = 1;
          sliceTargetCount++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        } else {
          sliceMask[rowOff + x] = 0;
        }
      }
    }

    if (sliceTargetCount === 0) continue;

    // Clear visited only within slice active bounding box
    for (let y = minY; y <= maxY; y++) {
      visited.fill(0, y * nx + minX, y * nx + maxX + 1);
    }

    const sliceAreaMm2 = sliceTargetCount * pixelAreaMm2;

    // First discover all 8-connected components on this slice so we know exact componentCountOnSlice
    // and evaluate each component's bidimensional RANO measurement.
    /** @type {Array<{ d1Mm: number, d2Mm: number, spdMm2: number, p1x: number, p1y: number, p2x: number, p2y: number, q1x: number, q1y: number, q2x: number, q2y: number, compSize: number }>} */
    const sliceCandidates = [];

    for (let sy = minY; sy <= maxY; sy++) {
      const sRow = sy * nx;
      for (let sx = minX; sx <= maxX; sx++) {
        const startIdx = sRow + sx;
        if (sliceMask[startIdx] === 0 || visited[startIdx] !== 0) continue;

        // BFS to collect 8-connected component
        let qHead = 0;
        let qTail = 0;
        bfsQueue[qTail++] = startIdx;
        visited[startIdx] = 1;

        let compCount = 0;
        while (qHead < qTail) {
          const curIdx = bfsQueue[qHead++];
          const cy = (curIdx / nx) | 0;
          const cx = curIdx - cy * nx;
          compX[compCount] = cx;
          compY[compCount] = cy;
          compCount++;

          for (let d = 0; d < 8; d++) {
            const nxPos = cx + dx8[d];
            const nyPos = cy + dy8[d];
            if (nxPos < 0 || nxPos >= nx || nyPos < 0 || nyPos >= ny) continue;
            const nIdx = nyPos * nx + nxPos;
            if (sliceMask[nIdx] === 1 && visited[nIdx] === 0) {
              visited[nIdx] = 1;
              bfsQueue[qTail++] = nIdx;
            }
          }
        }

        // Extract 4-connected boundary pixels of this component
        let bCount = 0;
        for (let i = 0; i < compCount; i++) {
          const cx = compX[i];
          const cy = compY[i];
          const cIdx = cy * nx + cx;
          const isBoundary =
            cx === 0 ||
            cx === nx - 1 ||
            cy === 0 ||
            cy === ny - 1 ||
            sliceMask[cIdx - 1] === 0 ||
            sliceMask[cIdx + 1] === 0 ||
            sliceMask[cIdx - nx] === 0 ||
            sliceMask[cIdx + nx] === 0;
          if (isBoundary) {
            boundX[bCount] = cx;
            boundY[bCount] = cy;
            bCount++;
          }
        }

        // Fallback (should never occur since every finite component has >= 1 boundary pixel)
        if (bCount === 0) {
          boundX[0] = compX[0];
          boundY[0] = compY[0];
          bCount = 1;
        }

        // Find farthest boundary pair (p1, p2) in physical mm space
        let p1x = boundX[0];
        let p1y = boundY[0];
        let p2x = boundX[0];
        let p2y = boundY[0];
        let maxDistSq = 0;

        if (bCount === 1) {
          maxDistSq = 0;
        } else if (bCount <= 32) {
          for (let i = 0; i < bCount; i++) {
            const x1 = boundX[i];
            const y1 = boundY[i];
            for (let j = i + 1; j < bCount; j++) {
              const ddx = (boundX[j] - x1) * dx;
              const ddy = (boundY[j] - y1) * dy;
              const dSq = ddx * ddx + ddy * ddy;
              if (dSq > maxDistSq + 1e-9) {
                maxDistSq = dSq;
                p1x = x1;
                p1y = y1;
                p2x = boundX[j];
                p2y = boundY[j];
              }
            }
          }
        } else {
          const hull = computeConvexHullIndices(boundX, boundY, bCount);
          const hLen = hull.length;
          for (let i = 0; i < hLen; i++) {
            const hi = hull[i];
            const x1 = boundX[hi];
            const y1 = boundY[hi];
            for (let j = i + 1; j < hLen; j++) {
              const hj = hull[j];
              const ddx = (boundX[hj] - x1) * dx;
              const ddy = (boundY[hj] - y1) * dy;
              const dSq = ddx * ddx + ddy * ddy;
              if (dSq > maxDistSq + 1e-9) {
                maxDistSq = dSq;
                p1x = x1;
                p1y = y1;
                p2x = boundX[hj];
                p2y = boundY[hj];
              }
            }
          }
        }

        const centerDist = Math.sqrt(maxDistSq);
        let ux;
        let uy;
        if (centerDist > EPS) {
          ux = ((p2x - p1x) * dx) / centerDist;
          uy = ((p2y - p1y) * dy) / centerDist;
        } else {
          ux = 1.0;
          uy = 0.0;
        }
        const vx = -uy;
        const vy = ux;

        const d1Mm = centerDist + Math.hypot(ux * dx, uy * dy);

        // Project all boundary pixels onto major (u) and perpendicular (v) axes
        let tMinAll = Infinity;
        let tMaxAll = -Infinity;
        for (let i = 0; i < bCount; i++) {
          const px = boundX[i] * dx;
          const py = boundY[i] * dy;
          const t = px * ux + py * uy;
          const s = px * vx + py * vy;
          projT[i] = t;
          projS[i] = s;
          if (t < tMinAll) tMinAll = t;
          if (t > tMaxAll) tMaxAll = t;
        }

        // Quantize t into bins of width binW with both 0 and +0.5*binW offsets
        let bestSpan = -1;
        let bestSMin = projS[0];
        let bestSMax = projS[0];
        let bestTMin = projT[0];
        let bestTMax = projT[0];

        for (let pass = 0; pass < 2; pass++) {
          const phase = pass === 0 ? 0.0 : 0.5 * binW;
          const baseBin = Math.floor((tMinAll + phase) / binW);
          const topBin = Math.floor((tMaxAll + phase) / binW);
          const numBins = topBin - baseBin + 1;
          ensureBinCapacity(numBins);
          binHas.fill(0, 0, numBins);

          for (let i = 0; i < bCount; i++) {
            const t = projT[i];
            const s = projS[i];
            const b = Math.floor((t + phase) / binW) - baseBin;
            if (binHas[b] === 0) {
              binHas[b] = 1;
              binMinS[b] = s;
              binMaxS[b] = s;
              binMinT[b] = t;
              binMaxT[b] = t;
            } else {
              if (s < binMinS[b]) {
                binMinS[b] = s;
                binMinT[b] = t;
              }
              if (s > binMaxS[b]) {
                binMaxS[b] = s;
                binMaxT[b] = t;
              }
            }
          }

          for (let b = 0; b < numBins; b++) {
            if (binHas[b] === 0) continue;
            const span = binMaxS[b] - binMinS[b];
            if (span > bestSpan + 1e-9) {
              bestSpan = span;
              bestSMin = binMinS[b];
              bestSMax = binMaxS[b];
              bestTMin = binMinT[b];
              bestTMax = binMaxT[b];
            }
          }
        }

        if (bestSpan < 0) bestSpan = 0;
        const d2Mm = bestSpan + Math.hypot(vx * dx, vy * dy);
        const spdMm2 = d1Mm * d2Mm;

        // Project minor extremes onto exact orthogonal line passing through tMid
        const tMid = 0.5 * (bestTMin + bestTMax);
        const q1x = (tMid * ux + bestSMin * vx) / dx;
        const q1y = (tMid * uy + bestSMin * vy) / dy;
        const q2x = (tMid * ux + bestSMax * vx) / dx;
        const q2y = (tMid * uy + bestSMax * vy) / dy;

        sliceCandidates.push({
          d1Mm,
          d2Mm,
          spdMm2,
          p1x,
          p1y,
          p2x,
          p2y,
          q1x,
          q1y,
          q2x,
          q2y,
          compSize: compCount,
        });
      }
    }

    const componentCountOnSlice = sliceCandidates.length;
    for (let i = 0; i < componentCountOnSlice; i++) {
      const c = sliceCandidates[i];
      const isBetter =
        !best ||
        c.spdMm2 > best.spdMm2 + 1e-9 ||
        (Math.abs(c.spdMm2 - best.spdMm2) <= 1e-9 && c.d1Mm > best.d1Mm + 1e-9) ||
        (Math.abs(c.spdMm2 - best.spdMm2) <= 1e-9 &&
          Math.abs(c.d1Mm - best.d1Mm) <= 1e-9 &&
          c.compSize > best.compSize);

      if (isBetter) {
        best = {
          z,
          d1Mm: c.d1Mm,
          d2Mm: c.d2Mm,
          spdMm2: c.spdMm2,
          p1x: c.p1x,
          p1y: c.p1y,
          p2x: c.p2x,
          p2y: c.p2y,
          q1x: c.q1x,
          q1y: c.q1y,
          q2x: c.q2x,
          q2y: c.q2y,
          compSize: c.compSize,
          sliceAreaMm2,
          componentCountOnSlice,
        };
      }
    }
  }

  if (!best) {
    return {
      region,
      d1Mm: 0,
      d2Mm: 0,
      spdMm2: 0,
      bestSliceZ: null,
      measurable: false,
      majorLine: null,
      minorLine: null,
      p1: null,
      p2: null,
      q1: null,
      q2: null,
      sliceAreaMm2: 0,
      componentCountOnSlice: 0,
    };
  }

  return {
    region,
    d1Mm: best.d1Mm,
    d2Mm: best.d2Mm,
    spdMm2: best.spdMm2,
    bestSliceZ: best.z,
    measurable: best.d1Mm >= 10.0 && best.d2Mm >= 10.0,
    majorLine: { x1: best.p1x, y1: best.p1y, x2: best.p2x, y2: best.p2y },
    minorLine: { x1: best.q1x, y1: best.q1y, x2: best.q2x, y2: best.q2y },
    p1: { x: best.p1x, y: best.p1y },
    p2: { x: best.p2x, y: best.p2y },
    q1: { x: best.q1x, y: best.q1y },
    q2: { x: best.q2x, y: best.q2y },
    sliceAreaMm2: best.sliceAreaMm2,
    componentCountOnSlice: best.componentCountOnSlice,
  };
}

/**
 * Compute single-pass 3D volumetrics, centroids, bounding boxes, equivalent spherical
 * diameters, and automated axial 2D RANO diameters for a BraTS + Post-Op segmentation mask.
 *
 * Per canonical spec, `rano2d` targets Enhancing Tumor (`'ET'`) by default so complete
 * disappearance of enhancing disease cleanly yields `spdMm2 = 0`. When `ET` is absent and
 * non-enhancing `WT` is present, `rano2dNonEnhancing` also provides the axial 2D `WT`
 * measurement (and callers may opt into WT fallback via `{ fallbackToWt: true }`).
 *
 * @param {import('./niftiParser.js').NiftiVolume} maskVol - Parsed segmentation mask volume.
 * @param {Object} [options] - Optional configuration.
 * @param {'ET' | 'WT' | 'TC' | 'RC' | 'nonCE'} [options.ranoRegion='ET'] - Primary region for `rano2d`.
 * @param {boolean} [options.fallbackToWt=false] - If true and primary `ET` is empty, assign `WT` 2D measurement to `rano2d`.
 * @returns {VolumetricsResult} Comprehensive volumetric & axial RANO 2D metrics.
 */
export function computeVolumetrics(maskVol, options = {}) {
  const { nx, ny, nz, dx, dy, dz, voxelVolumeMm3, data } = extractVolumeSpec(maskVol, 'maskVol');
  const ranoRegion = options.ranoRegion || 'ET';
  const fallbackToWt = Boolean(options.fallbackToWt);

  const acc1 = createRegionAccumulator();
  const acc2 = createRegionAccumulator();
  const acc3 = createRegionAccumulator();
  const acc5 = createRegionAccumulator();

  const sliceSize = nx * ny;
  for (let z = 0; z < nz; z++) {
    const zOff = z * sliceSize;
    for (let y = 0; y < ny; y++) {
      const yOff = zOff + y * nx;
      for (let x = 0; x < nx; x++) {
        const raw = data[yOff + x];
        if (raw === 0) continue;
        const norm = normalizeLabel(raw);
        let acc;
        if (norm === 1) acc = acc1;
        else if (norm === 2) acc = acc2;
        else if (norm === 3) acc = acc3;
        else if (norm === 5) acc = acc5;
        else continue;

        acc.count++;
        acc.sumX += x;
        acc.sumY += y;
        acc.sumZ += z;
        if (x < acc.minX) acc.minX = x;
        if (x > acc.maxX) acc.maxX = x;
        if (y < acc.minY) acc.minY = y;
        if (y > acc.maxY) acc.maxY = y;
        if (z < acc.minZ) acc.minZ = z;
        if (z > acc.maxZ) acc.maxZ = z;
      }
    }
  }

  const accTc = mergeAccumulators(acc1, acc3);
  const accNonCe = mergeAccumulators(acc1, acc2);
  const accWt = mergeAccumulators(acc1, acc2, acc3);

  const labels = {
    1: finalizeRegionMetrics(acc1, voxelVolumeMm3),
    2: finalizeRegionMetrics(acc2, voxelVolumeMm3),
    3: finalizeRegionMetrics(acc3, voxelVolumeMm3),
    5: finalizeRegionMetrics(acc5, voxelVolumeMm3),
  };

  const regions = {
    WT: finalizeRegionMetrics(accWt, voxelVolumeMm3),
    TC: finalizeRegionMetrics(accTc, voxelVolumeMm3),
    ET: labels[3],
    RC: labels[5],
    nonCE: finalizeRegionMetrics(accNonCe, voxelVolumeMm3),
  };

  let rano2d;
  let rano2dNonEnhancing = null;

  if (ranoRegion === 'ET' && acc3.count === 0) {
    const wt2d = accWt.count > 0 ? computeAxial2DDiameters(maskVol, 'WT') : null;
    if (fallbackToWt && wt2d) {
      rano2d = wt2d;
      rano2dNonEnhancing = wt2d;
    } else {
      rano2d = {
        region: 'ET',
        d1Mm: 0,
        d2Mm: 0,
        spdMm2: 0,
        bestSliceZ: null,
        measurable: false,
        majorLine: null,
        minorLine: null,
        p1: null,
        p2: null,
        q1: null,
        q2: null,
        sliceAreaMm2: 0,
        componentCountOnSlice: 0,
      };
      rano2dNonEnhancing = wt2d;
    }
  } else {
    rano2d = computeAxial2DDiameters(maskVol, ranoRegion);
  }

  return {
    dims: [nx, ny, nz],
    pixdim: [dx, dy, dz],
    voxelVolumeMm3,
    labels,
    regions,
    rano2d,
    rano2dNonEnhancing,
  };
}

/**
 * Fast lightweight compartment volume counter (in cm³) for RANO-Resect EOR calculation.
 * @param {import('./niftiParser.js').NiftiVolume} maskVol
 * @param {string} name
 * @returns {{ ceCm3: number, nonCeCm3: number, wtCm3: number, cavityCm3: number }}
 */
function countCompartmentVolumesCm3(maskVol, name) {
  const { nx, ny, nz, voxelVolumeMm3, data } = extractVolumeSpec(maskVol, name);
  const total = nx * ny * nz;
  let ceVox = 0;
  let nonCeVox = 0;
  let rcVox = 0;

  for (let i = 0; i < total; i++) {
    const raw = data[i];
    if (raw === 0) continue;
    const norm = normalizeLabel(raw);
    if (norm === 3) ceVox++;
    else if (norm === 1 || norm === 2) nonCeVox++;
    else if (norm === 5) rcVox++;
  }

  const voxToCm3 = voxelVolumeMm3 / 1000.0;
  const ceCm3 = ceVox * voxToCm3;
  const nonCeCm3 = nonCeVox * voxToCm3;
  return {
    ceCm3,
    nonCeCm3,
    wtCm3: ceCm3 + nonCeCm3,
    cavityCm3: rcVox * voxToCm3,
  };
}

/**
 * Compute Extent of Resection (EOR) and official 6-tier **RANO-Resect** surgical resection
 * class (Karschnia et al., *Neuro-Oncology* 2023) comparing pre-operative and early
 * post-operative segmentation masks.
 *
 * Pre-op and post-op volumes are evaluated in their own physical spacing (`cm³`), allowing
 * comparison even when pre- and post-op scans have different voxel grids.
 *
 * Classification hierarchy (Karschnia et al., 2023; evaluated strictly in order):
 * 0. Guard (`N/A`): `preCeCm3 <= 1e-6` (no pre-operative CE tumor — empty mask or non-enhancing tumor)
 * 1. `Class 4` (Biopsy): `ceEorPct < 10.0%` (no cytoreductive CE resection)
 * 2. `Class 1` (Supramaximal CE Resection): `residualCE <= 1e-6` AND `residualNonCE <= 5.0 cm³`
 * 3. `Class 2A` (Complete CE Resection): `residualCE <= 1e-6` AND `residualNonCE > 5.0 cm³`
 * 4. `Class 2B` (Near-Total CE Resection): `residualCE <= 1.0 cm³` (CE EOR% reported for reference)
 * 5. `Class 3A` (Subtotal CE Resection): `>1.0` to `<= 5.0 cm³` residual CE (CE EOR% reported for reference)
 * 6. `Class 3B` (Partial CE Resection): `residualCE > 5.0 cm³` (with `ceEorPct >= 10.0%`)
 *
 * @param {import('./niftiParser.js').NiftiVolume} preMaskVol - Pre-operative segmentation mask.
 * @param {import('./niftiParser.js').NiftiVolume} postMaskVol - Post-operative segmentation mask.
 * @returns {EorResult} Volumetric EOR breakdown and RANO-Resect classification.
 */
export function computeExtentOfResection(preMaskVol, postMaskVol) {
  const pre = countCompartmentVolumesCm3(preMaskVol, 'preMaskVol');
  const post = countCompartmentVolumesCm3(postMaskVol, 'postMaskVol');

  const preCeCm3 = pre.ceCm3;
  const preNonCeCm3 = pre.nonCeCm3;
  const preWtCm3 = pre.wtCm3;
  const residualCeCm3 = post.ceCm3;
  const residualNonCeCm3 = post.nonCeCm3;
  const residualWtCm3 = post.wtCm3;
  const cavityCm3 = post.cavityCm3;

  const hasPreOpCe = preCeCm3 > EPS;
  const ceEorPct =
    hasPreOpCe ? clamp(((preCeCm3 - residualCeCm3) / preCeCm3) * 100.0, 0.0, 100.0) : 0.0;
  const nonCeEorPct =
    preNonCeCm3 > EPS
      ? clamp(((preNonCeCm3 - residualNonCeCm3) / preNonCeCm3) * 100.0, 0.0, 100.0)
      : 0.0;

  /** @type {'Class 1' | 'Class 2A' | 'Class 2B' | 'Class 3A' | 'Class 3B' | 'Class 4' | 'N/A'} */
  let ranoClass;
  let ranoClassName;
  let ranoClassDescription;
  const rationale = [
    hasPreOpCe
      ? `Pre-op CE: ${preCeCm3.toFixed(2)} cm³ -> Residual CE: ${residualCeCm3.toFixed(2)} cm³ (reference CE EOR: ${ceEorPct.toFixed(1)}%).`
      : `Pre-op CE: 0.00 cm³ -> Residual CE: ${residualCeCm3.toFixed(2)} cm³ (CE EOR: N/A — zero pre-op CE volume).`,
    `Pre-op non-CE (NCR+ED): ${preNonCeCm3.toFixed(2)} cm³ -> Residual non-CE: ${residualNonCeCm3.toFixed(2)} cm³ (Non-CE EOR: ${nonCeEorPct.toFixed(1)}%).`,
  ];
  if (cavityCm3 > EPS) {
    rationale.push(`Post-op surgical resection cavity (RC): ${cavityCm3.toFixed(2)} cm³.`);
  }

  // Official RANO-Resect hierarchy (Karschnia et al., Neuro-Oncology 2023)
  if (!hasPreOpCe) {
    ranoClass = 'N/A';
    if (preNonCeCm3 <= EPS) {
      ranoClassName = 'Not Evaluable (No Pre-Op Tumor)';
      ranoClassDescription =
        'No pre-operative enhancing (CE) or non-enhancing (non-CE) tumor detected; RANO-Resect classification requires pre-operative CE tumor.';
      rationale.push(
        'Zero pre-operative enhancing and non-enhancing tumor volume detected: RANO-Resect CE resection classes (1–4) are not applicable to empty pre-op masks.'
      );
    } else {
      ranoClassName = 'Non-Enhancing Tumor (CE RANO-Resect N/A)';
      ranoClassDescription =
        'Zero pre-operative contrast-enhancing (CE) tumor; Karschnia et al. (2023) CE RANO-Resect Classes 1–4 apply to contrast-enhancing glioblastoma (non-CE EOR reported for reference).';
      rationale.push(
        `Zero pre-operative CE volume detected (non-enhancing tumor: ${preNonCeCm3.toFixed(2)} -> ${residualNonCeCm3.toFixed(2)} cm³ non-CE, ${nonCeEorPct.toFixed(1)}% non-CE EOR): CE RANO-Resect Classes 1–4 are not assigned.`
      );
      if (nonCeEorPct < 10.0) {
        rationale.push(
          `Reference note: non-CE volumetric reduction (${nonCeEorPct.toFixed(1)}%) is <10% (biopsy-range sampling).`
        );
      }
    }
    if (residualCeCm3 > EPS) {
      rationale.push(
        `Warning: post-op mask contains ${residualCeCm3.toFixed(2)} cm³ enhancing tissue despite 0.00 cm³ pre-op CE — verify Pre-Op / Post-Op mask assignment.`
      );
    }
  } else if (ceEorPct < 10.0) {
    ranoClass = 'Class 4';
    rationale.push(
      `RANO-Resect Class 4 (Biopsy): CE EOR (${ceEorPct.toFixed(1)}%) is <10% cytoreductive threshold (Karschnia et al., 2023).`
    );
  } else if (residualCeCm3 <= EPS && residualNonCeCm3 <= 5.0) {
    ranoClass = 'Class 1';
    rationale.push(
      `RANO-Resect Class 1 (Supramaximal CE Resection): 0 cm³ residual CE tumor AND residual non-CE (${residualNonCeCm3.toFixed(2)} cm³) ≤5.0 cm³ (Karschnia et al., 2023).`
    );
  } else if (residualCeCm3 <= EPS && residualNonCeCm3 > 5.0) {
    ranoClass = 'Class 2A';
    rationale.push(
      `RANO-Resect Class 2A (Complete CE Resection): 0 cm³ residual CE tumor with residual non-CE (${residualNonCeCm3.toFixed(2)} cm³) >5.0 cm³ (Karschnia et al., 2023).`
    );
  } else if (residualCeCm3 <= 1.0) {
    ranoClass = 'Class 2B';
    rationale.push(
      `RANO-Resect Class 2B (Near-Total CE Resection): residual CE (${residualCeCm3.toFixed(2)} cm³) ≤1.0 cm³ (reference CE EOR: ${ceEorPct.toFixed(1)}%; Karschnia et al., 2023).`
    );
  } else if (residualCeCm3 <= 5.0) {
    ranoClass = 'Class 3A';
    rationale.push(
      `RANO-Resect Class 3A (Subtotal CE Resection): residual CE (${residualCeCm3.toFixed(2)} cm³) >1.0 to ≤5.0 cm³ (reference CE EOR: ${ceEorPct.toFixed(1)}%; Karschnia et al., 2023).`
    );
  } else {
    ranoClass = 'Class 3B';
    rationale.push(
      `RANO-Resect Class 3B (Partial CE Resection): residual CE (${residualCeCm3.toFixed(2)} cm³) >5.0 cm³ with ≥10% CE reduction (reference CE EOR: ${ceEorPct.toFixed(1)}%; Karschnia et al., 2023).`
    );
  }

  if (ranoClass !== 'N/A') {
    const meta = RANO_RESECT_CLASSES[ranoClass];
    ranoClassName = meta.name;
    ranoClassDescription = meta.description;
  }

  return {
    preCeCm3,
    preNonCeCm3,
    preWtCm3,
    residualCeCm3,
    residualNonCeCm3,
    residualWtCm3,
    cavityCm3,
    ceEorPct,
    nonCeEorPct,
    hasPreOpCe,
    ranoResectApplicable: hasPreOpCe,
    ranoClass,
    ranoClassName,
    ranoClassDescription,
    rationale,
  };
}

/**
 * Compute relative percentage change `((curr - ref) / ref) * 100`, returning `0` when
 * both values are ~0 and `null` (never `Infinity`) when emerging from a `0` reference.
 *
 * @param {number} curr
 * @param {number} ref
 * @returns {number | null}
 */
function safePctChange(curr, ref) {
  if (ref > EPS) {
    return ((curr - ref) / ref) * 100.0;
  }
  if (curr <= EPS) {
    return 0.0;
  }
  return null;
}

/**
 * Format a signed percentage string for rationale messages.
 * @param {number | null} pct
 * @returns {string}
 */
function fmtSignedPct(pct) {
  if (pct === null) return 'emergence from 0';
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

/**
 * Evaluate longitudinal neuro-oncology treatment response per **RANO 2.0**
 * (Wen et al., *Journal of Clinical Oncology* 2023).
 *
 * Compares the latest follow-up (`timepoints[last]`) against both the RANO 2.0 baseline
 * (`timepoints[0]`; post-RT MRI ~4 weeks after radiotherapy for newly diagnosed RT-treated
 * gliomas, or early post-op MRI when RT is not given / for pre-RT therapy) and the prior
 * nadir (`min` over `timepoints[0 .. n-2]`) for both 2D bidimensional SPD (`mm²`) and 3D
 * tumor volume (`cm³`), incorporating corticosteroid requirements (`none_or_physiologic` for
 * CR; `stable_or_decreased` for PR/MR; `increased` blocking response), clinical status,
 * new measurable lesions, and the `<=12 weeks post-RT` pseudoprogression confirmation guard
 * for clinically stable patients.
 *
 * @param {Rano2Timepoint[]} timepoints - Chronologically ordered longitudinal timepoints.
 * @returns {Rano2Result} Detailed RANO 2.0 response assessment and decision rationale.
 */
export function computeRano2Response(timepoints) {
  if (!Array.isArray(timepoints)) {
    throw new TypeError('computeRano2Response(timepoints) requires an array of timepoints.');
  }

  const norm = timepoints.map((tp, idx) => ({
    id: tp && tp.id != null ? String(tp.id) : `tp_${idx}`,
    label: (tp && (tp.label || tp.id)) ? String(tp.label || tp.id) : `Timepoint ${idx + 1}`,
    spdMm2: Math.max(0, Number(tp?.spdMm2) || 0),
    volumeCm3: Math.max(0, Number(tp?.volumeCm3) || 0),
    steroids:
      tp?.steroids === 'increased'
        ? 'increased'
        : tp?.steroids === 'none_or_physiologic'
          ? 'none_or_physiologic'
          : 'stable_or_decreased',
    clinicalStatus: tp?.clinicalStatus === 'deteriorated' ? 'deteriorated' : 'stable_or_improved',
    newMeasurableLesion: Boolean(tp?.newMeasurableLesion),
    within12WeeksPostRT: Boolean(tp?.within12WeeksPostRT),
  }));

  if (norm.length < 2) {
    const tp0 = norm[0] || {
      label: 'None',
      spdMm2: 0,
      volumeCm3: 0,
      steroids: 'stable_or_decreased',
      clinicalStatus: 'stable_or_improved',
      newMeasurableLesion: false,
      within12WeeksPostRT: false,
    };
    return {
      category: 'Baseline Only',
      shortCode: 'BASELINE',
      severity: 'neutral',
      baseline: {
        label: tp0.label,
        spdMm2: tp0.spdMm2,
        volumeCm3: tp0.volumeCm3,
      },
      nadir: {
        spdMm2: tp0.spdMm2,
        volumeCm3: tp0.volumeCm3,
        spdLabel: tp0.label,
        volumeLabel: tp0.label,
      },
      current: {
        label: tp0.label,
        spdMm2: tp0.spdMm2,
        volumeCm3: tp0.volumeCm3,
        steroids: tp0.steroids,
        clinicalStatus: tp0.clinicalStatus,
        newMeasurableLesion: tp0.newMeasurableLesion,
        within12WeeksPostRT: tp0.within12WeeksPostRT,
      },
      spdChangeVsBaselinePct: 0,
      spdChangeVsNadirPct: 0,
      volChangeVsBaselinePct: 0,
      volChangeVsNadirPct: 0,
      criteriaTriggered: {
        spdProgression: false,
        volProgression: false,
        newLesion: false,
        clinicalDeterioration: false,
        steroidBlockedResponse: false,
        confirmationRequired: false,
      },
      rationale: [
        norm.length === 0
          ? 'No longitudinal timepoints provided; at least two scans are required for RANO 2.0 response categorization.'
          : 'Only one baseline timepoint is available; at least one longitudinal follow-up scan is required for RANO 2.0 response categorization.',
      ],
    };
  }

  const baseline = norm[0];
  const current = norm[norm.length - 1];

  // Compute nadir independently for SPD and 3D Volume across all prior timepoints [0 .. n-2]
  let nadirSpd = baseline.spdMm2;
  let nadirSpdLabel = baseline.label;
  let nadirVol = baseline.volumeCm3;
  let nadirVolLabel = baseline.label;

  for (let i = 1; i < norm.length - 1; i++) {
    const tp = norm[i];
    if (tp.spdMm2 < nadirSpd) {
      nadirSpd = tp.spdMm2;
      nadirSpdLabel = tp.label;
    }
    if (tp.volumeCm3 < nadirVol) {
      nadirVol = tp.volumeCm3;
      nadirVolLabel = tp.label;
    }
  }

  const spdChangeVsBaselinePct = safePctChange(current.spdMm2, baseline.spdMm2);
  const spdChangeVsNadirPct = safePctChange(current.spdMm2, nadirSpd);
  const volChangeVsBaselinePct = safePctChange(current.volumeCm3, baseline.volumeCm3);
  const volChangeVsNadirPct = safePctChange(current.volumeCm3, nadirVol);

  // 1. Progression triggers (RANO 2.0, Wen et al. JCO 2023)
  const spdProgression =
    (nadirSpd > EPS && spdChangeVsNadirPct !== null && spdChangeVsNadirPct >= 25.0) ||
    (nadirSpd <= EPS && current.spdMm2 >= 100.0);

  const volProgression =
    (nadirVol > EPS && volChangeVsNadirPct !== null && volChangeVsNadirPct >= 40.0) ||
    (nadirVol <= EPS && current.volumeCm3 >= 1.0);

  const newLesion = current.newMeasurableLesion;
  const clinicalDeterioration = current.clinicalStatus === 'deteriorated';

  const radiographicProgression = spdProgression || volProgression || newLesion;
  const anyProgression = radiographicProgression || clinicalDeterioration;

  const rationale = [];
  if (nadirSpd <= EPS && current.spdMm2 > EPS) {
    rationale.push(
      `2D SPD emerged from 0 mm² at nadir (${nadirSpdLabel}) to ${current.spdMm2.toFixed(1)} mm² (baseline: ${baseline.spdMm2.toFixed(1)} mm²).`
    );
  } else {
    rationale.push(
      `2D SPD: ${current.spdMm2.toFixed(1)} mm² (${fmtSignedPct(spdChangeVsBaselinePct)} vs baseline ${baseline.spdMm2.toFixed(1)} mm²; ${fmtSignedPct(spdChangeVsNadirPct)} vs nadir ${nadirSpd.toFixed(1)} mm² at ${nadirSpdLabel}).`
    );
  }

  if (nadirVol <= EPS && current.volumeCm3 > EPS) {
    rationale.push(
      `3D Volume emerged from 0.00 cm³ at nadir (${nadirVolLabel}) to ${current.volumeCm3.toFixed(2)} cm³ (baseline: ${baseline.volumeCm3.toFixed(2)} cm³).`
    );
  } else {
    rationale.push(
      `3D Volume: ${current.volumeCm3.toFixed(2)} cm³ (${fmtSignedPct(volChangeVsBaselinePct)} vs baseline ${baseline.volumeCm3.toFixed(2)} cm³; ${fmtSignedPct(volChangeVsNadirPct)} vs nadir ${nadirVol.toFixed(2)} cm³ at ${nadirVolLabel}).`
    );
  }

  /** @type {Rano2Result['category']} */
  let category = 'SD';
  /** @type {Rano2Result['shortCode']} */
  let shortCode = 'SD';
  /** @type {Rano2Result['severity']} */
  let severity = 'neutral';
  let steroidBlockedResponse = false;
  let confirmationRequired = false;

  if (anyProgression) {
    if (spdProgression) {
      rationale.push(
        nadirSpd <= EPS
          ? `Radiographic 2D progression triggered: new measurable SPD (${current.spdMm2.toFixed(1)} mm² ≥ 100 mm² threshold) after 0 mm² nadir.`
          : `Radiographic 2D progression triggered: SPD increased ${fmtSignedPct(spdChangeVsNadirPct)} from nadir (≥ +25% RANO 2.0 threshold).`
      );
    }
    if (volProgression) {
      rationale.push(
        nadirVol <= EPS
          ? `Radiographic 3D progression triggered: new tumor volume (${current.volumeCm3.toFixed(2)} cm³ ≥ 1.0 cm³ threshold) after 0 cm³ nadir.`
          : `Radiographic 3D progression triggered: 3D volume increased ${fmtSignedPct(volChangeVsNadirPct)} from nadir (≥ +40% RANO 2.0 threshold).`
      );
    }
    if (newLesion) {
      rationale.push('New measurable enhancing lesion reported (≥10 × 10 mm).');
    }
    if (clinicalDeterioration) {
      rationale.push(
        'Clinical deterioration reported (not attributable to non-tumor causes or steroid reduction).'
      );
    }

    if (current.within12WeeksPostRT && radiographicProgression && !clinicalDeterioration) {
      category = 'Preliminary PD (Confirm >=4 wks)';
      shortCode = 'PRELIM_PD';
      severity = 'warning';
      confirmationRequired = true;
      rationale.push(
        'RANO 2.0 ≤12 Weeks Post-RT Pseudoprogression Guard active (clinically stable): flagged as Preliminary PD; repeat confirmatory MRI required ≥4 weeks later (unless progression is outside the high-dose RT field or histopathologically confirmed).'
      );
    } else {
      category = 'PD';
      shortCode = 'PD';
      severity = 'progression';
      rationale.push(
        current.within12WeeksPostRT
          ? 'Within ≤12 weeks post-radiotherapy, but unequivocal clinical deterioration triggers definite Progressive Disease (PD) per RANO 2.0.'
          : 'Scan is >12 weeks post-radiotherapy: classified as Progressive Disease (PD) per RANO 2.0.'
      );
    }
  } else {
    // 2. Response triggers (no progression, clinical status stable/improved, no new lesion)
    const hasBaselineDisease = baseline.spdMm2 > EPS || baseline.volumeCm3 > EPS;
    const radCR = hasBaselineDisease && current.spdMm2 <= EPS && current.volumeCm3 <= EPS;
    const radPR =
      (baseline.spdMm2 > EPS && spdChangeVsBaselinePct !== null && spdChangeVsBaselinePct <= -50.0) ||
      (baseline.volumeCm3 > EPS && volChangeVsBaselinePct !== null && volChangeVsBaselinePct <= -65.0);
    const radMR =
      (baseline.spdMm2 > EPS && spdChangeVsBaselinePct !== null && spdChangeVsBaselinePct <= -25.0) ||
      (baseline.volumeCm3 > EPS && volChangeVsBaselinePct !== null && volChangeVsBaselinePct <= -40.0);

    if (radCR || radPR || radMR) {
      const targetRadLabel = radCR ? 'CR' : radPR ? 'PR' : 'MR';
      if (current.steroids === 'increased') {
        category = 'SD';
        shortCode = 'SD';
        severity = 'neutral';
        steroidBlockedResponse = true;
        rationale.push(
          `Radiographic ${targetRadLabel} threshold met, but corticosteroid dose was increased — downgraded to Stable Disease (SD) per RANO 2.0 steroid requirement.`
        );
      } else if (radCR) {
        if (current.steroids === 'none_or_physiologic') {
          category = 'CR';
          shortCode = 'CR';
          severity = 'favorable';
          rationale.push(
            'Complete disappearance of all enhancing disease (SPD = 0 mm², Volume = 0.00 cm³) while off corticosteroids or on physiologic replacement doses only, with stable/improved clinical status -> Complete Response (CR; confirm durability ≥4 weeks per RANO 2.0).'
          );
        } else {
          category = 'PR';
          shortCode = 'PR';
          severity = 'favorable';
          steroidBlockedResponse = true;
          rationale.push(
            'Complete radiographic disappearance of enhancing disease (SPD = 0 mm², Volume = 0.00 cm³), but patient remains on stable/decreased therapeutic corticosteroids — downgraded from CR to Partial Response (PR) per RANO 2.0 (CR requires off corticosteroids or physiologic replacement doses only; confirm ≥4 weeks).'
          );
        }
      } else if (radPR) {
        category = 'PR';
        shortCode = 'PR';
        severity = 'favorable';
        const steroidDesc =
          current.steroids === 'none_or_physiologic'
            ? 'off/physiologic corticosteroids'
            : 'stable/decreased corticosteroids';
        rationale.push(
          `Met Partial Response (PR) threshold (≥50% 2D SPD reduction or ≥65% 3D volume reduction vs baseline) with ${steroidDesc} and stable/improved clinical status (confirm ≥4 weeks per RANO 2.0).`
        );
      } else {
        category = 'MR';
        shortCode = 'MR';
        severity = 'favorable';
        const steroidDesc =
          current.steroids === 'none_or_physiologic'
            ? 'off/physiologic corticosteroids'
            : 'stable/decreased corticosteroids';
        rationale.push(
          `Met Minor Response (MR) threshold (25%–49% 2D SPD reduction or 40%–64% 3D volume reduction vs baseline; applicable primarily to non-enhancing / lower-grade gliomas under RANO 2.0) with ${steroidDesc} and stable/improved clinical status.`
        );
      }
    } else {
      category = 'SD';
      shortCode = 'SD';
      severity = 'neutral';
      if (!hasBaselineDisease && current.spdMm2 <= EPS && current.volumeCm3 <= EPS) {
        rationale.push(
          'No enhancing disease present at baseline (0 mm² SPD, 0.00 cm³) and no emergence of progression on follow-up -> Stable Disease (SD / non-PD; Complete Response requires baseline enhancing disease per RANO 2.0).'
        );
      } else {
        rationale.push(
          'Neither progression (PD) nor radiographic response (CR/PR/MR) thresholds were met -> Stable Disease (SD) per RANO 2.0.'
        );
      }
    }
  }

  return {
    category,
    shortCode,
    severity,
    baseline: {
      label: baseline.label,
      spdMm2: baseline.spdMm2,
      volumeCm3: baseline.volumeCm3,
    },
    nadir: {
      spdMm2: nadirSpd,
      volumeCm3: nadirVol,
      spdLabel: nadirSpdLabel,
      volumeLabel: nadirVolLabel,
    },
    current: {
      label: current.label,
      spdMm2: current.spdMm2,
      volumeCm3: current.volumeCm3,
      steroids: current.steroids,
      clinicalStatus: current.clinicalStatus,
      newMeasurableLesion: current.newMeasurableLesion,
      within12WeeksPostRT: current.within12WeeksPostRT,
    },
    spdChangeVsBaselinePct,
    spdChangeVsNadirPct,
    volChangeVsBaselinePct,
    volChangeVsNadirPct,
    criteriaTriggered: {
      spdProgression,
      volProgression,
      newLesion,
      clinicalDeterioration,
      steroidBlockedResponse,
      confirmationRequired,
    },
    rationale,
  };
}

/**
 * Exact 1D weighted parabolic lower-envelope distance transform
 * (Felzenszwalb & Huttenlocher, *Theory of Computing* 2012):
 *   out[q] = min_{p in [0..n-1]} ( f[p] + weight * (q - p)^2 )
 *
 * Handles `+Infinity` entries cleanly without overflow or NaN.
 *
 * @param {Float64Array} f - Input squared distances along 1D scanline.
 * @param {number} n - Length of scanline.
 * @param {number} weight - Squared physical voxel spacing along this axis (d²).
 * @param {Float64Array} out - Output squared distances along 1D scanline.
 * @param {Int32Array} v - Scratch array of length >= n storing lower-envelope parabola centers.
 * @param {Float64Array} z - Scratch array of length >= n + 1 storing parabola intersections.
 */
function edt1dWeighted(f, n, weight, out, v, z) {
  let k = -1;
  const twoW = 2.0 * weight;

  for (let q = 0; q < n; q++) {
    const fq = f[q];
    if (!Number.isFinite(fq)) continue;

    if (k < 0) {
      k = 0;
      v[0] = q;
      z[0] = -Infinity;
      z[1] = Infinity;
      continue;
    }

    let s;
    while (true) {
      const r = v[k];
      s = (fq - f[r]) / (twoW * (q - r)) + 0.5 * (q + r);
      if (s <= z[k]) {
        k--;
        if (k < 0) break;
      } else {
        break;
      }
    }

    k++;
    v[k] = q;
    z[k] = k === 0 ? -Infinity : s;
    z[k + 1] = Infinity;
  }

  if (k < 0) {
    for (let q = 0; q < n; q++) out[q] = Infinity;
    return;
  }

  let idx = 0;
  for (let q = 0; q < n; q++) {
    while (z[idx + 1] < q) {
      idx++;
    }
    const r = v[idx];
    const diff = q - r;
    out[q] = f[r] + weight * diff * diff;
  }
}

/**
 * Compute exact anisotropic 3D squared Euclidean Distance Transform from a set of
 * surface voxel indices inside a local bounding box `[bx, by, bz]`.
 *
 * @param {Int32Array} surfaceIndices - Local linear indices of surface voxels (`0` distance).
 * @param {number} bx
 * @param {number} by
 * @param {number} bz
 * @param {number} dx
 * @param {number} dy
 * @param {number} dz
 * @returns {Float64Array | Float32Array} Squared physical Euclidean distance (mm²) at each bbox voxel.
 */
function computeAnisotropicEdt3DSquared(surfaceIndices, bx, by, bz, dx, dy, dz) {
  const bxy = bx * by;
  const bTotal = bxy * bz;
  // Use Float64Array up to 4M bbox voxels for exact IEEE-754 parity; Float32Array for gigantic boxes
  const dist = bTotal <= 4000000 ? new Float64Array(bTotal) : new Float32Array(bTotal);
  dist.fill(Infinity);

  for (let i = 0; i < surfaceIndices.length; i++) {
    dist[surfaceIndices[i]] = 0.0;
  }

  const maxDim = Math.max(bx, by, bz);
  const lineIn = new Float64Array(maxDim);
  const lineOut = new Float64Array(maxDim);
  const envV = new Int32Array(maxDim);
  const envZ = new Float64Array(maxDim + 1);

  const wx = dx * dx;
  const wy = dy * dy;
  const wz = dz * dz;

  // Pass 1: along X
  if (bx > 1) {
    for (let lz = 0; lz < bz; lz++) {
      const zBase = lz * bxy;
      for (let ly = 0; ly < by; ly++) {
        const rowBase = zBase + ly * bx;
        let hasFinite = false;
        for (let lx = 0; lx < bx; lx++) {
          const val = dist[rowBase + lx];
          lineIn[lx] = val;
          if (val !== Infinity) hasFinite = true;
        }
        if (!hasFinite) continue;
        edt1dWeighted(lineIn, bx, wx, lineOut, envV, envZ);
        for (let lx = 0; lx < bx; lx++) {
          dist[rowBase + lx] = lineOut[lx];
        }
      }
    }
  }

  // Pass 2: along Y
  if (by > 1) {
    for (let lz = 0; lz < bz; lz++) {
      const zBase = lz * bxy;
      for (let lx = 0; lx < bx; lx++) {
        const colBase = zBase + lx;
        let hasFinite = false;
        for (let ly = 0; ly < by; ly++) {
          const val = dist[colBase + ly * bx];
          lineIn[ly] = val;
          if (val !== Infinity) hasFinite = true;
        }
        if (!hasFinite) continue;
        edt1dWeighted(lineIn, by, wy, lineOut, envV, envZ);
        for (let ly = 0; ly < by; ly++) {
          dist[colBase + ly * bx] = lineOut[ly];
        }
      }
    }
  }

  // Pass 3: along Z
  if (bz > 1) {
    for (let ly = 0; ly < by; ly++) {
      const yBase = ly * bx;
      for (let lx = 0; lx < bx; lx++) {
        const pillarBase = yBase + lx;
        let hasFinite = false;
        for (let lz = 0; lz < bz; lz++) {
          const val = dist[pillarBase + lz * bxy];
          lineIn[lz] = val;
          if (val !== Infinity) hasFinite = true;
        }
        if (!hasFinite) continue;
        edt1dWeighted(lineIn, bz, wz, lineOut, envV, envZ);
        for (let lz = 0; lz < bz; lz++) {
          dist[pillarBase + lz * bxy] = lineOut[lz];
        }
      }
    }
  }

  return dist;
}

/**
 * Compute linear-interpolated percentile (matching NumPy/medpy `method='linear'`)
 * on an already-sorted non-empty numeric array.
 *
 * @param {Float64Array} sorted - Ascending sorted distances.
 * @param {number} p - Percentile in [0, 100].
 * @returns {number}
 */
function percentileLinearSorted(sorted, p) {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const pos = (p / 100.0) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const frac = pos - lo;
  return sorted[lo] + frac * (sorted[hi] - sorted[lo]);
}

/**
 * Extract 6-connected binary surface voxel local indices inside a tight bounding box.
 *
 * @param {Uint8Array} bin - Binary mask (0/1) inside local bbox `[bx, by, bz]`.
 * @param {number} bx
 * @param {number} by
 * @param {number} bz
 * @returns {Int32Array} Local linear indices of all 6-connected boundary voxels.
 */
function extractSurface6Connected(bin, bx, by, bz) {
  const bxy = bx * by;
  const temp = [];

  for (let lz = 0; lz < bz; lz++) {
    const zBase = lz * bxy;
    const onZEdge = lz === 0 || lz === bz - 1;
    for (let ly = 0; ly < by; ly++) {
      const yBase = zBase + ly * bx;
      const onYEdge = ly === 0 || ly === by - 1;
      for (let lx = 0; lx < bx; lx++) {
        const li = yBase + lx;
        if (bin[li] === 0) continue;
        if (
          onZEdge ||
          onYEdge ||
          lx === 0 ||
          lx === bx - 1 ||
          bin[li - 1] === 0 ||
          bin[li + 1] === 0 ||
          bin[li - bx] === 0 ||
          bin[li + bx] === 0 ||
          bin[li - bxy] === 0 ||
          bin[li + bxy] === 0
        ) {
          temp.push(li);
        }
      }
    }
  }

  return Int32Array.from(temp);
}

/**
 * Compute exact symmetric 3D surface distance metrics (`hd95Mm` and `assdMm`) for one
 * binary target region inside its tight combined bounding box.
 *
 * @param {Uint8Array} gtNorm - Normalized canonical labels for ground-truth mask.
 * @param {Uint8Array} predNorm - Normalized canonical labels for prediction mask.
 * @param {string} region - Region code ('ET', 'TC', 'WT', 'RC').
 * @param {number} nx
 * @param {number} ny
 * @param {number} dx
 * @param {number} dy
 * @param {number} dz
 * @param {BoundingBox3D} bbox - Tight combined bounding box of GT ∪ Pred for this region.
 * @returns {{ hd95Mm: number, assdMm: number }}
 */
function computeSurfaceDistancesForRegion(gtNorm, predNorm, region, nx, ny, dx, dy, dz, bbox) {
  const bx = bbox.maxX - bbox.minX + 1;
  const by = bbox.maxY - bbox.minY + 1;
  const bz = bbox.maxZ - bbox.minZ + 1;
  const bxy = bx * by;
  const bTotal = bxy * bz;
  const nxy = nx * ny;

  const binGt = new Uint8Array(bTotal);
  const binPred = new Uint8Array(bTotal);

  for (let lz = 0; lz < bz; lz++) {
    const gzOff = (bbox.minZ + lz) * nxy;
    const lzOff = lz * bxy;
    for (let ly = 0; ly < by; ly++) {
      const gyOff = gzOff + (bbox.minY + ly) * nx + bbox.minX;
      const lyOff = lzOff + ly * bx;
      for (let lx = 0; lx < bx; lx++) {
        const gi = gyOff + lx;
        const li = lyOff + lx;
        if (isInRegion(gtNorm[gi], region)) binGt[li] = 1;
        if (isInRegion(predNorm[gi], region)) binPred[li] = 1;
      }
    }
  }

  const surfGt = extractSurface6Connected(binGt, bx, by, bz);
  const surfPred = extractSurface6Connected(binPred, bx, by, bz);

  const nGt = surfGt.length;
  const nPred = surfPred.length;
  if (nGt === 0 || nPred === 0) {
    return { hd95Mm: 0, assdMm: 0 };
  }

  const edtPredSq = computeAnisotropicEdt3DSquared(surfPred, bx, by, bz, dx, dy, dz);
  const edtGtSq = computeAnisotropicEdt3DSquared(surfGt, bx, by, bz, dx, dy, dz);

  const allDists = new Float64Array(nGt + nPred);
  let sum = 0;
  let k = 0;

  for (let i = 0; i < nGt; i++) {
    const d = Math.sqrt(Math.max(0, edtPredSq[surfGt[i]]));
    allDists[k++] = d;
    sum += d;
  }
  for (let i = 0; i < nPred; i++) {
    const d = Math.sqrt(Math.max(0, edtGtSq[surfPred[i]]));
    allDists[k++] = d;
    sum += d;
  }

  const assdMm = sum / allDists.length;
  allDists.sort();
  const hd95Mm = percentileLinearSorted(allDists, 95);

  return { hd95Mm, assdMm };
}

/**
 * Validate that two mask volumes share identical 3D voxel grid dimensions,
 * throwing a descriptive Error if mismatched.
 *
 * @param {import('./niftiParser.js').NiftiVolume} gtVol
 * @param {import('./niftiParser.js').NiftiVolume} predVol
 */
function assertMatchingDims(gtVol, predVol) {
  const gt = extractVolumeSpec(gtVol, 'gtVol');
  const pred = extractVolumeSpec(predVol, 'predVol');
  if (gt.nx !== pred.nx || gt.ny !== pred.ny || gt.nz !== pred.nz) {
    throw new Error(
      `Volume dimension mismatch: ground-truth dims [${gt.nx}×${gt.ny}×${gt.nz}] ` +
      `do not match prediction dims [${pred.nx}×${pred.ny}×${pred.nz}].`
    );
  }
  return { gt, pred };
}

/**
 * Build a 3D voxelwise TP/FP/FN error volume (`Uint8Array`) for instant QA overlay switching
 * without recomputing 3D surface distances.
 *
 * Output codes:
 * - `0`: TN (True Negative)
 * - `1`: TP (True Positive)
 * - `2`: FP (False Positive / Over-segmentation)
 * - `3`: FN (False Negative / Missed tumor)
 *
 * @param {import('./niftiParser.js').NiftiVolume} gtVol - Ground-truth segmentation mask.
 * @param {import('./niftiParser.js').NiftiVolume} predVol - Predicted segmentation mask.
 * @param {'ET' | 'TC' | 'WT' | 'RC'} [region='ET'] - Target region to encode.
 * @returns {Uint8Array} Flat error code volume of length `nx * ny * nz`.
 */
export function buildErrorVolume(gtVol, predVol, region = 'ET') {
  const { gt, pred } = assertMatchingDims(gtVol, predVol);
  const total = gt.nx * gt.ny * gt.nz;
  const errorVolume = new Uint8Array(total);
  const gtData = gt.data;
  const predData = pred.data;

  for (let i = 0; i < total; i++) {
    const gRaw = gtData[i];
    const pRaw = predData[i];
    if (gRaw === 0 && pRaw === 0) continue;
    const gIn = isInRegion(normalizeLabel(gRaw), region);
    const pIn = isInRegion(normalizeLabel(pRaw), region);
    if (gIn) {
      errorVolume[i] = pIn ? 1 : 3; // TP : FN
    } else if (pIn) {
      errorVolume[i] = 2; // FP
    }
  }

  return errorVolume;
}

/**
 * Evaluate an AI segmentation prediction mask against a ground-truth mask across all
 * canonical BraTS + Post-Op regions (`ET`, `TC`, `WT`, `RC`), computing overlap metrics
 * (`dice`, `iou`, `sensitivity`, `precision`, `rvePct`), exact anisotropic 3D surface
 * distances (`hd95Mm`, `assdMm` via Felzenszwalb-Huttenlocher EDT), and a 3D `TP/FP/FN`
 * error overlay volume for the requested region.
 *
 * Accepts either an options object (`{ errorRegion: 'ET' }`) or a region string (`'ET'`)
 * as the third argument for ergonomic interoperability.
 *
 * @param {import('./niftiParser.js').NiftiVolume} gtVol - Ground-truth segmentation mask volume.
 * @param {import('./niftiParser.js').NiftiVolume} predVol - AI-predicted segmentation mask volume.
 * @param {{ errorRegion?: 'ET' | 'TC' | 'WT' | 'RC', overlayRegion?: 'ET' | 'TC' | 'WT' | 'RC' } | 'ET' | 'TC' | 'WT' | 'RC'} [optionsOrRegion={}]
 * @returns {SegmentationEvalResult} Per-region QA metrics, summary statistics, and 3D error overlay.
 */
export function evaluateSegmentation(gtVol, predVol, optionsOrRegion = {}) {
  const { gt, pred } = assertMatchingDims(gtVol, predVol);
  const { nx, ny, nz, dx, dy, dz, voxelVolumeMm3 } = gt;
  const nxy = nx * ny;
  const total = nxy * nz;

  const validErrorRegions = new Set(['ET', 'TC', 'WT', 'RC']);
  let requestedRegion = 'ET';
  if (typeof optionsOrRegion === 'string') {
    requestedRegion = optionsOrRegion;
  } else if (optionsOrRegion && typeof optionsOrRegion === 'object') {
    requestedRegion = optionsOrRegion.errorRegion || optionsOrRegion.overlayRegion || 'ET';
  }
  /** @type {'ET' | 'TC' | 'WT' | 'RC'} */
  const errorRegion = validErrorRegions.has(requestedRegion) ? /** @type {any} */ (requestedRegion) : 'ET';

  const gtNorm = new Uint8Array(total);
  const predNorm = new Uint8Array(total);
  const errorVolume = new Uint8Array(total);

  const regionList = /** @type {const} */ (['ET', 'TC', 'WT', 'RC']);
  const stats = {
    ET: { tp: 0, fp: 0, fn: 0, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity },
    TC: { tp: 0, fp: 0, fn: 0, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity },
    WT: { tp: 0, fp: 0, fn: 0, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity },
    RC: { tp: 0, fp: 0, fn: 0, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity },
  };

  const gtData = gt.data;
  const predData = pred.data;

  // Single-pass normalization, confusion counts, combined bounding boxes, and errorVolume
  for (let z = 0; z < nz; z++) {
    const zOff = z * nxy;
    for (let y = 0; y < ny; y++) {
      const yOff = zOff + y * nx;
      for (let x = 0; x < nx; x++) {
        const i = yOff + x;
        const gRaw = gtData[i];
        const pRaw = predData[i];
        if (gRaw === 0 && pRaw === 0) continue;

        const g = normalizeLabel(gRaw);
        const p = normalizeLabel(pRaw);
        gtNorm[i] = g;
        predNorm[i] = p;
        if (g === 0 && p === 0) continue;

        // ET: label 3
        const gET = g === 3;
        const pET = p === 3;
        if (gET || pET) {
          const s = stats.ET;
          if (gET && pET) s.tp++;
          else if (pET) s.fp++;
          else s.fn++;
          if (x < s.minX) s.minX = x;
          if (x > s.maxX) s.maxX = x;
          if (y < s.minY) s.minY = y;
          if (y > s.maxY) s.maxY = y;
          if (z < s.minZ) s.minZ = z;
          if (z > s.maxZ) s.maxZ = z;
        }

        // TC: labels 1, 3
        const gTC = g === 1 || g === 3;
        const pTC = p === 1 || p === 3;
        if (gTC || pTC) {
          const s = stats.TC;
          if (gTC && pTC) s.tp++;
          else if (pTC) s.fp++;
          else s.fn++;
          if (x < s.minX) s.minX = x;
          if (x > s.maxX) s.maxX = x;
          if (y < s.minY) s.minY = y;
          if (y > s.maxY) s.maxY = y;
          if (z < s.minZ) s.minZ = z;
          if (z > s.maxZ) s.maxZ = z;
        }

        // WT: labels 1, 2, 3
        const gWT = g === 1 || g === 2 || g === 3;
        const pWT = p === 1 || p === 2 || p === 3;
        if (gWT || pWT) {
          const s = stats.WT;
          if (gWT && pWT) s.tp++;
          else if (pWT) s.fp++;
          else s.fn++;
          if (x < s.minX) s.minX = x;
          if (x > s.maxX) s.maxX = x;
          if (y < s.minY) s.minY = y;
          if (y > s.maxY) s.maxY = y;
          if (z < s.minZ) s.minZ = z;
          if (z > s.maxZ) s.maxZ = z;
        }

        // RC: label 5
        const gRC = g === 5;
        const pRC = p === 5;
        if (gRC || pRC) {
          const s = stats.RC;
          if (gRC && pRC) s.tp++;
          else if (pRC) s.fp++;
          else s.fn++;
          if (x < s.minX) s.minX = x;
          if (x > s.maxX) s.maxX = x;
          if (y < s.minY) s.minY = y;
          if (y > s.maxY) s.maxY = y;
          if (z < s.minZ) s.minZ = z;
          if (z > s.maxZ) s.maxZ = z;
        }

        // Populate 3D errorVolume for selected errorRegion
        let gSel = false;
        let pSel = false;
        if (errorRegion === 'ET') {
          gSel = gET;
          pSel = pET;
        } else if (errorRegion === 'TC') {
          gSel = gTC;
          pSel = pTC;
        } else if (errorRegion === 'WT') {
          gSel = gWT;
          pSel = pWT;
        } else {
          gSel = gRC;
          pSel = pRC;
        }
        if (gSel) {
          errorVolume[i] = pSel ? 1 : 3; // TP : FN
        } else if (pSel) {
          errorVolume[i] = 2; // FP
        }
      }
    }
  }

  const voxToCm3 = voxelVolumeMm3 / 1000.0;
  /** @type {Record<'ET' | 'TC' | 'WT' | 'RC', RegionEvalMetrics>} */
  const regions = /** @type {any} */ ({});

  for (let rIdx = 0; rIdx < regionList.length; rIdx++) {
    const r = regionList[rIdx];
    const s = stats[r];
    const tp = s.tp;
    const fp = s.fp;
    const fn = s.fn;
    const gtCount = tp + fn;
    const predCount = tp + fp;
    const bothEmpty = gtCount === 0 && predCount === 0;

    const gtCm3 = gtCount * voxToCm3;
    const predCm3 = predCount * voxToCm3;

    const dice = bothEmpty
      ? 1.0
      : gtCount === 0 || predCount === 0
        ? 0.0
        : (2.0 * tp) / (2.0 * tp + fp + fn);

    const iou = bothEmpty ? 1.0 : tp / (tp + fp + fn);

    const sensitivity = gtCount > 0 ? tp / gtCount : predCount === 0 ? 1.0 : 0.0;
    const precision = predCount > 0 ? tp / predCount : gtCount === 0 ? 1.0 : 0.0;
    const rvePct =
      gtCm3 > 0 ? ((predCm3 - gtCm3) / gtCm3) * 100.0 : predCm3 === 0 ? 0.0 : null;

    let hd95Mm;
    let assdMm;
    if (bothEmpty) {
      hd95Mm = 0.0;
      assdMm = 0.0;
    } else if (gtCount === 0 || predCount === 0) {
      hd95Mm = null;
      assdMm = null;
    } else {
      const surfRes = computeSurfaceDistancesForRegion(
        gtNorm,
        predNorm,
        r,
        nx,
        ny,
        dx,
        dy,
        dz,
        {
          minX: s.minX,
          maxX: s.maxX,
          minY: s.minY,
          maxY: s.maxY,
          minZ: s.minZ,
          maxZ: s.maxZ,
        }
      );
      hd95Mm = surfRes.hd95Mm;
      assdMm = surfRes.assdMm;
    }

    regions[r] = {
      tp,
      fp,
      fn,
      gtCm3,
      predCm3,
      dice,
      iou,
      hd95Mm,
      assdMm,
      sensitivity,
      precision,
      rvePct,
      bothEmpty,
    };
  }

  // Summary across BraTS tumor regions ET, TC, WT
  const tumorRegions = /** @type {const} */ (['ET', 'TC', 'WT']);
  let activeDiceSum = 0;
  let activeDiceCount = 0;
  let hd95Sum = 0;
  let hd95Count = 0;

  for (let i = 0; i < tumorRegions.length; i++) {
    const m = regions[tumorRegions[i]];
    if (!m.bothEmpty) {
      activeDiceSum += m.dice;
      activeDiceCount++;
      if (m.hd95Mm !== null) {
        hd95Sum += m.hd95Mm;
        hd95Count++;
      }
    }
  }

  const summary = {
    meanDiceActive: activeDiceCount > 0 ? activeDiceSum / activeDiceCount : 1.0,
    meanHd95Mm: hd95Count > 0 ? hd95Sum / hd95Count : null,
  };

  return {
    regions,
    summary,
    errorRegion,
    errorVolume,
  };
}
