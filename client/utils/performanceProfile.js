const QUALITY_STORAGE_KEY = 'littlewar:quality';

function normalizeQuality(value) {
  const q = String(value || '').trim().toLowerCase();
  if (q === 'low') return 'low';
  if (q === 'high') return 'high';
  return 'high';
}

export function getRenderQualityPreference() {
  if (typeof window === 'undefined') return 'high';

  try {
    return normalizeQuality(window.localStorage?.getItem(QUALITY_STORAGE_KEY));
  } catch (_) {
    return 'high';
  }
}

export function setRenderQualityPreference(quality) {
  const normalized = normalizeQuality(quality);
  if (typeof window === 'undefined') return normalized;

  try {
    window.localStorage?.setItem(QUALITY_STORAGE_KEY, normalized);
  } catch (_) {
    // Ignore unavailable localStorage.
  }
  return normalized;
}

export function isLowPowerQuality() {
  return getRenderQualityPreference() === 'low';
}

export function terrainDensityScale() {
  const quality = getRenderQualityPreference();
  if (quality === 'high') return 1;
  return 0.28;
}

export function useDetailedTerrainModels() {
  return getRenderQualityPreference() === 'high';
}

export function allowTinyPointLights() {
  return getRenderQualityPreference() === 'high';
}
