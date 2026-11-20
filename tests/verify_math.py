#!/usr/bin/env python3
"""
NeuroScope-RANO Independent Reference Math & Dataset Verification Suite
=======================================================================
Uses Python 3.12 standard library ONLY (unittest, struct, gzip, math, json,
collections, pathlib). Does NOT import from scripts/generate_samples.py so
every NIfTI header check and clinical metric serves as an independent oracle.

Run:
    python tests/verify_math.py
"""

from __future__ import annotations

import collections
import gzip
import json
import math
import struct
import unittest
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
SAMPLES_DIR = REPO_ROOT / "assets" / "samples"
MANIFEST_PATH = SAMPLES_DIR / "manifest.json"

MAX_COMPRESSED_BYTES = 250 * 1024  # 250 KB compact GitHub Pages budget
EPS = 1e-6

EXPECTED_MRI_FILES = [
    "case01_preop_t1ce.nii.gz",
    "case01_postop_t1ce.nii.gz",
    "case01_followup_t1ce.nii.gz",
]
EXPECTED_MASK_FILES = [
    "case01_preop_gt.nii.gz",
    "case01_preop_pred.nii.gz",
    "case01_postop_mask.nii.gz",
    "case01_followup_mask.nii.gz",
]
ALL_SAMPLE_FILES = EXPECTED_MRI_FILES + EXPECTED_MASK_FILES


# ---------------------------------------------------------------------------
# Independent NIfTI-1 Reader
# ---------------------------------------------------------------------------

def read_nifti_gz(path: Path) -> dict[str, Any]:
    """Read and parse a single-file NIfTI-1 .nii.gz volume with full header validation."""
    raw_gz = path.read_bytes()
    if len(raw_gz) < 2 or raw_gz[0] != 0x1F or raw_gz[1] != 0x8B:
        raise ValueError(f"{path.name}: missing gzip magic bytes 0x1f 0x8b")

    raw = gzip.decompress(raw_gz)
    if len(raw) < 348:
        raise ValueError(f"{path.name}: decompressed buffer smaller than 348-byte NIfTI-1 header")

    sizeof_hdr = struct.unpack_from("<i", raw, 0)[0]
    endian = "<"
    if sizeof_hdr != 348:
        sizeof_hdr_be = struct.unpack_from(">i", raw, 0)[0]
        if sizeof_hdr_be == 348:
            sizeof_hdr = sizeof_hdr_be
            endian = ">"
        else:
            raise ValueError(f"{path.name}: invalid sizeof_hdr={sizeof_hdr}")

    dim = struct.unpack_from(f"{endian}8h", raw, 40)
    datatype = struct.unpack_from(f"{endian}h", raw, 70)[0]
    bitpix = struct.unpack_from(f"{endian}h", raw, 72)[0]
    pixdim = struct.unpack_from(f"{endian}8f", raw, 76)
    vox_offset = struct.unpack_from(f"{endian}f", raw, 108)[0]
    scl_slope = struct.unpack_from(f"{endian}f", raw, 112)[0]
    scl_inter = struct.unpack_from(f"{endian}f", raw, 116)[0]
    xyzt_units = struct.unpack_from("B", raw, 123)[0]
    cal_max = struct.unpack_from(f"{endian}f", raw, 124)[0]
    cal_min = struct.unpack_from(f"{endian}f", raw, 128)[0]
    descrip = raw[148:228].split(b"\x00", 1)[0].decode("ascii", errors="replace")
    qform_code = struct.unpack_from(f"{endian}h", raw, 252)[0]
    sform_code = struct.unpack_from(f"{endian}h", raw, 254)[0]
    quatern = struct.unpack_from(f"{endian}3f", raw, 256)
    qoffset = struct.unpack_from(f"{endian}3f", raw, 268)
    srow_x = struct.unpack_from(f"{endian}4f", raw, 280)
    srow_y = struct.unpack_from(f"{endian}4f", raw, 296)
    srow_z = struct.unpack_from(f"{endian}4f", raw, 312)
    magic = raw[344:348]

    nx, ny, nz = max(1, dim[1]), max(1, dim[2]), max(1, dim[3])
    n_vox = nx * ny * nz
    offset_int = int(vox_offset)

    dtype_map = {
        2: ("B", 1),
        4: ("h", 2),
        8: ("i", 4),
        16: ("f", 4),
        64: ("d", 8),
        256: ("b", 1),
        512: ("H", 2),
        768: ("I", 4),
    }
    if datatype not in dtype_map:
        raise ValueError(f"{path.name}: unsupported NIfTI datatype {datatype}")
    fmt_char, elem_bytes = dtype_map[datatype]
    expected_bytes = offset_int + n_vox * elem_bytes
    if len(raw) != expected_bytes:
        raise ValueError(
            f"{path.name}: byte length mismatch (got {len(raw)}, expected {expected_bytes})"
        )

    raw_vals = struct.unpack_from(f"{endian}{n_vox}{fmt_char}", raw, offset_int)
    if scl_slope != 0.0 and math.isfinite(scl_slope) and (scl_slope != 1.0 or scl_inter != 0.0):
        data = [v * scl_slope + scl_inter for v in raw_vals]
    else:
        data = list(raw_vals)

    return {
        "path": path,
        "compressed_bytes": len(raw_gz),
        "uncompressed_bytes": len(raw),
        "sizeof_hdr": sizeof_hdr,
        "endian": endian,
        "dim": dim,
        "dims": (nx, ny, nz),
        "datatype": datatype,
        "bitpix": bitpix,
        "pixdim_raw": pixdim,
        "pixdim": (abs(pixdim[1]), abs(pixdim[2]), abs(pixdim[3])),
        "vox_offset": vox_offset,
        "scl_slope": scl_slope,
        "scl_inter": scl_inter,
        "xyzt_units": xyzt_units,
        "cal_min": cal_min,
        "cal_max": cal_max,
        "descrip": descrip,
        "qform_code": qform_code,
        "sform_code": sform_code,
        "quatern": quatern,
        "qoffset": qoffset,
        "srow_x": srow_x,
        "srow_y": srow_y,
        "srow_z": srow_z,
        "magic": magic,
        "data": data,
    }


# ---------------------------------------------------------------------------
# Independent Reference Math Engine (ARCHITECTURE.md Section 4.2)
# ---------------------------------------------------------------------------

def normalize_label(v: float) -> int:
    """Canonical BraTS 2023/2024 + Post-Op label normalization (legacy 4 -> 3)."""
    r = int(math.floor(v + 0.5))
    if r == 4:
        return 3
    if r in (1, 2, 3, 5):
        return r
    return 0


def is_in_region(norm_label: int, region: str) -> bool:
    if region == "ET":
        return norm_label == 3
    if region == "TC":
        return norm_label in (1, 3)
    if region == "WT":
        return norm_label in (1, 2, 3)
    if region == "RC":
        return norm_label == 5
    if region == "nonCE":
        return norm_label in (1, 2)
    raise ValueError(f"Unknown region: {region}")


def compute_volumetrics(
    mask_data: list[float] | list[int],
    dims: tuple[int, int, int],
    pixdim: tuple[float, float, float],
) -> dict[str, Any]:
    nx, ny, nz = dims
    dx, dy, dz = pixdim
    vox_mm3 = dx * dy * dz

    def _new_acc() -> dict[str, Any]:
        return {
            "count": 0,
            "sx": 0, "sy": 0, "sz": 0,
            "minX": nx, "maxX": -1,
            "minY": ny, "maxY": -1,
            "minZ": nz, "maxZ": -1,
        }

    lbl_acc = {k: _new_acc() for k in (1, 2, 3, 5)}
    reg_acc = {k: _new_acc() for k in ("WT", "TC", "ET", "RC", "nonCE")}

    def _update(acc: dict[str, Any], x: int, y: int, z: int) -> None:
        acc["count"] += 1
        acc["sx"] += x
        acc["sy"] += y
        acc["sz"] += z
        if x < acc["minX"]: acc["minX"] = x
        if x > acc["maxX"]: acc["maxX"] = x
        if y < acc["minY"]: acc["minY"] = y
        if y > acc["maxY"]: acc["maxY"] = y
        if z < acc["minZ"]: acc["minZ"] = z
        if z > acc["maxZ"]: acc["maxZ"] = z

    for z in range(nz):
        z_off = z * nx * ny
        for y in range(ny):
            row_off = z_off + y * nx
            for x in range(nx):
                nl = normalize_label(mask_data[row_off + x])
                if nl == 0:
                    continue
                _update(lbl_acc[nl], x, y, z)
                if nl == 3:
                    _update(reg_acc["ET"], x, y, z)
                    _update(reg_acc["TC"], x, y, z)
                    _update(reg_acc["WT"], x, y, z)
                elif nl == 1:
                    _update(reg_acc["TC"], x, y, z)
                    _update(reg_acc["WT"], x, y, z)
                    _update(reg_acc["nonCE"], x, y, z)
                elif nl == 2:
                    _update(reg_acc["WT"], x, y, z)
                    _update(reg_acc["nonCE"], x, y, z)
                elif nl == 5:
                    _update(reg_acc["RC"], x, y, z)

    def _finalize(acc: dict[str, Any]) -> dict[str, Any]:
        c = acc["count"]
        v_mm3 = c * vox_mm3
        v_cm3 = v_mm3 / 1000.0
        eq_d = 2.0 * ((3.0 * v_mm3) / (4.0 * math.pi)) ** (1.0 / 3.0) if c > 0 else 0.0
        centroid = [acc["sx"] / c, acc["sy"] / c, acc["sz"] / c] if c > 0 else None
        bbox = (
            {
                "minX": acc["minX"], "maxX": acc["maxX"],
                "minY": acc["minY"], "maxY": acc["maxY"],
                "minZ": acc["minZ"], "maxZ": acc["maxZ"],
            }
            if c > 0
            else None
        )
        return {
            "voxelCount": c,
            "volumeMm3": v_mm3,
            "volumeCm3": v_cm3,
            "centroid": centroid,
            "bbox": bbox,
            "eqSphereDiamMm": eq_d,
        }

    return {
        "dims": [nx, ny, nz],
        "pixdim": [dx, dy, dz],
        "voxelVolumeMm3": vox_mm3,
        "labels": {k: _finalize(v) for k, v in lbl_acc.items()},
        "regions": {k: _finalize(v) for k, v in reg_acc.items()},
        "rano2d": compute_axial_2d_diameters(mask_data, dims, pixdim, region="ET"),
    }


def compute_axial_2d_diameters(
    mask_data: list[float] | list[int],
    dims: tuple[int, int, int],
    pixdim: tuple[float, float, float],
    region: str = "ET",
) -> dict[str, Any]:
    """Independent reference implementation of axial 2D maximal perpendicular diameters (SPD)."""
    nx, ny, nz = dims
    dx, dy, _ = pixdim
    bin_w = max(dx, dy)

    best_result: dict[str, Any] | None = None
    best_rank = (-1.0, -1.0, -1)

    for z in range(nz):
        z_off = z * nx * ny
        pts: set[tuple[int, int]] = set()
        for y in range(ny):
            row_off = z_off + y * nx
            for x in range(nx):
                if is_in_region(normalize_label(mask_data[row_off + x]), region):
                    pts.add((x, y))
        if not pts:
            continue

        slice_area_mm2 = len(pts) * dx * dy

        # Partition into 8-connected components
        seen: set[tuple[int, int]] = set()
        comps: list[set[tuple[int, int]]] = []
        for start in pts:
            if start in seen:
                continue
            comp: set[tuple[int, int]] = set()
            dq = collections.deque([start])
            seen.add(start)
            while dq:
                cx, cy = dq.popleft()
                comp.add((cx, cy))
                for ox in (-1, 0, 1):
                    for oy in (-1, 0, 1):
                        if ox == 0 and oy == 0:
                            continue
                        nb = (cx + ox, cy + oy)
                        if nb in pts and nb not in seen:
                            seen.add(nb)
                            dq.append(nb)
            comps.append(comp)

        for comp in comps:
            # 4-connected boundary pixels
            boundary = [
                (x, y, x * dx, y * dy)
                for (x, y) in comp
                if (
                    (x - 1, y) not in comp
                    or (x + 1, y) not in comp
                    or (x, y - 1) not in comp
                    or (x, y + 1) not in comp
                )
            ]
            # Farthest pair
            max_d2 = -1.0
            p1 = boundary[0]
            p2 = boundary[0]
            nb_len = len(boundary)
            for i in range(nb_len):
                _, _, x1, y1 = boundary[i]
                for j in range(i + 1, nb_len):
                    _, _, x2, y2 = boundary[j]
                    dd = (x2 - x1) ** 2 + (y2 - y1) ** 2
                    if dd > max_d2:
                        max_d2 = dd
                        p1 = boundary[i]
                        p2 = boundary[j]

            center_dist = math.sqrt(max_d2) if max_d2 > 0.0 else 0.0
            if center_dist > 0.0:
                ux = (p2[2] - p1[2]) / center_dist
                uy = (p2[3] - p1[3]) / center_dist
            else:
                ux, uy = 1.0, 0.0

            d1_mm = center_dist + math.hypot(ux * dx, uy * dy)
            vx, vy = -uy, ux

            projected = [(px * ux + py * uy, px * vx + py * vy) for (_, _, px, py) in boundary]
            best_span = 0.0
            best_pair = (projected[0], projected[0])

            for shift in (0.0, 0.5 * bin_w):
                buckets: dict[int, list[tuple[float, float]]] = {}
                for t_val, s_val in projected:
                    bid = int(math.floor((t_val + shift) / bin_w))
                    buckets.setdefault(bid, []).append((t_val, s_val))
                for items in buckets.values():
                    qmin = min(items, key=lambda it: it[1])
                    qmax = max(items, key=lambda it: it[1])
                    span = qmax[1] - qmin[1]
                    if span > best_span:
                        best_span = span
                        best_pair = (qmin, qmax)

            d2_mm = best_span + math.hypot(vx * dx, vy * dy)
            spd_mm2 = d1_mm * d2_mm

            t_mid = 0.5 * (best_pair[0][0] + best_pair[1][0])
            s_min, s_max = best_pair[0][1], best_pair[1][1]
            minor_line = {
                "x1": (t_mid * ux + s_min * vx) / dx,
                "y1": (t_mid * uy + s_min * vy) / dy,
                "x2": (t_mid * ux + s_max * vx) / dx,
                "y2": (t_mid * uy + s_max * vy) / dy,
            }

            rank = (spd_mm2, d1_mm, len(comp))
            if rank > best_rank:
                best_rank = rank
                best_result = {
                    "region": region,
                    "d1Mm": d1_mm,
                    "d2Mm": d2_mm,
                    "spdMm2": spd_mm2,
                    "bestSliceZ": z,
                    "measurable": (d1_mm >= 10.0 and d2_mm >= 10.0),
                    "majorLine": {
                        "x1": float(p1[0]), "y1": float(p1[1]),
                        "x2": float(p2[0]), "y2": float(p2[1]),
                    },
                    "minorLine": minor_line,
                    "sliceAreaMm2": slice_area_mm2,
                    "componentCountOnSlice": len(comps),
                }

    if best_result is None:
        return {
            "region": region,
            "d1Mm": 0.0,
            "d2Mm": 0.0,
            "spdMm2": 0.0,
            "bestSliceZ": None,
            "measurable": False,
            "majorLine": None,
            "minorLine": None,
            "sliceAreaMm2": 0.0,
            "componentCountOnSlice": 0,
        }
    return best_result


def classify_rano_resect(
    pre_ce_cm3: float,
    pre_nonce_cm3: float,
    residual_ce_cm3: float,
    residual_nonce_cm3: float,
    cavity_cm3: float = 0.0,
) -> dict[str, Any]:
    """Official RANO-Resect classification (Karschnia et al., Neuro-Oncology 2023)."""
    def _clamp(val: float, lo: float, hi: float) -> float:
        return max(lo, min(hi, val))

    has_pre_op_ce = pre_ce_cm3 > EPS
    ce_eor = _clamp(((pre_ce_cm3 - residual_ce_cm3) / pre_ce_cm3) * 100.0, 0.0, 100.0) if has_pre_op_ce else 0.0
    nonce_eor = (
        _clamp(((pre_nonce_cm3 - residual_nonce_cm3) / pre_nonce_cm3) * 100.0, 0.0, 100.0)
        if pre_nonce_cm3 > EPS
        else 0.0
    )

    if not has_pre_op_ce:
        rano_class = "N/A"
        rano_name = (
            "Not Evaluable (No Pre-Op Tumor)"
            if pre_nonce_cm3 <= EPS
            else "Non-Enhancing Tumor (CE RANO-Resect N/A)"
        )
    elif ce_eor < 10.0:
        rano_class = "Class 4"
        rano_name = "Biopsy"
    elif residual_ce_cm3 <= EPS and residual_nonce_cm3 <= 5.0:
        rano_class = "Class 1"
        rano_name = "Supramaximal CE Resection"
    elif residual_ce_cm3 <= EPS and residual_nonce_cm3 > 5.0:
        rano_class = "Class 2A"
        rano_name = "Complete CE Resection"
    elif residual_ce_cm3 <= 1.0:
        rano_class = "Class 2B"
        rano_name = "Near-Total CE Resection"
    elif residual_ce_cm3 <= 5.0:
        rano_class = "Class 3A"
        rano_name = "Subtotal CE Resection"
    else:
        rano_class = "Class 3B"
        rano_name = "Partial CE Resection"

    return {
        "preCeCm3": pre_ce_cm3,
        "preNonCeCm3": pre_nonce_cm3,
        "preWtCm3": pre_ce_cm3 + pre_nonce_cm3,
        "residualCeCm3": residual_ce_cm3,
        "residualNonCeCm3": residual_nonce_cm3,
        "residualWtCm3": residual_ce_cm3 + residual_nonce_cm3,
        "cavityCm3": cavity_cm3,
        "ceEorPct": ce_eor,
        "nonCeEorPct": nonce_eor,
        "hasPreOpCe": has_pre_op_ce,
        "ranoResectApplicable": has_pre_op_ce,
        "ranoClass": rano_class,
        "ranoClassName": rano_name,
    }


def compute_rano2_response(timepoints: list[dict[str, Any]]) -> dict[str, Any]:
    """Official RANO 2.0 longitudinal criteria (Wen et al., JCO 2023)."""
    if len(timepoints) < 2:
        tp0 = timepoints[0] if timepoints else {"label": "None", "spdMm2": 0.0, "volumeCm3": 0.0}
        return {
            "category": "Baseline Only",
            "shortCode": "BASELINE",
            "severity": "neutral",
            "baseline": {"label": tp0["label"], "spdMm2": tp0["spdMm2"], "volumeCm3": tp0["volumeCm3"]},
            "spdChangeVsBaselinePct": 0.0,
            "spdChangeVsNadirPct": 0.0,
            "volChangeVsBaselinePct": 0.0,
            "volChangeVsNadirPct": 0.0,
            "criteriaTriggered": {
                "spdProgression": False,
                "volProgression": False,
                "newLesion": False,
                "clinicalDeterioration": False,
                "steroidBlockedResponse": False,
                "confirmationRequired": False,
            },
            "rationale": ["Only baseline scan available; longitudinal comparison requires >=2 timepoints."],
        }

    baseline = timepoints[0]
    current = timepoints[-1]
    prior = timepoints[:-1]

    nadir_spd_tp = min(prior, key=lambda t: t["spdMm2"])
    nadir_vol_tp = min(prior, key=lambda t: t["volumeCm3"])
    nadir_spd = float(nadir_spd_tp["spdMm2"])
    nadir_vol = float(nadir_vol_tp["volumeCm3"])
    base_spd = float(baseline["spdMm2"])
    base_vol = float(baseline["volumeCm3"])
    curr_spd = float(current["spdMm2"])
    curr_vol = float(current["volumeCm3"])

    def _pct_change(curr: float, ref: float) -> float | None:
        if ref > EPS:
            return ((curr - ref) / ref) * 100.0
        if curr <= EPS:
            return 0.0
        return None

    spd_vs_base = _pct_change(curr_spd, base_spd)
    spd_vs_nadir = _pct_change(curr_spd, nadir_spd)
    vol_vs_base = _pct_change(curr_vol, base_vol)
    vol_vs_nadir = _pct_change(curr_vol, nadir_vol)

    spd_prog = (nadir_spd > EPS and spd_vs_nadir is not None and spd_vs_nadir >= 25.0) or (
        nadir_spd <= EPS and curr_spd >= 100.0
    )
    vol_prog = (nadir_vol > EPS and vol_vs_nadir is not None and vol_vs_nadir >= 40.0) or (
        nadir_vol <= EPS and curr_vol >= 1.0
    )
    new_lesion = bool(current.get("newMeasurableLesion", False))
    clin_det = current.get("clinicalStatus") == "deteriorated"
    within_12w = bool(current.get("within12WeeksPostRT", False))
    raw_steroids = current.get("steroids")
    steroids = (
        "increased"
        if raw_steroids == "increased"
        else ("none_or_physiologic" if raw_steroids == "none_or_physiologic" else "stable_or_decreased")
    )
    steroids_inc = steroids == "increased"

    rationale: list[str] = []
    steroid_blocked = False
    confirmation_req = False

    rad_prog = spd_prog or vol_prog or new_lesion
    if rad_prog or clin_det:
        if spd_prog:
            rationale.append("2D SPD met RANO 2.0 progression threshold (>=+25% vs nadir or >=100 mm2 from 0).")
        if vol_prog:
            rationale.append("3D volume met RANO 2.0 progression threshold (>=+40% vs nadir or >=1.0 cm3 from 0).")
        if new_lesion:
            rationale.append("New measurable enhancing lesion identified.")
        if clin_det:
            rationale.append("Clinical status deteriorated.")

        if within_12w and rad_prog and not clin_det:
            category = "Preliminary PD (Confirm >=4 wks)"
            short_code = "PRELIM_PD"
            severity = "warning"
            confirmation_req = True
            rationale.append(
                "Within 12 weeks post-radiotherapy (clinically stable): RANO 2.0 requires >=4-week repeat MRI to rule out pseudoprogression."
            )
        else:
            category = "PD"
            short_code = "PD"
            severity = "progression"
            if within_12w and clin_det:
                rationale.append(
                    "Within <=12 weeks post-radiotherapy, but unequivocal clinical deterioration triggers definite PD per RANO 2.0."
                )
    else:
        has_baseline_disease = base_spd > EPS or base_vol > EPS
        is_cr = has_baseline_disease and curr_spd <= EPS and curr_vol <= EPS
        is_pr = (base_spd > EPS and spd_vs_base is not None and spd_vs_base <= -50.0) or (
            base_vol > EPS and vol_vs_base is not None and vol_vs_base <= -65.0
        )
        is_mr = (base_spd > EPS and spd_vs_base is not None and spd_vs_base <= -25.0) or (
            base_vol > EPS and vol_vs_base is not None and vol_vs_base <= -40.0
        )

        if is_cr or is_pr or is_mr:
            if steroids_inc:
                category = "SD"
                short_code = "SD"
                severity = "neutral"
                steroid_blocked = True
                rationale.append(
                    "Radiographic response criteria met, but downgraded to SD because corticosteroid dose increased."
                )
            elif is_cr:
                if steroids == "none_or_physiologic":
                    category, short_code, severity = "CR", "CR", "favorable"
                    rationale.append("Complete disappearance of all enhancing disease off corticosteroids / on physiologic replacement doses only.")
                else:
                    category, short_code, severity = "PR", "PR", "favorable"
                    steroid_blocked = True
                    rationale.append(
                        "Complete radiographic disappearance of enhancing disease on therapeutic stable/decreased corticosteroids: downgraded from CR to PR per RANO 2.0."
                    )
            elif is_pr:
                category, short_code, severity = "PR", "PR", "favorable"
                rationale.append("Partial response (>=50% SPD or >=65% volume reduction vs baseline).")
            else:
                category, short_code, severity = "MR", "MR", "favorable"
                rationale.append("Minor response (>=25% SPD or >=40% volume reduction vs baseline).")
        else:
            category, short_code, severity = "SD", "SD", "neutral"
            if not has_baseline_disease and curr_spd <= EPS and curr_vol <= EPS:
                rationale.append("No baseline enhancing disease present (0 -> 0); classified as SD / non-PD per RANO 2.0.")
            else:
                rationale.append("Does not meet criteria for CR, PR, MR, or PD.")

    return {
        "category": category,
        "shortCode": short_code,
        "severity": severity,
        "baseline": {"label": baseline["label"], "spdMm2": base_spd, "volumeCm3": base_vol},
        "nadir": {
            "spdMm2": nadir_spd,
            "volumeCm3": nadir_vol,
            "spdLabel": nadir_spd_tp["label"],
            "volumeLabel": nadir_vol_tp["label"],
        },
        "spdChangeVsBaselinePct": spd_vs_base,
        "spdChangeVsNadirPct": spd_vs_nadir,
        "volChangeVsBaselinePct": vol_vs_base,
        "volChangeVsNadirPct": vol_vs_nadir,
        "criteriaTriggered": {
            "spdProgression": spd_prog,
            "volProgression": vol_prog,
            "newLesion": new_lesion,
            "clinicalDeterioration": clin_det,
            "steroidBlockedResponse": steroid_blocked,
            "confirmationRequired": confirmation_req,
        },
        "rationale": rationale,
    }


def _edt_1d_parabolic(f: list[float], step_sq: float) -> list[float]:
    """Exact 1D squared Euclidean Distance Transform (Felzenszwalb & Huttenlocher 2012)."""
    n = len(f)
    inf = 1e30
    v = [0] * n
    z = [0.0] * (n + 1)
    k = 0
    v[0] = 0
    z[0] = -math.inf
    z[1] = math.inf

    for q in range(1, n):
        fq = f[q]
        if fq >= 1e29:
            continue
        while True:
            p = v[k]
            fp = f[p]
            if fp >= 1e29:
                v[k] = q
                z[k] = -math.inf
                z[k + 1] = math.inf
                break
            s = ((fq + q * q * step_sq) - (fp + p * p * step_sq)) / (2.0 * step_sq * (q - p))
            if s <= z[k]:
                k -= 1
            else:
                k += 1
                v[k] = q
                z[k] = s
                z[k + 1] = math.inf
                break

    if f[v[0]] >= 1e29:
        return [inf] * n

    out = [0.0] * n
    k = 0
    for q in range(n):
        while z[k + 1] < q:
            k += 1
        p = v[k]
        d = q - p
        out[q] = d * d * step_sq + f[p]
    return out


def _extract_surface_6conn(
    binary: bytearray,
    dims: tuple[int, int, int],
    bbox: tuple[int, int, int, int, int, int],
) -> list[tuple[int, int, int]]:
    nx, ny, nz = dims
    min_x, max_x, min_y, max_y, min_z, max_z = bbox
    surf: list[tuple[int, int, int]] = []
    stride_z = nx * ny
    for z in range(min_z, max_z + 1):
        z_off = z * stride_z
        for y in range(min_y, max_y + 1):
            row_off = z_off + y * nx
            for x in range(min_x, max_x + 1):
                idx = row_off + x
                if not binary[idx]:
                    continue
                if (
                    x == 0 or x == nx - 1
                    or y == 0 or y == ny - 1
                    or z == 0 or z == nz - 1
                    or not binary[idx - 1] or not binary[idx + 1]
                    or not binary[idx - nx] or not binary[idx + nx]
                    or not binary[idx - stride_z] or not binary[idx + stride_z]
                ):
                    surf.append((x, y, z))
    return surf


def compute_surface_distances_edt(
    s_gt: list[tuple[int, int, int]],
    s_pr: list[tuple[int, int, int]],
    bbox: tuple[int, int, int, int, int, int],
    pixdim: tuple[float, float, float],
) -> tuple[float, float]:
    """Exact anisotropic 3D surface distances (HD95, ASSD) in mm via separable 3D EDT."""
    min_x, max_x, min_y, max_y, min_z, max_z = bbox
    bx = max_x - min_x + 1
    by = max_y - min_y + 1
    bz = max_z - min_z + 1
    dx2, dy2, dz2 = pixdim[0] ** 2, pixdim[1] ** 2, pixdim[2] ** 2

    def _run_edt(seed_pts: list[tuple[int, int, int]]) -> list[float]:
        grid = [1e30] * (bx * by * bz)
        for x, y, z in seed_pts:
            grid[(x - min_x) + (y - min_y) * bx + (z - min_z) * bx * by] = 0.0
        for z in range(bz):
            zo = z * bx * by
            for y in range(by):
                o = zo + y * bx
                grid[o : o + bx] = _edt_1d_parabolic(grid[o : o + bx], dx2)
        for z in range(bz):
            zo = z * bx * by
            for x in range(bx):
                col = _edt_1d_parabolic([grid[zo + y * bx + x] for y in range(by)], dy2)
                for y in range(by):
                    grid[zo + y * bx + x] = col[y]
        for y in range(by):
            yo = y * bx
            for x in range(bx):
                col = _edt_1d_parabolic([grid[z * bx * by + yo + x] for z in range(bz)], dz2)
                for z in range(bz):
                    grid[z * bx * by + yo + x] = col[z]
        return grid

    edt_pr = _run_edt(s_pr)
    edt_gt = _run_edt(s_gt)

    dists = [
        math.sqrt(edt_pr[(x - min_x) + (y - min_y) * bx + (z - min_z) * bx * by])
        for (x, y, z) in s_gt
    ] + [
        math.sqrt(edt_gt[(x - min_x) + (y - min_y) * bx + (z - min_z) * bx * by])
        for (x, y, z) in s_pr
    ]

    dists.sort()
    n = len(dists)
    assd = sum(dists) / n
    pos = 0.95 * (n - 1)
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    hd95 = dists[lo] * (1.0 - (pos - lo)) + dists[hi] * (pos - lo)
    return hd95, assd


def compute_surface_distances_bruteforce(
    s_gt: list[tuple[int, int, int]],
    s_pr: list[tuple[int, int, int]],
    pixdim: tuple[float, float, float],
) -> tuple[float, float]:
    """Direct O(|S_gt| * |S_pred|) brute-force oracle for validating the O(N) 3D EDT."""
    dx, dy, dz = pixdim

    def _min_dists(src: list[tuple[int, int, int]], dst: list[tuple[int, int, int]]) -> list[float]:
        out: list[float] = []
        for x1, y1, z1 in src:
            best2 = math.inf
            for x2, y2, z2 in dst:
                d2 = ((x1 - x2) * dx) ** 2 + ((y1 - y2) * dy) ** 2 + ((z1 - z2) * dz) ** 2
                if d2 < best2:
                    best2 = d2
            out.append(math.sqrt(best2))
        return out

    dists = _min_dists(s_gt, s_pr) + _min_dists(s_pr, s_gt)
    dists.sort()
    n = len(dists)
    assd = sum(dists) / n
    pos = 0.95 * (n - 1)
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    hd95 = dists[lo] * (1.0 - (pos - lo)) + dists[hi] * (pos - lo)
    return hd95, assd


def evaluate_segmentation(
    gt_data: list[float] | list[int],
    pred_data: list[float] | list[int],
    dims: tuple[int, int, int],
    pixdim: tuple[float, float, float],
    error_region: str = "ET",
) -> dict[str, Any]:
    nx, ny, nz = dims
    n_vox = nx * ny * nz
    if len(gt_data) != n_vox or len(pred_data) != n_vox:
        raise ValueError("GT and Pred dimensions mismatch")
    vox_mm3 = pixdim[0] * pixdim[1] * pixdim[2]

    regions_out: dict[str, Any] = {}
    error_vol = bytearray(n_vox)

    for region in ("ET", "TC", "WT", "RC"):
        gt_bin = bytearray(n_vox)
        pr_bin = bytearray(n_vox)
        tp = fp = fn = 0
        min_x, max_x = nx, -1
        min_y, max_y = ny, -1
        min_z, max_z = nz, -1

        for z in range(nz):
            z_off = z * nx * ny
            for y in range(ny):
                row_off = z_off + y * nx
                for x in range(nx):
                    idx = row_off + x
                    g = 1 if is_in_region(normalize_label(gt_data[idx]), region) else 0
                    p = 1 if is_in_region(normalize_label(pred_data[idx]), region) else 0
                    gt_bin[idx] = g
                    pr_bin[idx] = p
                    if g and p:
                        tp += 1
                        if region == error_region:
                            error_vol[idx] = 1  # TP
                    elif p and not g:
                        fp += 1
                        if region == error_region:
                            error_vol[idx] = 2  # FP
                    elif g and not p:
                        fn += 1
                        if region == error_region:
                            error_vol[idx] = 3  # FN
                    if g or p:
                        if x < min_x: min_x = x
                        if x > max_x: max_x = x
                        if y < min_y: min_y = y
                        if y > max_y: max_y = y
                        if z < min_z: min_z = z
                        if z > max_z: max_z = z

        gt_cnt = tp + fn
        pr_cnt = tp + fp
        both_empty = (gt_cnt == 0 and pr_cnt == 0)
        dice = 1.0 if both_empty else (0.0 if (gt_cnt == 0 or pr_cnt == 0) else (2.0 * tp) / (2.0 * tp + fp + fn))
        iou = 1.0 if both_empty else (tp / (tp + fp + fn))
        sens = (tp / gt_cnt) if gt_cnt > 0 else (1.0 if pr_cnt == 0 else 0.0)
        prec = (tp / pr_cnt) if pr_cnt > 0 else (1.0 if gt_cnt == 0 else 0.0)
        gt_cm3 = gt_cnt * vox_mm3 / 1000.0
        pr_cm3 = pr_cnt * vox_mm3 / 1000.0
        rve = ((pr_cm3 - gt_cm3) / gt_cm3) * 100.0 if gt_cm3 > 0 else (0.0 if pr_cm3 == 0 else None)

        if both_empty:
            hd95, assd = 0.0, 0.0
        elif gt_cnt == 0 or pr_cnt == 0:
            hd95, assd = None, None
        else:
            bbox = (min_x, max_x, min_y, max_y, min_z, max_z)
            s_gt = _extract_surface_6conn(gt_bin, dims, bbox)
            s_pr = _extract_surface_6conn(pr_bin, dims, bbox)
            hd95, assd = compute_surface_distances_edt(s_gt, s_pr, bbox, pixdim)

        regions_out[region] = {
            "tp": tp,
            "fp": fp,
            "fn": fn,
            "gtCm3": gt_cm3,
            "predCm3": pr_cm3,
            "dice": dice,
            "iou": iou,
            "hd95Mm": hd95,
            "assdMm": assd,
            "sensitivity": sens,
            "precision": prec,
            "rvePct": rve,
            "bothEmpty": both_empty,
        }

    return {"regions": regions_out, "errorRegion": error_region, "errorVolume": error_vol}


# ---------------------------------------------------------------------------
# Unit Test Suites
# ---------------------------------------------------------------------------

class TestNiftiDatasetIntegrity(unittest.TestCase):
    """Validates all 7 generated .nii.gz headers, dimensions, byte sizes, labels, and intensities."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.volumes = {fname: read_nifti_gz(SAMPLES_DIR / fname) for fname in ALL_SAMPLE_FILES}

    def test_all_files_exist_and_under_250kb(self) -> None:
        for fname in ALL_SAMPLE_FILES:
            fpath = SAMPLES_DIR / fname
            self.assertTrue(fpath.is_file(), f"Missing generated file: {fpath}")
            size = fpath.stat().st_size
            self.assertGreater(size, 100, f"{fname} unexpectedly tiny ({size} bytes)")
            self.assertLess(
                size,
                MAX_COMPRESSED_BYTES,
                f"{fname} exceeds 250 KB limit ({size / 1024:.1f} KB)",
            )

    def test_nifti1_headers_spec_compliant(self) -> None:
        for fname, vol in self.volumes.items():
            with self.subTest(file=fname):
                self.assertEqual(vol["sizeof_hdr"], 348)
                self.assertEqual(vol["endian"], "<")
                self.assertEqual(vol["magic"], b"n+1\x00")
                self.assertEqual(vol["dim"], (3, 64, 64, 48, 1, 1, 1, 1))
                self.assertEqual(vol["dims"], (64, 64, 48))
                self.assertAlmostEqual(vol["pixdim_raw"][0], 1.0, places=5)
                self.assertEqual(vol["pixdim"], (2.0, 2.0, 2.0))
                self.assertAlmostEqual(vol["vox_offset"], 352.0, places=5)
                self.assertAlmostEqual(vol["scl_slope"], 1.0, places=5)
                self.assertAlmostEqual(vol["scl_inter"], 0.0, places=5)
                self.assertEqual(vol["sform_code"], 1)
                self.assertEqual(vol["qform_code"], 1)
                self.assertEqual(vol["xyzt_units"], 2)  # mm
                # Verify proper positive RAS diagonal sform affine
                self.assertAlmostEqual(vol["srow_x"][0], 2.0, places=5)
                self.assertAlmostEqual(vol["srow_x"][1], 0.0, places=5)
                self.assertAlmostEqual(vol["srow_x"][2], 0.0, places=5)
                self.assertAlmostEqual(vol["srow_y"][0], 0.0, places=5)
                self.assertAlmostEqual(vol["srow_y"][1], 2.0, places=5)
                self.assertAlmostEqual(vol["srow_y"][2], 0.0, places=5)
                self.assertAlmostEqual(vol["srow_z"][0], 0.0, places=5)
                self.assertAlmostEqual(vol["srow_z"][1], 0.0, places=5)
                self.assertAlmostEqual(vol["srow_z"][2], 2.0, places=5)

    def test_datatypes_and_exact_byte_sizes(self) -> None:
        n_vox = 64 * 64 * 48
        for fname in EXPECTED_MRI_FILES:
            vol = self.volumes[fname]
            self.assertEqual(vol["datatype"], 16, f"{fname} should be float32 (datatype=16)")
            self.assertEqual(vol["bitpix"], 32)
            self.assertEqual(vol["uncompressed_bytes"], 352 + n_vox * 4)

        for fname in EXPECTED_MASK_FILES:
            vol = self.volumes[fname]
            self.assertEqual(vol["datatype"], 2, f"{fname} should be uint8 (datatype=2)")
            self.assertEqual(vol["bitpix"], 8)
            self.assertEqual(vol["uncompressed_bytes"], 352 + n_vox)

    def test_mri_anatomical_intensity_ranges_and_tissue_contrast(self) -> None:
        for mri_name, mask_name in [
            ("case01_preop_t1ce.nii.gz", "case01_preop_gt.nii.gz"),
            ("case01_postop_t1ce.nii.gz", "case01_postop_mask.nii.gz"),
            ("case01_followup_t1ce.nii.gz", "case01_followup_mask.nii.gz"),
        ]:
            with self.subTest(mri=mri_name):
                mri = self.volumes[mri_name]["data"]
                mask = self.volumes[mask_name]["data"]
                self.assertTrue(all(math.isfinite(v) for v in mri))
                self.assertEqual(min(mri), 0.0)
                self.assertGreaterEqual(max(mri), 780.0)
                self.assertLessEqual(max(mri), 1000.0)

                # Verify clinical tissue contrast ordering on T1ce:
                # Enhancing Tumor (ET) >> Brain Parenchyma > Edema (ED) > Necrosis/Cavity (NCR/RC)
                et_vals = [mri[i] for i, m in enumerate(mask) if m == 3]
                ed_vals = [mri[i] for i, m in enumerate(mask) if m == 2]
                bg_brain_vals = [mri[i] for i, m in enumerate(mask) if m == 0 and mri[i] > 350.0]
                self.assertGreater(len(et_vals), 0)
                self.assertGreater(len(ed_vals), 0)
                self.assertGreater(len(bg_brain_vals), 10000)

                mean_et = sum(et_vals) / len(et_vals)
                mean_ed = sum(ed_vals) / len(ed_vals)
                mean_brain = sum(bg_brain_vals) / len(bg_brain_vals)

                self.assertGreater(mean_et, 780.0)
                self.assertGreater(mean_et, mean_brain + 200.0)
                self.assertGreater(mean_brain, mean_ed + 150.0)

                if mri_name == "case01_preop_t1ce.nii.gz":
                    ncr_vals = [mri[i] for i, m in enumerate(mask) if m == 1]
                    mean_ncr = sum(ncr_vals) / len(ncr_vals)
                    self.assertLess(mean_ncr, 170.0)
                    self.assertLess(mean_ncr, mean_ed - 100.0)
                else:
                    rc_vals = [mri[i] for i, m in enumerate(mask) if m == 5]
                    mean_rc = sum(rc_vals) / len(rc_vals)
                    self.assertLess(mean_rc, 160.0)
                    self.assertLess(mean_rc, mean_ed - 100.0)

    def test_mask_labels_non_empty_and_right_frontal_localization(self) -> None:
        self.assertEqual(set(self.volumes["case01_preop_gt.nii.gz"]["data"]), {0, 1, 2, 3})
        self.assertEqual(set(self.volumes["case01_preop_pred.nii.gz"]["data"]), {0, 1, 2, 3})
        self.assertEqual(set(self.volumes["case01_postop_mask.nii.gz"]["data"]), {0, 2, 3, 5})
        self.assertEqual(set(self.volumes["case01_followup_mask.nii.gz"]["data"]), {0, 2, 3, 5})

        # Verify Right Frontal lobe location in RAS+ (x > 32 = Right, y > 32 = Anterior)
        preop_vol = compute_volumetrics(
            self.volumes["case01_preop_gt.nii.gz"]["data"], (64, 64, 48), (2.0, 2.0, 2.0)
        )
        cx, cy, cz = preop_vol["regions"]["ET"]["centroid"]
        self.assertGreater(cx, 35.0, "Pre-op tumor must lie in Right hemisphere (RAS+ x > 32)")
        self.assertGreater(cy, 34.0, "Pre-op tumor must lie in Frontal lobe (RAS+ y > 32)")
        self.assertGreater(cz, 20.0)
        self.assertLess(cz, 34.0)


class TestClinicalDatasetCalibration(unittest.TestCase):
    """Validates clinical targets for Case 01 (Volumetrics, 2D RANO, RANO-Resect, RANO 2.0, AI QA)."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.preop_gt = read_nifti_gz(SAMPLES_DIR / "case01_preop_gt.nii.gz")
        cls.preop_pred = read_nifti_gz(SAMPLES_DIR / "case01_preop_pred.nii.gz")
        cls.postop_mask = read_nifti_gz(SAMPLES_DIR / "case01_postop_mask.nii.gz")
        cls.followup_mask = read_nifti_gz(SAMPLES_DIR / "case01_followup_mask.nii.gz")

        cls.vol_preop = compute_volumetrics(cls.preop_gt["data"], cls.preop_gt["dims"], cls.preop_gt["pixdim"])
        cls.vol_postop = compute_volumetrics(cls.postop_mask["data"], cls.postop_mask["dims"], cls.postop_mask["pixdim"])
        cls.vol_followup = compute_volumetrics(
            cls.followup_mask["data"], cls.followup_mask["dims"], cls.followup_mask["pixdim"]
        )

    def test_preop_gt_volumetrics_and_2d_rano(self) -> None:
        ncr = self.vol_preop["labels"][1]["volumeCm3"]
        et = self.vol_preop["regions"]["ET"]["volumeCm3"]
        ed = self.vol_preop["labels"][2]["volumeCm3"]
        rano2d = self.vol_preop["rano2d"]

        self.assertGreaterEqual(ncr, 5.0)
        self.assertLessEqual(ncr, 8.0)
        self.assertGreaterEqual(et, 16.0)
        self.assertLessEqual(et, 22.0)
        self.assertGreaterEqual(ed, 25.0)
        self.assertLessEqual(ed, 35.0)

        self.assertTrue(rano2d["measurable"])
        self.assertGreaterEqual(rano2d["d1Mm"], 10.0)
        self.assertGreaterEqual(rano2d["d2Mm"], 10.0)
        self.assertGreaterEqual(rano2d["spdMm2"], 900.0)
        self.assertLessEqual(rano2d["spdMm2"], 1300.0)
        self.assertIsNotNone(rano2d["bestSliceZ"])

    def test_postop_mask_and_rano_resect_class_2b(self) -> None:
        rc = self.vol_postop["regions"]["RC"]["volumeCm3"]
        res_et = self.vol_postop["regions"]["ET"]["volumeCm3"]
        ed = self.vol_postop["labels"][2]["volumeCm3"]
        ncr = self.vol_postop["labels"][1]["volumeCm3"]

        self.assertEqual(ncr, 0.0)
        self.assertGreaterEqual(rc, 18.0)
        self.assertLessEqual(rc, 24.0)
        self.assertGreaterEqual(res_et, 0.55)
        self.assertLessEqual(res_et, 0.85)
        self.assertGreaterEqual(ed, 10.0)
        self.assertLessEqual(ed, 15.0)

        eor = classify_rano_resect(
            pre_ce_cm3=self.vol_preop["regions"]["ET"]["volumeCm3"],
            pre_nonce_cm3=self.vol_preop["regions"]["nonCE"]["volumeCm3"],
            residual_ce_cm3=res_et,
            residual_nonce_cm3=self.vol_postop["regions"]["nonCE"]["volumeCm3"],
            cavity_cm3=rc,
        )
        self.assertGreaterEqual(eor["ceEorPct"], 95.5)
        self.assertLessEqual(eor["ceEorPct"], 97.5)
        self.assertEqual(eor["ranoClass"], "Class 2B")
        self.assertEqual(eor["ranoClassName"], "Near-Total CE Resection")

    def test_followup_mask_and_rano2_progression(self) -> None:
        rc = self.vol_followup["regions"]["RC"]["volumeCm3"]
        rec_et = self.vol_followup["regions"]["ET"]["volumeCm3"]
        ed = self.vol_followup["labels"][2]["volumeCm3"]
        rano2d_fu = self.vol_followup["rano2d"]

        self.assertGreaterEqual(rc, 14.0)
        self.assertLessEqual(rc, 18.0)
        self.assertGreaterEqual(rec_et, 4.5)
        self.assertLessEqual(rec_et, 6.5)
        self.assertGreaterEqual(ed, 18.0)
        self.assertLessEqual(ed, 24.0)
        self.assertTrue(rano2d_fu["measurable"])
        self.assertGreaterEqual(rano2d_fu["spdMm2"], 300.0)

        tp_postop = {
            "id": "postop",
            "label": "Early Post-Op (<72h)",
            "spdMm2": self.vol_postop["rano2d"]["spdMm2"],
            "volumeCm3": self.vol_postop["regions"]["ET"]["volumeCm3"],
            "steroids": "stable_or_decreased",
            "clinicalStatus": "stable_or_improved",
            "newMeasurableLesion": False,
            "within12WeeksPostRT": True,
        }
        tp_followup_gt12w = {
            "id": "followup",
            "label": "6-Month Follow-Up",
            "spdMm2": rano2d_fu["spdMm2"],
            "volumeCm3": rec_et,
            "steroids": "increased",
            "clinicalStatus": "deteriorated",
            "newMeasurableLesion": False,
            "within12WeeksPostRT": False,
        }
        res_pd = compute_rano2_response([tp_postop, tp_followup_gt12w])
        self.assertEqual(res_pd["category"], "PD")
        self.assertEqual(res_pd["shortCode"], "PD")
        self.assertTrue(res_pd["criteriaTriggered"]["spdProgression"])
        self.assertTrue(res_pd["criteriaTriggered"]["volProgression"])
        self.assertGreater(res_pd["spdChangeVsNadirPct"], 25.0)
        self.assertGreater(res_pd["volChangeVsNadirPct"], 40.0)

        # Toggle within12WeeksPostRT while clinicalStatus="deteriorated" -> definite PD (monotonic RANO 2.0 rule)
        tp_followup_lt12w_det = dict(tp_followup_gt12w, within12WeeksPostRT=True)
        res_det_lt12w = compute_rano2_response([tp_postop, tp_followup_lt12w_det])
        self.assertEqual(res_det_lt12w["category"], "PD")
        self.assertEqual(res_det_lt12w["shortCode"], "PD")
        self.assertFalse(res_det_lt12w["criteriaTriggered"]["confirmationRequired"])

        # Toggle within12WeeksPostRT while clinically stable -> Preliminary PD (Confirm >=4 wks)
        tp_followup_lt12w_stable = dict(
            tp_followup_gt12w, within12WeeksPostRT=True, clinicalStatus="stable_or_improved"
        )
        res_prelim = compute_rano2_response([tp_postop, tp_followup_lt12w_stable])
        self.assertEqual(res_prelim["category"], "Preliminary PD (Confirm >=4 wks)")
        self.assertEqual(res_prelim["shortCode"], "PRELIM_PD")
        self.assertTrue(res_prelim["criteriaTriggered"]["confirmationRequired"])

    def test_preop_ai_segmentation_qa_metrics(self) -> None:
        res = evaluate_segmentation(
            self.preop_gt["data"],
            self.preop_pred["data"],
            self.preop_gt["dims"],
            self.preop_gt["pixdim"],
            error_region="ET",
        )
        et = res["regions"]["ET"]
        tc = res["regions"]["TC"]
        wt = res["regions"]["WT"]
        rc = res["regions"]["RC"]

        # Calibration target bands (ARCHITECTURE.md Section 3.2)
        self.assertGreaterEqual(et["dice"], 0.86)
        self.assertLessEqual(et["dice"], 0.92)
        self.assertGreaterEqual(tc["dice"], 0.88)
        self.assertLessEqual(tc["dice"], 0.93)
        self.assertGreaterEqual(wt["dice"], 0.89)
        self.assertLessEqual(wt["dice"], 0.94)

        for rname, m in (("ET", et), ("TC", tc), ("WT", wt)):
            with self.subTest(region=rname):
                self.assertGreaterEqual(m["hd95Mm"], 2.0)
                self.assertLessEqual(m["hd95Mm"], 6.5)
                self.assertGreaterEqual(m["assdMm"], 0.4)
                self.assertLessEqual(m["assdMm"], 1.5)
                self.assertGreater(m["iou"], 0.70)
                self.assertLess(m["iou"], m["dice"])
                self.assertGreater(m["sensitivity"], 0.80)
                self.assertGreater(m["precision"], 0.80)
                # Verify mathematical identity: Dice = 2*IoU / (1 + IoU)
                self.assertAlmostEqual(m["dice"], (2.0 * m["iou"]) / (1.0 + m["iou"]), places=6)

        # Both preop GT and Pred have zero cavity (label 5)
        self.assertTrue(rc["bothEmpty"])
        self.assertEqual(rc["dice"], 1.0)
        self.assertEqual(rc["hd95Mm"], 0.0)

        # Verify 3D errorVolume counts match ET TP/FP/FN exactly
        ev = res["errorVolume"]
        self.assertEqual(ev.count(1), et["tp"])
        self.assertEqual(ev.count(2), et["fp"])
        self.assertEqual(ev.count(3), et["fn"])


class TestReferenceMathAlgorithms(unittest.TestCase):
    """Independent unit tests for every mathematical & clinical rule edge case."""

    def test_legacy_brats_label_4_mapping(self) -> None:
        self.assertEqual(normalize_label(4.0), 3)
        self.assertEqual(normalize_label(3.8), 3)
        self.assertEqual(normalize_label(5.0), 5)
        self.assertEqual(normalize_label(99.0), 0)
        self.assertTrue(is_in_region(normalize_label(4), "ET"))
        self.assertTrue(is_in_region(normalize_label(4), "TC"))
        self.assertTrue(is_in_region(normalize_label(4), "WT"))
        self.assertFalse(is_in_region(5, "WT"))  # Cavity excluded from WT!
        self.assertTrue(is_in_region(5, "RC"))

    def test_axial_2d_rano_analytical_shapes_and_multifocal_separation(self) -> None:
        # 1. Known 10x6 voxel solid rectangle (dx=2, dy=2 -> 20mm x 12mm) on slice z=1
        dims = (24, 24, 3)
        pixdim = (2.0, 2.0, 2.0)
        mask = [0] * (24 * 24 * 3)
        for y in range(6, 12):      # 6 voxels -> 12 mm
            for x in range(4, 14):  # 10 voxels -> 20 mm
                mask[x + y * 24 + 1 * 24 * 24] = 3
        r2d = compute_axial_2d_diameters(mask, dims, pixdim, "ET")
        self.assertEqual(r2d["bestSliceZ"], 1)
        self.assertTrue(r2d["measurable"])
        # Diagonal of 10x6 rectangle centers is hypot(18, 10) + 2*hypot(ux, uy) ~ 22.59 mm
        self.assertGreater(r2d["d1Mm"], 20.0)
        self.assertGreater(r2d["d2Mm"], 10.0)
        self.assertEqual(r2d["componentCountOnSlice"], 1)

        # 2. Two disconnected small lesions (each 3x3 = 6mm x 6mm, non-measurable) separated by 12 voxels:
        # 8-connected separation MUST prevent measuring across empty parenchyma!
        mask_mf = [0] * (24 * 24 * 3)
        for y in range(2, 5):
            for x in range(2, 5):
                mask_mf[x + y * 24 + 1 * 24 * 24] = 3
        for y in range(18, 21):
            for x in range(18, 21):
                mask_mf[x + y * 24 + 1 * 24 * 24] = 3
        r2d_mf = compute_axial_2d_diameters(mask_mf, dims, pixdim, "ET")
        self.assertEqual(r2d_mf["componentCountOnSlice"], 2)
        self.assertFalse(r2d_mf["measurable"], "Separated 6x6mm lesions must NOT merge into measurable lesion")
        self.assertLess(r2d_mf["d1Mm"], 10.0)

        # 3. Legacy label 4 ring should auto-map to ET and measure outer diameter across hollow core
        mask_ring = [0] * (24 * 24 * 3)
        for y in range(4, 15):
            for x in range(4, 15):
                r = math.hypot(x - 9.0, y - 9.0)
                if 3.0 <= r <= 5.0:
                    mask_ring[x + y * 24 + 1 * 24 * 24] = 4  # Legacy BraTS label 4!
        r2d_ring = compute_axial_2d_diameters(mask_ring, dims, pixdim, "ET")
        self.assertTrue(r2d_ring["measurable"])
        self.assertGreater(r2d_ring["d1Mm"], 20.0)
        self.assertGreater(r2d_ring["d2Mm"], 20.0)

    def test_all_six_rano_resect_classes(self) -> None:
        # Class 1: Supramaximal CE Resection (0 residual CE, <= 5 cm3 non-CE)
        c1 = classify_rano_resect(20.0, 30.0, 0.0, 3.5)
        self.assertEqual(c1["ranoClass"], "Class 1")
        self.assertTrue(c1["hasPreOpCe"])

        # Class 2A: Complete CE Resection (0 residual CE, > 5 cm3 non-CE)
        c2a = classify_rano_resect(20.0, 30.0, 0.0, 12.0)
        self.assertEqual(c2a["ranoClass"], "Class 2A")

        # Class 2B: Near-Total CE Resection (<= 1.0 cm3 residual CE strictly by absolute residual volume)
        c2b = classify_rano_resect(20.0, 30.0, 0.8, 12.0)
        self.assertEqual(c2b["ranoClass"], "Class 2B")
        self.assertAlmostEqual(c2b["ceEorPct"], 96.0, places=5)

        # Small GBM (3.0 -> 0.8 cm3 CE, 73.3% EOR): strictly Class 2B under Karschnia et al. 2023 (no 95% gate!)
        c2b_small = classify_rano_resect(3.0, 10.0, 0.8, 6.0)
        self.assertEqual(c2b_small["ranoClass"], "Class 2B")
        self.assertAlmostEqual(c2b_small["ceEorPct"], (2.2 / 3.0) * 100.0, places=4)

        # Class 3A: Subtotal CE Resection (>1.0 to <= 5.0 cm3 residual CE strictly by absolute residual volume)
        c3a = classify_rano_resect(20.0, 30.0, 3.0, 15.0)
        self.assertEqual(c3a["ranoClass"], "Class 3A")
        self.assertAlmostEqual(c3a["ceEorPct"], 85.0, places=5)

        # Smaller GBM (10.0 -> 3.0 cm3 CE, 70.0% EOR): strictly Class 3A under Karschnia et al. 2023 (no 80% gate!)
        c3a_small = classify_rano_resect(10.0, 20.0, 3.0, 12.0)
        self.assertEqual(c3a_small["ranoClass"], "Class 3A")
        self.assertAlmostEqual(c3a_small["ceEorPct"], 70.0, places=5)

        # Class 3B: Partial CE Resection (> 5.0 cm3 residual CE, >= 10% CE reduction)
        c3b = classify_rano_resect(20.0, 30.0, 8.0, 20.0)
        self.assertEqual(c3b["ranoClass"], "Class 3B")
        self.assertAlmostEqual(c3b["ceEorPct"], 60.0, places=5)

        # Class 4: Biopsy (< 10% CE EOR)
        c4 = classify_rano_resect(20.0, 30.0, 19.0, 29.0)
        self.assertEqual(c4["ranoClass"], "Class 4")
        self.assertAlmostEqual(c4["ceEorPct"], 5.0, places=5)

        # Zero pre-op CE guards: non-enhancing tumor (40 -> 25 non-CE) and empty mask pair (0 -> 0) must NOT be Class 1/2A
        non_enh = classify_rano_resect(0.0, 40.0, 0.0, 25.0)
        self.assertEqual(non_enh["ranoClass"], "N/A")
        self.assertFalse(non_enh["hasPreOpCe"])
        self.assertAlmostEqual(non_enh["nonCeEorPct"], 37.5, places=5)

        empty_pair = classify_rano_resect(0.0, 0.0, 0.0, 0.0)
        self.assertEqual(empty_pair["ranoClass"], "N/A")
        self.assertFalse(empty_pair["hasPreOpCe"])

    def test_all_rano2_longitudinal_categories(self) -> None:
        base = {
            "id": "t0", "label": "Baseline", "spdMm2": 400.0, "volumeCm3": 10.0,
            "steroids": "stable_or_decreased", "clinicalStatus": "stable_or_improved",
            "newMeasurableLesion": False, "within12WeeksPostRT": False,
        }

        # Baseline Only
        self.assertEqual(compute_rano2_response([base])["category"], "Baseline Only")

        # CR: Complete disappearance requires off corticosteroids or physiologic replacement doses only
        tp_cr = dict(base, id="t1", label="CR", spdMm2=0.0, volumeCm3=0.0, steroids="none_or_physiologic")
        res_cr = compute_rano2_response([base, tp_cr])
        self.assertEqual(res_cr["category"], "CR")
        self.assertFalse(res_cr["criteriaTriggered"]["steroidBlockedResponse"])

        # Radiographic CR on therapeutic stable/decreased steroids -> downgraded to PR per RANO 2.0
        tp_cr_ther_steroids = dict(base, id="t1", label="CR-TherSteroid", spdMm2=0.0, volumeCm3=0.0, steroids="stable_or_decreased")
        res_cr_pr = compute_rano2_response([base, tp_cr_ther_steroids])
        self.assertEqual(res_cr_pr["category"], "PR")
        self.assertTrue(res_cr_pr["criteriaTriggered"]["steroidBlockedResponse"])

        # CR blocked by increased steroids -> downgraded to SD
        tp_cr_steroid = dict(tp_cr, steroids="increased")
        res_sb = compute_rano2_response([base, tp_cr_steroid])
        self.assertEqual(res_sb["category"], "SD")
        self.assertTrue(res_sb["criteriaTriggered"]["steroidBlockedResponse"])

        # 0 -> 0 trajectory (no baseline enhancing disease, e.g. post-GTR) must remain SD, never CR
        base_zero = dict(base, spdMm2=0.0, volumeCm3=0.0, steroids="none_or_physiologic")
        tp_zero_fu = dict(base_zero, id="t1", label="NoRecurrence", spdMm2=0.0, volumeCm3=0.0, steroids="none_or_physiologic")
        res_zero = compute_rano2_response([base_zero, tp_zero_fu])
        self.assertEqual(res_zero["category"], "SD")

        # PR by SPD (<= -50%) on stable/decreased steroids
        tp_pr_spd = dict(base, id="t1", label="PR-SPD", spdMm2=190.0, volumeCm3=5.0)
        self.assertEqual(compute_rano2_response([base, tp_pr_spd])["category"], "PR")

        # PR by Volume (<= -65%)
        tp_pr_vol = dict(base, id="t1", label="PR-Vol", spdMm2=250.0, volumeCm3=3.2)
        self.assertEqual(compute_rano2_response([base, tp_pr_vol])["category"], "PR")

        # MR by SPD (-25% to -49%)
        tp_mr = dict(base, id="t1", label="MR", spdMm2=280.0, volumeCm3=7.0)
        self.assertEqual(compute_rano2_response([base, tp_mr])["category"], "MR")

        # SD (between -24% and +24% SPD, -39% and +39% Vol)
        tp_sd = dict(base, id="t1", label="SD", spdMm2=440.0, volumeCm3=11.5)
        self.assertEqual(compute_rano2_response([base, tp_sd])["category"], "SD")

        # PD by SPD >= +25% vs nadir (even if still below baseline!)
        tp_nadir = dict(base, id="t1", label="Nadir PR", spdMm2=160.0, volumeCm3=3.0)
        tp_rebound = dict(base, id="t2", label="Rebound", spdMm2=220.0, volumeCm3=3.8)
        res_reb = compute_rano2_response([base, tp_nadir, tp_rebound])
        self.assertEqual(res_reb["category"], "PD")
        self.assertAlmostEqual(res_reb["spdChangeVsNadirPct"], 37.5, places=5)

        # PD by Volume >= +40% vs nadir
        tp_pd_vol = dict(base, id="t1", label="PD-Vol", spdMm2=440.0, volumeCm3=14.5)
        self.assertEqual(compute_rano2_response([base, tp_pd_vol])["category"], "PD")

        # PD by emergence from 0 nadir (>= 100 mm2 or >= 1.0 cm3)
        tp_emerge = dict(base, id="t1", label="Emerge", spdMm2=120.0, volumeCm3=1.2)
        res_em = compute_rano2_response([base_zero, tp_emerge])
        self.assertEqual(res_em["category"], "PD")
        self.assertIsNone(res_em["spdChangeVsNadirPct"])

        # PD by new measurable lesion
        tp_new = dict(base, id="t1", label="NewLesion", newMeasurableLesion=True)
        self.assertEqual(compute_rano2_response([base, tp_new])["category"], "PD")

        # PD by clinical deterioration alone
        tp_clin = dict(base, id="t1", label="ClinDet", clinicalStatus="deteriorated")
        self.assertEqual(compute_rano2_response([base, tp_clin])["category"], "PD")

        # Preliminary PD when radiographic progression occurs within 12 weeks post-RT AND clinically stable
        tp_prelim = dict(base, id="t1", label="EarlyRT", spdMm2=560.0, volumeCm3=16.0, within12WeeksPostRT=True)
        res_pre = compute_rano2_response([base, tp_prelim])
        self.assertEqual(res_pre["category"], "Preliminary PD (Confirm >=4 wks)")
        self.assertEqual(res_pre["shortCode"], "PRELIM_PD")
        self.assertTrue(res_pre["criteriaTriggered"]["confirmationRequired"])

        # Definite PD when clinical deterioration + radiographic progression occur within 12 weeks post-RT
        tp_early_det = dict(tp_prelim, label="EarlyRT-ClinDet", clinicalStatus="deteriorated")
        res_early_det = compute_rano2_response([base, tp_early_det])
        self.assertEqual(res_early_det["category"], "PD")
        self.assertEqual(res_early_det["shortCode"], "PD")
        self.assertFalse(res_early_det["criteriaTriggered"]["confirmationRequired"])

    def test_anisotropic_3d_edt_matches_bruteforce_exactly(self) -> None:
        # Small 12x12x10 volume with anisotropic spacing (1.5, 2.0, 3.0) mm
        dims = (12, 12, 10)
        pixdim = (1.5, 2.0, 3.0)
        nx, ny, nz = dims
        gt = bytearray(nx * ny * nz)
        pr = bytearray(nx * ny * nz)

        for z in range(nz):
            for y in range(ny):
                for x in range(nx):
                    idx = x + y * nx + z * nx * ny
                    if (x - 5) ** 2 + (y - 5) ** 2 + (z - 4) ** 2 <= 9:
                        gt[idx] = 1
                    if (x - 6) ** 2 + (y - 5) ** 2 + (z - 5) ** 2 <= 9:
                        pr[idx] = 1

        bbox = (0, nx - 1, 0, ny - 1, 0, nz - 1)
        s_gt = _extract_surface_6conn(gt, dims, bbox)
        s_pr = _extract_surface_6conn(pr, dims, bbox)

        hd95_edt, assd_edt = compute_surface_distances_edt(s_gt, s_pr, bbox, pixdim)
        hd95_bf, assd_bf = compute_surface_distances_bruteforce(s_gt, s_pr, pixdim)

        self.assertAlmostEqual(hd95_edt, hd95_bf, places=9)
        self.assertAlmostEqual(assd_edt, assd_bf, places=9)
        self.assertGreater(hd95_edt, 0.0)
        self.assertGreater(assd_edt, 0.0)


class TestManifestIntegrity(unittest.TestCase):
    """Verifies assets/samples/manifest.json schema, file paths, and exact numeric reference parity."""

    @classmethod
    def setUpClass(cls) -> None:
        with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
            cls.manifest = json.load(f)

    def test_manifest_schema_and_file_references(self) -> None:
        self.assertEqual(self.manifest["schemaVersion"], "1.0")
        self.assertIsInstance(self.manifest["cases"], list)
        self.assertGreaterEqual(len(self.manifest["cases"]), 1)

        case = self.manifest["cases"][0]
        for key in ("id", "title", "diagnosis", "location", "molecularProfile", "syntheticNote", "timepoints"):
            self.assertIn(key, case)
        self.assertEqual(case["id"], "case01")
        self.assertEqual(len(case["timepoints"]), 3)

        expected_ids = ["preop", "postop", "followup"]
        self.assertEqual([tp["id"] for tp in case["timepoints"]], expected_ids)

        req_tp_keys = (
            "id", "label", "role", "dayOffset", "date", "t1ce", "mask", "predMask",
            "dexamethasoneMgPerDay", "steroids", "clinicalStatus", "kps",
            "newMeasurableLesion", "within12WeeksPostRT", "notes",
        )
        for tp in case["timepoints"]:
            for k in req_tp_keys:
                self.assertIn(k, tp)
            self.assertTrue((REPO_ROOT / tp["t1ce"]).is_file(), f"Missing {tp['t1ce']}")
            self.assertTrue((REPO_ROOT / tp["mask"]).is_file(), f"Missing {tp['mask']}")
            if tp["predMask"] is not None:
                self.assertTrue((REPO_ROOT / tp["predMask"]).is_file(), f"Missing {tp['predMask']}")

    def test_manifest_reference_summary_matches_independent_math(self) -> None:
        case = self.manifest["cases"][0]
        self.assertIn("referenceSummary", case)
        ref = case["referenceSummary"]

        # Verify file sizes recorded in manifest match disk
        for fname, recorded_size in ref["fileSizesBytes"].items():
            actual_size = (SAMPLES_DIR / fname).stat().st_size
            self.assertEqual(recorded_size, actual_size, f"File size mismatch in manifest for {fname}")

        # Recompute volumetrics independently from disk and compare
        for tp_id, mask_fname in [
            ("preop", "case01_preop_gt.nii.gz"),
            ("postop", "case01_postop_mask.nii.gz"),
            ("followup", "case01_followup_mask.nii.gz"),
        ]:
            v = read_nifti_gz(SAMPLES_DIR / mask_fname)
            ind_vol = compute_volumetrics(v["data"], v["dims"], v["pixdim"])
            man_vol = ref["volumetrics"][tp_id]
            for reg in ("WT", "TC", "ET", "RC", "nonCE"):
                self.assertAlmostEqual(
                    ind_vol["regions"][reg]["volumeCm3"],
                    man_vol["regions"][reg]["volumeCm3"],
                    places=3,
                    msg=f"{tp_id} {reg} volumeCm3 mismatch",
                )
            self.assertAlmostEqual(ind_vol["rano2d"]["spdMm2"], man_vol["rano2d"]["spdMm2"], places=3)
            self.assertAlmostEqual(ind_vol["rano2d"]["d1Mm"], man_vol["rano2d"]["d1Mm"], places=3)
            self.assertAlmostEqual(ind_vol["rano2d"]["d2Mm"], man_vol["rano2d"]["d2Mm"], places=3)
            self.assertEqual(ind_vol["rano2d"]["bestSliceZ"], man_vol["rano2d"]["bestSliceZ"])

        # Recompute RANO-Resect independently and compare
        pre_v = read_nifti_gz(SAMPLES_DIR / "case01_preop_gt.nii.gz")
        post_v = read_nifti_gz(SAMPLES_DIR / "case01_postop_mask.nii.gz")
        ind_pre = compute_volumetrics(pre_v["data"], pre_v["dims"], pre_v["pixdim"])
        ind_post = compute_volumetrics(post_v["data"], post_v["dims"], post_v["pixdim"])
        ind_eor = classify_rano_resect(
            ind_pre["regions"]["ET"]["volumeCm3"],
            ind_pre["regions"]["nonCE"]["volumeCm3"],
            ind_post["regions"]["ET"]["volumeCm3"],
            ind_post["regions"]["nonCE"]["volumeCm3"],
            ind_post["regions"]["RC"]["volumeCm3"],
        )
        self.assertEqual(ind_eor["ranoClass"], ref["ranoResect"]["ranoClass"])
        self.assertAlmostEqual(ind_eor["ceEorPct"], ref["ranoResect"]["ceEorPct"], places=3)
        self.assertAlmostEqual(ind_eor["residualCeCm3"], ref["ranoResect"]["residualCeCm3"], places=3)

        # Recompute AI segmentation evaluation independently and compare
        pred_v = read_nifti_gz(SAMPLES_DIR / "case01_preop_pred.nii.gz")
        ind_ai = evaluate_segmentation(pre_v["data"], pred_v["data"], pre_v["dims"], pre_v["pixdim"])
        for reg in ("ET", "TC", "WT", "RC"):
            m_ind = ind_ai["regions"][reg]
            m_ref = ref["aiEvaluation"]["regions"][reg]
            self.assertAlmostEqual(m_ind["dice"], m_ref["dice"], places=4)
            self.assertAlmostEqual(m_ind["iou"], m_ref["iou"], places=4)
            self.assertAlmostEqual(m_ind["hd95Mm"], m_ref["hd95Mm"], places=3)
            self.assertAlmostEqual(m_ind["assdMm"], m_ref["assdMm"], places=3)
            self.assertAlmostEqual(m_ind["sensitivity"], m_ref["sensitivity"], places=4)
            self.assertAlmostEqual(m_ind["precision"], m_ref["precision"], places=4)


if __name__ == "__main__":
    unittest.main(verbosity=2)
