/**
 * AQUAPIX palette (retro, limited, high-contrast).
 * Few, punchy colours so the pixel art reads at a glance - a readable ball and
 * clear player caps matter more than realism.
 */
export const PAL = {
  poolDeep:   '#0a3a5c', poolMid: '#0e4e78', poolLight: '#1567a0', poolLine: '#2a86c4',
  ripple:     '#3d9bd6', foam: '#dff2ff',
  deck:       '#c9b79a', deckDark: '#a8977c', deckEdge: '#8a7a60', gutter: '#e8eef2',
  goalPost:   '#f4f7fa', goalNet: 'rgba(230,240,250,0.35)',
  ballMain:   '#ffd23f', ballDark: '#c98a12', ballHi: '#fff6cf',
  shadow:     'rgba(2,12,20,0.30)', splash: '#eaf7ff',
  lineRed:    '#e23b3b', lineYellow: '#f4c430', lineGreen: '#3fb96b',
  skin: ['#f1c9a5', '#e0ab84', '#c68d63', '#a06a45', '#7a4d31', '#5a3823'],
  hudBg: '#04121c', hudEdge: '#1f5f86', ink: '#eaf6ff', inkDim: '#7fa8c4',
  select: '#8be9fd', passLine: 'rgba(139,233,253,0.6)',
  danger: '#ff5a5a', warn: '#ffcf4d', go: '#5ef08a',
};
export const snap = (v) => Math.round(v);
