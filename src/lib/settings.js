/** User settings: provider, keys, voice and pacing. Kept in this browser only. */
import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'kokuban.settings.v2';
const OLD_STORAGE_KEY = 'adaptive-tutor.settings.v2'; // the name before the app was called Kokuban

export const DEFAULT_SETTINGS = {
  provider: '', // '' = the default for where the app runs: built-in Claude when hosted, the demo locally
  providers: {
    claude: { depth: 'balanced' },
    gemini: { apiKey: '', model: '', extraBody: '' },
    groq: { apiKey: '', model: '', jsonMode: 'auto', extraBody: '' },
    together: { apiKey: '', model: '', jsonMode: 'auto', extraBody: '' },
    custom: { apiKey: '', model: '', baseUrl: '', jsonMode: 'auto', headers: '', extraBody: '' },
  },
  voice: { enabled: true, voiceURI: '', rate: 0.9 },
  pacing: { hesitationSeconds: 90 },
};

function merge(base, saved) {
  if (!saved || typeof saved !== 'object') return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(saved)) {
    const nested = value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object';
    out[key] = nested ? merge(base[key], value) : value;
  }
  return out;
}

export function loadSettings() {
  try {
    return merge(DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(OLD_STORAGE_KEY) ?? 'null'));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** [settings, update] where update(path, value) sets one field, e.g. update('voice.rate', 1). */
export function useSettings() {
  const [settings, setSettings] = useState(loadSettings);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* private mode: settings last for this tab only */
    }
  }, [settings]);

  const update = useCallback((path, value) => {
    setSettings((previous) => {
      const keys = path.split('.');
      const next = { ...previous };
      let node = next;
      keys.slice(0, -1).forEach((key) => {
        node[key] = { ...node[key] };
        node = node[key];
      });
      node[keys.at(-1)] = value;
      return next;
    });
  }, []);

  return [settings, update];
}
