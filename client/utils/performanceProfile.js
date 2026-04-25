const QUALITY_STORAGE_KEY = 'littlewar:quality';

function normalizeQuality(value) {
  const q = String(value || '').trim().toLowerCase();
  if (q === 'low' || q === 'battery') return 'low';
  if (q === 'high') return 'high';
  return 'auto';
}

export function getRenderQualityPreference() {
  if (typeof window === 'undefined') return 'auto';

  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = normalizeQuality(params.get('quality'));
    if (fromUrl !== 'auto') return fromUrl;
  } catch (_) {
    // Ignore unavailable URL APIs.
  }

  try {
    return normalizeQuality(window.localStorage?.getItem(QUALITY_STORAGE_KEY));
  } catch (_) {
    return 'auto';
  }
}

export function isLowPowerQuality() {
  return getRenderQualityPreference() === 'low';
}

export function terrainDensityScale() {
  const quality = getRenderQualityPreference();
  if (quality === 'high') return 1;
  if (quality === 'low') return 0.28;
  return 0.5;
}

export function useDetailedTerrainModels() {
  return getRenderQualityPreference() === 'high';
}

export function allowTinyPointLights() {
  return getRenderQualityPreference() === 'high';
}

export function watchBatteryLowPower(onLowPower) {
  if (getRenderQualityPreference() === 'high') return;
  if (typeof navigator === 'undefined' || typeof navigator.getBattery !== 'function') return;

  navigator.getBattery()
    .then((battery) => {
      const update = () => {
        if (!battery.charging) onLowPower?.();
      };
      update();
      battery.addEventListener?.('chargingchange', update);
      battery.addEventListener?.('levelchange', update);
    })
    .catch(() => {});
}
