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
    function findTextRegion(binary, width, height) {
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
        let left = width;
        let right = -1;
        let x = 0;

        while (x < width) {
            while (x < width && columnCounts[x] < minColumnPixels) x++;
            const start = x;
            while (x < width && columnCounts[x] >= minColumnPixels) x++;
            const runWidth = x - start;
            if (runWidth >= minRunWidth) {
                if (start < left) left = start;
                if (x - 1 > right) right = x - 1;
            }
        }

        if (right < left) return null;

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

    // Parses the most plausible positive number out of OCR output.
    function parseNumber(text) {
        if (!text) return null;
        const normalized = normalizeDigits(text);
        const matches = normalized.match(/\d[\d.,]*\d|\d/g) || [];

        let best = null;

        for (const match of matches) {
            const raw = match.replace(/[.,]+$/, '');
            if (!/^\d+(?:[.,]\d+)*$/.test(raw)) continue;

            let cleaned;
            if (raw.includes(',')) {
                cleaned = raw.replace(/,/g, '');
            } else if (/^\d{1,3}\.\d{3}$/.test(raw)) {
                // Printed labels such as 45.250 normally mean 45,250.
                cleaned = raw.replace('.', '');
            } else {
                cleaned = raw;
            }

            const value = parseFloat(cleaned);
            if (!Number.isFinite(value) || value <= 0) continue;

            const digits = cleaned.replace(/[.,]/g, '').length;
            if (!best || digits > best.digits) {
                best = { value, digits };
            }
        }

        return best ? best.value : null;
    }

    const api = {
        percentileFromHistogram,
        otsuFromHistogram,
        adaptiveBinarize,
        findTextRegion,
        normalizeDigits,
        parseNumber,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.ScannerOCR = api;
})(typeof window !== 'undefined' ? window : globalThis);
