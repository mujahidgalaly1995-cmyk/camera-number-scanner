(function (global) {
    'use strict';

    function percentileFromHistogram(hist, total, fraction) {
        const target = Math.max(1, Math.floor(total * fraction));
        let acc = 0;
        for (let v = 0; v < 256; v++) {
            acc += hist[v];
            if (acc >= target) return v;
        }
        return 255;
    }

    function otsuFromHistogram(hist, total) {
        let sum = 0;
        for (let t = 0; t < 256; t++) sum += t * hist[t];

        let sumB = 0;
        let weightB = 0;
        let maxVariance = 0;
        let threshold = 135;

        for (let t = 0; t < 256; t++) {
            weightB += hist[t];
            if (weightB === 0) continue;
            const weightF = total - weightB;
            if (weightF === 0) break;
            sumB += t * hist[t];
            const meanB = sumB / weightB;
            const meanF = (sum - sumB) / weightF;
            const variance = weightB * weightF * (meanB - meanF) * (meanB - meanF);
            if (variance > maxVariance) {
                maxVariance = variance;
                threshold = t;
            }
        }
        return threshold;
    }

    // Marks pixels that are clearly darker than their local surroundings.
    // Works on paper photos where the background around the sheet is dark.
    function adaptiveBinarize(gray, width, height, radius) {
        const r = Math.max(4, radius || Math.round(Math.min(width, height) * 0.05));
        const stride = width + 1;
        const integral = new Float64Array(stride * (height + 1));

        for (let y = 0; y < height; y++) {
            let rowSum = 0;
            const rowOffset = y * width;
            const current = (y + 1) * stride;
            const previous = y * stride;
            for (let x = 0; x < width; x++) {
                rowSum += gray[rowOffset + x];
                integral[current + x + 1] = integral[previous + x + 1] + rowSum;
            }
        }

        const out = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
            const y0 = y > r ? y - r : 0;
            const y1 = y + r < height ? y + r : height - 1;
            const rowTop = y0 * stride;
            const rowBottom = (y1 + 1) * stride;
            const rowOffset = y * width;

            for (let x = 0; x < width; x++) {
                const x0 = x > r ? x - r : 0;
                const x1 = x + r < width ? x + r : width - 1;
                const area = (x1 - x0 + 1) * (y1 - y0 + 1);
                const sum = integral[rowBottom + x1 + 1] - integral[rowTop + x1 + 1]
                    - integral[rowBottom + x0] + integral[rowTop + x0];
                const mean = sum / area;
                const value = gray[rowOffset + x];
                const margin = Math.max(10, mean * 0.16);
                if (value < mean - margin) out[rowOffset + x] = 1;
            }
        }

        return out;
    }

    // Finds the dominant line of dark text inside a binarized strip (1 = dark).
    // When focusX is given and the line holds more than one number, only the
    // number nearest that x is returned (the one the user aimed at).
    function findTextRegion(binary, width, height, focusX) {
        // Drop isolated specks (paper grain, sensor noise, camera blur) so faint
        // noise does not form rows that swallow the whole strip.
        const clean = new Uint8Array(binary.length);
        for (let y = 0; y < height; y++) {
            const row = y * width;
            const up = y > 0 ? row - width : -1;
            const down = y < height - 1 ? row + width : -1;
            for (let x = 0; x < width; x++) {
                const i = row + x;
                if (!binary[i]) continue;
                let neighbours = 0;
                if (x > 0 && binary[i - 1]) neighbours++;
                if (x < width - 1 && binary[i + 1]) neighbours++;
                if (up >= 0) {
                    if (binary[up + x]) neighbours++;
                    if (x > 0 && binary[up + x - 1]) neighbours++;
                    if (x < width - 1 && binary[up + x + 1]) neighbours++;
                }
                if (down >= 0) {
                    if (binary[down + x]) neighbours++;
                    if (x > 0 && binary[down + x - 1]) neighbours++;
                    if (x < width - 1 && binary[down + x + 1]) neighbours++;
                }
                if (neighbours >= 2) clean[i] = 1;
            }
        }

        // Table rules, paper edges and borders are long uninterrupted runs;
        // remove them so they cannot outvote the actual text line.
        const maxRun = Math.max(12, Math.round(width * 0.35));
        for (let y = 0; y < height; y++) {
            const row = y * width;
            let x = 0;
            while (x < width) {
                while (x < width && !clean[row + x]) x++;
                const start = x;
                while (x < width && clean[row + x]) x++;
                if (x - start >= maxRun) {
                    for (let i = start; i < x; i++) clean[row + i] = 0;
                }
            }
        }
        const maxVRun = Math.max(10, Math.round(height * 0.6));
        for (let x = 0; x < width; x++) {
            let y = 0;
            while (y < height) {
                while (y < height && !clean[y * width + x]) y++;
                const start = y;
                while (y < height && clean[y * width + x]) y++;
                if (y - start >= maxVRun) {
                    for (let i = start; i < y; i++) clean[i * width + x] = 0;
                }
            }
        }

        const rowCounts = new Uint32Array(height);
        for (let y = 0; y < height; y++) {
            const offset = y * width;
            let count = 0;
            for (let x = 0; x < width; x++) {
                if (clean[offset + x]) count++;
            }
            rowCounts[y] = count;
        }

        // Smooth rows so single stray rows cannot break a text line apart.
        const smooth = new Float64Array(height);
        let maxRow = 0;
        for (let y = 0; y < height; y++) {
            const a = rowCounts[y > 0 ? y - 1 : 0];
            const b = rowCounts[y];
            const c = rowCounts[y < height - 1 ? y + 1 : height - 1];
            smooth[y] = (a + b * 2 + c) / 4;
            if (smooth[y] > maxRow) maxRow = smooth[y];
        }

        if (maxRow < 3) return null;

        // Rows belonging to real text are a sizeable fraction of the strongest
        // row; everything gentler is background noise.
        const low = Math.max(2, Math.round(maxRow * 0.1));
        const high = Math.max(low + 1, Math.round(maxRow * 0.32));

        let best = null;
        let y = 0;

        while (y < height) {
            while (y < height && smooth[y] < high) y++;
            if (y >= height) break;

            let start = y;
            while (start > 0 && smooth[start - 1] >= low) start--;

            let end = y;
            while (end < height && smooth[end] >= low) end++;

            let total = 0;
            for (let yy = start; yy < end; yy++) total += rowCounts[yy];

            const bandHeight = end - start;
            if (bandHeight >= 3) {
                const center = start + bandHeight / 2;
                const centerBias = 1 - 0.15 * (Math.abs(center - height / 2) / (height / 2 || 1));
                const score = total * centerBias;
                if (!best || score > best.score) {
                    best = { top: start, bottom: end, score };
                }
            }

            y = end;
            while (y < height && smooth[y] < high) y++;
        }

        if (!best) return null;

        const bandHeight = best.bottom - best.top;
        const columnCounts = new Uint32Array(width);
        for (let yy = best.top; yy < best.bottom; yy++) {
            const offset = yy * width;
            for (let x = 0; x < width; x++) {
                if (clean[offset + x]) columnCounts[x]++;
            }
        }

        const minColumnPixels = Math.max(2, Math.round(bandHeight * 0.08));
        const minRunWidth = Math.max(3, Math.round(bandHeight * 0.06));
        const runs = [];
        let x = 0;

        while (x < width) {
            while (x < width && columnCounts[x] < minColumnPixels) x++;
            const start = x;
            while (x < width && columnCounts[x] >= minColumnPixels) x++;
            const runWidth = x - start;
            if (runWidth >= minRunWidth) runs.push({ left: start, right: x - 1 });
        }

        if (!runs.length) return null;

        // Glyphs belonging to one number sit close together; a gap about as
        // tall as the line separates two different numbers (table cells).
        const numberGap = Math.max(6, Math.round(bandHeight * 0.8));
        const groups = [];
        for (const run of runs) {
            const prev = groups[groups.length - 1];
            if (prev && run.left - prev.right - 1 < numberGap) prev.right = run.right;
            else groups.push({ left: run.left, right: run.right });
        }

        let left = groups[0].left;
        let right = groups[groups.length - 1].right;

        if (focusX > 0) {
            // Short specks are never numbers; only digit-sized blocks compete.
            const blocks = groups.filter((g) => g.right - g.left + 1 >= bandHeight * 0.35);
            if (blocks.length > 1) {
                let chosen = blocks[0];
                let bestDist = Infinity;
                for (const g of blocks) {
                    const dist = Math.abs((g.left + g.right) / 2 - focusX);
                    if (dist < bestDist) {
                        bestDist = dist;
                        chosen = g;
                    }
                }
                left = chosen.left;
                right = chosen.right;
            }
        }

        return {
            left,
            top: best.top,
            width: right - left + 1,
            height: bandHeight,
        };
    }

    function normalizeDigits(text) {
        return text
            .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
            .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
            .replace(/[٬،]/g, ',')
            .replace(/٫/g, '.');
    }

    // Turns one OCR token such as "1.234,56" into a number.
    function parseToken(raw) {
        const s = raw.replace(/[^\d.,]/g, '').replace(/^[.,]+/, '').replace(/[.,]+$/, '');
        if (!/\d/.test(s)) return null;

        const hasDot = s.includes('.');
        const hasComma = s.includes(',');
        let decimalSep = null;

        if (hasDot && hasComma) {
            // The separator that appears last is the decimal one.
            decimalSep = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
        } else if (hasDot) {
            const groups = s.split('.');
            if (groups.length === 2) {
                // 45.250 is a printed thousands label, 12.5 is a decimal.
                decimalSep = groups[1].length <= 2 ? '.' : null;
            }
        } else if (hasComma) {
            const groups = s.split(',');
            if (groups.length === 2) {
                decimalSep = groups[1].length <= 2 ? ',' : null;
            }
        }

        let intPart;
        let fracPart = '';
        if (decimalSep) {
            const idx = s.lastIndexOf(decimalSep);
            intPart = s.slice(0, idx).replace(/[.,]/g, '');
            fracPart = s.slice(idx + 1).replace(/[.,]/g, '');
        } else {
            intPart = s.replace(/[.,]/g, '');
        }
        if (!intPart) return null;

        const value = parseFloat(fracPart ? `${intPart}.${fracPart}` : intPart);
        if (!Number.isFinite(value) || value <= 0) return null;

        return { value, digits: intPart.length + fracPart.length };
    }

    // Parses the most plausible positive number out of OCR output.
    function parseNumber(text) {
        if (!text) return null;
        let normalized = normalizeDigits(text);
        // OCR often inserts spaces around separators or in place of them.
        normalized = normalized
            .replace(/\s+([.,])/g, '$1')
            .replace(/([.,])\s+/g, '$1')
            .replace(/(\d)[ \t\u00a0]+(?=\d)/g, '$1');

        const matches = normalized.match(/\d[\d.,]*\d|\d/g) || [];

        let best = null;
        for (const match of matches) {
            const parsed = parseToken(match);
            if (!parsed) continue;
            if (!best || parsed.digits > best.digits) best = parsed;
        }

        return best ? best.value : null;
    }

    // ---------- Arabic-Indic digits ----------
    // Small classifier for ٠١٢٣٤٥٦٧٨٩, which the bundled Tesseract models do
    // not read. Weights are in arabic-digit-model.js; features are the
    // normalized glyph plus gradient histograms and hole/density geometry.
    const AR_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
    let arNet = null;

    function arDecodeBase64(b64) {
        if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64');
        const raw = atob(b64);
        const out = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
    }

    function arLoadNet() {
        if (arNet) return arNet;
        const model = global.ArabicDigitModel;
        if (!model) return null;

        const size = model.size;
        const hidden = model.hidden;
        const classes = model.classes;
        const hogCells = model.hogCells;
        const hogBins = model.hogBins;
        const inSize = size * size;
        const hogSize = hogCells * hogCells * hogBins;
        const featSize = inSize + hogSize + 3;

        const bytes = arDecodeBase64(model.weights);
        const q = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length);
        const counts = [featSize * hidden, hidden, hidden * classes, classes];
        const parts = [];
        let off = 0;
        for (let t = 0; t < counts.length; t++) {
            const part = q.subarray(off, off + counts[t]);
            off += counts[t];
            const scale = model.scales[t];
            const deq = new Float32Array(part.length);
            for (let i = 0; i < part.length; i++) deq[i] = part[i] * scale;
            parts.push(deq);
        }

        arNet = {
            size,
            hidden,
            classes,
            hogCells,
            hogBins,
            inSize,
            hogSize,
            featSize,
            W1: parts[0],
            b1: parts[1],
            W2: parts[2],
            b2: parts[3],
        };
        return arNet;
    }

    function arExtractFeatures(net, patch) {
        const size = net.size;
        const feats = new Float32Array(net.featSize);
        feats.set(patch, 0);
        const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

        const hog = new Float32Array(net.hogSize);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const gx = patch[y * size + clamp(x + 1, 0, size - 1)] - patch[y * size + clamp(x - 1, 0, size - 1)];
                const gy = patch[clamp(y + 1, 0, size - 1) * size + x] - patch[clamp(y - 1, 0, size - 1) * size + x];
                const mag = Math.hypot(gx, gy);
                if (mag < 0.04) continue;
                let ang = Math.atan2(gy, gx);
                if (ang < 0) ang += Math.PI * 2;
                const binPos = (ang / (Math.PI * 2)) * net.hogBins;
                const b0 = Math.floor(binPos) % net.hogBins;
                const b1 = (b0 + 1) % net.hogBins;
                const frac = binPos - Math.floor(binPos);
                const cellX = Math.min(net.hogCells - 1, Math.floor((x * net.hogCells) / size));
                const cellY = Math.min(net.hogCells - 1, Math.floor((y * net.hogCells) / size));
                const base = (cellY * net.hogCells + cellX) * net.hogBins;
                hog[base + b0] += mag * (1 - frac);
                hog[base + b1] += mag * frac;
            }
        }
        for (let c = 0; c < net.hogCells * net.hogCells; c++) {
            let norm = 0;
            for (let b = 0; b < net.hogBins; b++) norm += hog[c * net.hogBins + b] * hog[c * net.hogBins + b];
            norm = Math.sqrt(norm) + 1e-4;
            for (let b = 0; b < net.hogBins; b++) feats[net.inSize + c * net.hogBins + b] = hog[c * net.hogBins + b] / norm;
        }

        const ink = new Uint8Array(net.inSize);
        let inkCount = 0;
        let minX = size, maxX = -1, minY = size, maxY = -1;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                if (patch[y * size + x] > 0.5) {
                    ink[y * size + x] = 1;
                    inkCount++;
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }

        let holes = 0;
        const seen = new Uint8Array(net.inSize);
        for (let start = 0; start < net.inSize; start++) {
            if (ink[start] || seen[start]) continue;
            const stack = [start];
            seen[start] = 1;
            let border = false;
            let sizePx = 0;
            while (stack.length) {
                const idx = stack.pop();
                sizePx++;
                const cx = idx % size;
                const cy = (idx / size) | 0;
                if (cx === 0 || cy === 0 || cx === size - 1 || cy === size - 1) border = true;
                if (cx > 0 && !ink[idx - 1] && !seen[idx - 1]) { seen[idx - 1] = 1; stack.push(idx - 1); }
                if (cx < size - 1 && !ink[idx + 1] && !seen[idx + 1]) { seen[idx + 1] = 1; stack.push(idx + 1); }
                if (cy > 0 && !ink[idx - size] && !seen[idx - size]) { seen[idx - size] = 1; stack.push(idx - size); }
                if (cy < size - 1 && !ink[idx + size] && !seen[idx + size]) { seen[idx + size] = 1; stack.push(idx + size); }
            }
            if (!border && sizePx >= 3) holes++;
        }

        const bw = Math.max(1, maxX - minX + 1);
        const bh = Math.max(1, maxY - minY + 1);
        feats[net.inSize + net.hogSize] = Math.min(1, holes / 2);
        feats[net.inSize + net.hogSize + 1] = inkCount / net.inSize;
        feats[net.inSize + net.hogSize + 2] = Math.min(2, bw / bh) / 2;
        return feats;
    }

    function arClassify(net, patch) {
        const feats = arExtractFeatures(net, patch);
        const hidden = new Float32Array(net.hidden);
        for (let j = 0; j < net.hidden; j++) {
            let sum = net.b1[j];
            for (let i = 0; i < net.featSize; i++) sum += feats[i] * net.W1[i * net.hidden + j];
            hidden[j] = sum > 0 ? sum : 0;
        }
        const probs = new Float32Array(net.classes);
        let max = -Infinity;
        for (let k = 0; k < net.classes; k++) {
            let sum = net.b2[k];
            for (let j = 0; j < net.hidden; j++) sum += hidden[j] * net.W2[j * net.classes + k];
            probs[k] = sum;
            if (sum > max) max = sum;
        }
        let denom = 0;
        for (let k = 0; k < net.classes; k++) { probs[k] = Math.exp(probs[k] - max); denom += probs[k]; }
        for (let k = 0; k < net.classes; k++) probs[k] /= denom;

        let best = 0;
        let second = 1;
        if (probs[1] > probs[0]) { best = 1; second = 0; }
        for (let k = 2; k < net.classes; k++) {
            if (probs[k] > probs[best]) { second = best; best = k; }
            else if (probs[k] > probs[second]) second = k;
        }
        return { best, prob: probs[best], margin: probs[best] - probs[second] };
    }

    // Fits the component into a square patch, ink coverage in [0, 1].
    function arGlyphPatch(binary, width, comp) {
        const net = arLoadNet();
        const size = net.size;
        const inner = size - 2;
        const bw = comp.width;
        const bh = comp.height;
        const scale = Math.min(inner / bw, inner / bh);
        const tw = Math.max(1, Math.round(bw * scale));
        const th = Math.max(1, Math.round(bh * scale));
        const offX = Math.floor((size - tw) / 2);
        const offY = Math.floor((size - th) / 2);
        const patch = new Float32Array(size * size);

        for (let ty = 0; ty < th; ty++) {
            for (let tx = 0; tx < tw; tx++) {
                const sx = comp.left + ((tx + 0.5) * bw) / tw - 0.5;
                const sy = comp.top + ((ty + 0.5) * bh) / th - 0.5;
                const x0 = Math.floor(sx);
                const y0 = Math.floor(sy);
                const fx = sx - x0;
                const fy = sy - y0;
                let v = 0;
                for (let dy = 0; dy <= 1; dy++) {
                    for (let dx = 0; dx <= 1; dx++) {
                        const px = Math.min(comp.left + bw - 1, Math.max(comp.left, x0 + dx));
                        const py = Math.min(comp.top + bh - 1, Math.max(comp.top, y0 + dy));
                        const wt = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
                        v += (binary[py * width + px] ? 1 : 0) * wt;
                    }
                }
                patch[(offY + ty) * size + offX + tx] = v;
            }
        }
        return patch;
    }

    function arComponents(binary, width, height) {
        const labels = new Int32Array(width * height).fill(-1);
        const comps = [];
        const stack = new Int32Array(width * height);
        let nextLabel = 0;

        for (let start = 0; start < binary.length; start++) {
            if (!binary[start] || labels[start] >= 0) continue;
            const label = nextLabel++;
            labels[start] = label;
            stack[0] = start;
            let count = 1;
            let left = start % width, right = left, minY = (start / width) | 0, maxY = minY;

            while (count > 0) {
                const idx = stack[--count];
                const x = idx % width;
                const y = (idx / width) | 0;
                if (x < left) left = x;
                if (x > right) right = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;

                for (let dy = -1; dy <= 1; dy++) {
                    const ny = y + dy;
                    if (ny < 0 || ny >= height) continue;
                    for (let dx = -1; dx <= 1; dx++) {
                        if (!dx && !dy) continue;
                        const nx = x + dx;
                        if (nx < 0 || nx >= width) continue;
                        const n = ny * width + nx;
                        if (binary[n] && labels[n] < 0) {
                            labels[n] = label;
                            stack[count++] = n;
                        }
                    }
                }
            }

            comps[label] = {
                left,
                top: minY,
                width: right - left + 1,
                height: maxY - minY + 1,
                area: 0,
                bottom: maxY,
            };
        }

        // Second pass for exact areas.
        for (let i = 0; i < binary.length; i++) {
            if (binary[i] && labels[i] >= 0) comps[labels[i]].area++;
        }
        return comps.filter(Boolean);
    }

    // Reads a line of Arabic-Indic digits from a binary image (1 = ink).
    function recognizeArabicDigits(binary, width, height) {
        const net = arLoadNet();
        if (!net || width < 12 || height < 12) return null;

        const comps = arComponents(binary, width, height);
        if (!comps.length) return null;

        // Solid background blocks (paper edges, shadow bands) are never glyphs.
        // A tall thin stroke can still be a digit (١), so require width too.
        const blockWidth = width * 0.1;
        const foreground = comps.filter(
            (c) => c.area <= width * height * 0.25 && !(c.height >= height * 0.9 && c.width >= blockWidth)
        );
        if (!foreground.length) return null;

        let maxHeight = 0;
        for (const c of foreground) if (c.height > maxHeight) maxHeight = c.height;
        if (maxHeight < 10) return null;
        const minArea = Math.max(6, Math.round(maxHeight * maxHeight * 0.006));

        let glyphs = foreground.filter((c) => c.area >= minArea);
        if (!glyphs.length) return null;

        // Thin strokes can break apart at low resolution; rejoin fragments that
        // sit next to each other on the same line.
        let joined = true;
        while (joined) {
            joined = false;
            outer:
            for (let i = 0; i < glyphs.length; i++) {
                for (let j = i + 1; j < glyphs.length; j++) {
                    const a = glyphs[i];
                    const b = glyphs[j];
                    const gap = Math.max(a.left, b.left) - Math.min(a.left + a.width, b.left + b.width);
                    if (gap > maxHeight * 0.05) continue;
                    const overlapY = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
                    if (overlapY < Math.min(a.height, b.height) * 0.6) continue;
                    const left = Math.min(a.left, b.left);
                    const right = Math.max(a.left + a.width, b.left + b.width);
                    const top = Math.min(a.top, b.top);
                    const bottom = Math.max(a.top + a.height, b.top + b.height);
                    if (right - left > maxHeight * 0.9) continue;
                    const cand = {
                        left,
                        top,
                        width: right - left,
                        height: bottom - top,
                        area: a.area + b.area,
                        bottom,
                    };
                    // Only join when the combined shape clearly reads as one digit.
                    const cres = arClassify(net, arGlyphPatch(binary, width, cand));
                    if (cres.prob < 0.95 || cres.margin < 0.6) continue;
                    glyphs[i] = cand;
                    glyphs.splice(j, 1);
                    joined = true;
                    break outer;
                }
            }
        }

        // Arabic separators (٬ ٫) hang below the digits on either side of them,
        // which is independent of font, tilt and the glyphs' own shapes.
        const neighborSpan = maxHeight * 1.5;
        const neighborBaseline = glyphs.map((c) => {
            const cx = c.left + c.width / 2;
            let bottom = -Infinity;
            for (const o of glyphs) {
                if (o === c) continue;
                if (Math.abs(o.left + o.width / 2 - cx) > neighborSpan) continue;
                if (o.bottom > bottom) bottom = o.bottom;
            }
            return bottom;
        });

        const sorted = glyphs.slice().sort((a, b) => a.left - b.left);
        const marks = [];

        for (const comp of sorted) {
            const patch = arGlyphPatch(binary, width, comp);
            const res = arClassify(net, patch);

            const small = comp.height <= maxHeight * 0.6;
            const localBottom = neighborBaseline[glyphs.indexOf(comp)];
            const relBottom = Number.isFinite(localBottom)
                ? (comp.bottom - localBottom) / maxHeight
                : -1;
            const belowLine =
                relBottom > 0.11 || (relBottom > 0.07 && comp.height > maxHeight * 0.46);
            const weak = res.prob < 0.9 || res.margin < 0.45;
            // ٢/٣ and ٤/٥ are easy to mix in some fonts; demand more certainty.
            const risky =
                (res.best === 2 || res.best === 3) ||
                (res.best === 4 || res.best === 5);
            const confidentDigit = !weak && !(risky && res.margin < 0.75);

            let type;
            if (small && (belowLine || weak)) type = 'sep';
            else if (confidentDigit) type = 'digit';
            else type = 'other';

            marks.push({ comp, res, type });
        }

        // Pretend everything around the number is noise: read the longest run
        // of digits (letters, logos, currency words merely end a run).
        const runs = [];
        let run = [];
        const closeRun = () => {
            if (run.length) runs.push(run);
            run = [];
        };
        for (const mark of marks) {
            if (mark.type === 'other') {
                closeRun();
                continue;
            }
            run.push(mark);
        }
        closeRun();

        let best = null;
        for (const candidateRun of runs) {
            let items = candidateRun.slice();

            // Letters next to a number can classify as digits. The space before
            // a word is much wider than the spacing between digits, so cut the
            // smaller side off at that gap.
            for (;;) {
                if (items.length < 4) break;
                const gapsArr = [];
                for (let i = 1; i < items.length; i++) {
                    const prev = items[i - 1].comp;
                    const next = items[i].comp;
                    gapsArr.push(next.left - (prev.left + prev.width));
                }
                const sortedGaps = gapsArr.slice().sort((a, b) => a - b);
                const median = sortedGaps[(sortedGaps.length / 2) | 0];
                let maxIndex = 0;
                for (let i = 1; i < gapsArr.length; i++) if (gapsArr[i] > gapsArr[maxIndex]) maxIndex = i;
                const outlier = Math.max(median * 2.5, maxHeight * 0.45);
                if (gapsArr[maxIndex] <= outlier) break;
                const leftPart = items.slice(0, maxIndex + 1);
                const rightPart = items.slice(maxIndex + 1);
                const leftDigits = leftPart.filter((m) => m.type === 'digit').length;
                const rightDigits = rightPart.filter((m) => m.type === 'digit').length;
                if (leftDigits >= 2 && rightDigits >= 2) {
                    items = leftDigits >= rightDigits ? leftPart : rightPart;
                } else if (leftDigits >= 2) {
                    items = leftPart;
                } else if (rightDigits >= 2) {
                    items = rightPart;
                } else {
                    break;
                }
            }
            while (items.length && items[0].type === 'sep') items.shift();
            while (items.length && items[items.length - 1].type === 'sep') items.pop();

            const digits = items.filter((m) => m.type === 'digit');
            if (digits.length < 2) continue;

            // A narrow, digit-sized mark sitting right against either end of
            // the run is more likely a dropped digit than a surrounding word.
            const first = items[0].comp;
            const last = items[items.length - 1].comp;
            const maxDigitHeight = Math.max(...digits.map((d) => d.comp.height));
            const edgePoisoned = marks.some((m) => {
                if (m.type !== 'other') return false;
                const c = m.comp;
                if (c.height < maxDigitHeight * 0.55 || c.height > maxDigitHeight * 1.6) return false;
                if (c.width > maxHeight * 0.7) return false;
                const before = first.left - (c.left + c.width);
                const after = c.left - (last.left + last.width);
                return (before >= 0 && before <= maxHeight * 0.2) ||
                    (after >= 0 && after <= maxHeight * 0.2);
            });
            if (edgePoisoned) continue;

            // Digits on one line have similar heights (٠ and ٥ are naturally small).
            const tall = digits.filter((d) => d.res.best !== 0 && d.res.best !== 5).map((d) => d.comp.height);
            if (tall.length >= 2) {
                tall.sort((a, b) => a - b);
                const median = tall[(tall.length / 2) | 0];
                if (tall.some((h) => h < median * 0.55 || h > median * 1.6)) continue;
            }

            let minProb = 1;
            let lastRight = -Infinity;
            let overlapping = false;
            for (const mark of items) {
                if (mark.type !== 'digit') continue;
                if (mark.comp.left < lastRight - mark.comp.width * 0.3) overlapping = true;
                lastRight = mark.comp.left + mark.comp.width;
                if (mark.res.prob < minProb) minProb = mark.res.prob;
            }
            if (overlapping) continue;

            if (!best || digits.length > best.digits || (digits.length === best.digits && minProb > best.minProb)) {
                best = { run: items, digits: digits.length, minProb };
            }
        }

        if (!best) return null;

        // Decide each separator from the group it starts: 1-2 digits means a
        // decimal point, otherwise it is a thousands separator.
        let text = '';
        const items = best.run;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.type === 'digit') {
                text += AR_DIGITS[item.res.best];
                continue;
            }
            let group = 0;
            for (let j = i + 1; j < items.length && items[j].type === 'digit'; j++) group++;
            text += group > 0 && group <= 2 ? '.' : ',';
        }

        return {
            text,
            confidence: Math.round(best.minProb * 100),
        };
    }

    const api = {
        percentileFromHistogram,
        otsuFromHistogram,
        adaptiveBinarize,
        findTextRegion,
        normalizeDigits,
        parseNumber,
        recognizeArabicDigits,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.ScannerOCR = api;
})(typeof window !== 'undefined' ? window : globalThis);
