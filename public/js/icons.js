export const ICONS = {
  spine: '<path d="M12 2v20M8 6h8M7 10h10M8 14h8M9 18h6"/>',
  sport: '<circle cx="12" cy="5" r="2"/><path d="M12 7v6l-4 8M12 13l4 8M6 10h12"/>',
  pulse: '<path d="M4 12h4l2-6 4 12 2-6h4"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8a8 8 0 0 0 16 0v-2a2 2 0 0 0-4 0"/>',
  bolt: '<path d="M13 2 3 14h7l-1 8 10-12h-7z"/>',
  child: '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10Z"/><path d="M2 21c0-3 1.9-5.4 5.1-6"/>',
};

export const ICON_LABELS = {
  spine: 'Chrbtica', sport: 'Šport', pulse: 'Diagnostika', hand: 'Manuálna terapia',
  bolt: 'Prístroj', child: 'Deti', heart: 'Srdce', leaf: 'Relax',
};

export const icon = (key, size = 28) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[key] || ICONS.hand}</svg>`;
