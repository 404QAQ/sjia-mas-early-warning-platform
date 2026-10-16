/** 仅规范显示，不换算或修改服务端原始数值、单位。 */
export function displayUnit(unit: string): string {
  return ['10^9/L', '10*9/L', '10⁹/L'].includes(unit) ? '×10⁹/L' : unit;
}

export function formatMeasurement(value: number | string, unit: string): string {
  return unit ? `${value} ${displayUnit(unit)}` : String(value);
}
