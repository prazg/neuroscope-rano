# Contributing to NeuroScope-RANO

Thank you for helping advance open-science neuroimaging, surgical neuro-oncology, and transparent AI evaluation. **NeuroScope-RANO** is built as an interdisciplinary bridge between **neurosurgeons**, **neuroradiologists**, and **AI/research engineers**. Whether you are refining clinical decision rules, contributing synthetic benchmark phantoms, or optimizing 3D distance transforms, your contributions are welcome.

---

## Core Architectural & Governance Principles

Before submitting changes, please review [`ARCHITECTURE.md`](ARCHITECTURE.md). All contributions must preserve four non-negotiable guarantees:

1. **Zero-Upload Browser-Local Privacy:** User-loaded medical imaging files (`.nii` / `.nii.gz`) must never leave browser memory. Never introduce analytics beacons, telemetry calls, remote storage APIs, or external file-processing endpoints.
2. **Zero Protected Health Information (PHI):** Never commit real patient scans, unstripped DICOM/NIfTI headers, identifiable facial geometry, dates of birth, medical record numbers, or restricted clinical datasets to this repository.
3. **Zero-Build & 100% Offline Runtime:** The web application uses pure HTML5, CSS3, and native ES Modules (`<script type="module">`) with **no Node.js, npm, bundler, or hard CDN dependencies**. Every core workflow must function completely offline.
4. **Standard-Library Local Tooling:** Python sample-generation and mathematical verification scripts must depend exclusively on the **Python 3.12 standard library** (`struct`, `gzip`, `math`, `json`, `random`, `pathlib`, `collections`, `unittest`) so any clinician or researcher can verify calculations without installing third-party scientific stacks.

---

## How to Contribute by Discipline

### For Neurosurgeons
Your domain expertise keeps extent-of-resection (EOR) modeling faithful to operative reality:
- Audit **RANO-Resect** classifications (`Class 1` Supramaximal CE through `Class 4` Biopsy) against real-world surgical workflows and post-operative `<72h` imaging conventions.
- Review handling of **resection cavity (`Label 5 / RC`)**, non-contrast-enhancing (`nonCE`) margins, multifocal resections, and subtle residual contrast-enhancing nodules along cavity walls.
- Propose realistic clinical vignettes (pre-op, `<72h` post-op, and longitudinal surveillance metadata such as KPS and dexamethasone dosing) for new procedural test phantoms.

### For Neuroradiologists
Your clinical review ensures measurement fidelity and response-assessment accuracy:
- Verify **RANO 2.0** longitudinal classification logic (`CR`, `PR`, `MR`, `SD`, `PD`, `Preliminary PD (Confirm >=4 wks)`), including nadir tracking, measurable disease thresholds (`>=10 x 10 mm`), corticosteroid-blocked response downgrades, and the `<=12 weeks post-RT` pseudoprogression confirmation window.
- Inspect **automated 2D RANO calipers** (`d1`, `d2`, `SPD`) across irregular, ring-enhancing, cystic, or multifocal lesions to identify edge cases where perpendicular projection or component selection can be improved.
- Validate **radiological display orientation** (`RAS+` coordinates rendered with patient Right on viewer Left `R/L`, `A/P`, `S/I`), Window/Level auto-scaling, and **BraTS 2023/2024 + Post-Op** compartment definitions.

### For AI & Software Engineers
Your engineering rigor maintains numerical exactness and workstation responsiveness:
- Harden `js/niftiParser.js` for diverse NIfTI-1 headers (big-endian/little-endian, arbitrary `vox_offset`, `scl_slope`/`scl_inter`, 4D first-frame extraction, and malformed-header diagnostics).
- Maintain exact cross-language parity between `js/metricsEngine.js` and the Python reference math suite—especially for the separable **Felzenszwalb–Huttenlocher** anisotropic 3D Euclidean Distance Transform (`HD95`, `ASSD`), legacy BraTS `4 -> 3` label normalization, and empty-region edge cases.
- Optimize `js/viewer.js` Canvas 2D / 3D MIP rendering performance on full-resolution `240 x 240 x 155` clinical BraTS volumes while keeping UI interactions fluid.

---

## Adding Sample Datasets

Sample cases live in `assets/samples/` and are indexed by `assets/samples/manifest.json`. Because NeuroScope-RANO deploys statically to GitHub Pages, bundled datasets must be **lightweight**, **ethically clean**, and **reproducible**.

### 1. Data Eligibility & Privacy Rules
- **Preferred:** Deterministic procedural NIfTI-1 phantoms generated via `scripts/generate_samples.py` using fixed PRNG seeds (Python 3.12 stdlib only).
- **Permitted (with attribution):** Fully de-identified, skull-stripped/defaced open-access benchmark cases carrying an explicit compatible license (e.g., CC0 / CC-BY) documented in the PR description and `manifest.json`.
- **Prohibited:** Unlicensed clinical scans, non-defaced head MRIs, or any volume containing PHI in NIfTI header fields (`descrip`, `aux_file`, or extensions).

### 2. Required NIfTI-1 & Label Specification
Every bundled dataset must strictly follow the canonical layout in [`ARCHITECTURE.md`](ARCHITECTURE.md):

- **Format:** Single-file gzipped NIfTI-1 (`.nii.gz`), 348-byte header, magic `n+1\0`, valid positive `pixdim[1..3]` in millimeters, and `sform_code >= 1`.
- **Coordinate Space:** Canonical `RAS+` (`x`: Left -> Right, `y`: Posterior -> Anterior, `z`: Inferior -> Superior) stored in Fortran/column-major order (`idx = x + y * nx + z * nx * ny`).
- **Datatypes:** `INT16` (code `4`) or `FLOAT32` (code `16`) for MRI anatomy; `UINT8` (code `2`) for segmentation masks.
- **Canonical Label Standard (BraTS 2023/2024 + Post-Op):**

| Label | Code | Region | Clinical Meaning |
| :---: | :---: | :--- | :--- |
| `0` | `BG` | Background | Normal brain / background |
| `1` | `NCR` | Necrotic / Non-Enhancing Core | Necrotic & non-enhancing tumor core (`TC = 1 ∪ 3`) |
| `2` | `ED` | Peritumoral Edema | Edema / infiltrated FLAIR hyperintensity (`WT = 1 ∪ 2 ∪ 3`, `nonCE = 1 ∪ 2`) |
| `3` | `ET` | Enhancing Tumor | Contrast-enhancing tumor *(legacy BraTS label `4` is automatically normalized to `3`)* |
| `5` | `RC` | Resection Cavity | Post-operative surgical resection cavity (excluded from `WT`) |

- **Bundle Size Budget:** Keep individual synthetic `.nii.gz` files compact (typically `< 500 KB` each) so the workstation loads instantaneously on GitHub Pages without bloating repository history.

### 3. Registering a New Case in `assets/samples/manifest.json`
Add a new entry under `cases` following the exact schema below:

```json
{
  "id": "case02",
  "title": "Case 02 — Left Temporal Oligodendroglioma (IDH-mutant, 1p/19q-codeleted)",
  "diagnosis": "Oligodendroglioma, IDH-mutant and 1p/19q-codeleted, CNS WHO Grade 3",
  "location": "Left Temporal Lobe",
  "molecularProfile": "IDH1 R132H mutant | 1p/19q-codeleted | MGMT methylated",
  "syntheticNote": "Synthetic procedural phantom for research & educational demonstration only.",
  "timepoints": [
    {
      "id": "preop",
      "label": "Pre-Op Diagnostic",
      "role": "preop",
      "dayOffset": 0,
      "date": "2025-03-01",
      "t1ce": "assets/samples/case02_preop_t1ce.nii.gz",
      "mask": "assets/samples/case02_preop_gt.nii.gz",
      "predMask": "assets/samples/case02_preop_pred.nii.gz",
      "dexamethasoneMgPerDay": 4,
      "steroids": "stable_or_decreased",
      "clinicalStatus": "stable_or_improved",
      "kps": 90,
      "newMeasurableLesion": false,
      "within12WeeksPostRT": false,
      "notes": "Baseline pre-operative scan."
    }
  ]
}
```

Whenever you add or update synthetic sample generation in `scripts/generate_samples.py`, regenerate the `.nii.gz` files and run the verification suite to confirm all mathematical targets and NIfTI headers pass.

---

## Reporting Clinical Criteria Updates

Neuro-oncology response and surgical assessment standards evolve continuously (e.g., updates to RANO 2.0, RANO-Resect, RANO-BM, RANO-Meningioma, or pediatric RAPNO). To report a clinical discrepancy or propose a criteria update, open an issue (or pull request) containing:

1. **Authoritative Citation:** Full reference with journal, publication year, DOI, and exact table/section/figure in the consensus publication (for example, *Wen et al., JCO 2023, doi:10.1200/JCO.23.01059* or *Karschnia et al., Neuro-Oncology 2023, doi:10.1093/neuonc/noac193*).
2. **Current vs. Proposed Decision Logic:** Specify the exact affected module (`computeAxial2DDiameters`, `computeExtentOfResection`, or `computeRano2Response` in `js/metricsEngine.js`), threshold values, boundary inequalities (`<` vs. `<=`), and precedence order.
3. **Clinical Vignette & Expected Output:** Provide at least one concrete numeric test fixture (pre-op/post-op volumes or baseline/nadir/follow-up `SPD`, 3D `ET` volume, steroid status, clinical status, and post-RT window) along with the expected classification and rationale text.
4. **Domain Impact Note:** Indicate whether the change affects adult high-grade glioma, non-enhancing low-grade glioma, post-immunotherapy surveillance, or a separate tumor subtype (which should be modeled as an explicit criteria mode rather than silently altering adult GBM RANO 2.0 defaults).

---

## Running Verification & Test Suites

All pull requests touching NIfTI parsing, volumetrics, RANO-Resect, RANO 2.0, AI segmentation metrics, or sample datasets **must pass both the Python mathematical verification suite and the browser ES module test harness**.

### 1. Python Mathematical Verification Suite (Required)
Run the zero-dependency Python 3.12 verification suite from the repository root:

```bash
python tests/verify_math.py
```

This verifies:
- NIfTI-1 binary & gzip header integrity (`sizeof_hdr = 348`, `dims`, `pixdim`, finite intensity bounds).
- BraTS + Post-Op label normalization (including automatic legacy label `4 -> 3` mapping) and physical `cm³` volumetrics.
- Automated axial 2D RANO diameters (`d1`, `d2`, `SPD mm²`, `>=10 x 10 mm` measurability).
- All 6 **RANO-Resect** EOR classes (`Class 1`, `Class 2A`, `Class 2B`, `Class 3A`, `Class 3B`, `Class 4`) including boundary conditions.
- All **RANO 2.0** longitudinal response categories (`CR`, `PR`, `MR`, `SD`, `PD`, `Preliminary PD (Confirm >=4 wks)`), nadir tracking, steroid-blocked response downgrades, and `<=12 weeks post-RT` confirmation logic.
- Exact anisotropic 3D AI evaluation metrics (`Dice`, `IoU`, `HD95`, `ASSD`, `Sensitivity`, `Precision`, `RVE %`).

*(If you modified procedural sample generation in `scripts/generate_samples.py`, also run `python scripts/verify_reference.py` if present in your branch to cross-check generated phantom targets.)*

### 2. Browser-Native ES Module Test Runner & Offline Check
Start a local static server from the repository root:

```bash
python -m http.server 8000
```

Then:
1. Open `http://localhost:8000/tests/test.html` in a modern Chromium, Firefox, or WebKit browser and confirm **100% of unit and cross-language parity tests pass** (matching Python reference values within `1e-3`).
2. Open `http://localhost:8000/` with browser DevTools → **Network** set to **Offline** (after initial load) and verify:
   - Zero console errors and zero failed external CDN/font/script requests.
   - Smooth synchronized crosshair interaction across Axial, Coronal, Sagittal, and 3D MIP/Surface viewports.
   - RANO 2D calipers render accurately on `bestSliceZ` and `TP/FP/FN` error overlay toggles cleanly.

---

## Pull Request Checklist

- [ ] Branch uses a clear prefix (`feat/`, `clinical/`, `fix/`, `data/`, `docs/`).
- [ ] No real patient data or PHI is included anywhere in the diff or commit history.
- [ ] Zero build steps, zero external hard CDN dependencies, and zero third-party Python packages added.
- [ ] `python tests/verify_math.py` passes with zero errors.
- [ ] `tests/test.html` passes in a modern browser with zero console or offline network errors.
- [ ] Clinical rule changes include peer-reviewed references and corresponding unit tests.
- [ ] Documentation (`README.md`, `ARCHITECTURE.md`, or `CITATION.cff`) is updated if public APIs, labels, or references changed.

By contributing to NeuroScope-RANO, you agree that your contributions will be licensed under the repository's [MIT License](LICENSE).
