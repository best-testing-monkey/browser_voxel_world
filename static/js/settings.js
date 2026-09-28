// Per-player settings, kept in this browser (localStorage). These are the
// player's own preferences — graphics quality, view distance, mouse — as
// opposed to the world/server configuration the backend dictates through
// /api/config. Every read and write tolerates storage being unavailable
// (private windows, blocked site data): the defaults are used instead.

const STORAGE_KEY = 'voxelWorld.settings.v1';

// Each setting: default value, the allowed values (or a numeric range) and
// how the Settings dialog presents it.
export const SETTINGS_SCHEMA = {
  fluidShaders: {
    label: 'Fluid shaders',
    type: 'choice',
    default: 'high',
    choices: [
      ['high', 'High - rippling, reflective water; flowing lava'],
      ['low', 'Low - flat shading, for slower GPUs'],
    ],
  },
  renderDistance: {
    label: 'Render distance (chunks)',
    type: 'range',
    default: 3,
    min: 2,
    max: 8,
    step: 1,
  },
  mouseSensitivity: {
    label: 'Mouse sensitivity',
    type: 'range',
    default: 1,
    min: 0.25,
    max: 3,
    step: 0.05,
  },
};

function sanitize(key, value) {
  const spec = SETTINGS_SCHEMA[key];
  if (spec.type === 'choice') {
    return spec.choices.some(([v]) => v === value) ? value : spec.default;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return spec.default;
  return Math.min(spec.max, Math.max(spec.min, n));
}

function readStored() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function createSettings() {
  const stored = readStored();
  const values = {};
  for (const key of Object.keys(SETTINGS_SCHEMA)) {
    values[key] = sanitize(key, key in stored ? stored[key] : SETTINGS_SCHEMA[key].default);
  }
  const listeners = [];

  function save() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
    } catch { /* storage unavailable: keep the values for this session */ }
  }

  return {
    get: (key) => values[key],
    all: () => ({ ...values }),
    set(key, value) {
      if (!(key in SETTINGS_SCHEMA)) return;
      const v = sanitize(key, value);
      if (v === values[key]) return;
      values[key] = v;
      save();
      for (const fn of listeners) fn(key, v);
    },
    reset() {
      for (const key of Object.keys(SETTINGS_SCHEMA)) {
        this.set(key, SETTINGS_SCHEMA[key].default);
      }
    },
    // fn(key, value) after any change.
    onChange: (fn) => listeners.push(fn),
  };
}

// Build the Settings dialog's controls inside `container`.
export function renderSettingsForm(container, settings) {
  container.textContent = '';
  for (const [key, spec] of Object.entries(SETTINGS_SCHEMA)) {
    const label = document.createElement('label');
    label.className = 'setting-row';
    const name = document.createElement('span');
    name.textContent = spec.label;
    label.appendChild(name);
    if (spec.type === 'choice') {
      const select = document.createElement('select');
      select.dataset.setting = key;
      for (const [value, text] of spec.choices) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = text;
        select.appendChild(opt);
      }
      select.value = settings.get(key);
      select.addEventListener('change', () => settings.set(key, select.value));
      label.appendChild(select);
    } else {
      const wrap = document.createElement('span');
      wrap.className = 'setting-range';
      const input = document.createElement('input');
      input.type = 'range';
      input.dataset.setting = key;
      input.min = spec.min;
      input.max = spec.max;
      input.step = spec.step;
      input.value = settings.get(key);
      const out = document.createElement('output');
      out.textContent = settings.get(key);
      input.addEventListener('input', () => {
        settings.set(key, input.value);
        out.textContent = settings.get(key);
      });
      wrap.appendChild(input);
      wrap.appendChild(out);
      label.appendChild(wrap);
    }
    container.appendChild(label);
  }
}
