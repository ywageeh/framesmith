// A procedurally drawn sample screenshot so the editor is never empty on first visit.

/** Annotations that ship with the sample, in its 1600×1000 pixel space. */
export function demoAnnotations() {
  return [
    { id: 'demo-label', type: 'text', x: 1118, y: 356, text: 'Best month yet', color: '#ff4d2e', size: 'm' },
    { id: 'demo-arrow', type: 'arrow', x1: 1350, y1: 424, x2: 1494, y2: 476, color: '#ff4d2e', size: 'm' },
  ];
}

const F = '"Geist", system-ui, sans-serif';

export function demoShot() {
  const W = 1600;
  const H = 1000;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d');
  const text = (t, px, py, size, color, weight = 500, align = 'left') => {
    x.font = `${weight} ${size}px ${F}`;
    x.fillStyle = color;
    x.textAlign = align;
    x.textBaseline = 'alphabetic';
    x.fillText(t, px, py);
  };
  const box = (px, py, w, h, r, fill, stroke) => {
    x.beginPath();
    x.roundRect(px, py, w, h, r);
    if (fill) {
      x.fillStyle = fill;
      x.fill();
    }
    if (stroke) {
      x.strokeStyle = stroke;
      x.lineWidth = 1.5;
      x.stroke();
    }
  };

  x.fillStyle = '#fbfaf8';
  x.fillRect(0, 0, W, H);

  // Sidebar.
  x.fillStyle = '#f2f0ec';
  x.fillRect(0, 0, 280, H);
  x.fillStyle = '#e4e0d9';
  x.fillRect(279, 0, 1, H);
  box(32, 36, 36, 36, 10, '#1f6f5c');
  text('Tally', 84, 62, 22, '#1d1c1a', 650);
  const nav = ['Overview', 'Customers', 'Invoices', 'Subscriptions', 'Payouts', 'Settings'];
  nav.forEach((n, i) => {
    const y = 128 + i * 52;
    if (i === 0) box(20, y - 30, 240, 44, 10, '#ffffff', '#e4e0d9');
    box(40, y - 16, 16, 16, 4, i === 0 ? '#1f6f5c' : '#cfc9bf');
    text(n, 72, y - 2, 17, i === 0 ? '#1d1c1a' : '#6b655d', i === 0 ? 600 : 500);
  });
  box(20, H - 100, 240, 68, 12, '#ffffff', '#e4e0d9');
  x.beginPath();
  x.arc(56, H - 66, 18, 0, Math.PI * 2);
  x.fillStyle = '#f0b38a';
  x.fill();
  text('Maya Lindqvist', 86, H - 70, 16, '#1d1c1a', 600);
  text('Owner', 86, H - 48, 14, '#8a847b');

  // Header.
  text('Overview', 332, 92, 34, '#1d1c1a', 650);
  text('Last 30 days · updated just now', 332, 124, 16, '#8a847b');
  box(1270, 58, 130, 44, 10, '#ffffff', '#e4e0d9');
  text('Export', 1335, 86, 16, '#1d1c1a', 600, 'center');
  box(1414, 58, 150, 44, 10, '#1f6f5c');
  text('New invoice', 1489, 86, 16, '#ffffff', 600, 'center');

  // KPI cards.
  const kpis = [
    ['Revenue', '$48,210', '+12.4%'],
    ['Active subscribers', '1,284', '+86'],
    ['Churn', '1.9%', '−0.4 pts'],
  ];
  kpis.forEach(([label, value, delta], i) => {
    const px = 332 + i * 416;
    box(px, 160, 396, 150, 16, '#ffffff', '#e8e4dd');
    text(label, px + 28, 204, 16, '#8a847b', 500);
    text(value, px + 28, 262, 42, '#1d1c1a', 650);
    box(px + 28, 276, 92, 26, 13, '#e3f1ec');
    text(delta, px + 74, 294, 14, '#1f6f5c', 600, 'center');
  });

  // Chart.
  box(332, 332, 1232, 380, 16, '#ffffff', '#e8e4dd');
  text('Monthly recurring revenue', 360, 378, 19, '#1d1c1a', 600);
  text('$41.2k → $48.2k', 360, 404, 15, '#8a847b');
  const pts = [0.3, 0.34, 0.31, 0.42, 0.46, 0.44, 0.52, 0.58, 0.55, 0.63, 0.7, 0.68, 0.78, 0.83];
  const cx0 = 372;
  const cx1 = 1524;
  const cy0 = 680;
  const ch = 230;
  x.strokeStyle = '#efece6';
  x.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const y = cy0 - (ch / 3) * i;
    x.beginPath();
    x.moveTo(cx0, y);
    x.lineTo(cx1, y);
    x.stroke();
  }
  const px = (i) => cx0 + ((cx1 - cx0) / (pts.length - 1)) * i;
  const py = (v) => cy0 - v * ch;
  x.beginPath();
  pts.forEach((v, i) => {
    if (!i) x.moveTo(px(i), py(v));
    else {
      const mx = (px(i - 1) + px(i)) / 2;
      x.bezierCurveTo(mx, py(pts[i - 1]), mx, py(v), px(i), py(v));
    }
  });
  x.save();
  x.lineTo(cx1, cy0);
  x.lineTo(cx0, cy0);
  x.closePath();
  const g = x.createLinearGradient(0, cy0 - ch, 0, cy0);
  g.addColorStop(0, 'rgba(31,111,92,0.22)');
  g.addColorStop(1, 'rgba(31,111,92,0)');
  x.fillStyle = g;
  x.fill();
  x.restore();
  x.beginPath();
  pts.forEach((v, i) => {
    if (!i) x.moveTo(px(i), py(v));
    else {
      const mx = (px(i - 1) + px(i)) / 2;
      x.bezierCurveTo(mx, py(pts[i - 1]), mx, py(v), px(i), py(v));
    }
  });
  x.strokeStyle = '#1f6f5c';
  x.lineWidth = 3.5;
  x.stroke();
  const last = pts.length - 1;
  x.beginPath();
  x.arc(px(last), py(pts[last]), 7, 0, Math.PI * 2);
  x.fillStyle = '#ffffff';
  x.fill();
  x.lineWidth = 3.5;
  x.stroke();

  // Table.
  box(332, 734, 1232, 236, 16, '#ffffff', '#e8e4dd');
  const rows = [
    ['Northwind Studio', 'Pro · yearly', '$2,400', 'Paid'],
    ['Juniper & Co', 'Team · monthly', '$480', 'Paid'],
    ['Okafor Labs', 'Pro · monthly', '$240', 'Due'],
  ];
  ['Customer', 'Plan', 'Amount', 'Status'].forEach((h, i) =>
    text(h, 360 + [0, 440, 800, 1060][i], 776, 14, '#8a847b', 600),
  );
  rows.forEach((r, j) => {
    const y = 834 + j * 50;
    x.fillStyle = '#f1eee9';
    x.fillRect(360, y - 34, 1176, 1);
    r.slice(0, 3).forEach((v, i) => text(v, 360 + [0, 440, 800, 1060][i], y, 17, i === 0 ? '#1d1c1a' : '#57524b', i === 0 ? 600 : 500));
    const paid = r[3] === 'Paid';
    box(1412, y - 22, 64, 30, 15, paid ? '#e3f1ec' : '#fdeede');
    text(r[3], 1444, y - 1, 14, paid ? '#1f6f5c' : '#b4570f', 600, 'center');
  });

  return c;
}
