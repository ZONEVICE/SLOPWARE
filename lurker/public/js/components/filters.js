/**
 * The advanced filter panel: file type, date, size, shape, video length,
 * camera and a few switches. Every change applies immediately (and lands in
 * the URL through the shell); the panel only reads and reports filters.
 */
import { debounce, h } from '../core/dom.js';
import { number, toDateInput, todayWall } from '../core/format.js';
import { icon } from '../core/icons.js';
import { DATE_BASES, DEFAULT_FILTERS } from '../core/query.js';

const UNITS = [
  { key: 'KB', factor: 1024 },
  { key: 'MB', factor: 1024 ** 2 },
  { key: 'GB', factor: 1024 ** 3 },
];

function splitBytes(value) {
  if (value === null) return { amount: '', unit: 'MB' };
  const unit = value >= 1024 ** 3 && value % 1024 ** 3 === 0 ? UNITS[2] : value >= 1024 ** 2 ? UNITS[1] : UNITS[0];
  return { amount: String(+(value / unit.factor).toFixed(2)), unit: unit.key };
}

/** "90", "1:30" or "1:02:03" -> seconds; "" -> null. */
export function parseDuration(text) {
  const value = (text || '').trim();
  if (!value) return null;
  if (!/^\d+(:\d{1,2}){0,2}$/.test(value)) return NaN;
  return value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

function formatDurationInput(seconds) {
  if (seconds === null) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}:${String(s).padStart(2, '0')}` : String(s);
}

/**
 * @param {{ onChange: (patch) => void, onClose: () => void }} handlers
 */
export function createFilterPanel({ onChange, onClose }) {
  const body = h('div', { class: 'body' });
  const panel = h(
    'aside',
    { class: 'filters', 'aria-label': 'Filters' },
    h(
      'header',
      {},
      h('h2', { text: 'Filters' }),
      h('button', { type: 'button', class: 'icon-btn', title: 'Close filters', 'aria-label': 'Close filters', onClick: onClose }, icon('x', { size: 18 })),
    ),
    body,
    h(
      'footer',
      {},
      h('button', { type: 'button', class: 'btn', onClick: () => onChange(advancedDefaults()) }, 'Reset'),
      h('button', { type: 'button', class: 'btn primary', onClick: onClose }, 'Done'),
    ),
  );
  const backdrop = h('div', { class: 'sheet-backdrop', onClick: onClose });

  let current = { ...DEFAULT_FILTERS };

  const section = (title, action, ...children) =>
    h('section', {}, h('h3', {}, h('span', { text: title }), action || null), ...children);

  const clearButton = (active, patch) =>
    active ? h('button', { type: 'button', text: 'Clear', onClick: () => onChange(patch) }) : null;

  function render(filters, facts) {
    current = filters;
    const focused = document.activeElement && body.contains(document.activeElement) ? document.activeElement.dataset.field : null;
    const sections = [];

    // --- Type ---------------------------------------------------------------
    const types = new Set(filters.types);
    const groups = [
      { kind: 'image', name: 'Images' },
      { kind: 'video', name: 'Videos' },
    ].map((group) => {
      const formats = facts.formats.filter((format) => format.kind === group.kind && facts.formatCounts.get(format.key));
      if (!formats.length) return null;
      formats.sort((a, b) => facts.formatCounts.get(b.key) - facts.formatCounts.get(a.key));
      return h(
        'div',
        { class: 'type-group' },
        h('div', { class: 'group-name', text: group.name }),
        formats.map((format) =>
          h(
            'label',
            { class: 'check', title: format.extensions.map((ext) => `.${ext}`).join(' ') },
            h('input', {
              type: 'checkbox',
              checked: types.has(format.key),
              dataset: { field: `type-${format.key}` },
              onChange: (event) => {
                const next = new Set(current.types);
                if (event.target.checked) next.add(format.key);
                else next.delete(format.key);
                onChange({ types: [...next] });
              },
            }),
            h('span', { text: format.label }),
            h('span', { class: 'count', text: number(facts.formatCounts.get(format.key)) }),
          ),
        ),
      );
    });
    sections.push(
      section(
        'File type',
        clearButton(types.size > 0, { types: [] }),
        h('p', { class: 'muted', text: types.size ? 'Only the checked types are shown.' : 'Check types to show only those.' }),
        ...groups.filter(Boolean),
      ),
    );

    // --- Date ---------------------------------------------------------------------
    const dateInput = (field, value) =>
      h('input', {
        type: 'date',
        class: 'input',
        value,
        dataset: { field },
        onChange: (event) => onChange({ [field]: event.target.value }),
      });
    const today = todayWall();
    const startOfYear = Date.UTC(new Date(today * 1000).getUTCFullYear(), 0, 1) / 1000;
    const presets = [
      { label: 'Today', from: today, to: today },
      { label: 'Last 7 days', from: today - 6 * 86400, to: today },
      { label: 'Last 30 days', from: today - 29 * 86400, to: today },
      { label: 'This year', from: startOfYear, to: today },
      { label: 'Last year', from: Date.UTC(new Date(today * 1000).getUTCFullYear() - 1, 0, 1) / 1000, to: startOfYear - 86400 },
    ];
    sections.push(
      section(
        'Date',
        clearButton(Boolean(filters.from || filters.to), { from: '', to: '' }),
        h(
          'label',
          { class: 'field' },
          h('span', { text: 'Which date' }),
          h(
            'select',
            { class: 'select', dataset: { field: 'dateBasis' }, onChange: (event) => onChange({ dateBasis: event.target.value }) },
            DATE_BASES.map((basis) => h('option', { value: basis.key, selected: basis.key === filters.dateBasis, text: basis.label })),
          ),
        ),
        h(
          'div',
          { class: 'pair' },
          h('label', { class: 'field' }, h('span', { text: 'From' }), dateInput('from', filters.from)),
          h('label', { class: 'field' }, h('span', { text: 'To' }), dateInput('to', filters.to)),
        ),
        h(
          'div',
          { class: 'presets' },
          presets.map((preset) =>
            h('button', {
              type: 'button',
              class: 'chip link',
              text: preset.label,
              onClick: () => onChange({ from: toDateInput(preset.from), to: toDateInput(preset.to) }),
            }),
          ),
        ),
        facts.dateRange
          ? h('p', { class: 'muted', text: `This album spans ${facts.dateRange}.` })
          : null,
      ),
    );

    // --- Size ---------------------------------------------------------------------
    const sizeField = (field, label) => {
      const parts = splitBytes(filters[field]);
      const amount = h('input', { type: 'number', min: '0', step: 'any', class: 'input', value: parts.amount, placeholder: 'Any', dataset: { field } });
      const unit = h('select', { class: 'select', dataset: { field: `${field}-unit` } }, UNITS.map((u) => h('option', { value: u.key, selected: u.key === parts.unit, text: u.key })));
      const commit = () => {
        const value = parseFloat(amount.value);
        const factor = UNITS.find((u) => u.key === unit.value).factor;
        onChange({ [field]: Number.isFinite(value) && value >= 0 ? Math.round(value * factor) : null });
      };
      const later = debounce(commit, 500);
      amount.addEventListener('input', later);
      amount.addEventListener('change', () => {
        later.cancel();
        commit();
      });
      unit.addEventListener('change', commit);
      return h('label', { class: 'field' }, h('span', { text: label }), h('div', { class: 'input-group' }, amount, unit));
    };
    const MB = 1024 ** 2;
    sections.push(
      section(
        'File size',
        clearButton(filters.minSize !== null || filters.maxSize !== null, { minSize: null, maxSize: null }),
        h('div', { class: 'pair' }, sizeField('minSize', 'At least'), sizeField('maxSize', 'At most')),
        h(
          'div',
          { class: 'presets' },
          [
            { label: 'Under 1 MB', min: null, max: MB },
            { label: '1–10 MB', min: MB, max: 10 * MB },
            { label: '10–100 MB', min: 10 * MB, max: 100 * MB },
            { label: 'Over 100 MB', min: 100 * MB, max: null },
          ].map((preset) =>
            h('button', { type: 'button', class: 'chip link', text: preset.label, onClick: () => onChange({ minSize: preset.min, maxSize: preset.max }) }),
          ),
        ),
      ),
    );

    // --- Shape --------------------------------------------------------------------
    const orientations = [
      { key: '', label: 'Any' },
      { key: 'landscape', label: 'Landscape' },
      { key: 'portrait', label: 'Portrait' },
      { key: 'square', label: 'Square' },
      { key: 'panorama', label: 'Panorama' },
    ];
    sections.push(
      section(
        'Shape and resolution',
        clearButton(Boolean(filters.orientation) || filters.minMegapixels !== null, { orientation: '', minMegapixels: null }),
        h(
          'div',
          { class: 'presets' },
          orientations.map((option) =>
            h('button', {
              type: 'button',
              class: 'chip link',
              'aria-pressed': String(filters.orientation === option.key),
              text: option.label,
              onClick: () => onChange({ orientation: option.key }),
            }),
          ),
        ),
        h(
          'label',
          { class: 'field' },
          h('span', { text: 'Minimum resolution' }),
          h(
            'select',
            {
              class: 'select',
              dataset: { field: 'minMegapixels' },
              onChange: (event) => onChange({ minMegapixels: event.target.value ? Number(event.target.value) : null }),
            },
            [
              { value: '', label: 'Any' },
              { value: '0.9', label: 'HD (about 1 MP)' },
              { value: '2', label: 'Full HD (2 MP)' },
              { value: '8', label: '4K (8 MP)' },
              { value: '12', label: '12 MP' },
              { value: '24', label: '24 MP' },
            ].map((option) =>
              h('option', { value: option.value, selected: String(filters.minMegapixels ?? '') === option.value, text: option.label }),
            ),
          ),
        ),
      ),
    );

    // --- Video length ----------------------------------------------------------------
    const durationField = (field, label) => {
      const input = h('input', {
        type: 'text',
        inputmode: 'numeric',
        class: 'input',
        placeholder: 'm:ss',
        value: formatDurationInput(filters[field]),
        dataset: { field },
      });
      const commit = () => {
        const seconds = parseDuration(input.value);
        if (Number.isNaN(seconds)) {
          input.setCustomValidity('Use seconds (90) or minutes:seconds (1:30).');
          input.reportValidity();
          return;
        }
        input.setCustomValidity('');
        onChange({ [field]: seconds });
      };
      input.addEventListener('change', commit);
      return h('label', { class: 'field' }, h('span', { text: label }), input);
    };
    if (facts.hasVideos) {
      sections.push(
        section(
          'Video length',
          clearButton(filters.minDuration !== null || filters.maxDuration !== null, { minDuration: null, maxDuration: null }),
          h('div', { class: 'pair' }, durationField('minDuration', 'At least'), durationField('maxDuration', 'At most')),
          h(
            'div',
            { class: 'presets' },
            [
              { label: 'Under 30 s', min: null, max: 30 },
              { label: '30 s – 5 min', min: 30, max: 300 },
              { label: 'Over 5 min', min: 300, max: null },
            ].map((preset) =>
              h('button', { type: 'button', class: 'chip link', text: preset.label, onClick: () => onChange({ minDuration: preset.min, maxDuration: preset.max }) }),
            ),
          ),
        ),
      );
    }

    // --- Camera ---------------------------------------------------------------------
    if (facts.cameras.length) {
      sections.push(
        section(
          'Camera',
          clearButton(Boolean(filters.camera), { camera: '' }),
          h(
            'select',
            { class: 'select', dataset: { field: 'camera' }, onChange: (event) => onChange({ camera: event.target.value }) },
            h('option', { value: '', text: 'Any camera' }),
            facts.cameras.map(([name, count]) => h('option', { value: name, selected: name === filters.camera, text: `${name} (${number(count)})` })),
          ),
        ),
      );
    }

    // --- Switches --------------------------------------------------------------------
    const toggle = (field, label, hint) =>
      h(
        'label',
        { class: 'switch', title: hint },
        h('span', { text: label }),
        h('input', { type: 'checkbox', checked: filters[field], dataset: { field }, onChange: (event) => onChange({ [field]: event.target.checked }) }),
      );
    sections.push(
      section(
        'More',
        null,
        toggle('hidden', 'Hidden files and folders', 'Names starting with a dot, like .thumbnails'),
        toggle('viewable', 'Only what this browser can show', 'Hides RAW, HEIC, AVI and other formats this browser cannot display'),
        facts.hasAnimated ? toggle('animated', 'Only animated images', 'Animated GIF, PNG and WebP') : null,
      ),
    );

    body.replaceChildren(...sections);
    if (focused) body.querySelector(`[data-field="${focused}"]`)?.focus();
  }

  return { el: panel, backdrop, render };
}

/** The defaults of everything this panel controls (not the kind or the search, which live in the toolbar). */
export function advancedDefaults() {
  const { kind, q, ...rest } = DEFAULT_FILTERS;
  return { ...rest, types: [] };
}
