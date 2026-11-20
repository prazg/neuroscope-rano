/**
 * @fileoverview Client-side NIfTI-1 (.nii / .nii.gz) binary parser and geometry validator.
 * Zero external dependencies; pure ES Module implementing the NIfTI-1 specification
 * with automatic gzip detection (via native DecompressionStream), little- and big-endian
 * header/voxel decoding, intensity scaling (scl_slope/scl_inter), and geometry validation.
 *
 * Voxel indexing convention (NIfTI Fortran / column-major order):
 *   idx = x + y * nx + z * nx * ny
 *   where 0 <= x < nx, 0 <= y < ny, 0 <= z < nz.
 *
 * Raw voxel values are preserved without label remapping so grayscale MRI intensities
 * (including intensity 4.0) are never modified.
 */

/** Standard NIfTI-1 header size in bytes. */
const NIFTI1_HEADER_SIZE = 348;

/** Standard NIfTI-2 header size in bytes (detected for informative rejection). */
const NIFTI2_HEADER_SIZE = 540;

/** Default voxel data byte offset for single-file NIfTI-1 ("n+1\0"). */
const NIFTI1_DEFAULT_VOX_OFFSET = 352;

/**
 * Supported NIfTI-1 datatype descriptors mapped by header datatype code.
 * @type {Readonly<Record<number, { name: string, bytesPerVoxel: number }>>}
 */
const SUPPORTED_DATATYPES = Object.freeze({
  2:   Object.freeze({ name: 'UINT8',   bytesPerVoxel: 1 }),
  4:   Object.freeze({ name: 'INT16',   bytesPerVoxel: 2 }),
  8:   Object.freeze({ name: 'INT32',   bytesPerVoxel: 4 }),
  16:  Object.freeze({ name: 'FLOAT32', bytesPerVoxel: 4 }),
  64:  Object.freeze({ name: 'FLOAT64', bytesPerVoxel: 8 }),
  256: Object.freeze({ name: 'INT8',    bytesPerVoxel: 1 }),
  512: Object.freeze({ name: 'UINT16',  bytesPerVoxel: 2 }),
  768: Object.freeze({ name: 'UINT32',  bytesPerVoxel: 4 }),
});

/** Detected host CPU endianness (true on little-endian platforms such as x86/ARM). */
const HOST_LITTLE_ENDIAN = (() => {
  const buf = new ArrayBuffer(2);
  new DataView(buf).setInt16(0, 0x0102, true);
  return new Int16Array(buf)[0] === 0x0102;
})();

/**
 * @typedef {Object} NiftiHeader
 * @property {number} sizeofHdr - Header byte length (always 348 for NIfTI-1).
 * @property {boolean} littleEndian - True if header & voxel payload are little-endian.
 * @property {string} magic - NIfTI magic string with trailing NUL bytes stripped (e.g. "n+1").
 * @property {number} bitpix - Bits per voxel recorded in the header.
 * @property {number} voxOffset - Byte offset where voxel data starts.
 * @property {number} sclSlope - Intensity scaling slope (0 indicates unscaled).
 * @property {number} sclInter - Intensity scaling intercept.
 * @property {number} qformCode - NIfTI qform spatial transform code.
 * @property {number} sformCode - NIfTI sform spatial transform code.
 * @property {[[number, number, number, number], [number, number, number, number], [number, number, number, number]]} sform - 3x4 affine rows (srow_x, srow_y, srow_z).
 * @property {string} descrip - Null-terminated ASCII description field (up to 80 bytes).
 * @property {number} nt - Number of 4th-dimension timepoints/volumes (1 for 3D volumes).
 */

/**
 * @typedef {Object} NiftiVolume
 * @property {[number, number, number]} dims - Volume dimensions [nx, ny, nz].
 * @property {[number, number, number]} pixdim - Physical voxel spacings [dx, dy, dz] in mm.
 * @property {number} voxelVolumeMm3 - Physical volume of one voxel in mm^3 (dx * dy * dz).
 * @property {number} datatype - NIfTI-1 numeric datatype code.
 * @property {Float32Array} data - Flattened voxel data (length nx * ny * nz, x-fastest).
 * @property {number} min - Minimum finite value in `data`.
 * @property {number} max - Maximum finite value in `data`.
 * @property {NiftiHeader} header - Parsed NIfTI-1 header metadata.
 */

/**
 * @typedef {Object} GeometryValidationResult
 * @property {boolean} valid - True if both dimensions and voxel spacings match within tolerance.
 * @property {boolean} ok - Alias of `valid`.
 * @property {boolean} dimsMatch - True if [nx, ny, nz] are identical.
 * @property {boolean} pixdimMatch - True if [dx, dy, dz] match within `pixdimTolerance` mm.
 * @property {string[]} errors - Descriptive mismatch errors (empty when valid).
 * @property {string[]} warnings - Non-fatal geometry warnings, if any.
 * @property {string} message - Concise human-readable summary.
 */

/**
 * Normalize an ArrayBuffer or ArrayBufferView into a standalone Uint8Array view.
 * @param {ArrayBuffer | ArrayBufferView} input
 * @returns {Uint8Array}
 */
function toUint8View(input) {
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError('Expected an ArrayBuffer or TypedArray view containing NIfTI data.');
}

/**
 * Test whether a byte buffer begins with the RFC 1952 gzip magic header (0x1f 0x8b).
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
function isGzipped(bytes) {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Decompress a gzip-encoded byte view using the browser's native DecompressionStream API.
 * @param {Uint8Array} gzBytes
 * @returns {Promise<ArrayBuffer>}
 */
async function decompressGzip(gzBytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error(
      'Cannot decompress gzipped NIfTI (.nii.gz): native DecompressionStream("gzip") is unavailable in this browser. ' +
      'Use a modern browser (Chrome 80+, Edge 80+, Firefox 113+, Safari 16.4+) or load an uncompressed .nii file.'
    );
  }
  try {
    const ds = new DecompressionStream('gzip');
    const decompressedStream = new Blob([gzBytes]).stream().pipeThrough(ds);
    return await new Response(decompressedStream).arrayBuffer();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to decompress gzipped NIfTI buffer: ${detail}`);
  }
}

/**
 * Read a null-terminated ASCII string from a Uint8Array slice.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @param {number} maxLength
 * @returns {string}
 */
function readNullTerminatedAscii(bytes, offset, maxLength) {
  let end = offset;
  const limit = Math.min(bytes.byteLength, offset + maxLength);
  while (end < limit && bytes[end] !== 0) {
    end++;
  }
  let out = '';
  for (let i = offset; i < end; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

/**
 * Sanitize a NIfTI physical voxel spacing value, falling back to 1.0 mm if zero or invalid.
 * @param {number} value
 * @returns {number}
 */
function sanitizePixdim(value) {
  if (!Number.isFinite(value) || value === 0) {
    return 1.0;
  }
  return Math.abs(value);
}

/**
 * Decode voxel payload into a Float32Array, applying NIfTI-1 intensity scaling
 * (scl_slope / scl_inter) and tracking exact finite min/max values.
 *
 * Uses a zero-copy TypedArray fast path when endianness and byte alignment match the host;
 * falls back to an alignment- and endian-safe DataView loop otherwise.
 *
 * @param {ArrayBuffer} buffer
 * @param {number} byteOffset
 * @param {number} datatype
 * @param {number} totalVoxels
 * @param {boolean} littleEndian
 * @param {number} sclSlope
 * @param {number} sclInter
 * @returns {{ data: Float32Array, min: number, max: number }}
 */
function decodeVoxels(buffer, byteOffset, datatype, totalVoxels, littleEndian, sclSlope, sclInter) {
  const typeInfo = SUPPORTED_DATATYPES[datatype];
  const bpv = typeInfo.bytesPerVoxel;
  const data = new Float32Array(totalVoxels);

  if (totalVoxels === 0) {
    return { data, min: 0, max: 0 };
  }

  const hasValidSlope = Number.isFinite(sclSlope) && sclSlope !== 0;
  const inter = Number.isFinite(sclInter) ? sclInter : 0;
  const applyScaling = hasValidSlope && !(sclSlope === 1 && inter === 0);

  let min = Infinity;
  let max = -Infinity;

  const canUseTypedFastPath =
    (bpv === 1 || littleEndian === HOST_LITTLE_ENDIAN) &&
    (byteOffset % bpv === 0);

  if (canUseTypedFastPath) {
    let src;
    switch (datatype) {
      case 2:   src = new Uint8Array(buffer, byteOffset, totalVoxels); break;
      case 4:   src = new Int16Array(buffer, byteOffset, totalVoxels); break;
      case 8:   src = new Int32Array(buffer, byteOffset, totalVoxels); break;
      case 16:  src = new Float32Array(buffer, byteOffset, totalVoxels); break;
      case 64:  src = new Float64Array(buffer, byteOffset, totalVoxels); break;
      case 256: src = new Int8Array(buffer, byteOffset, totalVoxels); break;
      case 512: src = new Uint16Array(buffer, byteOffset, totalVoxels); break;
      case 768: src = new Uint32Array(buffer, byteOffset, totalVoxels); break;
      default:
        throw new Error(`Unsupported NIfTI datatype code: ${datatype}`);
    }

    if (applyScaling) {
      for (let i = 0; i < totalVoxels; i++) {
        let v = src[i] * sclSlope + inter;
        if (!Number.isFinite(v)) v = 0;
        data[i] = v;
        const stored = data[i];
        if (stored < min) min = stored;
        if (stored > max) max = stored;
      }
    } else if (datatype === 16 || datatype === 64) {
      for (let i = 0; i < totalVoxels; i++) {
        let v = src[i];
        if (!Number.isFinite(v)) v = 0;
        data[i] = v;
        const stored = data[i];
        if (stored < min) min = stored;
        if (stored > max) max = stored;
      }
    } else {
      for (let i = 0; i < totalVoxels; i++) {
        data[i] = src[i];
        const stored = data[i];
        if (stored < min) min = stored;
        if (stored > max) max = stored;
      }
    }
  } else {
    const view = new DataView(buffer, byteOffset, totalVoxels * bpv);
    for (let i = 0; i < totalVoxels; i++) {
      const off = i * bpv;
      let raw;
      switch (datatype) {
        case 2:   raw = view.getUint8(off); break;
        case 4:   raw = view.getInt16(off, littleEndian); break;
        case 8:   raw = view.getInt32(off, littleEndian); break;
        case 16:  raw = view.getFloat32(off, littleEndian); break;
        case 64:  raw = view.getFloat64(off, littleEndian); break;
        case 256: raw = view.getInt8(off); break;
        case 512: raw = view.getUint16(off, littleEndian); break;
        case 768: raw = view.getUint32(off, littleEndian); break;
        default:
          throw new Error(`Unsupported NIfTI datatype code: ${datatype}`);
      }
      let v = applyScaling ? raw * sclSlope + inter : raw;
      if (!Number.isFinite(v)) v = 0;
      data[i] = v;
      const stored = data[i];
      if (stored < min) min = stored;
      if (stored > max) max = stored;
    }
  }

  if (!Number.isFinite(min)) min = 0;
  if (!Number.isFinite(max)) max = 0;

  return { data, min, max };
}

/**
 * Parse a raw or gzip-compressed NIfTI-1 (.nii / .nii.gz) binary buffer into a `NiftiVolume`.
 *
 * Automatically detects gzip magic bytes (`0x1f 0x8b`), decompresses via native
 * `DecompressionStream('gzip')`, auto-detects little/big endianness (`sizeof_hdr === 348`),
 * validates single-file NIfTI-1 magic (`n+1\0`), decodes supported scalar datatypes
 * (`2, 4, 8, 16, 64, 256, 512, 768`), applies `scl_slope`/`scl_inter` when `scl_slope !== 0`,
 * and returns a `Float32Array` volume with exact geometry and intensity bounds.
 *
 * @param {ArrayBuffer | ArrayBufferView} arrayBuffer - Raw `.nii` or gzipped `.nii.gz` bytes.
 * @returns {Promise<NiftiVolume>} Parsed NIfTI-1 volume object.
 */
export async function parseNiftiBuffer(arrayBuffer) {
  let bytes = toUint8View(arrayBuffer);
  if (bytes.byteLength === 0) {
    throw new Error('Cannot parse empty NIfTI buffer.');
  }

  let rawBuffer;
  let baseOffset = 0;

  if (isGzipped(bytes)) {
    rawBuffer = await decompressGzip(bytes);
    bytes = new Uint8Array(rawBuffer);
    baseOffset = 0;
  } else {
    rawBuffer = bytes.buffer;
    baseOffset = bytes.byteOffset;
  }

  if (bytes.byteLength < NIFTI1_HEADER_SIZE) {
    throw new Error(
      `Invalid NIfTI file: buffer length (${bytes.byteLength} bytes) is smaller than the 348-byte NIfTI-1 header.`
    );
  }

  const headerView = new DataView(rawBuffer, baseOffset, bytes.byteLength);

  // Auto-detect endianness via sizeof_hdr === 348
  const hdrSizeLE = headerView.getInt32(0, true);
  const hdrSizeBE = headerView.getInt32(0, false);

  let littleEndian;
  if (hdrSizeLE === NIFTI1_HEADER_SIZE) {
    littleEndian = true;
  } else if (hdrSizeBE === NIFTI1_HEADER_SIZE) {
    littleEndian = false;
  } else if (hdrSizeLE === NIFTI2_HEADER_SIZE || hdrSizeBE === NIFTI2_HEADER_SIZE) {
    throw new Error(
      'NIfTI-2 format detected (sizeof_hdr = 540). NeuroScope-RANO requires NIfTI-1 (sizeof_hdr = 348).'
    );
  } else {
    throw new Error(
      `Invalid NIfTI-1 header: expected sizeof_hdr = 348, got ${hdrSizeLE} (LE) / ${hdrSizeBE} (BE).`
    );
  }

  // Validate single-file NIfTI-1 magic bytes at offsets 344..347
  const m0 = bytes[344];
  const m1 = bytes[345];
  const m2 = bytes[346];
  const m3 = bytes[347];

  const isSingleFileNifti1 = (m0 === 0x6e && m1 === 0x2b && m2 === 0x31 && m3 === 0x00); // "n+1\0"
  const isSplitPairNifti1  = (m0 === 0x6e && m1 === 0x69 && m2 === 0x31 && m3 === 0x00); // "ni1\0"

  if (isSplitPairNifti1) {
    throw new Error(
      'Split NIfTI-1 header/image pairs ("ni1", .hdr/.img) are not supported. ' +
      'Please convert to a single-file .nii or .nii.gz volume ("n+1").'
    );
  }
  if (!isSingleFileNifti1) {
    const printableMagic = readNullTerminatedAscii(bytes, 344, 4);
    throw new Error(
      `Invalid NIfTI-1 magic bytes "${printableMagic}" (expected single-file "n+1\\0").`
    );
  }

  // Read dimensions: dim[0..7] at offset 40 (8 x int16)
  const ndim = headerView.getInt16(40, littleEndian);
  if (ndim < 1 || ndim > 7) {
    throw new Error(`Invalid NIfTI-1 dimension count dim[0] = ${ndim} (expected 1..7).`);
  }
  const rawDim1 = headerView.getInt16(42, littleEndian);
  const rawDim2 = headerView.getInt16(44, littleEndian);
  const rawDim3 = headerView.getInt16(46, littleEndian);
  const rawDim4 = headerView.getInt16(48, littleEndian);

  if (rawDim1 <= 0 || rawDim2 < 0 || rawDim3 < 0) {
    throw new Error(`Invalid NIfTI-1 spatial dimensions: [${rawDim1}, ${rawDim2}, ${rawDim3}].`);
  }

  const nx = Math.max(1, rawDim1);
  const ny = Math.max(1, rawDim2);
  const nz = Math.max(1, rawDim3);
  const nt = (ndim >= 4 && rawDim4 > 1) ? rawDim4 : 1;
  /** @type {[number, number, number]} */
  const dims = [nx, ny, nz];

  // Read datatype (offset 70) and bitpix (offset 72)
  const datatype = headerView.getInt16(70, littleEndian);
  const bitpix = headerView.getInt16(72, littleEndian);
  const typeInfo = SUPPORTED_DATATYPES[datatype];
  if (!typeInfo) {
    throw new Error(
      `Unsupported NIfTI-1 datatype code ${datatype} (bitpix=${bitpix}). ` +
      'Supported codes: 2 (UINT8), 4 (INT16), 8 (INT32), 16 (FLOAT32), 64 (FLOAT64), 256 (INT8), 512 (UINT16), 768 (UINT32).'
    );
  }

  // Read physical voxel spacings pixdim[1..3] at offsets 80, 84, 88 (float32)
  const dx = sanitizePixdim(headerView.getFloat32(80, littleEndian));
  const dy = sanitizePixdim(headerView.getFloat32(84, littleEndian));
  const dz = sanitizePixdim(headerView.getFloat32(88, littleEndian));
  /** @type {[number, number, number]} */
  const pixdim = [dx, dy, dz];
  const voxelVolumeMm3 = dx * dy * dz;

  // Read vox_offset (108), scl_slope (112), scl_inter (116)
  const voxOffsetRaw = headerView.getFloat32(108, littleEndian);
  const voxOffset =
    Number.isFinite(voxOffsetRaw) && voxOffsetRaw >= NIFTI1_HEADER_SIZE
      ? Math.floor(voxOffsetRaw)
      : NIFTI1_DEFAULT_VOX_OFFSET;

  const sclSlope = headerView.getFloat32(112, littleEndian);
  const sclInter = headerView.getFloat32(116, littleEndian);

  // Read descrip (148..227), qform_code (252), sform_code (254), and srow_x/y/z (280..327)
  const descrip = readNullTerminatedAscii(bytes, 148, 80).trim();
  const qformCode = headerView.getInt16(252, littleEndian);
  const sformCode = headerView.getInt16(254, littleEndian);
  /** @type {[[number, number, number, number], [number, number, number, number], [number, number, number, number]]} */
  const sform = [
    [
      headerView.getFloat32(280, littleEndian),
      headerView.getFloat32(284, littleEndian),
      headerView.getFloat32(288, littleEndian),
      headerView.getFloat32(292, littleEndian),
    ],
    [
      headerView.getFloat32(296, littleEndian),
      headerView.getFloat32(300, littleEndian),
      headerView.getFloat32(304, littleEndian),
      headerView.getFloat32(308, littleEndian),
    ],
    [
      headerView.getFloat32(312, littleEndian),
      headerView.getFloat32(316, littleEndian),
      headerView.getFloat32(320, littleEndian),
      headerView.getFloat32(324, littleEndian),
    ],
  ];

  // Validate payload byte availability for volume t = 0
  const totalVoxels = nx * ny * nz;
  const requiredPayloadBytes = totalVoxels * typeInfo.bytesPerVoxel;
  const availablePayloadBytes = bytes.byteLength - voxOffset;
  if (availablePayloadBytes < requiredPayloadBytes) {
    throw new Error(
      `Truncated NIfTI-1 voxel payload: volume [${nx}x${ny}x${nz}] of ${typeInfo.name} requires ` +
      `${requiredPayloadBytes} bytes starting at offset ${voxOffset}, but only ${Math.max(0, availablePayloadBytes)} bytes are available.`
    );
  }

  const { data, min, max } = decodeVoxels(
    rawBuffer,
    baseOffset + voxOffset,
    datatype,
    totalVoxels,
    littleEndian,
    sclSlope,
    sclInter
  );

  return {
    dims,
    pixdim,
    voxelVolumeMm3,
    datatype,
    data,
    min,
    max,
    header: {
      sizeofHdr: NIFTI1_HEADER_SIZE,
      littleEndian,
      magic: 'n+1',
      bitpix,
      voxOffset,
      sclSlope,
      sclInter,
      qformCode,
      sformCode,
      sform,
      descrip,
      nt,
    },
  };
}

/**
 * Fetch a NIfTI-1 (.nii or .nii.gz) volume from a URL and parse it.
 *
 * @param {string} url - Relative or absolute URL to fetch.
 * @returns {Promise<NiftiVolume>} Parsed NIfTI-1 volume.
 */
export async function fetchNifti(url) {
  if (typeof url !== 'string' || url.trim().length === 0) {
    throw new TypeError('fetchNifti(url) requires a non-empty URL string.');
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch NIfTI volume from "${url}": HTTP ${response.status} ${response.statusText || ''}`.trim()
    );
  }
  const buffer = await response.arrayBuffer();
  return parseNiftiBuffer(buffer);
}

/**
 * Read and parse a browser `File` or `Blob` containing a NIfTI-1 (.nii or .nii.gz) volume.
 * All processing remains strictly in local browser memory with zero network transfer.
 *
 * @param {File | Blob} file - User-selected local File or Blob object.
 * @returns {Promise<NiftiVolume>} Parsed NIfTI-1 volume.
 */
export async function loadNiftiFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new TypeError('loadNiftiFile(file) requires a browser File or Blob instance.');
  }
  const buffer = await file.arrayBuffer();
  return parseNiftiBuffer(buffer);
}

/**
 * Validate whether two parsed `NiftiVolume` objects share matching voxel grid dimensions
 * and physical voxel spacing (`pixdim`).
 *
 * @param {NiftiVolume} volA - Reference volume (e.g., structural MRI or ground-truth mask).
 * @param {NiftiVolume} volB - Comparison volume (e.g., overlay mask or AI prediction).
 * @param {Object} [options] - Validation options.
 * @param {number} [options.pixdimTolerance=1e-3] - Maximum allowed spacing delta in mm per axis.
 * @param {boolean} [options.throwOnMismatch=false] - If true, throws an Error when geometry mismatches.
 * @returns {GeometryValidationResult} Detailed geometry comparison summary.
 */
export function validateMatchingGeometry(volA, volB, options = {}) {
  const pixdimTolerance =
    typeof options.pixdimTolerance === 'number' && options.pixdimTolerance >= 0
      ? options.pixdimTolerance
      : 1e-3;
  const throwOnMismatch = Boolean(options.throwOnMismatch);

  const errors = [];
  const warnings = [];

  if (!volA || !Array.isArray(volA.dims) || volA.dims.length < 3) {
    errors.push('Reference volume A is missing valid 3D dims.');
  }
  if (!volB || !Array.isArray(volB.dims) || volB.dims.length < 3) {
    errors.push('Comparison volume B is missing valid 3D dims.');
  }

  if (errors.length > 0) {
    const message = errors.join(' ');
    if (throwOnMismatch) throw new Error(message);
    return {
      valid: false,
      ok: false,
      dimsMatch: false,
      pixdimMatch: false,
      errors,
      warnings,
      message,
    };
  }

  const [ax, ay, az] = volA.dims;
  const [bx, by, bz] = volB.dims;
  const dimsMatch = ax === bx && ay === by && az === bz;
  if (!dimsMatch) {
    errors.push(`Dimension mismatch: [${ax}×${ay}×${az}] vs [${bx}×${by}×${bz}].`);
  }

  let pixdimMatch = true;
  const hasPixA = Array.isArray(volA.pixdim) && volA.pixdim.length >= 3;
  const hasPixB = Array.isArray(volB.pixdim) && volB.pixdim.length >= 3;
  if (hasPixA && hasPixB) {
    const [adx, ady, adz] = volA.pixdim;
    const [bdx, bdy, bdz] = volB.pixdim;
    pixdimMatch =
      Math.abs(adx - bdx) <= pixdimTolerance &&
      Math.abs(ady - bdy) <= pixdimTolerance &&
      Math.abs(adz - bdz) <= pixdimTolerance;
    if (!pixdimMatch) {
      errors.push(
        `Voxel spacing mismatch: [${adx.toFixed(3)}×${ady.toFixed(3)}×${adz.toFixed(3)} mm] ` +
        `vs [${bdx.toFixed(3)}×${bdy.toFixed(3)}×${bdz.toFixed(3)} mm].`
      );
    }
  } else {
    warnings.push('One or both volumes are missing pixdim metadata; spacing match assumed.');
  }

  const valid = dimsMatch && pixdimMatch;
  const message = valid
    ? `Geometry matches ([${ax}×${ay}×${az}] voxels).`
    : errors.join(' ');

  if (!valid && throwOnMismatch) {
    throw new Error(message);
  }

  return {
    valid,
    ok: valid,
    dimsMatch,
    pixdimMatch,
    errors,
    warnings,
    message,
  };
}
