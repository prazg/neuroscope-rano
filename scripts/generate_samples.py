#!/usr/bin/env python3
"""
NeuroScope-RANO Synthetic Neuroimaging Dataset Generator
========================================================
Generates deterministic, spec-compliant NIfTI-1 (.nii.gz) T1ce MRI volumes and
BraTS 2023/2024 + Post-Op segmentation masks for Case 01 (Right Frontal GBM):
  - case01_preop_t1ce.nii.gz      (float32, 64x64x48, 2.0mm isotropic)
  - case01_preop_gt.nii.gz        (uint8, labels {0,1,2,3})
  - case01_preop_pred.nii.gz      (uint8, calibrated synthetic AI prediction)
  - case01_postop_t1ce.nii.gz     (float32, early <72h post-op cavity + residual)
  - case01_postop_mask.nii.gz     (uint8, labels {0,2,3,5}, RANO-Resect Class 2B)
  - case01_followup_t1ce.nii.gz   (float32, 6-month recurrence)
  - case01_followup_mask.nii.gz   (uint8, labels {0,2,3,5}, RANO 2.0 PD)
  - manifest.json                 (clinical metadata + precomputed reference summary)

Uses Python 3.12 standard library ONLY (zero external dependencies).
"""

from __future__ import annotations

import collections
import gzip
import json
import math
import os
import random
import struct
from pathlib import Path
from typing import Any

# Canonical volume geometry (RAS+ orientation, Fortran voxel order: x + y*nx + z*nx*ny)
NX, NY, NZ = 64, 64, 48
DX, DY, DZ = 2.0, 2.0, 2.0
VOXEL_VOL_MM3 = DX * DY * DZ  # 8.0 mm^3 = 0.008 cm^3
N_VOXELS = NX * NY * NZ

SEED = 20250110
EPS = 1e-6

# Label definitions (BraTS 2023/2024 + Post-Op)
LBL_BG = 0
LBL_NCR = 1
LBL_ED = 2
LBL_ET = 3
LBL_RC = 5

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = REPO_ROOT / "assets" / "samples"


# ---------------------------------------------------------------------------
# NIfTI-1 Binary Serialization (.nii.gz)
# ---------------------------------------------------------------------------

def build_nifti1_header(
    dims: tuple[int, int, int],
    pixdim: tuple[float, float, float],
    datatype: int,
    bitpix: int,
    descrip: str,
    cal_min: float = 0.0,
    cal_max: float = 0.0,
) -> bytes:
    """Build a spec-compliant 348-byte little-endian NIfTI-1 header + 4-byte extender."""
    nx, ny, nz = dims
    dx, dy, dz = pixdim

    # Center RAS+ scanner anatomical origin at volume center
    ox = -0.5 * nx * dx
    oy = -0.5 * ny * dy
    oz = -0.5 * nz * dz

    descrip_bytes = descrip.encode("ascii", errors="replace")[:80].ljust(80, b"\x00")

    header = struct.pack(
        "<"
        "i"      # 0:   sizeof_hdr (348)
        "10s"    # 4:   data_type
        "18s"    # 14:  db_name
        "i"      # 32:  extents
        "h"      # 36:  session_error
        "c"      # 38:  regular
        "B"      # 39:  dim_info
        "8h"     # 40:  dim[0..7]
        "fff"    # 56:  intent_p1..p3
        "h"      # 68:  intent_code
        "h"      # 70:  datatype
        "h"      # 72:  bitpix
        "h"      # 74:  slice_start
        "8f"     # 76:  pixdim[0..7]
        "f"      # 108: vox_offset
        "f"      # 112: scl_slope
        "f"      # 116: scl_inter
        "h"      # 120: slice_end
        "B"      # 122: slice_code
        "B"      # 123: xyzt_units (2 = mm)
        "f"      # 124: cal_max
        "f"      # 128: cal_min
        "f"      # 132: slice_duration
        "f"      # 136: toffset
        "i"      # 140: glmax
        "i"      # 144: glmin
        "80s"    # 148: descrip
        "24s"    # 228: aux_file
        "h"      # 252: qform_code
        "h"      # 254: sform_code
        "fff"    # 256: quatern_b, c, d
        "fff"    # 268: qoffset_x, y, z
        "4f"     # 280: srow_x
        "4f"     # 296: srow_y
        "4f"     # 312: srow_z
        "16s"    # 328: intent_name
        "4s",    # 344: magic
        348,
        b"\x00" * 10,
        b"\x00" * 18,
        0,
        0,
        b"r",
        0,
        3, nx, ny, nz, 1, 1, 1, 1,
        0.0, 0.0, 0.0,
        0,
        datatype,
        bitpix,
        0,
        1.0, dx, dy, dz, 0.0, 0.0, 0.0, 0.0,
        352.0,
        1.0,
        0.0,
        0,
        0,
        2,  # NIFTI_UNITS_MM
        float(cal_max),
        float(cal_min),
        0.0,
        0.0,
        0,
        0,
        descrip_bytes,
        b"\x00" * 24,
        1,  # qform_code = NIFTI_XFORM_SCANNER_ANAT
        1,  # sform_code = NIFTI_XFORM_SCANNER_ANAT
        0.0, 0.0, 0.0,
        ox, oy, oz,
        dx, 0.0, 0.0, ox,
        0.0, dy, 0.0, oy,
        0.0, 0.0, dz, oz,
        b"\x00" * 16,
        b"n+1\x00",
    )
    assert len(header) == 348, f"Expected 348-byte header, got {len(header)}"
    return header + b"\x00\x00\x00\x00"  # 4-byte extender -> vox_offset = 352


def write_nifti_float32_gz(path: Path, data: list[float], descrip: str) -> int:
    """Write a float32 (datatype=16) NIfTI-1 .nii.gz file and return byte size."""
    assert len(data) == N_VOXELS
    cal_min = min(data)
    cal_max = max(data)
    header = build_nifti1_header(
        dims=(NX, NY, NZ),
        pixdim=(DX, DY, DZ),
        datatype=16,
        bitpix=32,
        descrip=descrip,
        cal_min=cal_min,
        cal_max=cal_max,
    )
    payload = struct.pack(f"<{N_VOXELS}f", *data)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as raw_f:
        with gzip.GzipFile(filename="", mode="wb", compresslevel=9, fileobj=raw_f, mtime=0) as gz:
            gz.write(header)
            gz.write(payload)
    return path.stat().st_size


def write_nifti_uint8_gz(path: Path, data: bytearray, descrip: str) -> int:
    """Write a uint8 (datatype=2) NIfTI-1 .nii.gz file and return byte size."""
    assert len(data) == N_VOXELS
    cal_max = float(max(data)) if data else 0.0
    header = build_nifti1_header(
        dims=(NX, NY, NZ),
        pixdim=(DX, DY, DZ),
        datatype=2,
        bitpix=8,
        descrip=descrip,
        cal_min=0.0,
        cal_max=cal_max,
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as raw_f:
        with gzip.GzipFile(filename="", mode="wb", compresslevel=9, fileobj=raw_f, mtime=0) as gz:
            gz.write(header)
            gz.write(data)
    return path.stat().st_size


# ---------------------------------------------------------------------------
# Deterministic Pseudo-Noise & Smooth Anatomical Helpers
# ---------------------------------------------------------------------------

def _hash_noise(x: int, y: int, z: int, salt: int) -> float:
    """Deterministic zero-mean pseudo-Gaussian noise in roughly [-2.5, +2.5]."""
    # Sum of 3 fast integer hashes approximates Gaussian (Irwin-Hall)
    n1 = ((x * 374761393 + y * 668265263 + z * 2147483647 + salt * 1274126177) & 0xFFFFFFFF)
    n1 = ((n1 ^ (n1 >> 13)) * 1274126177) & 0xFFFFFFFF
    n1 = (n1 ^ (n1 >> 16)) & 0xFFFF

    n2 = ((x * 668265263 + y * 2147483647 + z * 374761393 + salt * 2246822519) & 0xFFFFFFFF)
    n2 = ((n2 ^ (n2 >> 13)) * 3266489917) & 0xFFFFFFFF
    n2 = (n2 ^ (n2 >> 16)) & 0xFFFF

    n3 = ((x * 2246822519 + y * 374761393 + z * 668265263 + salt * 3266489917) & 0xFFFFFFFF)
    n3 = ((n3 ^ (n3 >> 13)) * 668265263) & 0xFFFFFFFF
    n3 = (n3 ^ (n3 >> 16)) & 0xFFFF

    u = (n1 + n2 + n3) / 65535.0 - 1.5  # mean 0, std ~ 0.5
    return u * 2.0  # std ~ 1.0


def _clamp(v: float, lo: float, hi: float) -> float:
    if v < lo:
        return lo
    if v > hi:
        return hi
    return v


def _smoothstep(edge0: float, edge1: float, x: float) -> float:
    if edge1 == edge0:
        return 0.0
    t = _clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


# ---------------------------------------------------------------------------
# Realistic Synthetic T1ce Brain Volume Generator
# ---------------------------------------------------------------------------

def synthesize_base_brain(
    mass_effect_strength: float = 0.0,
    noise_salt: int = 1,
) -> tuple[list[float], bytearray, bytearray]:
    """
    Synthesize a realistic 64x64x48 (2mm isotropic) T1ce head/brain MRI volume.

    Returns:
        t1ce: list[float] of length NX*NY*NZ (intensities ~0..1000)
        parenchyma_mask: bytearray (1 inside cerebral parenchyma, 0 outside)
        ventricle_mask: bytearray (1 inside ventricular system, 0 outside)
    """
    sin = math.sin
    cos = math.cos
    sqrt = math.sqrt
    exp = math.exp

    t1ce = [0.0] * N_VOXELS
    parenchyma = bytearray(N_VOXELS)
    ventricles = bytearray(N_VOXELS)

    # Head center in voxel coordinates
    cx, cy, cz = 31.5, 31.5, 23.0
    # Tumor mass-effect source (Right Frontal lobe)
    tx, ty, tz = 41.2, 38.2, 26.0

    for z in range(NZ):
        dz_h = (z - cz) / 21.5
        dz_h2 = dz_h * dz_h
        # Slight anterior/inferior cranial tapering
        inf_taper = 1.0 - 0.18 * _smoothstep(14.0, 4.0, float(z))
        # Frontal pole subtle narrowing for realistic axial oval
        for y in range(NY):
            dy_h = (y - cy) / (28.2 * inf_taper)
            dy_h2 = dy_h * dy_h
            # Slight anterior taper (frontal narrower than parietal)
            ant_taper = 1.0 - 0.09 * _smoothstep(32.0, 56.0, float(y))
            rx_eff = 24.8 * inf_taper * ant_taper
            z_plane_off = z * NX * NY
            row_off = z_plane_off + y * NX

            for x in range(NX):
                idx = row_off + x
                dx_h = (x - cx) / rx_eff
                r_head = sqrt(dx_h * dx_h + dy_h2 + dz_h2)

                # Lower neck/skull base cutoff below foramen magnum
                if r_head > 1.02 or z < 2:
                    t1ce[idx] = 0.0
                    continue

                # Gentle cranial contour modulation
                cranium_mod = 0.015 * sin(0.22 * y) * cos(0.24 * z)
                rh = r_head + cranium_mod

                if rh > 1.0:
                    t1ce[idx] = 0.0
                    continue

                # Outer scalp / subcutaneous fat bright T1 ring (0.925 .. 1.0)
                if rh >= 0.925:
                    t_scalp = 1.0 - abs(rh - 0.962) / 0.038
                    val = 290.0 + 115.0 * max(0.0, t_scalp)
                    val += 12.0 * _hash_noise(x, y, z, noise_salt)
                    t1ce[idx] = _clamp(val, 40.0, 460.0)
                    continue

                # Calvarium / cortical bone dark rim (0.865 .. 0.925)
                if rh >= 0.865:
                    # Diploic marrow slightly brighter in mid-table
                    t_mid = 1.0 - abs(rh - 0.895) / 0.03
                    val = 145.0 + 48.0 * max(0.0, t_mid)
                    val += 8.0 * _hash_noise(x, y, z, noise_salt)
                    t1ce[idx] = _clamp(val, 60.0, 240.0)
                    continue

                # Apply subtle local mass-effect displacement for internal structures (pre-op)
                # Pulls sampling coords toward tumor so ventricles shift away from right frontal mass
                sx, sy, sz = float(x), float(y), float(z)
                if mass_effect_strength > 0.0:
                    vx = sx - tx
                    vy = sy - ty
                    vz = sz - tz
                    d2 = vx * vx + vy * vy + vz * vz
                    if d2 > 1.0:
                        # Smooth radial push peaking ~10-16 voxels away from center
                        d = sqrt(d2)
                        push = mass_effect_strength * exp(-((d - 11.0) ** 2) / 95.0)
                        # Sample slightly closer to tumor -> structures appear shifted away
                        sx = sx + (vx / d) * push
                        sy = sy + (vy / d) * push
                        sz = sz + (vz / d) * push * 0.45

                # Normalized brain radius inside inner skull table (brain ~ 0..0.835)
                dx_b = (sx - cx) / (rx_eff * 0.84)
                dy_b = (sy - cy) / (28.2 * inf_taper * 0.84)
                dz_b = (sz - (cz + 1.0)) / (20.2 * 0.84)
                r_brain = sqrt(dx_b * dx_b + dy_b * dy_b + dz_b * dz_b)

                # --- Inferior Posterior Fossa: Cerebellum & Brainstem ---
                # Brainstem (medulla -> pons -> midbrain)
                bs_x = (sx - cx) / (4.4 + 1.1 * exp(-((sz - 11.5) ** 2) / 14.0))
                bs_y = (sy - (26.5 + 0.16 * (sz - 10.0))) / (4.3 + 1.2 * exp(-((sz - 11.5) ** 2) / 14.0))
                bs_r = sqrt(bs_x * bs_x + bs_y * bs_y)
                in_brainstem = (3.0 <= sz <= 19.5) and (bs_r <= 1.0)

                # Bilateral cerebellar hemispheres
                ax_s = abs(sx - cx)
                cb_dx = (ax_s - 8.2) / 8.2
                cb_dy = (sy - 17.5) / 7.4
                cb_dz = (sz - 10.8) / 5.4
                cb_r = sqrt(cb_dx * cb_dx + cb_dy * cb_dy + cb_dz * cb_dz)
                in_cerebellum = (cb_r <= 1.0) and (sz < 16.5) and (sy < 25.5) and (rh < 0.85)

                if in_brainstem:
                    # Brainstem white/gray tracts
                    val = 540.0 + 45.0 * (1.0 - bs_r * bs_r)
                    val += 14.0 * _hash_noise(x, y, z, noise_salt)
                    t1ce[idx] = _clamp(val, 350.0, 650.0)
                    continue

                if in_cerebellum:
                    # Cerebellar folia pattern (distinctive horizontal striations on coronal/sagittal)
                    folia = sin(sz * 2.35 + 0.25 * cos(sx * 0.35))
                    arbor = 1.0 - cb_r * cb_r
                    val = 455.0 + 68.0 * arbor + 48.0 * folia * _smoothstep(0.35, 0.95, cb_r)
                    val += 13.0 * _hash_noise(x, y, z, noise_salt)
                    t1ce[idx] = _clamp(val, 240.0, 620.0)
                    continue

                # Subarachnoid CSF around cerebral cortex & skull base
                # Base of cerebrum slopes upward anteriorly over orbital roofs
                cerebrum_floor = 13.2 + 3.2 * _smoothstep(26.0, 44.0, sy) - 2.4 * _smoothstep(6.0, 16.0, ax_s)
                # Mild cortical gyral outer contour modulation
                gyri_wave = (
                    0.50 * sin(sx * 0.56 + 0.35 * sin(sy * 0.31)) * cos(sy * 0.52 + 0.3 * sin(sz * 0.36))
                    + 0.32 * sin(sy * 0.64 - 0.28 * cos(sz * 0.45)) * cos(sz * 0.58 + 0.25 * sx)
                    + 0.18 * cos(sx * 0.82 + sy * 0.42 - sz * 0.61)
                )
                # Slightly asymmetric hemisphere sulcal phase
                r_brain_folded = r_brain + 0.036 * gyri_wave

                # Superior sagittal sinus (subtle bright dural venous contrast at top midline)
                if rh < 0.865 and ax_s < 1.5 and sz > 24.0 and r_brain > 0.94 and r_brain < 1.08:
                    val = 650.0 + 45.0 * (1.0 - ax_s / 1.5)
                    val += 12.0 * _hash_noise(x, y, z, noise_salt)
                    t1ce[idx] = _clamp(val, 450.0, 720.0)
                    continue

                if r_brain_folded > 1.0 or sz < cerebrum_floor:
                    # Subarachnoid CSF space
                    val = 102.0 + 18.0 * (1.0 - _smoothstep(0.86, 1.08, r_brain))
                    val += 9.0 * _hash_noise(x, y, z, noise_salt)
                    t1ce[idx] = _clamp(val, 60.0, 165.0)
                    continue

                # --- Inside Cerebral Hemispheres ---

                # 1. Bilateral Lateral Ventricles (frontal horns, bodies, occipital/trigone horns)
                # Frontal horn
                fh_x = (ax_s - (2.4 + 0.22 * max(0.0, sy - 33.0))) / 2.2
                fh_y = (sy - 36.2) / 5.2
                fh_z = (sz - 24.6) / 2.3
                d_fh = fh_x * fh_x + fh_y * fh_y + fh_z * fh_z

                # Ventricular body
                vb_x = (ax_s - (3.1 + 0.08 * max(0.0, 33.0 - sy))) / 2.3
                vb_y = (sy - 28.5) / 6.8
                vb_z = (sz - 26.2) / 1.9
                d_vb = vb_x * vb_x + vb_y * vb_y + vb_z * vb_z

                # Occipital / posterior horn
                oh_x = (ax_s - (5.8 + 0.16 * max(0.0, 24.0 - sy))) / 2.2
                oh_y = (sy - 20.8) / 4.4
                oh_z = (sz - 23.8) / 2.0
                d_oh = oh_x * oh_x + oh_y * oh_y + oh_z * oh_z

                # Third ventricle (midline slit inferior to corpus callosum)
                v3_x = ax_s / 0.95
                v3_y = (sy - 28.5) / 3.4
                v3_z = (sz - 20.6) / 2.0
                d_v3 = v3_x * v3_x + v3_y * v3_y + v3_z * v3_z

                # Keep thin septum pellucidum at midline between lateral ventricles
                in_lat_vent = (min(d_fh, d_vb, d_oh) <= 1.0) and (ax_s >= 0.72)
                in_third_vent = d_v3 <= 1.0

                if in_lat_vent or in_third_vent:
                    ventricles[idx] = 1
                    val = 96.0 + 16.0 * min(1.0, min(d_fh, d_vb, d_oh, d_v3))
                    val += 8.0 * _hash_noise(x, y, z, noise_salt)
                    t1ce[idx] = _clamp(val, 65.0, 145.0)
                    continue

                # 2. Corpus Callosum (distinctive bright commissural white matter arch)
                cc_arch_z = 28.1 - 0.028 * ((sy - 30.5) ** 2)
                cc_x = ax_s / 7.8
                cc_y = (sy - 30.2) / 9.2
                cc_z = (sz - cc_arch_z) / (1.55 + 0.45 * exp(-((sy - 38.0) ** 2) / 9.0) + 0.4 * exp(-((sy - 22.0) ** 2) / 9.0))
                in_cc = (cc_x * cc_x + cc_y * cc_y <= 1.0) and (abs(cc_z) <= 1.0) and (sy >= 20.5) and (sy <= 40.5)

                if in_cc:
                    parenchyma[idx] = 1
                    val = 655.0 + 28.0 * (1.0 - cc_z * cc_z)
                    val += 12.0 * _hash_noise(x, y, z, noise_salt)
                    t1ce[idx] = _clamp(val, 580.0, 710.0)
                    continue

                # 3. Interhemispheric Fissure & Midline Falx Cerebri
                in_fissure = (ax_s < 1.05) and ((sz > cc_arch_z + 1.2) or (sy > 40.5) or (sy < 20.5))
                if in_fissure:
                    if ax_s < 0.42:
                        # Subtle enhancing falx cerebri dura
                        val = 285.0 + 25.0 * _smoothstep(24.0, 40.0, sz)
                    else:
                        # Interhemispheric CSF
                        val = 112.0
                    val += 10.0 * _hash_noise(x, y, z, noise_salt)
                    t1ce[idx] = _clamp(val, 75.0, 350.0)
                    continue

                # Mark valid cerebral parenchyma
                parenchyma[idx] = 1

                # 4. Deep Gray Matter Nuclei (Thalamus & Lentiform/Caudate)
                th_x = (ax_s - 4.7) / 3.4
                th_y = (sy - 27.0) / 4.8
                th_z = (sz - 21.6) / 3.0
                d_th = th_x * th_x + th_y * th_y + th_z * th_z

                bg_x = (ax_s - 10.0) / 3.2
                bg_y = (sy - 33.0) / 5.0
                bg_z = (sz - 22.4) / 3.2
                d_bg = bg_x * bg_x + bg_y * bg_y + bg_z * bg_z

                # 5. Cortical Gray Matter Ribbon vs Subcortical White Matter
                # Depth inward from folded cortical boundary
                cortical_depth = 1.0 - r_brain_folded
                # Also include medial interhemispheric cortex ribbon near midline
                medial_dist = max(0.0, ax_s - 1.05) / 22.0
                eff_depth = min(cortical_depth, medial_dist * 1.45 if (sz > cc_arch_z + 1.2 or sy > 40.5 or sy < 20.5) else cortical_depth)

                # Sulcal invaginations extending inward into cortex
                sulcus_factor = _smoothstep(0.42, 0.85, gyri_wave) * _smoothstep(0.22, 0.0, eff_depth)

                if sulcus_factor > 0.58 and eff_depth < 0.11:
                    # Thin CSF-filled cortical sulcus
                    val = 135.0 + 70.0 * (1.0 - sulcus_factor)
                elif d_th <= 1.0:
                    # Thalamus (deep gray matter ~490-520)
                    val = 492.0 + 24.0 * (1.0 - d_th)
                elif d_bg <= 1.0:
                    # Lentiform / caudate nucleus (~480-510)
                    val = 482.0 + 22.0 * (1.0 - d_bg)
                else:
                    # Smooth transition from cortical GM (~455) to WM (~605)
                    wm_blend = _smoothstep(0.095, 0.215, eff_depth)
                    # Subtle regional WM heterogeneity (brighter corona radiata / internal capsule)
                    wm_var = 24.0 * sin(sx * 0.18) * cos(sy * 0.16) + 14.0 * cos(sz * 0.22)
                    val = (455.0 + 0.35 * wm_var) * (1.0 - wm_blend) + (605.0 + wm_var) * wm_blend
                    # Slight darkening at sulcal banks
                    val -= 38.0 * sulcus_factor

                val += 14.0 * _hash_noise(x, y, z, noise_salt)
                t1ce[idx] = _clamp(val, 70.0, 720.0)

    return t1ce, parenchyma, ventricles


# ---------------------------------------------------------------------------
# Pathology Synthesis (Pre-Op GT, Pre-Op Pred, Post-Op, 6-Month Follow-Up)
# ---------------------------------------------------------------------------

def _organic_radial_mod(dx: float, dy: float, dz: float, phase: float = 0.0) -> float:
    """Smooth low-order angular lobulation factor around 1.0 for realistic GBM shape."""
    r = math.sqrt(dx * dx + dy * dy + dz * dz)
    if r < 1e-6:
        return 1.0
    ux, uy, uz = dx / r, dy / r, dz / r
    mod = (
        0.095 * math.sin(2.4 * ux + 1.9 * uy + phase)
        + 0.075 * math.cos(2.7 * uy - 2.1 * uz + 0.7 * phase)
        + 0.060 * math.sin(3.1 * uz + 1.8 * ux - 0.5 * phase)
        + 0.045 * (ux * uy - uz * ux)
    )
    return 1.0 + mod


def build_preop_gt_mask(parenchyma: bytearray, ventricles: bytearray) -> bytearray:
    """
    Build ground-truth pre-op right frontal glioblastoma mask:
      - Label 1 (NCR): ~5-8 cm^3 (target ~6.2-6.8 cm^3)
      - Label 3 (ET):  ~16-22 cm^3 (target ~18.0-19.5 cm^3), axial SPD ~900-1300 mm^2 (~1120 mm^2)
      - Label 2 (ED):  ~25-35 cm^3 (target ~29-31 cm^3)
    """
    mask = bytearray(N_VOXELS)
    tx, ty, tz = 41.2, 38.2, 26.0

    for z in range(NZ):
        dz = z - tz
        z_off = z * NX * NY
        for y in range(NY):
            dy = y - ty
            row_off = z_off + y * NX
            for x in range(NX):
                idx = row_off + x
                # Keep pathology strictly inside right cerebral parenchyma (respect falx/skull/ventricles)
                if not parenchyma[idx] or ventricles[idx] or x <= 32:
                    continue
                dx = x - tx

                # Fast bounding box reject
                if abs(dx) > 19 or abs(dy) > 21 or abs(dz) > 17:
                    continue

                lob_core = _organic_radial_mod(dx, dy, dz, phase=0.4)
                lob_et = _organic_radial_mod(dx, dy, dz, phase=1.1)

                r_ncr = math.sqrt((dx / 5.30) ** 2 + (dy / 6.00) ** 2 + (dz / 5.55) ** 2) / lob_core
                r_et = math.sqrt((dx / 8.55) ** 2 + (dy / 9.55) ** 2 + (dz / 9.05) ** 2) / lob_et

                # Asymmetric edema extending slightly posteriorly/medially along frontal white matter
                ed_dx = dx + 1.2
                ed_dy = dy + 2.0
                ed_dz = dz - 0.3
                lob_ed = _organic_radial_mod(ed_dx, ed_dy, ed_dz, phase=2.3)
                # Finger-like vasogenic edema tracts
                wm_fingers = 1.0 + 0.14 * math.sin(0.38 * dx + 0.27 * dy) * math.cos(0.33 * dz - 0.22 * dy)
                r_ed = math.sqrt((ed_dx / 12.1) ** 2 + (ed_dy / 13.7) ** 2 + (ed_dz / 11.4) ** 2) / (lob_ed * wm_fingers)

                if r_ncr <= 1.0:
                    mask[idx] = LBL_NCR
                elif r_et <= 1.0:
                    mask[idx] = LBL_ET
                elif r_ed <= 1.0:
                    mask[idx] = LBL_ED

    return mask


def build_preop_pred_mask(gt_mask: bytearray, parenchyma: bytearray, ventricles: bytearray) -> bytearray:
    """
    Derive deterministic simulated AI prediction from pre-op GT mask with:
      - realistic boundary jitter
      - small medial FP protrusion (produces realistic HD95 ~3.5-5.0 mm)
      - subtle lateral FN under-segmentation
      - minor NCR/ET boundary shift
    Calibration targets:
      ET Dice 0.86-0.92, TC Dice 0.88-0.93, WT Dice 0.89-0.94,
      HD95 2.0-6.5 mm, ASSD 0.4-1.5 mm.
    """
    pred = bytearray(N_VOXELS)
    tx, ty, tz = 41.2, 38.2, 26.0

    # Small anterior-medial FP protrusion of ET along frontal lobe margin (unclipped by midline)
    fp_cx, fp_cy, fp_cz = 37.8, 48.8, 26.0
    # Secondary small anterior-inferior ED over-segmentation lobe
    ed_fp_cx, ed_fp_cy, ed_fp_cz = 40.5, 49.0, 23.0

    for z in range(NZ):
        dz = z - tz
        z_off = z * NX * NY
        for y in range(NY):
            dy = y - ty
            row_off = z_off + y * NX
            for x in range(NX):
                idx = row_off + x
                if not parenchyma[idx] or ventricles[idx] or x <= 32:
                    continue
                dx = x - tx
                if abs(dx) > 21 or abs(dy) > 22 or abs(dz) > 19:
                    continue

                # Subtle spatial shift + boundary jitter for AI prediction
                jitter = (
                    0.038 * math.sin(0.55 * x + 0.41 * y - 0.35 * z)
                    + 0.024 * math.cos(0.72 * y + 0.63 * z - 0.48 * x)
                )

                # Subtle lateral FN under-segmentation (shrinks high-x side of ET)
                lat_shrink = 0.072 * _smoothstep(2.8, 9.0, dx)
                # Slight superior FN under-segmentation on TC
                sup_shrink = 0.035 * _smoothstep(3.4, 8.5, dz)

                lob_core = _organic_radial_mod(dx, dy, dz, phase=0.4)
                lob_et = _organic_radial_mod(dx, dy, dz, phase=1.1)

                # Slight NCR/ET boundary shift
                r_ncr_p = (
                    math.sqrt(((dx - 0.18) / 5.25) ** 2 + ((dy + 0.14) / 5.95) ** 2 + ((dz - 0.10) / 5.52) ** 2)
                    / (lob_core * (1.0 + 0.5 * jitter))
                )
                r_et_p = (
                    math.sqrt(((dx + 0.18) / 8.55) ** 2 + ((dy - 0.15) / 9.53) ** 2 + ((dz + 0.12) / 9.03) ** 2)
                    / (lob_et * (1.0 + jitter - lat_shrink - sup_shrink))
                )

                # Small anterior-medial FP protrusion of ET (sticks ~2-3 voxels beyond GT wall)
                d_fp = math.sqrt(((x - fp_cx) / 2.95) ** 2 + ((y - fp_cy) / 3.90) ** 2 + ((z - fp_cz) / 3.45) ** 2)

                # Perturbed edema boundary (slight under-seg posteriorly, slight over-seg anteriorly)
                ed_dx = dx + 0.55
                ed_dy = dy + 1.15
                ed_dz = dz + 0.45
                lob_ed = _organic_radial_mod(ed_dx, ed_dy, ed_dz, phase=2.3)
                wm_fingers = 1.0 + 0.14 * math.sin(0.38 * dx + 0.27 * dy) * math.cos(0.33 * dz - 0.22 * dy)
                ed_jitter = 0.095 * math.sin(0.34 * x - 0.41 * y + 0.47 * z)
                ed_lat_shrink = 0.11 * _smoothstep(4.0, 12.0, dx)
                r_ed_p = (
                    math.sqrt((ed_dx / 12.05) ** 2 + (ed_dy / 13.65) ** 2 + (ed_dz / 11.45) ** 2)
                    / (lob_ed * wm_fingers * (1.0 + ed_jitter - ed_lat_shrink))
                )
                d_ed_fp = math.sqrt(((x - ed_fp_cx) / 3.2) ** 2 + ((y - ed_fp_cy) / 3.0) ** 2 + ((z - ed_fp_cz) / 2.8) ** 2)

                if r_ncr_p <= 1.0:
                    pred[idx] = LBL_NCR
                elif r_et_p <= 1.0 or d_fp <= 1.0:
                    pred[idx] = LBL_ET
                elif r_ed_p <= 1.0 or d_ed_fp <= 1.0:
                    pred[idx] = LBL_ED

    return pred


def build_postop_mask(parenchyma: bytearray, ventricles: bytearray) -> bytearray:
    """
    Build early (<72h) post-operative segmentation mask:
      - Label 5 (RC): ~18-24 cm^3 (target ~20.5 cm^3) surgical resection cavity
      - Label 3 (ET): 0.55-0.85 cm^3 (target ~0.68 cm^3) small residual focus along
                      posterior-medial cavity wall -> ~96.3% CE EOR -> RANO-Resect Class 2B
      - Label 2 (ED): ~10-15 cm^3 (target ~12.5 cm^3) reduced post-op edema
      - Label 1 (NCR): 0 voxels
    """
    mask = bytearray(N_VOXELS)
    # Resection cavity centered at former tumor bed
    rcx, rcy, rcz = 41.6, 38.6, 26.0
    # Small nodular/crescentic residual enhancing focus at posterior-medial margin of cavity
    resx, resy, resz = 35.8, 30.8, 25.8

    for z in range(NZ):
        z_off = z * NX * NY
        for y in range(NY):
            row_off = z_off + y * NX
            for x in range(NX):
                idx = row_off + x
                if not parenchyma[idx] or ventricles[idx] or x <= 32:
                    continue

                dx_c, dy_c, dz_c = x - rcx, y - rcy, z - rcz
                if abs(dx_c) > 19 or abs(dy_c) > 20 or abs(dz_c) > 16:
                    continue

                lob_c = _organic_radial_mod(dx_c, dy_c, dz_c, phase=0.9)
                r_cav = math.sqrt((dx_c / 8.35) ** 2 + (dy_c / 9.30) ** 2 + (dz_c / 8.55) ** 2) / (0.98 + 0.45 * (lob_c - 1.0))

                # Small residual focus along posterior-medial margin (just outside cavity)
                dx_r, dy_r, dz_r = x - resx, y - resy, z - resz
                r_res = math.sqrt((dx_r / 3.70) ** 2 + (dy_r / 3.90) ** 2 + (dz_r / 3.35) ** 2)

                # Reduced surrounding edema halo
                ed_dx = dx_c + 1.0
                ed_dy = dy_c + 1.6
                ed_dz = dz_c - 0.2
                lob_ed = _organic_radial_mod(ed_dx, ed_dy, ed_dz, phase=2.0)
                r_ed = math.sqrt((ed_dx / 9.55) ** 2 + (ed_dy / 10.65) ** 2 + (ed_dz / 9.20) ** 2) / lob_ed

                if r_cav <= 1.0:
                    mask[idx] = LBL_RC
                elif r_res <= 1.0:
                    mask[idx] = LBL_ET
                elif r_ed <= 1.0:
                    mask[idx] = LBL_ED

    return mask


def build_followup_mask(parenchyma: bytearray, ventricles: bytearray) -> bytearray:
    """
    Build 6-month follow-up surveillance mask showing nodular progression:
      - Label 5 (RC): ~14-18 cm^3 (target ~16.0 cm^3) mildly contracted resection cavity
      - Label 3 (ET): 4.5-6.5 cm^3 (target ~5.4 cm^3), axial SPD >= 300 mm^2 (~440 mm^2),
                      enlarged nodular recurrence along posterior-medial cavity margin -> RANO 2.0 PD
      - Label 2 (ED): ~18-24 cm^3 (target ~21.0 cm^3) expanded recurrent peritumoral edema
      - Label 1 (NCR): 0 voxels
    """
    mask = bytearray(N_VOXELS)
    # Mildly contracted cavity
    rcx, rcy, rcz = 42.1, 39.2, 26.0
    # Enlarged nodular recurrence expanding from the posterior-medial residual site
    recx, recy, recz = 36.8, 31.0, 25.8

    for z in range(NZ):
        z_off = z * NX * NY
        for y in range(NY):
            row_off = z_off + y * NX
            for x in range(NX):
                idx = row_off + x
                if not parenchyma[idx] or ventricles[idx] or x <= 32:
                    continue

                dx_c, dy_c, dz_c = x - rcx, y - rcy, z - rcz
                if abs(dx_c) > 20 or abs(dy_c) > 21 or abs(dz_c) > 17:
                    continue

                lob_c = _organic_radial_mod(dx_c, dy_c, dz_c, phase=1.3)
                r_cav = math.sqrt((dx_c / 7.80) ** 2 + (dy_c / 8.70) ** 2 + (dz_c / 8.05) ** 2) / (0.98 + 0.42 * (lob_c - 1.0))

                # Enlarged irregular nodular recurrence at posterior-medial margin
                dx_r, dy_r, dz_r = x - recx, y - recy, z - recz
                lob_r = _organic_radial_mod(dx_r, dy_r, dz_r, phase=2.7)
                r_rec = math.sqrt((dx_r / 5.70) ** 2 + (dy_r / 6.05) ** 2 + (dz_r / 5.30) ** 2) / lob_r

                # Expanded recurrent peritumoral edema tracking surrounding frontal/posterior WM
                ed_dx = (x - 40.0)
                ed_dy = (y - 35.5)
                ed_dz = (z - 25.9)
                lob_ed = _organic_radial_mod(ed_dx, ed_dy, ed_dz, phase=2.4)
                wm_fingers = 1.0 + 0.13 * math.sin(0.36 * ed_dx + 0.29 * ed_dy) * math.cos(0.31 * ed_dz)
                r_ed = math.sqrt((ed_dx / 10.65) ** 2 + (ed_dy / 11.85) ** 2 + (ed_dz / 9.90) ** 2) / (lob_ed * wm_fingers)

                # Recurrence invades margin (takes precedence over cavity wall on overlap)
                if r_rec <= 1.0:
                    mask[idx] = LBL_ET
                elif r_cav <= 1.0:
                    mask[idx] = LBL_RC
                elif r_ed <= 1.0:
                    mask[idx] = LBL_ED

    return mask


def blend_pathology_into_t1ce(
    base_t1ce: list[float],
    mask: bytearray,
    noise_salt: int,
    has_cavity_rim: bool = False,
) -> list[float]:
    """
    Embed realistic T1ce MRI signal characteristics for NCR, ET, ED, and RC into the
    base brain intensity volume and quantize to integer float32 (0.0..1000.0) for
    clinical visual smoothness + compact gzip compression (<250 KB).
    """
    out = list(base_t1ce)

    # Pre-identify thin post-op cavity rim voxels (parenchyma adjacent to RC, not ET)
    cavity_rim = bytearray(N_VOXELS)
    if has_cavity_rim:
        for z in range(1, NZ - 1):
            z_off = z * NX * NY
            for y in range(1, NY - 1):
                row_off = z_off + y * NX
                for x in range(1, NX - 1):
                    idx = row_off + x
                    if mask[idx] in (LBL_BG, LBL_ED):
                        if (
                            mask[idx - 1] == LBL_RC
                            or mask[idx + 1] == LBL_RC
                            or mask[idx - NX] == LBL_RC
                            or mask[idx + NX] == LBL_RC
                            or mask[idx - NX * NY] == LBL_RC
                            or mask[idx + NX * NY] == LBL_RC
                        ):
                            cavity_rim[idx] = 1

    # Also compute a subtle boundary-depth flag for ET so enhancement peaks in mid-wall
    et_interior = bytearray(N_VOXELS)
    for z in range(1, NZ - 1):
        z_off = z * NX * NY
        for y in range(1, NY - 1):
            row_off = z_off + y * NX
            for x in range(1, NX - 1):
                idx = row_off + x
                if mask[idx] == LBL_ET:
                    if (
                        mask[idx - 1] == LBL_ET
                        and mask[idx + 1] == LBL_ET
                        and mask[idx - NX] == LBL_ET
                        and mask[idx + NX] == LBL_ET
                        and mask[idx - NX * NY] == LBL_ET
                        and mask[idx + NX * NY] == LBL_ET
                    ):
                        et_interior[idx] = 1

    for z in range(NZ):
        z_off = z * NX * NY
        for y in range(NY):
            row_off = z_off + y * NX
            for x in range(NX):
                idx = row_off + x
                lbl = mask[idx]
                base = out[idx]

                if lbl == LBL_NCR:
                    # Dark necrotic center (~95-155) with subtle cellular debris variation
                    debris = 18.0 * math.sin(0.5 * x + 0.4 * y) * math.cos(0.45 * z)
                    val = 122.0 + debris + 11.0 * _hash_noise(x, y, z, noise_salt + 10)
                    val = _clamp(val, 80.0, 175.0)
                elif lbl == LBL_ET:
                    # Bright avid gadolinium enhancement (~790-950), slightly higher inside wall
                    hetero = 32.0 * math.sin(0.42 * x - 0.38 * y + 0.31 * z)
                    core_boost = 52.0 if et_interior[idx] else 0.0
                    val = 825.0 + core_boost + hetero + 20.0 * _hash_noise(x, y, z, noise_salt + 20)
                    val = _clamp(val, 760.0, 965.0)
                elif lbl == LBL_ED:
                    # T1-hypointense vasogenic edema (~265-345), preserving subtle underlying anatomy
                    val = 0.28 * base + 160.0 + 12.0 * _hash_noise(x, y, z, noise_salt + 30)
                    val = _clamp(val, 240.0, 365.0)
                elif lbl == LBL_RC:
                    # Fluid-filled surgical resection cavity (~90-140)
                    val = 110.0 + 10.0 * math.sin(0.35 * x + 0.3 * z) + 9.0 * _hash_noise(x, y, z, noise_salt + 40)
                    val = _clamp(val, 80.0, 155.0)
                else:
                    val = base

                # Subtle thin non-nodular post-op linear cavity rim (clearly dimmer than ET!)
                if cavity_rim[idx] and lbl != LBL_ET:
                    val = max(val, 385.0 + 14.0 * _hash_noise(x, y, z, noise_salt + 50))
                    val = _clamp(val, 340.0, 445.0)

                # Round to integer float32 in [0.0, 1000.0]: preserves full 1000-level
                # dynamic range while keeping gzipped float32 .nii.gz well under 250 KB
                if val <= 0.0:
                    out[idx] = 0.0
                else:
                    out[idx] = float(int(round(val)))

    return out


# ---------------------------------------------------------------------------
# Reference Summary Calculations (matches ARCHITECTURE.md Section 4.2)
# ---------------------------------------------------------------------------

def _normalize_label(v: float) -> int:
    r = int(math.floor(v + 0.5))
    if r == 4:
        return 3
    if r in (1, 2, 3, 5):
        return r
    return 0


def _in_region(lbl: int, region: str) -> bool:
    if region == "ET":
        return lbl == 3
    if region == "TC":
        return lbl == 1 or lbl == 3
    if region == "WT":
        return lbl == 1 or lbl == 2 or lbl == 3
    if region == "RC":
        return lbl == 5
    if region == "nonCE":
        return lbl == 1 or lbl == 2
    raise ValueError(f"Unknown region: {region}")


def _compute_axial_2d_diameters(mask: bytearray, region: str = "ET") -> dict[str, Any]:
    best: dict[str, Any] | None = None
    best_key = (-1.0, -1.0, -1)

    for z in range(NZ):
        z_off = z * NX * NY
        target_set: set[tuple[int, int]] = set()
        for y in range(NY):
            row_off = z_off + y * NX
            for x in range(NX):
                if _in_region(_normalize_label(mask[row_off + x]), region):
                    target_set.add((x, y))
        if not target_set:
            continue

        slice_area_mm2 = len(target_set) * DX * DY

        # 8-connected components on axial slice z
        visited: set[tuple[int, int]] = set()
        components: list[set[tuple[int, int]]] = []
        for pt in target_set:
            if pt in visited:
                continue
            comp: set[tuple[int, int]] = set()
            q = collections.deque([pt])
            visited.add(pt)
            while q:
                cx, cy = q.popleft()
                comp.add((cx, cy))
                for ox in (-1, 0, 1):
                    for oy in (-1, 0, 1):
                        if ox == 0 and oy == 0:
                            continue
                        nb = (cx + ox, cy + oy)
                        if nb in target_set and nb not in visited:
                            visited.add(nb)
                            q.append(nb)
            components.append(comp)

        comp_count = len(components)
        for comp in components:
            # 4-connected boundary pixels
            boundary: list[tuple[int, int, float, float]] = []
            for x, y in comp:
                if (
                    (x - 1, y) not in comp
                    or (x + 1, y) not in comp
                    or (x, y - 1) not in comp
                    or (x, y + 1) not in comp
                ):
                    boundary.append((x, y, x * DX, y * DY))

            n_b = len(boundary)
            # Farthest boundary pair
            max_dist2 = -1.0
            p1 = boundary[0]
            p2 = boundary[0]
            for i in range(n_b):
                _, _, px1, py1 = boundary[i]
                for j in range(i + 1, n_b):
                    _, _, px2, py2 = boundary[j]
                    d2 = (px2 - px1) ** 2 + (py2 - py1) ** 2
                    if d2 > max_dist2:
                        max_dist2 = d2
                        p1 = boundary[i]
                        p2 = boundary[j]

            center_dist = math.sqrt(max_dist2) if max_dist2 > 0.0 else 0.0
            if center_dist > 0.0:
                ux = (p2[2] - p1[2]) / center_dist
                uy = (p2[3] - p1[3]) / center_dist
            else:
                ux, uy = 1.0, 0.0

            d1_mm = center_dist + math.hypot(ux * DX, uy * DY)
            vx, vy = -uy, ux

            # Project boundary onto u and v, bin along u with unshifted & half-shifted bins
            bin_w = max(DX, DY)
            proj = [(px * ux + py * uy, px * vx + py * vy, bx, by) for (bx, by, px, py) in boundary]

            best_span = -1.0
            best_qmin = proj[0]
            best_qmax = proj[0]

            for shift in (0.0, 0.5 * bin_w):
                bins: dict[int, list[tuple[float, float, int, int]]] = {}
                for item in proj:
                    b_id = int(math.floor((item[0] + shift) / bin_w))
                    bins.setdefault(b_id, []).append(item)
                for items in bins.values():
                    qmin = min(items, key=lambda it: it[1])
                    qmax = max(items, key=lambda it: it[1])
                    span = qmax[1] - qmin[1]
                    if span > best_span:
                        best_span = span
                        best_qmin = qmin
                        best_qmax = qmax

            if best_span < 0.0:
                best_span = 0.0
            d2_mm = best_span + math.hypot(vx * DX, vy * DY)
            spd_mm2 = d1_mm * d2_mm

            t_mid = 0.5 * (best_qmin[0] + best_qmax[0])
            s_min, s_max = best_qmin[1], best_qmax[1]
            min_x1 = (t_mid * ux + s_min * vx) / DX
            min_y1 = (t_mid * uy + s_min * vy) / DY
            min_x2 = (t_mid * ux + s_max * vx) / DX
            min_y2 = (t_mid * uy + s_max * vy) / DY

            key = (spd_mm2, d1_mm, len(comp))
            if key > best_key:
                best_key = key
                best = {
                    "region": region,
                    "d1Mm": round(d1_mm, 4),
                    "d2Mm": round(d2_mm, 4),
                    "spdMm2": round(spd_mm2, 4),
                    "bestSliceZ": z,
                    "measurable": bool(d1_mm >= 10.0 and d2_mm >= 10.0),
                    "majorLine": {
                        "x1": float(p1[0]),
                        "y1": float(p1[1]),
                        "x2": float(p2[0]),
                        "y2": float(p2[1]),
                    },
                    "minorLine": {
                        "x1": round(min_x1, 4),
                        "y1": round(min_y1, 4),
                        "x2": round(min_x2, 4),
                        "y2": round(min_y2, 4),
                    },
                    "sliceAreaMm2": round(slice_area_mm2, 4),
                    "componentCountOnSlice": comp_count,
                }

    if best is None:
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
    return best


def _compute_volumetrics(mask: bytearray) -> dict[str, Any]:
    label_counts = {1: 0, 2: 0, 3: 0, 5: 0}
    for v in mask:
        lbl = _normalize_label(v)
        if lbl in label_counts:
            label_counts[lbl] += 1

    region_counts = {
        "WT": label_counts[1] + label_counts[2] + label_counts[3],
        "TC": label_counts[1] + label_counts[3],
        "ET": label_counts[3],
        "RC": label_counts[5],
        "nonCE": label_counts[1] + label_counts[2],
    }

    def _entry(cnt: int) -> dict[str, Any]:
        vol_mm3 = cnt * VOXEL_VOL_MM3
        vol_cm3 = vol_mm3 / 1000.0
        eq_d = 2.0 * ((3.0 * vol_mm3) / (4.0 * math.pi)) ** (1.0 / 3.0) if cnt > 0 else 0.0
        return {
            "voxelCount": cnt,
            "volumeMm3": round(vol_mm3, 4),
            "volumeCm3": round(vol_cm3, 4),
            "eqSphereDiamMm": round(eq_d, 4),
        }

    return {
        "labels": {str(k): _entry(v) for k, v in label_counts.items()},
        "regions": {k: _entry(v) for k, v in region_counts.items()},
        "rano2d": _compute_axial_2d_diameters(mask, "ET"),
    }


def _edt_1d(f: list[float], step_sq: float) -> list[float]:
    """Exact 1D squared Euclidean Distance Transform (Felzenszwalb-Huttenlocher)."""
    n = len(f)
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
                # Replace infinite sentinel parabola at k=0
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

    out = [1e30] * n
    if f[v[0]] >= 1e29:
        return out

    k = 0
    for q in range(n):
        while z[k + 1] < q:
            k += 1
        p = v[k]
        diff = q - p
        out[q] = diff * diff * step_sq + f[p]
    return out


def _edt_3d_bbox(
    surface_pts: list[tuple[int, int, int]],
    min_x: int, max_x: int,
    min_y: int, max_y: int,
    min_z: int, max_z: int,
) -> list[float]:
    """Exact anisotropic 3D squared EDT inside tight bounding box."""
    bx = max_x - min_x + 1
    by = max_y - min_y + 1
    bz = max_z - min_z + 1
    inf = 1e30
    grid = [inf] * (bx * by * bz)
    for x, y, z in surface_pts:
        grid[(x - min_x) + (y - min_y) * bx + (z - min_z) * bx * by] = 0.0

    dx2, dy2, dz2 = DX * DX, DY * DY, DZ * DZ

    # Pass X
    for z in range(bz):
        z_off = z * bx * by
        for y in range(by):
            off = z_off + y * bx
            row = _edt_1d(grid[off : off + bx], dx2)
            grid[off : off + bx] = row

    # Pass Y
    for z in range(bz):
        z_off = z * bx * by
        for x in range(bx):
            col = [grid[z_off + y * bx + x] for y in range(by)]
            res = _edt_1d(col, dy2)
            for y in range(by):
                grid[z_off + y * bx + x] = res[y]

    # Pass Z
    for y in range(by):
        y_off = y * bx
        for x in range(bx):
            col = [grid[z * bx * by + y_off + x] for z in range(bz)]
            res = _edt_1d(col, dz2)
            for z in range(bz):
                grid[z * bx * by + y_off + x] = res[z]

    return grid


def _percentile_linear(values: list[float], pct: float) -> float:
    s = sorted(values)
    n = len(s)
    if n == 0:
        return 0.0
    if n == 1:
        return s[0]
    pos = (pct / 100.0) * (n - 1)
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    frac = pos - lo
    return s[lo] * (1.0 - frac) + s[hi] * frac


def _evaluate_segmentation(gt_mask: bytearray, pred_mask: bytearray) -> dict[str, Any]:
    regions_out: dict[str, Any] = {}
    for region in ("ET", "TC", "WT", "RC"):
        gt_bin = bytearray(N_VOXELS)
        pr_bin = bytearray(N_VOXELS)
        tp = fp = fn = 0
        min_x, max_x = NX, -1
        min_y, max_y = NY, -1
        min_z, max_z = NZ, -1

        for z in range(NZ):
            z_off = z * NX * NY
            for y in range(NY):
                row_off = z_off + y * NX
                for x in range(NX):
                    idx = row_off + x
                    g = 1 if _in_region(_normalize_label(gt_mask[idx]), region) else 0
                    p = 1 if _in_region(_normalize_label(pred_mask[idx]), region) else 0
                    gt_bin[idx] = g
                    pr_bin[idx] = p
                    if g and p:
                        tp += 1
                    elif p and not g:
                        fp += 1
                    elif g and not p:
                        fn += 1
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
        gt_cm3 = gt_cnt * VOXEL_VOL_MM3 / 1000.0
        pr_cm3 = pr_cnt * VOXEL_VOL_MM3 / 1000.0
        rve = ((pr_cm3 - gt_cm3) / gt_cm3) * 100.0 if gt_cm3 > 0.0 else (0.0 if pr_cm3 == 0.0 else None)

        if both_empty:
            hd95_mm: float | None = 0.0
            assd_mm: float | None = 0.0
        elif gt_cnt == 0 or pr_cnt == 0:
            hd95_mm = None
            assd_mm = None
        else:
            s_gt: list[tuple[int, int, int]] = []
            s_pr: list[tuple[int, int, int]] = []
            for z in range(min_z, max_z + 1):
                z_off = z * NX * NY
                for y in range(min_y, max_y + 1):
                    row_off = z_off + y * NX
                    for x in range(min_x, max_x + 1):
                        idx = row_off + x
                        if gt_bin[idx]:
                            if (
                                x == 0 or x == NX - 1 or y == 0 or y == NY - 1 or z == 0 or z == NZ - 1
                                or not gt_bin[idx - 1] or not gt_bin[idx + 1]
                                or not gt_bin[idx - NX] or not gt_bin[idx + NX]
                                or not gt_bin[idx - NX * NY] or not gt_bin[idx + NX * NY]
                            ):
                                s_gt.append((x, y, z))
                        if pr_bin[idx]:
                            if (
                                x == 0 or x == NX - 1 or y == 0 or y == NY - 1 or z == 0 or z == NZ - 1
                                or not pr_bin[idx - 1] or not pr_bin[idx + 1]
                                or not pr_bin[idx - NX] or not pr_bin[idx + NX]
                                or not pr_bin[idx - NX * NY] or not pr_bin[idx + NX * NY]
                            ):
                                s_pr.append((x, y, z))

            bx = max_x - min_x + 1
            by = max_y - min_y + 1
            edt_pr = _edt_3d_bbox(s_pr, min_x, max_x, min_y, max_y, min_z, max_z)
            edt_gt = _edt_3d_bbox(s_gt, min_x, max_x, min_y, max_y, min_z, max_z)

            dists: list[float] = []
            for x, y, z in s_gt:
                d2 = edt_pr[(x - min_x) + (y - min_y) * bx + (z - min_z) * bx * by]
                dists.append(math.sqrt(d2))
            for x, y, z in s_pr:
                d2 = edt_gt[(x - min_x) + (y - min_y) * bx + (z - min_z) * bx * by]
                dists.append(math.sqrt(d2))

            assd_mm = sum(dists) / len(dists)
            hd95_mm = _percentile_linear(dists, 95.0)

        regions_out[region] = {
            "tp": tp,
            "fp": fp,
            "fn": fn,
            "gtCm3": round(gt_cm3, 4),
            "predCm3": round(pr_cm3, 4),
            "dice": round(dice, 6),
            "iou": round(iou, 6),
            "hd95Mm": round(hd95_mm, 4) if hd95_mm is not None else None,
            "assdMm": round(assd_mm, 4) if assd_mm is not None else None,
            "sensitivity": round(sens, 6),
            "precision": round(prec, 6),
            "rvePct": round(rve, 4) if rve is not None else None,
            "bothEmpty": both_empty,
        }

    active = [regions_out[r] for r in ("ET", "TC", "WT") if not regions_out[r]["bothEmpty"]]
    mean_dice = sum(m["dice"] for m in active) / len(active) if active else 1.0
    hd_vals = [m["hd95Mm"] for m in active if m["hd95Mm"] is not None]
    mean_hd95 = sum(hd_vals) / len(hd_vals) if hd_vals else None

    return {
        "regions": regions_out,
        "summary": {
            "meanDiceActive": round(mean_dice, 6),
            "meanHd95Mm": round(mean_hd95, 4) if mean_hd95 is not None else None,
        },
    }


def _compute_eor(pre_vol: dict[str, Any], post_vol: dict[str, Any]) -> dict[str, Any]:
    pre_ce = pre_vol["regions"]["ET"]["volumeCm3"]
    pre_nonce = pre_vol["regions"]["nonCE"]["volumeCm3"]
    pre_wt = pre_vol["regions"]["WT"]["volumeCm3"]
    res_ce = post_vol["regions"]["ET"]["volumeCm3"]
    res_nonce = post_vol["regions"]["nonCE"]["volumeCm3"]
    res_wt = post_vol["regions"]["WT"]["volumeCm3"]
    cav = post_vol["regions"]["RC"]["volumeCm3"]

    ce_eor = _clamp(((pre_ce - res_ce) / pre_ce) * 100.0, 0.0, 100.0) if pre_ce > EPS else 0.0
    nonce_eor = _clamp(((pre_nonce - res_nonce) / pre_nonce) * 100.0, 0.0, 100.0) if pre_nonce > EPS else 0.0

    if pre_ce <= EPS:
        rano_class = "N/A"
        rano_name = "Not Evaluable (No Pre-Op Tumor)" if pre_nonce <= EPS else "Non-Enhancing Tumor (CE RANO-Resect N/A)"
    elif ce_eor < 10.0:
        rano_class, rano_name = "Class 4", "Biopsy"
    elif res_ce <= EPS and res_nonce <= 5.0:
        rano_class, rano_name = "Class 1", "Supramaximal CE Resection"
    elif res_ce <= EPS and res_nonce > 5.0:
        rano_class, rano_name = "Class 2A", "Complete CE Resection"
    elif res_ce <= 1.0:
        rano_class, rano_name = "Class 2B", "Near-Total CE Resection"
    elif res_ce <= 5.0:
        rano_class, rano_name = "Class 3A", "Subtotal CE Resection"
    else:
        rano_class, rano_name = "Class 3B", "Partial CE Resection"

    return {
        "preCeCm3": round(pre_ce, 4),
        "preNonCeCm3": round(pre_nonce, 4),
        "preWtCm3": round(pre_wt, 4),
        "residualCeCm3": round(res_ce, 4),
        "residualNonCeCm3": round(res_nonce, 4),
        "residualWtCm3": round(res_wt, 4),
        "cavityCm3": round(cav, 4),
        "ceEorPct": round(ce_eor, 4),
        "nonCeEorPct": round(nonce_eor, 4),
        "ranoClass": rano_class,
        "ranoClassName": rano_name,
    }


def _compute_rano2_summary(post_vol: dict[str, Any], fu_vol: dict[str, Any]) -> dict[str, Any]:
    b_spd = post_vol["rano2d"]["spdMm2"]
    b_vol = post_vol["regions"]["ET"]["volumeCm3"]
    c_spd = fu_vol["rano2d"]["spdMm2"]
    c_vol = fu_vol["regions"]["ET"]["volumeCm3"]

    spd_chg = ((c_spd - b_spd) / b_spd) * 100.0 if b_spd > 0 else None
    vol_chg = ((c_vol - b_vol) / b_vol) * 100.0 if b_vol > 0 else None

    return {
        "baselineSpdMm2": round(b_spd, 4),
        "baselineVolCm3": round(b_vol, 4),
        "followupSpdMm2": round(c_spd, 4),
        "followupVolCm3": round(c_vol, 4),
        "spdChangeVsNadirPct": round(spd_chg, 4) if spd_chg is not None else None,
        "volChangeVsNadirPct": round(vol_chg, 4) if vol_chg is not None else None,
        "categoryPost12Weeks": "PD",
        "categoryWithin12WeeksPostRT": "PD",
        "categoryWithin12WeeksPostRTClinicallyStable": "Preliminary PD (Confirm >=4 wks)",
    }


# ---------------------------------------------------------------------------
# Main Generation Entry Point
# ---------------------------------------------------------------------------

def main() -> None:
    random.seed(SEED)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print("Generating NeuroScope-RANO synthetic neuroimaging dataset (Case 01)...")

    # 1. Synthesize base brains (with subtle mass effect on Pre-Op, relieved on Post-Op/Follow-Up)
    preop_brain, preop_parenchyma, preop_ventricles = synthesize_base_brain(mass_effect_strength=1.45, noise_salt=101)
    postop_brain, postop_parenchyma, postop_ventricles = synthesize_base_brain(mass_effect_strength=0.0, noise_salt=202)
    followup_brain, followup_parenchyma, followup_ventricles = synthesize_base_brain(mass_effect_strength=0.45, noise_salt=303)

    # 2. Synthesize segmentation masks
    preop_gt = build_preop_gt_mask(preop_parenchyma, preop_ventricles)
    preop_pred = build_preop_pred_mask(preop_gt, preop_parenchyma, preop_ventricles)
    postop_mask = build_postop_mask(postop_parenchyma, postop_ventricles)
    followup_mask = build_followup_mask(followup_parenchyma, followup_ventricles)

    # 3. Synthesize T1ce MRI intensity volumes
    preop_t1ce = blend_pathology_into_t1ce(preop_brain, preop_gt, noise_salt=111, has_cavity_rim=False)
    postop_t1ce = blend_pathology_into_t1ce(postop_brain, postop_mask, noise_salt=222, has_cavity_rim=True)
    followup_t1ce = blend_pathology_into_t1ce(followup_brain, followup_mask, noise_salt=333, has_cavity_rim=True)

    # 4. Write all 7 NIfTI-1 .nii.gz files
    files_written: dict[str, int] = {}
    files_written["case01_preop_t1ce.nii.gz"] = write_nifti_float32_gz(
        OUT_DIR / "case01_preop_t1ce.nii.gz",
        preop_t1ce,
        "NeuroScope-RANO Synthetic Case01 Pre-Op T1ce MRI (RAS+, 2mm iso)",
    )
    files_written["case01_preop_gt.nii.gz"] = write_nifti_uint8_gz(
        OUT_DIR / "case01_preop_gt.nii.gz",
        preop_gt,
        "NeuroScope-RANO Synthetic Case01 Pre-Op GT Mask (1=NCR,2=ED,3=ET)",
    )
    files_written["case01_preop_pred.nii.gz"] = write_nifti_uint8_gz(
        OUT_DIR / "case01_preop_pred.nii.gz",
        preop_pred,
        "NeuroScope-RANO Synthetic Case01 Pre-Op AI Pred Mask (1=NCR,2=ED,3=ET)",
    )
    files_written["case01_postop_t1ce.nii.gz"] = write_nifti_float32_gz(
        OUT_DIR / "case01_postop_t1ce.nii.gz",
        postop_t1ce,
        "NeuroScope-RANO Synthetic Case01 Early Post-Op <72h T1ce MRI",
    )
    files_written["case01_postop_mask.nii.gz"] = write_nifti_uint8_gz(
        OUT_DIR / "case01_postop_mask.nii.gz",
        postop_mask,
        "NeuroScope-RANO Synthetic Case01 Post-Op Mask (2=ED,3=ET,5=RC)",
    )
    files_written["case01_followup_t1ce.nii.gz"] = write_nifti_float32_gz(
        OUT_DIR / "case01_followup_t1ce.nii.gz",
        followup_t1ce,
        "NeuroScope-RANO Synthetic Case01 6-Month Follow-Up T1ce MRI",
    )
    files_written["case01_followup_mask.nii.gz"] = write_nifti_uint8_gz(
        OUT_DIR / "case01_followup_mask.nii.gz",
        followup_mask,
        "NeuroScope-RANO Synthetic Case01 6-Month Follow-Up Mask (2=ED,3=ET,5=RC)",
    )

    # 5. Compute reference summary metrics
    preop_vol = _compute_volumetrics(preop_gt)
    postop_vol = _compute_volumetrics(postop_mask)
    followup_vol = _compute_volumetrics(followup_mask)
    eor_ref = _compute_eor(preop_vol, postop_vol)
    rano2_ref = _compute_rano2_summary(postop_vol, followup_vol)
    ai_eval_ref = _evaluate_segmentation(preop_gt, preop_pred)

    # 6. Build and write manifest.json (strictly preserving ARCHITECTURE.md Section 3.3 schema + referenceSummary)
    manifest = {
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
                        "newMeasurableLesion": False,
                        "within12WeeksPostRT": False,
                        "notes": "Baseline diagnostic MRI showing right frontal ring-enhancing necrotic mass with surrounding FLAIR edema.",
                    },
                    {
                        "id": "postop",
                        "label": "Early Post-Op (<72h)",
                        "role": "baseline_postop",
                        "dayOffset": 2,
                        "date": "2025-01-12",
                        "t1ce": "assets/samples/case01_postop_t1ce.nii.gz",
                        "mask": "assets/samples/case01_postop_mask.nii.gz",
                        "predMask": None,
                        "dexamethasoneMgPerDay": 4,
                        "steroids": "stable_or_decreased",
                        "clinicalStatus": "stable_or_improved",
                        "kps": 90,
                        "newMeasurableLesion": False,
                        "within12WeeksPostRT": True,
                        "notes": "Early post-operative MRI (<72h) demonstrating right frontal resection cavity with small posterior-medial residual enhancing focus. Under RANO 2.0 (Wen et al., JCO 2023), post-radiotherapy MRI (~4 weeks post-RT) is the standard baseline for newly diagnosed gliomas treated with RT; Case 01 uses this early post-op scan as an illustrative pre-RT/surgical baseline.",
                    },
                    {
                        "id": "followup",
                        "label": "6-Month Follow-Up",
                        "role": "followup",
                        "dayOffset": 182,
                        "date": "2025-07-11",
                        "t1ce": "assets/samples/case01_followup_t1ce.nii.gz",
                        "mask": "assets/samples/case01_followup_mask.nii.gz",
                        "predMask": None,
                        "dexamethasoneMgPerDay": 8,
                        "steroids": "increased",
                        "clinicalStatus": "deteriorated",
                        "kps": 70,
                        "newMeasurableLesion": False,
                        "within12WeeksPostRT": False,
                        "notes": "6-month surveillance scan (>12 wks post-RT) showing nodular enhancing progression along posterior-medial resection margin with increased edema and mild left-hand weakness.",
                    },
                ],
                "referenceSummary": {
                    "geometry": {
                        "dims": [NX, NY, NZ],
                        "pixdim": [DX, DY, DZ],
                        "voxelVolumeMm3": VOXEL_VOL_MM3,
                    },
                    "fileSizesBytes": files_written,
                    "volumetrics": {
                        "preop": preop_vol,
                        "postop": postop_vol,
                        "followup": followup_vol,
                    },
                    "ranoResect": eor_ref,
                    "rano2": rano2_ref,
                    "aiEvaluation": ai_eval_ref,
                },
            }
        ],
    }

    manifest_path = OUT_DIR / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    # Print diagnostic summary
    print("\n--- File Sizes ---")
    for fname, fsize in files_written.items():
        kb = fsize / 1024.0
        status = "OK" if fsize < 250 * 1024 else "OVER 250KB!"
        print(f"  {fname:32s} {fsize:8d} bytes ({kb:6.1f} KB) [{status}]")

    print("\n--- Pre-Op Volumetrics & 2D RANO ---")
    print(f"  NCR: {preop_vol['labels']['1']['volumeCm3']:.2f} cm3 | ET: {preop_vol['regions']['ET']['volumeCm3']:.2f} cm3 | ED: {preop_vol['labels']['2']['volumeCm3']:.2f} cm3 | WT: {preop_vol['regions']['WT']['volumeCm3']:.2f} cm3")
    r2d = preop_vol["rano2d"]
    print(f"  2D RANO (ET): d1={r2d['d1Mm']:.1f} mm, d2={r2d['d2Mm']:.1f} mm, SPD={r2d['spdMm2']:.1f} mm2 @ z={r2d['bestSliceZ']} (measurable={r2d['measurable']})")

    print("\n--- Post-Op Volumetrics & RANO-Resect ---")
    print(f"  RC: {postop_vol['regions']['RC']['volumeCm3']:.2f} cm3 | Residual ET: {postop_vol['regions']['ET']['volumeCm3']:.3f} cm3 | ED: {postop_vol['labels']['2']['volumeCm3']:.2f} cm3 | NCR: {postop_vol['labels']['1']['volumeCm3']:.2f} cm3")
    print(f"  CE EOR: {eor_ref['ceEorPct']:.2f}% | Non-CE EOR: {eor_ref['nonCeEorPct']:.2f}% -> {eor_ref['ranoClass']}: {eor_ref['ranoClassName']}")
    r2d_po = postop_vol["rano2d"]
    print(f"  Post-Op 2D RANO (ET): d1={r2d_po['d1Mm']:.1f} mm, d2={r2d_po['d2Mm']:.1f} mm, SPD={r2d_po['spdMm2']:.1f} mm2 @ z={r2d_po['bestSliceZ']}")

    print("\n--- 6-Month Follow-Up Volumetrics & RANO 2.0 ---")
    print(f"  RC: {followup_vol['regions']['RC']['volumeCm3']:.2f} cm3 | Recurrent ET: {followup_vol['regions']['ET']['volumeCm3']:.2f} cm3 | ED: {followup_vol['labels']['2']['volumeCm3']:.2f} cm3")
    r2d_fu = followup_vol["rano2d"]
    print(f"  Follow-Up 2D RANO (ET): d1={r2d_fu['d1Mm']:.1f} mm, d2={r2d_fu['d2Mm']:.1f} mm, SPD={r2d_fu['spdMm2']:.1f} mm2 @ z={r2d_fu['bestSliceZ']} (measurable={r2d_fu['measurable']})")
    print(f"  vs Post-Op Nadir: SPD {rano2_ref['spdChangeVsNadirPct']:+.1f}%, Vol {rano2_ref['volChangeVsNadirPct']:+.1f}% -> {rano2_ref['categoryPost12Weeks']}")

    print("\n--- Pre-Op AI Segmentation QA (GT vs Pred) ---")
    for r in ("ET", "TC", "WT"):
        m = ai_eval_ref["regions"][r]
        print(f"  {r:2s}: Dice={m['dice']:.4f}, IoU={m['iou']:.4f}, HD95={m['hd95Mm']:.2f} mm, ASSD={m['assdMm']:.2f} mm, Sens={m['sensitivity']:.4f}, Prec={m['precision']:.4f}, RVE={m['rvePct']:+.2f}%")

    print(f"\nManifest written to: {manifest_path}")


if __name__ == "__main__":
    main()
