/** Standard normal PDF / CDF (Abramowitz–Stegun approximation). */

export function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = normalPdf(x);
  const p =
    d *
    t *
    (0.319381539 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/** Inverse standard normal CDF (Acklam). */
export function normalInv(p: number): number {
  const pp = clip(p, 1e-12, 1 - 1e-12);
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239e0,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188367592e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
    -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
    3.754408661907416e0,
  ];

  const plow = 0.02425;
  const phigh = 1 - plow;

  if (pp < plow) {
    const q = Math.sqrt(-2 * Math.log(pp));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (pp > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - pp));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  const q = pp - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

export function clip(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Kalshi 15m crypto tick bands:
 * - deci-cents (0.1¢) only in 0–9.9¢ and 90.1–99.9¢
 * - whole cents elsewhere (10–90.0¢, and 100¢)
 */
export function isDeciCentBand(cents: number): boolean {
  return (cents >= 0 && cents <= 9.9) || (cents >= 90.1 && cents <= 99.9);
}

/** Snap a cents level to the legal Kalshi tick for its band. */
export function snapKalshiCents(cents: number): number {
  const c = clip(cents, 0, 100);
  if (c <= 9.9) return Math.round(c * 10) / 10;
  if (c >= 90.1 && c <= 99.9) return Math.round(c * 10) / 10;
  return Math.round(c);
}

/** Snap a 0–1 contract price to the legal Kalshi tick. */
export function snapKalshiPrice(prob: number): number {
  return snapKalshiCents(prob * 100) / 100;
}

/** Next legal tick above `price` (0–1). */
export function nextKalshiTick(price: number): number {
  const tenths = Math.round(snapKalshiCents(price * 100) * 10);
  let n = tenths;
  if (n < 99) n += 1;
  else if (n === 99) n = 100;
  else if (n < 900) n += 10;
  else if (n === 900) n = 901;
  else n = Math.min(1000, n + 1);
  return snapKalshiPrice(n / 1000);
}

/** Next legal tick below `price` (0–1). */
export function prevKalshiTick(price: number): number {
  const tenths = Math.round(snapKalshiCents(price * 100) * 10);
  let n = tenths;
  if (n <= 0) return 0;
  if (n <= 99) n -= 1;
  else if (n === 100) n = 99;
  else if (n <= 900) n -= 10;
  else if (n === 901) n = 900;
  else n -= 1;
  return snapKalshiPrice(n / 1000);
}

/**
 * One tick in front of the live best bid, without crossing the ask or
 * 98¢. If `ourPrice` is already that inside bid, stay put so we do not
 * chase our own quote (91.2 → 91.3, then hold 91.3 until someone outbids).
 * `max` is the best-bid / quote ceiling (Mode B: 98¢), not the live ask.
 */
export function frontOfBookBid(args: {
  bid: number;
  ask: number;
  max: number;
  ourPrice?: number | null;
}): number | null {
  const ask = snapKalshiPrice(args.ask);
  const max = snapKalshiPrice(args.max);
  const bid = Number.isFinite(args.bid) && args.bid > 0 ? snapKalshiPrice(args.bid) : 0;
  if (!(ask > 0) || ask <= 0.01) return null;

  const our =
    args.ourPrice != null && Number.isFinite(args.ourPrice)
      ? snapKalshiPrice(args.ourPrice)
      : null;
  if (
    our != null &&
    our < ask &&
    our <= max &&
    bid <= our + 1e-12
  ) {
    return our;
  }

  let px = nextKalshiTick(bid);
  if (px <= bid) px = nextKalshiTick(bid);
  if (px > max) px = max;
  if (px >= ask) {
    if (bid > 0 && bid < ask && bid <= max) return bid;
    return null;
  }
  return snapKalshiPrice(px);
}

/** Snap a yes/no BBO to legal Kalshi ticks. */
export function snapKalshiBook<
  T extends { bidUp: number; askUp: number; bidDown: number; askDown: number },
>(book: T): T {
  return {
    ...book,
    bidUp: snapKalshiPrice(book.bidUp),
    askUp: snapKalshiPrice(book.askUp),
    bidDown: snapKalshiPrice(book.bidDown),
    askDown: snapKalshiPrice(book.askDown),
  };
}

/** @deprecated Prefer snapKalshiPrice — kept as alias. */
export function roundDeciCentPrice(prob: number): number {
  return snapKalshiPrice(prob);
}

/** Format a 0–1 price as cents; decimals only in 0–9.9 and 90.1–99.9. */
export function formatCents(prob: number): string {
  const cents = snapKalshiCents(prob * 100);
  if (isDeciCentBand(cents)) {
    const deci = Math.round(cents * 10) / 10;
    const tenth = Math.round(deci * 10) % 10;
    if (tenth !== 0) return `${deci.toFixed(1)}¢`;
    return `${Math.round(deci)}¢`;
  }
  return `${Math.round(cents)}¢`;
}

/** Format a cents value for labels (e.g. @99.1); same band rules. */
export function formatCentValue(cents: number): string {
  const c = snapKalshiCents(cents);
  if (isDeciCentBand(c)) {
    const deci = Math.round(c * 10) / 10;
    const tenth = Math.round(deci * 10) % 10;
    if (tenth !== 0) return deci.toFixed(1);
    return `${Math.round(deci)}`;
  }
  return `${Math.round(c)}`;
}

export function formatClock(secondsLeft: number): string {
  const s = Math.max(0, Math.floor(secondsLeft));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}
