# NeuroScope-RANO

**Zero-Upload, Browser-Local Neuro-Oncology Workstation for NIfTI-1 Visualization, BraTS Volumetrics, RANO-Resect EOR, RANO 2.0 Longitudinal Response Assessment, and AI Segmentation QA.**

[![License: MIT](https://img.shields.io/badge/License-MIT-2dd4bf.svg)](LICENSE)
[![Architecture: Zero-Build Static ES Modules](https://img.shields.io/badge/Runtime-100%25%20Browser--Local-38bdf8.svg)](ARCHITECTURE.md)
[![Citation: CFF 1.2.0](https://img.shields.io/badge/Citation-CFF%201.2.0-a855f7.svg)](CITATION.cff)

> **Research & Educational Use Only — Not a Medical Device:** NeuroScope-RANO is an open-science research and educational tool. It is **not** FDA-cleared, CE-marked, or approved for clinical diagnosis, surgical navigation, radiation planning, or patient management. See the [Non-Clinical & Research-Use Disclaimer](#non-clinical--research-use-disclaimer).

---

## Overview & Zero-Upload Browser-Local Privacy Guarantee

Quantitative neuro-oncology workflows routinely span three fragmented toolchains: a desktop NIfTI viewer, custom Python scripts for volumetrics and AI benchmarking, and manual spreadsheets for surgical extent-of-resection (**RANO-Resect**) and longitudinal treatment response (**RANO 2.0**). Meanwhile, uploading clinical or institutional research MRI volumes to cloud web apps raises immediate HIPAA, GDPR, and IRB privacy barriers.

**NeuroScope-RANO** unifies all four workflows into a single **100% client-side, zero-build static web application** (pure HTML5, CSS3, and native ES Modules):

- **Zero Data Uploaded:** Local `.nii` and `.nii.gz` files selected or dragged into the workstation are decoded exclusively inside browser memory via the native `File` API and `DecompressionStream('gzip')`. No imaging bytes, filenames, or computed metrics are ever transmitted over the network.
- **100% Offline Capable & Zero Hard CDN Dependencies:** Every core capability—binary NIfTI-1 parsing, multi-planar Canvas rendering, 3D MIP/surface projection, volumetrics, RANO-Resect, RANO 2.0, exact 3D Hausdorff/ASSD evaluation, inline SVG trajectory charts, and JSON/print report export—runs with zero external scripts, stylesheets, or font requests.
- **Instant Reproducibility:** Ships with a deterministic synthetic multi-timepoint right-frontal glioblastoma phantom (`Pre-Op`, `Early Post-Op <72h`, and `6-Month Follow-Up`) so neurosurgeons, neuroradiologists, and AI researchers can inspect every module immediately on page load.

---

## Feature Overview

### 1. Native Multi-Planar & 3D NIfTI-1 Viewer (`NeuroViewer`)
- **Direct NIfTI-1 Parsing:** Reads single-file `.nii` and gzipped `.nii.gz` volumes directly in browser memory across standard NIfTI-1 datatypes (`UINT8`, `INT16`, `INT32`, `FLOAT32`, `FLOAT64`, `INT8`, `UINT16`, `UINT32`), both endiannesses, intensity scaling (`scl_slope`, `scl_inter`), and 4D first-frame extraction.
- **Radiological Quad-Viewport Workstation:** Synchronized **Axial**, **Coronal**, and **Sagittal** planes rendered in canonical `RAS+` radiological orientation (`R/L`, `A/P`, `S/I`) with physical `pixdim` aspect-ratio preservation, paired with an interactive orbital **3D MIP & Depth-Shaded Tumor Surface** canvas.
- **Radiology Interaction Suite:** Synchronized click/drag crosshairs, mouse-wheel slice scrolling, right-drag / `Shift + drag` Window/Level adjustment with smart auto-percentile (`p1`–`p99.5`) reset, mask opacity control, per-compartment visibility chips, vector RANO 2D calipers (`d1` solid teal, `d2` dashed yellow), and live voxel/millimeter/intensity telemetry.

### 2. BraTS 2023/2024 + Post-Op Volumetrics & Automated 2D RANO
Supports the unified **BraTS 2023/2024 + Post-Op** segmentation convention with automatic normalization of legacy BraTS enhancing tumor label `4 -> 3`:

| Canonical Label | Code | Compartment | Overlay Color | Composite Inclusion |
| :---: | :---: | :--- | :---: | :--- |
| `0` | `BG` | Background / Normal Brain | Transparent | — |
| `1` | `NCR` | Necrotic / Non-Enhancing Tumor Core | `#f43f5e` (Rose) | `TC`, `WT`, `nonCE` |
| `2` | `ED` | Peritumoral Edema / Infiltrated FLAIR | `#f59e0b` (Amber) | `WT`, `nonCE` |
| `3` *(or legacy `4`)* | `ET` | Contrast-Enhancing Tumor (`CE`) | `#38bdf8` (Cyan) | `ET`, `TC`, `WT` |
| `5` | `RC` | Surgical Resection Cavity | `#a855f7` (Violet) | `RC` *(excluded from `WT`)* |

- **Exact 3D Compartment Volumetrics:** Single-pass computation of voxel counts, physical volume (`mm³` and `cm³`), 3D centroids, bounding boxes, and equivalent spherical diameters across `ET`, `TC`, `WT`, `NCR`, `ED`, `RC`, and `nonCE`.
- **Automated Axial 2D RANO Calipers:** Performs 8-connected lesion component separation on every axial slice, extracts maximal physical diameter (`d1`) and orthogonal maximal cross-sectional diameter (`d2`) in millimeters, computes sum of products of diameters (`SPD = d1 × d2` in `mm²`), flags **RANO 2.0 measurability (`>=10 × 10 mm`)**, and snaps the Axial viewport directly to `bestSliceZ`.

### 3. RANO-Resect Extent of Resection (EOR) Classifier
Compares pre-operative and early post-operative (`<72h`) masks across contrast-enhancing (`CE = ET`), non-contrast-enhancing (`nonCE = NCR ∪ ED`), and surgical cavity (`RC`) compartments, automatically assigning the official **RANO-Resect** class (Karschnia et al., *Neuro-Oncology* 2023):

| RANO-Resect Class | Name | Decision Rule (`CE` = Enhancing Tumor, `nonCE` = NCR + ED) |
| :--- | :--- | :--- |
| **Class 1** | Supramaximal CE Resection | `Residual CE = 0 cm³` and `Residual nonCE <= 5.0 cm³` |
| **Class 2A** | Complete CE Resection | `Residual CE = 0 cm³` and `Residual nonCE > 5.0 cm³` |
| **Class 2B** | Near-Total CE Resection | `Residual CE > 0 to <= 1.0 cm³` *(after Class 4 biopsy check; CE EOR% reported for reference)* |
| **Class 3A** | Subtotal CE Resection | `Residual CE > 1.0 to <= 5.0 cm³` *(after Class 4 biopsy check; CE EOR% reported for reference)* |
| **Class 3B** | Partial CE Resection | `Residual CE > 5.0 cm³` *(with `CE EOR >= 10%`)* |
| **Class 4** | Biopsy | `CE EOR < 10%` *(no cytoreductive CE resection)* |
| **N/A** | Zero Pre-Op CE Guard | `Pre-Op CE = 0 cm³` *(empty pre-op mask or non-enhancing tumor; CE classes not assigned)* |

### 4. RANO 2.0 Longitudinal Response Tracker
Evaluates serial follow-up scans against both **Baseline** (post-radiotherapy MRI ~4 weeks post-RT for newly diagnosed RT-treated gliomas, or early post-op MRI when RT is not given / for pre-RT therapy; Case 01 uses Early Post-Op as an illustrative pre-RT/surgical baseline) and **Nadir** across 2D `SPD` and 3D `ET` volume per **RANO 2.0** (Wen et al., *JCO* 2023):
- Classifies **CR** (Complete Response: complete disappearance of baseline enhancing disease while off corticosteroids or on physiologic replacement doses only), **PR** (Partial Response: `<= -50%` SPD or `<= -65%` volume on off/physiologic or stable/decreased steroids, or radiographic CR on stable/decreased therapeutic steroids), **MR** (Minor Response: `<= -25%` SPD or `<= -40%` volume), **SD** (Stable Disease, including `0 -> 0` trajectories with no baseline enhancing disease), **PD** (Progressive Disease: `>= +25%` SPD or `>= +40%` volume vs. nadir, new measurable lesion, or unequivocal clinical deterioration), and **Preliminary PD (Confirm >=4 wks)** for clinically stable patients with radiographic progression within the `<=12 weeks post-RT` pseudoprogression window.
- Enforces **corticosteroid gating** (requiring `none_or_physiologic` steroids for `CR`, downgrading radiographic CR on therapeutic `stable_or_decreased` steroids to `PR`, and downgrading radiographic CR/PR/MR to `SD` when steroids are increased, with an explicit rationale bullet).
- Renders a zero-dependency inline **SVG longitudinal trajectory chart** alongside structured clinical decision rationale and JSON/print report export.

### 5. AI Segmentation Evaluator (Dice, IoU, HD95, ASSD & 3D Error Overlay)
Benchmarks predicted AI segmentation masks against ground truth across `ET`, `TC`, `WT`, and `RC`:
- **Overlap & Volume Metrics:** `Dice Similarity Coefficient`, `IoU (Jaccard)`, `Sensitivity`, `Precision`, `Relative Volume Error (RVE %)`, and ground-truth vs. predicted volumes (`cm³`).
- **Exact Anisotropic 3D Surface Distances:** Computes **95th-Percentile Hausdorff Distance (`HD95`, mm)** and **Average Symmetric Surface Distance (`ASSD`, mm)** using the exact separable **Felzenszwalb–Huttenlocher** 3D Euclidean Distance Transform in physical voxel spacing (`dx`, `dy`, `dz`), matching standard BraTS / `medpy` evaluation without isotropic resampling error.
- **Interactive 3D Error Overlay (`TP / FP / FN`):** Instantaneously projects voxel-wise True Positives (`#22c55e` Emerald), False Positives (`#f43f5e` Rose), and False Negatives (`#38bdf8` Sky Cyan) onto all three orthogonal slices and the 3D surface viewer for rapid qualitative error inspection.

---

## Quick Start

NeuroScope-RANO requires **no build step, no Node.js installation, and no Python packages**. Because browsers restrict ES Module imports and `fetch()` calls over the `file://` protocol, serve the repository over HTTP locally or via GitHub Pages.

### Run Locally with Python

```bash
git clone https://github.com/<your-org>/neuroscope-rano.git
cd neuroscope-rano
python -m http.server 8000
```

Open **[http://localhost:8000](http://localhost:8000)** in any modern browser (Chrome, Edge, Firefox, or Safari supporting ES Modules and `DecompressionStream`). The built-in synthetic glioblastoma case (`case01`) loads automatically; use the header upload buttons or drag-and-drop to inspect your own local `.nii` / `.nii.gz` volumes.

### Verification & Mathematical Testing

Validate all clinical calculations and synthetic sample fixtures using Python 3.12 (standard library only):

```bash
python tests/verify_math.py
```

To verify cross-language JavaScript/Python parity in the browser, run `python -m http.server 8000` and open **[http://localhost:8000/tests/test.html](http://localhost:8000/tests/test.html)**. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for detailed clinician and developer guidelines.

---

## Repository Structure

```text
neuroscope-rano/
├── index.html                        # Single-page radiology workstation shell
├── css/styles.css                    # Dark-slate workstation styling (zero external fonts/CDNs)
├── js/
│   ├── niftiParser.js                # Native NIfTI-1 (.nii/.nii.gz) binary parser
│   ├── metricsEngine.js              # Volumetrics, 2D RANO, RANO-Resect, RANO 2.0, Dice/HD95/ASSD
│   ├── viewer.js                     # Multi-planar Canvas 2D + 3D MIP/Surface NeuroViewer
│   └── app.js                        # Workstation state, clinical tabs, SVG chart, JSON/print export
├── assets/samples/                   # Deterministic synthetic 3-timepoint GBM phantom & manifest.json
├── scripts/                          # Python 3.12 stdlib synthetic data & reference verification tools
├── tests/                            # Mathematical verification suite & browser ES module test runner
├── .github/workflows/pages.yml       # Automated GitHub Pages static deployment workflow
├── ARCHITECTURE.md                   # Complete engineering & clinical systems specification
├── CONTRIBUTING.md                   # Guide for neurosurgeons, neuroradiologists, and AI engineers
├── CITATION.cff                      # CFF 1.2.0 academic citation metadata
└── LICENSE                           # MIT License
```

---

## Clinical & Methodological References

1. **RANO 2.0 Criteria:** Wen PY, van den Bent MJ, Youssef G, et al. *RANO 2.0: Update to the Response Assessment in Neuro-Oncology Criteria for High- and Low-Grade Gliomas in Adults.* Journal of Clinical Oncology. 2023;41(33):5187–5199. doi:[10.1200/JCO.23.01059](https://doi.org/10.1200/JCO.23.01059)
2. **RANO-Resect Classification:** Karschnia P, Young JS, Dono A, et al. *Prognostic validation of a new classification system for extent of resection in glioblastoma: A report of the RANO resect group.* Neuro-Oncology. 2023;25(5):940–954. doi:[10.1093/neuonc/noac193](https://doi.org/10.1093/neuonc/noac193)
3. **BraTS Challenge (Foundational Benchmark):** Menze BH, Jakab A, Bauer S, et al. *The Multimodal Brain Tumor Image Segmentation Benchmark (BRATS).* IEEE Transactions on Medical Imaging. 2015;34(10):1993–2024. doi:[10.1109/TMI.2014.2377694](https://doi.org/10.1109/TMI.2014.2377694)
4. **BraTS 2021 Benchmark:** Baid U, Ghodasara S, Mohan S, et al. *The RSNA-ASNR-MICCAI BraTS 2021 Benchmark on Brain Tumor Segmentation and Radiogenomic Classification.* arXiv:2107.02314. 2021. https://arxiv.org/abs/2107.02314
5. **BraTS 2024 Post-Treatment Glioma Benchmark:** Correia de Verdier M, Saluja R, Gagnon L, et al. *The 2024 Brain Tumor Segmentation (BraTS) Challenge: Glioma Segmentation on Post-treatment MRI.* arXiv:2405.18368. 2024. https://arxiv.org/abs/2405.18368
6. **Exact Anisotropic 3D Distance Transform:** Felzenszwalb PF, Huttenlocher DP. *Distance Transforms of Sampled Functions.* Theory of Computing. 2012;8(19):415–428. doi:[10.4086/toc.2012.v008a019](https://doi.org/10.4086/toc.2012.v008a019)

---

## Citation & License

If you use **NeuroScope-RANO** in academic research, manuscripts, or AI segmentation benchmarks, please cite it via [`CITATION.cff`](CITATION.cff) (supported natively by GitHub's *"Cite this repository"* button):

```bibtex
@software{neuroscope_rano_2026,
  title   = {NeuroScope-RANO: Zero-Upload Browser-Local Neuro-Oncology Volumetrics, RANO-Resect, RANO 2.0, and AI Segmentation QA Workstation},
  author  = {{Prajwal Ghimire}},
  year    = {2026},
  version = {1.0.0},
  license = {MIT}
}
```

NeuroScope-RANO is released under the [MIT License](LICENSE) (`Copyright (c) 2026 Prajwal Ghimire`).

---

## Non-Clinical & Research-Use Disclaimer

**NeuroScope-RANO is provided strictly for academic research, algorithm quality assurance, and educational demonstration.**

- It is **not** a medical device and has **not** been cleared, approved, or certified by the U.S. Food and Drug Administration (FDA), European Union Medical Device Regulation (EU MDR / CE), MHRA, or any other regulatory authority.
- It must **not** be used for primary radiologic diagnosis, neurosurgical planning or navigation, radiotherapy target delineation, clinical trial central-read adjudication without independent regulatory validation, or direct patient care decisions.
- All outputs (2D diameters, 3D volumes, RANO-Resect classifications, RANO 2.0 response categories, and AI QA scores) depend on input image quality, voxel spacing metadata, orientation headers, and upstream segmentation accuracy. Clinical interpretation remains the sole responsibility of qualified, licensed physicians using certified clinical PACS/RIS workstations.
- Users remain responsible for complying with institutional IRB, HIPAA, GDPR, and local data-governance policies when viewing any human neuroimaging data on local workstations.

---

<!-- PRAZG_SUITE_README_START -->
## Open Neuro & Pathology AI Suite

Part of the open-access neurosurgery, neuroimaging, neuro-oncology, and computational pathology web suite by [@prazg](https://github.com/prazg):

| Tool | Live App | Repository | Focus |
|---|---|---|---|
| **NeuroScope-RANO** *(this repo)* | [Open App](https://prazg.github.io/neuroscope-rano/) | [`prazg/neuroscope-rano`](https://github.com/prazg/neuroscope-rano) | Zero-upload NIfTI MRI volumetrics, RANO 2.0, RANO-Resect (EOR) & AI segmentation QA |
| **OpenNeuroAtlas** | [Open App](https://prazg.github.io/openneuroatlas/) | [`prazg/openneuroatlas`](https://github.com/prazg/openneuroatlas) | Living registry of 44 open neurosurgery & neuroimaging datasets, foundation models & MICCAI benchmarks |
| **CNS5-Audit** | [Open App](https://prazg.github.io/cns5-audit/) | [`prazg/cns5-audit`](https://github.com/prazg/cns5-audit) | WHO CNS5 (2021) classifier, RANO 2.0 / RANO-BM / RANO-Resect calculators & CLAIM/TRIPOD+AI leakage auditor |
| **NeuroCorridor-3D** | [Open App](https://prazg.github.io/neurocorridor-3d/) | [`prazg/neurocorridor-3d`](https://github.com/prazg/neurocorridor-3d) | Interactive 3D MNI-152 eloquent neuroanatomy, white-matter tractography & surgical corridor sandbox |
| **3D Neurosurgical Atlas** | [Open App](https://prazg.github.io/3D_Neurosurgical_Atlas/) | [`prazg/3D_Neurosurgical_Atlas`](https://github.com/prazg/3D_Neurosurgical_Atlas) | Interactive browser-based 3D atlas of craniospinal anatomy, 76 walkthroughs & neuro-oncological pathology |
| **Brain Trials Finder** | [Open App](https://prazg.github.io/brain_trials_finder/) | [`prazg/brain_trials_finder`](https://github.com/prazg/brain_trials_finder) | Discovers actively recruiting neuro-oncology clinical trials across ClinicalTrials.gov, ISRCTN, EU CTIS & WHO ICTRP |
| **Brain Radiology FM** | [Open App](https://prazg.github.io/Brain_Radiology_FM_Portal/) | [`prazg/Brain_Radiology_FM_Portal`](https://github.com/prazg/Brain_Radiology_FM_Portal) | Interactive PACS portal & GPU runner for 28 open-weight 3D Brain MRI, Head CT & fMRI foundation models |
| **Histology FM** | [Open App](https://prazg.github.io/Histology_FM_Portal/) | [`prazg/Histology_FM_Portal`](https://github.com/prazg/Histology_FM_Portal) | Graphical frontend & GPU runner for 55 open-weight clinical & preclinical histology foundation models |
| **Animal Pathology FM** | [Open App](https://prazg.github.io/Animal_Pathology_FM_Portal/) | [`prazg/Animal_Pathology_FM_Portal`](https://github.com/prazg/Animal_Pathology_FM_Portal) | Frontend & local runner for open-weight preclinical, rodent & veterinary pathology foundation models |
| **Remote DICOM Viewer** | [Open App](https://prazg.github.io/Remote_Dicom_Viewer/) | [`prazg/Remote_Dicom_Viewer`](https://github.com/prazg/Remote_Dicom_Viewer) | Secure browser-based DICOM viewer for sending scans for remote radiological reporting |

<!-- PRAZG_SUITE_README_END -->
