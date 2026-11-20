# NeuroScope-RANO — Engineering & Clinical Systems Architecture

**Version:** 1.0  
**Scope:** 100% client-side, zero-upload, open-access static web application for neurosurgery, neuroimaging, neuro-oncology response assessment (**RANO-Resect** & **RANO 2.0**), and AI brain-tumor segmentation QA.

---

## 1. Platform Constraints & Module Ownership

### 1.1 Runtime & Deployment Constraints
- **Zero-Build Static Architecture:** Pure HTML5, CSS3, and native ES Modules (`<script type="module">`). **No Node.js, npm, webpack, Vite, or transpiler** required. Deployable directly to GitHub Pages from repository root.
- **100% Offline & Zero Hard CDN Dependency:** Every core workflow—loading NIfTI files (`.nii` / `.nii.gz`), multi-planar Canvas rendering, 3D MIP/surface projection, clinical volumetrics, RANO-Resect, RANO 2.0, AI evaluation, SVG charts, and JSON/print report export—MUST operate completely offline with zero external CDN scripts, stylesheets, or font requests.
  - Optional progressive NiiVue WebGL2 toggle/link is permitted ONLY as a strictly lazy, user-triggered, non-blocking enhancement with automatic fallback notice when offline. The primary viewer MUST be `NeuroViewer` (native HTML5 Canvas 2D).
- **Local Tooling:** Sample dataset synthesis and reference verification scripts MUST use **Python 3.12 standard library only** (`struct`, `gzip`, `math`, `json`, `random`, `pathlib`, `collections`, `unittest`)—zero third-party packages (`numpy`, `scipy`, `nibabel` are unavailable).
- **Privacy Guarantee:** Zero network transmission of user-loaded medical imaging files. All `File` objects stay strictly inside browser memory.

### 1.2 Repository File Map & Parallel Agent Ownership
```text
neuroscope-rano/
├── ARCHITECTURE.md                      # This canonical specification
├── index.html                           # Single-page workstation shell (UI Agent)
├── css/
│   └── styles.css                       # Radiology dark-slate theme & layout (UI Agent)
├── js/
│   ├── niftiParser.js                   # NIfTI-1 binary/.nii.gz parser (Core Engine Agent)
│   ├── metricsEngine.js                 # Volumetrics, 2D RANO, RANO-Resect, RANO 2.0, AI QA (Core Engine Agent)
│   ├── viewer.js                        # Multi-planar + 3D MIP/Surface Canvas NeuroViewer (Viewer Agent)
│   └── app.js                           # Workstation state, UI wiring, SVG charts, export (UI Agent)
├── assets/
│   └── samples/                         # Generated deterministic synthetic dataset (Data Agent)
│       ├── manifest.json
│       ├── case01_preop_t1ce.nii.gz
│       ├── case01_preop_gt.nii.gz
│       ├── case01_preop_pred.nii.gz
│       ├── case01_postop_t1ce.nii.gz
│       ├── case01_postop_mask.nii.gz
│       ├── case01_followup_t1ce.nii.gz
│       └── case01_followup_mask.nii.gz
├── scripts/
│   ├── generate_samples.py              # Python 3.12 stdlib synthetic NIfTI-1 generator (Data Agent)
│   └── verify_reference.py              # Python 3.12 stdlib ground-truth verification suite (QA Agent)
└── tests/
    └── test.html                        # Browser-native ES module unit/integration test runner (QA Agent)
```

---

## 2. NIfTI-1 Coordinate Space & BraTS + Post-Op Label Convention

### 2.1 Memory Layout & Coordinate Convention
All modules (`generate_samples.py`, `niftiParser.js`, `metricsEngine.js`, `viewer.js`) MUST share the exact voxel indexing and anatomical axis convention:
- **Linear Voxel Index (NIfTI Fortran/column-major order):**
  ```js
  idx = x + y * nx + z * nx * ny
  ```
  where `0 <= x < nx`, `0 <= y < ny`, `0 <= z < nz`.
- **Canonical Orientation (RAS+):**
  - `x`: Left (`0`) -> Right (`nx - 1`)
  - `y`: Posterior (`0`) -> Anterior (`ny - 1`)
  - `z`: Inferior (`0`) -> Superior (`nz - 1`)
- **Radiological Display Convention (Default in `NeuroViewer`):**
  - **Axial (XY at slice `iz`):** Patient Right (`high x`) on Viewer Left (`screenX = 0`, label `R`); Patient Left (`low x`) on Viewer Right (`L`); Anterior (`high y`) at Top (`A`); Posterior (`low y`) at Bottom (`P`).
  - **Coronal (XZ at slice `iy`):** Patient Right (`high x`) on Viewer Left (`R`); Patient Left (`low x`) on Viewer Right (`L`); Superior (`high z`) at Top (`S`); Inferior (`low z`) at Bottom (`I`).
  - **Sagittal (YZ at slice `ix`):** Anterior (`high y`) on Viewer Left (`A`); Posterior (`low y`) on Viewer Right (`P`); Superior (`high z`) at Top (`S`); Inferior (`low z`) at Bottom (`I`).
- **Physical Volume Conversion:**
  - `voxelVolumeMm3 = dx * dy * dz` (where `[dx, dy, dz] = pixdim` in `mm`).
  - `volumeCm3 = (voxelCount * voxelVolumeMm3) / 1000.0`.

### 2.2 Exact Segmentation Label Standard (BraTS 2023/2024 + Post-Op)

| Canonical Label | Code | Clinical Meaning | Overlay Color (Hex) | RGB Tuple |
| :---: | :---: | :--- | :---: | :---: |
| `0` | `BG` | Background / Normal Brain | Transparent | `(0, 0, 0)` |
| `1` | `NCR` | Necrotic / Non-Enhancing Tumor Core (NCR/NET) | `#f43f5e` (Rose) | `(244, 63, 94)` |
| `2` | `ED` | Peritumoral Edema / Infiltrated FLAIR (ED) | `#f59e0b` (Amber) | `(245, 158, 11)` |
| `3` | `ET` | Enhancing Tumor (ET) *(legacy BraTS `4` auto-mapped to `3`)* | `#38bdf8` (Cyan) | `(56, 189, 248)` |
| `5` | `RC` | Surgical Resection Cavity (RC) | `#a855f7` (Violet) | `(168, 85, 247)` |

- **Legacy BraTS Label `4` Auto-Mapping Rule:**
  - `niftiParser.js` MUST preserve raw voxel values in `Float32Array` (so grayscale MRI intensity `4.0` is never corrupted).
  - Every mask-consuming function in `metricsEngine.js` and `viewer.js` MUST pass mask values through `normalizeLabel(v)`, which rounds `v` and maps legacy BraTS label `4 -> 3`.
- **Composite Regions:**
  - `WT` (Whole Tumor): canonical `{1, 2, 3}` (raw `{1, 2, 3, 4}`) — excludes `0` and `5` (cavity is non-tumor).
  - `TC` (Tumor Core): canonical `{1, 3}` (raw `{1, 3, 4}`).
  - `ET` (Enhancing Tumor / CE): canonical `{3}` (raw `{3, 4}`).
  - `RC` (Resection Cavity): canonical `{5}`.
  - `nonCE` (Non-Contrast-Enhancing Tumor compartment for RANO-Resect): canonical `{1, 2}` (`WT \ ET`).
- **3D AI Error Overlay Codes (`errorVolume: Uint8Array`):**
  - `0`: `TN` (True Negative) — Transparent
  - `1`: `TP` (True Positive) — `#22c55e` (Emerald, RGB `34, 197, 94`)
  - `2`: `FP` (False Positive / Over-segmentation) — `#f43f5e` (Rose, RGB `244, 63, 94`)
  - `3`: `FN` (False Negative / Missed tumor) — `#38bdf8` (Sky Cyan, RGB `56, 189, 248`)

---

## 3. Sample Dataset Specification (`assets/samples/`)

Generated deterministically by `scripts/generate_samples.py` using Python 3.12 stdlib only (fixed PRNG seed, valid NIfTI-1 `sizeof_hdr = 348`, little-endian, magic `b"n+1\x00"`, `vox_offset = 352.0`, `scl_slope = 1.0`, `scl_inter = 0.0`, `sform_code = 1` with RAS diagonal affine `diag(2, 2, 2)`).

### 3.1 Volume Geometry & Datatypes
- **Dimensions:** `64 × 64 × 48` (`196,608` voxels).
- **Voxel Spacing (`pixdim[1..3]`):** `2.0 × 2.0 × 2.0 mm` isotropic (`voxelVolumeMm3 = 8.0 mm³ = 0.008 cm³`).
- **T1ce MRI volumes:** NIfTI datatype `4` (`INT16`), intensity range approximately `0..1000` (background `0`, CSF/ventricles/necrosis/cavity `~80–160`, edema `~260–340`, cortical gray matter `~420–500`, white matter `~560–650`, skull/scalp rim `~180/380`, contrast-enhancing tumor `~780–950` with realistic deterministic intensity texture & noise).
- **Segmentation mask volumes:** NIfTI datatype `2` (`UINT8`), exact integer values from `{0, 1, 2, 3, 5}`.

### 3.2 Required Files (`assets/samples/`)

| File | Datatype | Contents & Clinical Design Targets |
| :--- | :---: | :--- |
| `case01_preop_t1ce.nii.gz` | `INT16` | Realistic synthetic brain (scalp/skull, folded GM/WM cortex, lateral ventricles, midline falx, cerebellum) + **Right Frontal** (`x ≈ 42–45`, `y ≈ 38–42`, `z ≈ 25–28`) ring-enhancing GBM with central necrotic hypointensity, bright irregular enhancing ring, peritumoral hypointense edema, and subtle ipsilateral ventricular mass effect. |
| `case01_preop_gt.nii.gz` | `UINT8` | Ground-truth mask with labels `1` (NCR, ~5–8 cm³), `3` (ET ring, ~16–22 cm³, measurable axial SPD ~900–1300 mm²), and `2` (peritumoral ED, ~25–35 cm³). |
| `case01_preop_pred.nii.gz` | `UINT8` | Simulated AI prediction derived deterministically from `case01_preop_gt` with realistic boundary jitter, small medial FP protrusion, subtle lateral FN under-segmentation, and minor NCR/ET boundary shift. **Calibration target:** `ET` Dice `0.86–0.92`, `TC` Dice `0.88–0.93`, `WT` Dice `0.89–0.94`, non-zero `HD95` (`2.0–6.5 mm`) and `ASSD` (`0.4–1.5 mm`). |
| `case01_postop_t1ce.nii.gz` | `INT16` | Early `<72h` post-operative T1ce showing fluid-filled right frontal resection cavity, subtle thin post-op cavity wall, small nodular/crescentic residual enhancing focus along the posterior-medial wall, and relieved mass effect. |
| `case01_postop_mask.nii.gz` | `UINT8` | Label `5` (RC, ~18–24 cm³), small residual label `3` (ET, **`0.55–0.85 cm³`**, achieving **`95.5%–97.5%` CE EOR** -> cleanly classifies as **RANO-Resect Class 2B: Near-Total CE Resection**), and reduced label `2` (ED, ~10–15 cm³). Zero label `1`. |
| `case01_followup_t1ce.nii.gz` | `INT16` | 6-month follow-up T1ce showing mildly contracted resection cavity + clearly enlarged nodular enhancing recurrence along the posterior-medial cavity margin + recurrent surrounding edema. |
| `case01_followup_mask.nii.gz` | `UINT8` | Label `5` (RC, ~14–18 cm³), enlarged label `3` (ET, **`4.5–6.5 cm³`**, measurable axial SPD **`>= 300 mm²`**, `>> +25%` SPD and `>> +40%` volume vs post-op baseline -> cleanly classifies as **RANO 2.0 PD** at >12 wks post-RT), and expanded label `2` (ED, ~18–24 cm³). |
| `manifest.json` | JSON | Case metadata, file paths, longitudinal dates, dexamethasone doses, and clinical co-factors (exact schema below). |

### 3.3 Exact `assets/samples/manifest.json` Schema
```json
{
  "schemaVersion": "1.0",
  "cases": [
    {
      "id": "case01",
      "title": "Case 01 — Right Frontal Glioblastoma (IDH-wildtype)",
      "diagnosis": "Glioblastoma, IDH-wildtype, CNS WHO Grade 4",
      "location": "Right Frontal Lobe",
      "molecularProfile": "IDH-wildtype | MGMT promoter unmethylated | TERTp mutant",
      "syntheticNote": "Synthetic procedural phantom for research & educational demonstration only.",
      "timepoints": [
        {
          "id": "preop",
          "label": "Pre-Op Diagnostic",
          "role": "preop",
          "dayOffset": 0,
          "date": "2025-01-10",
          "t1ce": "assets/samples/case01_preop_t1ce.nii.gz",
          "mask": "assets/samples/case01_preop_gt.nii.gz",
          "predMask": "assets/samples/case01_preop_pred.nii.gz",
          "dexamethasoneMgPerDay": 8,
          "steroids": "stable_or_decreased",
          "clinicalStatus": "stable_or_improved",
          "kps": 80,
          "newMeasurableLesion": false,
          "within12WeeksPostRT": false,
          "notes": "Baseline diagnostic MRI showing right frontal ring-enhancing necrotic mass with surrounding FLAIR edema."
        },
        {
          "id": "postop",
          "label": "Early Post-Op (<72h)",
          "role": "baseline_postop",
          "dayOffset": 2,
          "date": "2025-01-12",
          "t1ce": "assets/samples/case01_postop_t1ce.nii.gz",
          "mask": "assets/samples/case01_postop_mask.nii.gz",
          "predMask": null,
          "dexamethasoneMgPerDay": 4,
          "steroids": "stable_or_decreased",
          "clinicalStatus": "stable_or_improved",
          "kps": 90,
          "newMeasurableLesion": false,
          "within12WeeksPostRT": true,
          "notes": "Early post-operative MRI (<72h) demonstrating right frontal resection cavity with small posterior-medial residual enhancing focus. Under RANO 2.0 (Wen et al., JCO 2023), post-radiotherapy MRI (~4 weeks post-RT) is the standard baseline for newly diagnosed gliomas treated with RT; Case 01 uses this early post-op scan as an illustrative pre-RT/surgical baseline."
        },
        {
          "id": "followup",
          "label": "6-Month Follow-Up",
          "role": "followup",
          "dayOffset": 182,
          "date": "2025-07-11",
          "t1ce": "assets/samples/case01_followup_t1ce.nii.gz",
          "mask": "assets/samples/case01_followup_mask.nii.gz",
          "predMask": null,
          "dexamethasoneMgPerDay": 8,
          "steroids": "increased",
          "clinicalStatus": "deteriorated",
          "kps": 70,
          "newMeasurableLesion": false,
          "within12WeeksPostRT": false,
          "notes": "6-month surveillance scan (>12 wks post-RT) showing nodular enhancing progression along posterior-medial resection margin with increased edema and mild left-hand weakness."
        }
      ]
    }
  ]
}
```

---

## 4. Exact Exported ES Module APIs

### 4.1 `js/niftiParser.js`

#### Exported Functions
1. `export async function parseNiftiBuffer(arrayBuffer)` -> `Promise<NiftiVolume>`
   - **Gzip Handling:** Checks magic bytes `0x1f, 0x8b`. When gzipped, decompresses using native `DecompressionStream('gzip')` (`new Response(new Blob([arrayBuffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()`). If `typeof DecompressionStream === 'undefined'`, throws an informative `Error` directing the user to use a modern browser or uncompressed `.nii`.
   - **Header Parsing (NIfTI-1, 348 bytes):**
     - Auto-detects endianness by checking `int32` `sizeof_hdr === 348` (LE first, then BE). Rejects invalid headers or NIfTI-2 (`540`) with descriptive errors.
     - Validates single-file magic (`"n+1\0"`). Rejects split `.hdr/.img` (`"ni1\0"`) with a clear error message.
     - Reads `dims = [Math.max(1, dim[1]), Math.max(1, dim[2]), Math.max(1, dim[3])]`. If 4D (`dim[0] >= 4 && dim[4] > 1`), parses volume `t = 0` and records `nt = dim[4]` in `header`.
     - Reads `pixdim = [Math.abs(pixdim[1]) || 1.0, Math.abs(pixdim[2]) || 1.0, Math.abs(pixdim[3]) || 1.0]`.
     - Computes `voxelVolumeMm3 = pixdim[0] * pixdim[1] * pixdim[2]`.
     - Supports NIfTI-1 datatypes: `2` (`UINT8`), `4` (`INT16`), `8` (`INT32`), `16` (`FLOAT32`), `64` (`FLOAT64`), `256` (`INT8`), `512` (`UINT16`), `768` (`UINT32`), handling both endiannesses and arbitrary `vox_offset` alignment safely.
     - Applies NIfTI-1 intensity scaling ONLY when `scl_slope !== 0 && Number.isFinite(scl_slope)`: `val = raw * scl_slope + scl_inter`. Replaces non-finite values (`NaN`, `±Infinity`) with `0`.
     - Computes exact finite `min` and `max` across `data`.
   - **Return Object (`NiftiVolume`):**
     ```js
     {
       dims: [nx, ny, nz],
       pixdim: [dx, dy, dz],
       voxelVolumeMm3: number,
       datatype: number,
       data: Float32Array,        // length nx * ny * nz, idx = x + y*nx + z*nx*ny
       min: number,
       max: number,
       header: {
         sizeofHdr: number,
         littleEndian: boolean,
         magic: string,
         bitpix: number,
         voxOffset: number,
         sclSlope: number,
         sclInter: number,
         qformCode: number,
         sformCode: number,
         sform: [[number,number,number,number], [number,number,number,number], [number,number,number,number]],
         descrip: string,
         nt: number
       }
     }
     ```
2. `export async function fetchNifti(url)` -> `Promise<NiftiVolume>`
   - Fetches `url`, asserts `response.ok` (throws with HTTP status on failure), reads `arrayBuffer()`, returns `parseNiftiBuffer(buffer)`.
3. `export async function loadNiftiFile(file)` -> `Promise<NiftiVolume>`
   - Reads `await file.arrayBuffer()` from a browser `File` or `Blob`, returns `parseNiftiBuffer(buffer)`.

---

### 4.2 `js/metricsEngine.js`

#### Exported Constants & Label Helpers
- `export const LABEL_META` — metadata dictionary for labels `1`, `2`, `3`, `5` (`{ code, name, color, rgb }`).
- `export const ERROR_META` — metadata dictionary for error codes `1` (`TP`), `2` (`FP`), `3` (`FN`).
- `export function normalizeLabel(v)` -> `0 | 1 | 2 | 3 | 5`
  - `const r = Math.round(v); if (r === 4) return 3; if (r === 1 || r === 2 || r === 3 || r === 5) return r; return 0;`
- `export function isInRegion(normLabel, region)` -> `boolean`
  - `'ET'`: `normLabel === 3`
  - `'TC'`: `normLabel === 1 || normLabel === 3`
  - `'WT'`: `normLabel === 1 || normLabel === 2 || normLabel === 3`
  - `'RC'`: `normLabel === 5`
  - `'nonCE'`: `normLabel === 1 || normLabel === 2`

#### 1. `export function computeVolumetrics(maskVol)` -> `VolumetricsResult`
Computes single-pass voxel counts, `volumeMm3`, `volumeCm3`, voxel `centroid` (`[cx, cy, cz]` or `null`), axis-aligned `bbox` (`{ minX, maxX, minY, maxY, minZ, maxZ }` or `null`), and equivalent spherical diameter `eqSphereDiamMm = 2 * Math.cbrt((3 * volumeMm3) / (4 * Math.PI))` for individual labels `{ 1, 2, 3, 5 }` and composite regions `{ WT, TC, ET, RC, nonCE }`, plus automated axial 2D RANO diameters on `ET`.

- **Automated Axial 2D Maximal Perpendicular Diameters (`export function computeAxial2DDiameters(maskVol, region = 'ET')`):**
  1. For each axial slice `z ∈ [0, nz - 1]` containing voxels in `region`:
     - Partition target voxels on slice `z` into 8-connected 2D components (prevents measuring empty parenchyma across separate multifocal lesions).
     - For each component, extract its 4-connected boundary pixels and physical 2D centers `(x * dx, y * dy)`.
     - Find the farthest boundary pair `(p1, p2)` maximizing Euclidean center distance `centerDist = hypot((x2 - x1)*dx, (y2 - y1)*dy)`.
       - Unit major vector `u = (ux, uy)` (for a single-voxel component, default `u = (1, 0)`).
       - Physical major diameter including half-voxel extent on both ends: `d1Mm = centerDist + Math.hypot(ux * dx, uy * dy)`.
     - Unit perpendicular vector `v = (-uy, ux)`.
     - To find the maximal perpendicular cross-sectional diameter `d2Mm` without inflating across hollow concavities:
       - Project all component boundary points onto `u` (`t = px * ux + py * uy`) and `v` (`s = px * vx + py * vy`).
       - Quantize `t` into bins of width `binW = Math.max(dx, dy)` (also checking half-bin shifted offsets `t + binW/2` to avoid bin-edge splitting).
       - In each bin containing points, compute `span = max(s) - min(s)` between its extreme points `(qMin, qMax)`. Select the bin maximizing `span`.
       - Physical minor diameter: `d2Mm = span + Math.hypot(vx * dx, vy * dy)`.
       - Project `(qMin, qMax)` onto the exact perpendicular line passing through their midpoint `tMid = 0.5 * (t(qMin) + t(qMax))` so the rendered `minorLine` is visually orthogonal to `majorLine` in physical space, then convert endpoints back to voxel coordinates `{ x1, y1, x2, y2 }`.
     - Compute `spdMm2 = d1Mm * d2Mm`.
  2. Across all slices and components, pick the measurement maximizing `spdMm2` (tie-break by `d1Mm`, then component pixel count).
  3. Measurability per RANO 2.0: `measurable = (d1Mm >= 10.0 && d2Mm >= 10.0)`.
- **Return Shape:**
  ```js
  {
    dims: [nx, ny, nz],
    pixdim: [dx, dy, dz],
    voxelVolumeMm3: number,
    labels: { 1: RegionMetrics, 2: RegionMetrics, 3: RegionMetrics, 5: RegionMetrics },
    regions: { WT: RegionMetrics, TC: RegionMetrics, ET: RegionMetrics, RC: RegionMetrics, nonCE: RegionMetrics },
    rano2d: {
      region: 'ET',
      d1Mm: number,
      d2Mm: number,
      spdMm2: number,
      bestSliceZ: number | null,
      measurable: boolean,
      majorLine: { x1: number, y1: number, x2: number, y2: number } | null,
      minorLine: { x1: number, y1: number, x2: number, y2: number } | null,
      sliceAreaMm2: number,
      componentCountOnSlice: number
    }
  }
  ```

#### 2. `export function computeExtentOfResection(preMaskVol, postMaskVol)` -> `EorResult`
- Compartment mapping:
  - `CE` = `ET` (canonical label `3`)
  - `nonCE` = `NCR + ED` (canonical labels `1 | 2`)
  - `cavity` = `RC` (canonical label `5`)
- Percentage EOR:
  - `ceEorPct = preCeCm3 > 0 ? clamp(((preCeCm3 - residualCeCm3) / preCeCm3) * 100, 0, 100) : 0`
  - `nonCeEorPct = preNonCeCm3 > 0 ? clamp(((preNonCeCm3 - residualNonCeCm3) / preNonCeCm3) * 100, 0, 100) : 0`
- **Official RANO-Resect Classification Rules (Karschnia et al., *Neuro-Oncology* 2023; evaluated strictly in order, `EPS = 1e-6`):**
  0. **`N/A` — Zero Pre-Op CE Guard:** `preCeCm3 <= EPS` (empty pre-op mask or non-enhancing tumor; CE resection classes 1–4 not assigned)
  1. **`Class 4` — Biopsy:** `ceEorPct < 10.0` (no cytoreductive CE resection)
  2. **`Class 1` — Supramaximal CE Resection:** `residualCeCm3 <= EPS && residualNonCeCm3 <= 5.0`
  3. **`Class 2A` — Complete CE Resection:** `residualCeCm3 <= EPS && residualNonCeCm3 > 5.0`
  4. **`Class 2B` — Near-Total CE Resection:** `residualCeCm3 <= 1.0` *(CE EOR% reported for reference)*
  5. **`Class 3A` — Subtotal CE Resection:** `residualCeCm3 > 1.0 && residualCeCm3 <= 5.0` *(CE EOR% reported for reference)*
  6. **`Class 3B` — Partial CE Resection:** `residualCeCm3 > 5.0` *(with `ceEorPct >= 10.0`)*
- **Return Shape:**
  ```js
  {
    preCeCm3: number,
    preNonCeCm3: number,
    preWtCm3: number,
    residualCeCm3: number,
    residualNonCeCm3: number,
    residualWtCm3: number,
    cavityCm3: number,
    ceEorPct: number,
    nonCeEorPct: number,
    ranoClass: 'Class 1' | 'Class 2A' | 'Class 2B' | 'Class 3A' | 'Class 3B' | 'Class 4',
    ranoClassName: string,
    ranoClassDescription: string,
    rationale: string[]
  }
  ```

#### 3. `export function computeRano2Response(timepoints)` -> `Rano2Result`
- Input: chronologically ordered array of >= 2 timepoint objects (`timepoints[0]` = RANO 2.0 baseline, i.e., post-RT MRI ~4 wks post-RT for newly diagnosed RT-treated gliomas, or early post-op MRI when RT is not given / for pre-RT therapy; `timepoints[last]` = current follow-up):
  ```js
  {
    id: string,
    label: string,
    date?: string,
    spdMm2: number,
    volumeCm3: number,
    steroids: 'none_or_physiologic' | 'stable_or_decreased' | 'increased',
    clinicalStatus: 'stable_or_improved' | 'deteriorated',
    newMeasurableLesion: boolean,
    within12WeeksPostRT: boolean
  }
  ```
- Computes `baseline` (`timepoints[0]`), `nadir` (minimum `spdMm2` and minimum `volumeCm3` across `timepoints[0 .. n-2]`), and percentage changes vs both baseline and nadir (returns `null` rather than `Infinity` when denominator is `0` and current `> 0`, noting emergence from `0` in `rationale`).
- **Official RANO 2.0 Decision Logic (Wen et al., *JCO* 2023):**
  1. **Progression Triggers:**
     - `spdProgression`: `(nadirSpd > 0 && spdChangeVsNadirPct >= 25.0)` OR `(nadirSpd === 0 && current.spdMm2 >= 100.0)`
     - `volProgression`: `(nadirVol > 0 && volChangeVsNadirPct >= 40.0)` OR `(nadirVol === 0 && current.volumeCm3 >= 1.0)`
     - `newLesion`: `current.newMeasurableLesion === true`
     - `clinicalDeterioration`: `current.clinicalStatus === 'deteriorated'`
     - If any progression trigger holds:
       - If `current.within12WeeksPostRT === true && radiographicProgression && !clinicalDeterioration` (clinically stable within <=12w post-RT pseudoprogression window) -> **`Preliminary PD (Confirm >=4 wks)`** (`shortCode: 'PRELIM_PD'`, `severity: 'warning'`).
       - Else (including any unequivocal clinical deterioration) -> **`PD`** (`shortCode: 'PD'`, `severity: 'progression'`).
  2. **Response Triggers (require `clinicalStatus === 'stable_or_improved'`, `!newMeasurableLesion`, and baseline enhancing disease):**
     - **`CR` (Complete Response):** `(baseline.spdMm2 > 1e-6 || baseline.volumeCm3 > 1e-6) && current.spdMm2 <= 1e-6 && current.volumeCm3 <= 1e-6` AND `steroids === 'none_or_physiologic'` (if on therapeutic `stable_or_decreased` steroids, downgraded to **`PR`** with `steroidBlockedResponse: true`).
     - **`PR` (Partial Response):** `(baselineSpd > 0 && spdChangeVsBaselinePct <= -50.0)` OR `(baselineVol > 0 && volChangeVsBaselinePct <= -65.0)` on `none_or_physiologic` or `stable_or_decreased` steroids.
     - **`MR` (Minor Response):** `(baselineSpd > 0 && spdChangeVsBaselinePct <= -25.0)` OR `(baselineVol > 0 && volChangeVsBaselinePct <= -40.0)` on `none_or_physiologic` or `stable_or_decreased` steroids.
     - If radiographic `CR`/`PR`/`MR` thresholds are met BUT `steroids === 'increased'`, downgrade to **`SD`** (`steroidBlockedResponse: true`) and append an explicit rationale bullet.
  3. **Otherwise (including `0 -> 0` trajectories with no baseline enhancing disease):** **`SD`** (Stable Disease, `severity: 'neutral'`).
- **Return Shape:**
  ```js
  {
    category: 'CR' | 'PR' | 'MR' | 'SD' | 'PD' | 'Preliminary PD (Confirm >=4 wks)' | 'Baseline Only',
    shortCode: 'CR' | 'PR' | 'MR' | 'SD' | 'PD' | 'PRELIM_PD' | 'BASELINE',
    severity: 'favorable' | 'neutral' | 'warning' | 'progression',
    baseline: { label: string, spdMm2: number, volumeCm3: number },
    nadir: { spdMm2: number, volumeCm3: number, spdLabel: string, volumeLabel: string },
    current: { label: string, spdMm2: number, volumeCm3: number, steroids: string, clinicalStatus: string, newMeasurableLesion: boolean, within12WeeksPostRT: boolean },
    spdChangeVsBaselinePct: number | null,
    spdChangeVsNadirPct: number | null,
    volChangeVsBaselinePct: number | null,
    volChangeVsNadirPct: number | null,
    criteriaTriggered: {
      spdProgression: boolean,
      volProgression: boolean,
      newLesion: boolean,
      clinicalDeterioration: boolean,
      steroidBlockedResponse: boolean,
      confirmationRequired: boolean
    },
    rationale: string[]
  }
  ```

#### 4. `export function evaluateSegmentation(gtVol, predVol, options = {})` -> `SegmentationEvalResult`
- Validates `gtVol.dims` equals `predVol.dims` (throws descriptive `Error` if mismatched).
- `options.errorRegion`: `'ET' | 'TC' | 'WT' | 'RC'` (default `'ET'`).
- Also exports `export function buildErrorVolume(gtVol, predVol, region = 'ET')` -> `Uint8Array` so the viewer can switch the 3D `TP/FP/FN` overlay region instantaneously without recomputing surface distances.
- **Metrics per Region (`ET`, `TC`, `WT`, `RC`):**
  - `dice`: `gt===0 && pred===0 ? 1 : (gt===0 || pred===0 ? 0 : (2*tp)/(2*tp + fp + fn))`
  - `iou`: `gt===0 && pred===0 ? 1 : tp / (tp + fp + fn)`
  - `sensitivity`: `gt > 0 ? tp / (tp + fn) : (pred === 0 ? 1 : 0)`
  - `precision`: `pred > 0 ? tp / (tp + fp) : (gt === 0 ? 1 : 0)`
  - `gtCm3`, `predCm3`: volumes in `cm³`
  - `rvePct`: `gtCm3 > 0 ? ((predCm3 - gtCm3) / gtCm3) * 100 : (predCm3 === 0 ? 0 : null)`
  - **`hd95Mm` & `assdMm` (Exact Anisotropic 3D Surface Distances):**
    - Extract 6-connected binary surface voxels `S_gt` and `S_pred`.
    - Both empty -> `hd95Mm = 0`, `assdMm = 0`. Exactly one empty -> `hd95Mm = null`, `assdMm = null`.
    - Compute exact anisotropic 3D Euclidean Distance Transform (`dx²`, `dy²`, `dz²`) using the **Felzenszwalb-Huttenlocher separable 1D parabolic lower-envelope algorithm** inside the tight combined bounding box of `GT ∪ Pred` (O(N_bbox), exact in physical mm, real-time even on full 240×240×155 BraTS scans).
    - Let `D = concat(d(S_gt -> S_pred), d(S_pred -> S_gt))` in mm:
      - `assdMm = mean(D)`
      - `hd95Mm = percentileLinear(D, 95)` (matches `medpy.metric.binary.hd95` / BraTS challenge standard).
- **Return Shape:**
  ```js
  {
    regions: {
      ET: RegionEvalMetrics, // { tp, fp, fn, gtCm3, predCm3, dice, iou, hd95Mm, assdMm, sensitivity, precision, rvePct, bothEmpty }
      TC: RegionEvalMetrics,
      WT: RegionEvalMetrics,
      RC: RegionEvalMetrics
    },
    summary: {
      meanDiceActive: number, // mean Dice across ET, TC, WT where !bothEmpty
      meanHd95Mm: number | null
    },
    errorRegion: 'ET' | 'TC' | 'WT' | 'RC',
    errorVolume: Uint8Array   // length nx*ny*nz; 0=TN, 1=TP, 2=FP, 3=FN
  }
  ```

---

### 4.3 `js/viewer.js`

#### Exported Class: `export class NeuroViewer`

```js
export class NeuroViewer {
  constructor(canvases, options = {})
}
```
- `canvases`: `{ axial: HTMLCanvasElement, coronal: HTMLCanvasElement, sagittal: HTMLCanvasElement, mip3d: HTMLCanvasElement }`
- `options`:
  - `onCrosshairChange?: ({ ix, iy, iz, mmX, mmY, mmZ, intensity, label, errorCode }) => void`
  - `onWindowLevelChange?: ({ windowWidth, windowLevel }) => void`
  - `showCrosshairs?: boolean` (default `true`)
  - `showCalipers?: boolean` (default `true`)
  - `showOrientationLabels?: boolean` (default `true`)
  - `maskOpacity?: number` (default `0.55`)

#### Public Methods
| Method | Behavior |
| :--- | :--- |
| `setVolume(niftiVol)` | Sets grayscale MRI volume, centers crosshair `(⌊nx/2⌋, ⌊ny/2⌋, ⌊nz/2⌋)`, auto-computes smart W/L from non-zero intensity percentiles (`p1`..`p99.5`), renders all 4 canvases. |
| `setMask(maskVol \| null)` | Sets segmentation mask volume (interpreted via `normalizeLabel`), updates 2D & 3D renders. |
| `setErrorVolume(uint8Array \| null, regionName = 'ET')` | Sets 3D error volume (`0=TN, 1=TP, 2=FP, 3=FN`) for QA overlay mode. |
| `setErrorOverlayMode(enabled)` | Switches overlay rendering between BraTS labels (`false`) and TP/FP/FN error colors (`true`). |
| `setRanoCalipers(rano2d \| null)` | Stores axial RANO 2D caliper geometry. Draws crisp vector calipers (`d1` in `#2dd4bf` teal solid, `d2` in `#fde047` yellow dashed, endpoint ticks, mm annotations) on Axial canvas whenever `iz === rano2d.bestSliceZ` and `showCalipers === true`. |
| `setCrosshair(ix, iy, iz, emit = true)` | Clamps indices, updates all 3 orthogonal views + crosshair line overlays, emits `onCrosshairChange`. |
| `jumpToCentroid(centroid)` | Jumps crosshair to rounded `[cx, cy, cz]` if non-null. |
| `setWindowLevel(windowWidth, windowLevel)` | Updates W/L (`windowWidth >= 1e-3`), re-renders all 4 views. |
| `resetWindowLevel()` | Restores auto-percentile W/L for current MRI volume. |
| `setMaskOpacity(opacity)` | Clamps `[0, 1]`, re-renders overlays. |
| `setLabelVisibility(labelId, visible)` | Toggles visibility for canonical label `1`, `2`, `3`, or `5` (and re-renders 2D + 3D). |
| `setShowCrosshairs(show)` | Toggles orthogonal crosshair lines. |
| `setShowCalipers(show)` | Toggles RANO 2D caliper overlay. |
| `set3DMode(mode)` | `'mip'` (rotatable grayscale MRI MIP + alpha-blended colored tumor MIP) or `'tumor_surface'` (rotatable depth-shaded 3D volumetric tumor/error surface over translucent brain contour). |
| `set3DRotation(yawRad, pitchRad)` | Updates orbital 3D camera angles and re-renders `mip3d`. |
| `getState()` | Returns `{ ix, iy, iz, windowWidth, windowLevel, autoWindowWidth, autoWindowLevel, maskOpacity, labelVisibility, errorOverlayMode, showCrosshairs, showCalipers, mode3d, yaw, pitch }`. |
| `resize()` | Syncs all 4 canvases to CSS container size × `window.devicePixelRatio`, preserving physical `pixdim` aspect ratios, and re-renders. |
| `destroy()` | Detaches all event listeners (`pointerdown`, `pointermove`, `pointerup`, `wheel`, `contextmenu`, `dblclick`, `resize`) and cancels pending `requestAnimationFrame` work. |

#### Interaction Model
- **Orthogonal Canvases (`axial`, `coronal`, `sagittal`):**
  - Left-click / pointer-drag: updates crosshair `(ix, iy, iz)` live across all 3 planes.
  - Mouse wheel: increments/decrements the slice index orthogonal to the hovered plane (`iz` on Axial, `iy` on Coronal, `ix` on Sagittal).
  - Right-click drag OR `Shift + Left-drag`: radiology Window/Level adjustment (horizontal -> `windowWidth`, vertical -> `windowLevel`).
- **3D MIP / Surface Canvas (`mip3d`):**
  - Left-drag: smooth orbital rotation (`yaw`, `pitch`), with adaptive fast stride while dragging and full-quality settle on pointer release so even large user-uploaded volumes stay responsive.
  - Double-click: resets camera to oblique right-anterior view (`yaw = -0.55`, `pitch = 0.25`).
- **Rendering Details:**
  - Composites grayscale slice + mask/error colors into offscreen `ImageData` at native slice resolution, scales cleanly onto the HiDPI viewport canvas preserving physical `pixdim` aspect ratio (`nx*dx` vs `ny*dy`, etc.), then draws crisp vector crosshairs, orientation letters (`R`/`L`/`A`/`P`/`S`/`I`), slice indicator, and RANO 2D calipers on top.

---

## 5. UI Aesthetic, Clinical UX & Workstation Layout

### 5.1 Visual Design System (`css/styles.css`)
- **Color Palette (Deep Radiology Workstation Dark Slate):**
  - Primary canvas background: `#0b0f17`
  - Elevated panels & cards: `#121826`
  - Interactive control surfaces: `#1a2234`
  - Subtle borders: `rgba(148, 163, 184, 0.16)`
  - Primary / Secondary / Muted text: `#f1f5f9` / `#94a3b8` / `#64748b`
  - Accents: Crisp Cyan `#38bdf8`, Medical Teal `#2dd4bf`, Amber `#f59e0b`, Rose `#f43f5e`, Violet `#a855f7`, Emerald `#22c55e`
- **Typography:** Zero-CDN system sans stack (`'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`) + tabular monospace (`'JetBrains Mono', ui-monospace, SFMono-Regular, Consolas, monospace`; `font-variant-numeric: tabular-nums`) for all clinical metrics, coordinates, and tables.

### 5.2 Mandatory Trust, Privacy & Regulatory Chrome
1. **Privacy Badge (always visible in header):** High-contrast emerald/teal pill displaying:
   > `100% Browser-Local — Zero Data Uploaded`
2. **Clinical Safety Banner (always visible at top of workstation):** Slim amber-accented clinical warning banner displaying:
   > `Research & Educational Tool — Not FDA/CE Approved for Clinical Diagnosis`

### 5.3 Workstation Structure (`index.html` & `js/app.js`)
- **Header Bar:** App brand (`NeuroScope-RANO`), sample timepoint quick-switcher (`Pre-Op` | `Post-Op <72h` | `6-Mo Follow-Up`), local NIfTI upload triggers (`MRI`, `GT/Mask`, `AI Pred`) + drag-and-drop overlay, JSON/Print Report Export button, Privacy Badge.
- **Left/Center Pane (Multi-Planar & 3D Quad Viewer):**
  - Compact viewer control strip: Window/Level sliders + Auto button, Mask Opacity slider, Label visibility chips (`1 NCR`, `2 ED`, `3/4 ET`, `5 RC`), Crosshair toggle, RANO Calipers toggle, Jump-to-ET / Snap-to-Max-Axial buttons, Error Overlay (`TP/FP/FN`) toggle, 3D Mode toggle (`MIP` / `3D Surface`).
  - **2×2 Quad Viewport Grid:** Axial, Coronal, Sagittal, 3D MIP/Surface, each with slice badge and bottom crosshair telemetry bar (`Voxel (x,y,z) | Physical mm | Intensity | Label`).
- **Right Pane (4 Tabbed Clinical Modules):**
  1. **Volumetrics & 2D RANO:** Full region breakdown table (`ET`, `TC`, `WT`, `NCR`, `ED`, `RC` with `cm³`, voxel count, equivalent spherical diameter) + **Automated 2D RANO Card** (`d1`, `d2`, `SPD mm²`, `Best Axial Slice Z`, measurability badge, "Snap to Max Slice" button).
  2. **RANO-Resect (EOR):** Pre-op vs Post-op comparison metrics (`CE EOR %`, `Non-CE EOR %`, `Residual CE cm³`, `Residual Non-CE cm³`, `Cavity cm³`), prominent **RANO-Resect Class Badge** (`Class 1`–`Class 4` per Karschnia et al.), visual EOR bar, and complete 6-class reference legend.
  3. **RANO 2.0 Response:** Longitudinal response banner (`CR`/`PR`/`MR`/`SD`/`PD`/`Preliminary PD (Confirm >=4 wks)`), % change vs Baseline & Nadir for both 2D SPD and 3D Volume, interactive clinical co-factor controls (Steroids, Clinical Status, New Measurable Lesion, `<=12 Weeks Post-RT` confirmation guard), pure inline **SVG Longitudinal Trajectory Chart**, and bulleted clinical rationale.
  4. **AI Seg Evaluator:** Ground-Truth vs AI Prediction metrics table (`ET`, `TC`, `WT`, `RC`: `Dice`, `IoU`, `HD95 mm`, `ASSD mm`, `Sensitivity`, `Precision`, `RVE %`, `GT vs Pred cm³`), interactive `TP/FP/FN` 3D Error Overlay region switcher (`ET`/`TC`/`WT`/`RC`), and voxel confusion breakdown.

---

## 6. Verification & Acceptance Criteria

1. **Synthetic Dataset Integrity (`scripts/verify_reference.py`):**
   - All 7 `.nii.gz` files decompress cleanly, have valid 348-byte NIfTI-1 headers, dims `64×64×48`, `pixdim = [2, 2, 2]`, and valid finite values.
   - `case01_preop_gt` vs `case01_preop_pred` achieves `ET` Dice in `[0.85, 0.93]`, non-zero `HD95` and `ASSD`.
   - `case01_preop_gt` vs `case01_postop_mask` yields `Class 2B` (residual CE `<= 1.0 cm³`, reference CE EOR `~96%`).
   - `case01_postop_mask` -> `case01_followup_mask` yields RANO 2.0 `PD` (>12 wks post-RT, or <=12 wks post-RT with clinical deterioration) and switches to `Preliminary PD (Confirm >=4 wks)` when `within12WeeksPostRT = true` and clinically stable.
2. **Cross-Language Parity (`tests/test.html`):**
   - Browser ES Module test harness verifies `niftiParser.js` and `metricsEngine.js` against reference test cases (legacy label `4 -> 3` mapping, all 6 RANO-Resect classes, all RANO 2.0 response categories including steroid-blocked response and `<12 wks` confirmation, exact EDT `HD95`/`ASSD`, and `case01` ground-truth numbers matching Python reference within `1e-3`).
3. **Offline & UI Verification:**
   - Zero failed network requests or console errors when served statically with no internet access.
   - All 4 canvases render crisply, crosshairs stay synchronized across clicks/drags/wheel scrolls, RANO calipers appear on `bestSliceZ`, and error overlay renders `TP`/`FP`/`FN` accurately.
