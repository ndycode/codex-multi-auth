export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) {
    return sorted[0];
  }
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) {
    return sorted[low];
  }
  const frac = index - low;
  return sorted[low] + (sorted[high] - sorted[low]) * frac;
}

export function stats(values) {
  const nums = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (nums.length === 0) {
    return null;
  }
  const sum = nums.reduce((acc, value) => acc + value, 0);
  return {
    n: nums.length,
    min: Math.min(...nums),
    p50: percentile(nums, 0.5),
    p95: percentile(nums, 0.95),
    max: Math.max(...nums),
    mean: sum / nums.length,
  };
}

export function safePercent(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }
  return (numerator / denominator) * 100;
}

export function round1(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(value * 10) / 10;
}

export function pctDelta(current, baseline) {
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline === 0) {
    return null;
  }
  return ((current - baseline) / baseline) * 100;
}
