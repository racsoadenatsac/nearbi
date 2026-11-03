// Exact decimal <-> base-unit conversion with BigInt (no float rounding on money).

const DEC_RE = /^(\d+)(?:\.(\d+))?$/;

/** "49" or "49.5" (or a number) with `decimals` -> integer string in base units. Rounds up past `decimals`. */
export function toBaseUnits(amount: string | number, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error(`bad decimals ${decimals}`);
  const s = typeof amount === "number" ? numberToPlain(amount) : amount.trim();
  const m = DEC_RE.exec(s);
  if (!m) throw new Error(`not a non-negative decimal: ${s}`);
  const [, int, frac = ""] = m;
  const kept = frac.slice(0, decimals).padEnd(decimals, "0");
  let v = BigInt(int + kept);
  if (/[1-9]/.test(frac.slice(decimals))) v += 1n; // never under-charge
  return v.toString();
}

/** Integer string in base units -> plain decimal string (trailing zeros trimmed). */
export function fromBaseUnits(base: string, decimals: number): string {
  if (!/^\d+$/.test(base)) throw new Error(`not an integer string: ${base}`);
  const p = base.padStart(decimals + 1, "0");
  const int = p.slice(0, p.length - decimals).replace(/^0+(?=\d)/, "");
  const frac = decimals ? p.slice(p.length - decimals).replace(/0+$/, "") : "";
  return frac ? `${int}.${frac}` : int;
}

function numberToPlain(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new Error(`not a non-negative finite number: ${n}`);
  // toFixed(12) avoids exponent notation for the small/large values a price can take.
  return n.toFixed(12).replace(/\.?0+$/, "");
}

/** Stablecoins we price 1:1 with USD when they are the settlement asset. */
export const USD_STABLE_SYMBOLS = new Set(["USDC", "USDT", "USDC.E", "USDT.E", "DAI", "USDT0"]);
