export function formatBaseUnitsToUi(amount: bigint, decimals: number): string {
  if (decimals === 0) {
    return amount.toString();
  }
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const base = absolute.toString().padStart(decimals + 1, '0');
  const whole = base.slice(0, -decimals);
  const fraction = base.slice(-decimals).replace(/0+$/, '');
  const formatted = fraction ? `${whole}.${fraction}` : whole;
  return negative ? `-${formatted}` : formatted;
}

