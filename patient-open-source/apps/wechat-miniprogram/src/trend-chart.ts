import { displayUnit } from './measurement-format';

interface ChartInput { at: string; value: number; unit: string; }
interface ChartPoint extends ChartInput { label: string; height: number; }
interface ChartView { points: ChartPoint[]; ticks: string[]; comparable: boolean; }

/** 有限量程内展示原值；刻度明确，单次记录和不同单位的数据不绘制趋势。 */
function buildTrendChart(input: ChartInput[], fallbackUnit: string, temperature = false, limit = 7): ChartView {
  const points = input.filter(point => Number.isFinite(point.value) && Number.isFinite(Date.parse(point.at)))
    .slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-limit);
  const units = new Set(points.map(point => displayUnit(point.unit || fallbackUnit).replace(/°C/g, '℃')));
  const comparable = units.size <= 1;
  const values = points.map(point => point.value);
  const minimum = values.length ? Math.min(...values) : 0;
  const maximum = values.length ? Math.max(...values) : 1;
  const span = maximum - minimum;
  const padding = temperature ? Math.max(.5, (2 - span) / 2) : Math.max(span * .2, Math.abs(maximum) * .05, .1);
  const low = Math.floor((minimum - padding) * 10) / 10;
  const high = Math.ceil((maximum + padding) * 10) / 10;
  const tick = (value: number): string => String(Number(value.toFixed(2)));
  return {
    comparable,
    ticks: [tick(high), tick((high + low) / 2), tick(low)],
    points: points.map(point => {
      const date = new Date(Date.parse(point.at) + 8 * 3_600_000);
      return { ...point, label: `${date.getUTCMonth() + 1}/${date.getUTCDate()}`, height: (point.value - low) / (high - low) * 100 };
    }),
  };
}

export { buildTrendChart, type ChartPoint, type ChartView };
