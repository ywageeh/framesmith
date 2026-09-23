// Auto-trim: find the rectangle left after shaving off uniform borders
// (the empty desktop or page margin around most screenshots).

const close = (d, i, ref, tol) =>
  Math.abs(d[i] - ref[0]) <= tol &&
  Math.abs(d[i + 1] - ref[1]) <= tol &&
  Math.abs(d[i + 2] - ref[2]) <= tol &&
  Math.abs(d[i + 3] - ref[3]) <= tol;

/**
 * @param {Uint8ClampedArray} data RGBA pixels
 * @returns {{x:number,y:number,w:number,h:number}} crop rect (whole image when nothing to trim)
 */
export function findTrim(data, w, h, tol = 10) {
  const px = (x, y) => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };
  const rowUniform = (y, ref) => {
    for (let x = 0; x < w; x++) if (!close(data, (y * w + x) * 4, ref, tol)) return false;
    return true;
  };
  const colUniform = (x, ref, y0, y1) => {
    for (let y = y0; y <= y1; y++) if (!close(data, (y * w + x) * 4, ref, tol)) return false;
    return true;
  };

  const tl = px(0, 0);
  const br = px(w - 1, h - 1);
  let top = 0;
  while (top < h - 1 && rowUniform(top, tl)) top++;
  let bottom = h - 1;
  while (bottom > top && rowUniform(bottom, br)) bottom--;
  let left = 0;
  while (left < w - 1 && colUniform(left, tl, top, bottom)) left++;
  let right = w - 1;
  while (right > left && colUniform(right, br, top, bottom)) right--;

  // A fully uniform image, or a trim that would leave a sliver, isn't a trim.
  if (right - left < 8 || bottom - top < 8) return { x: 0, y: 0, w, h };
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}
