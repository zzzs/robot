import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
} from 'lightweight-charts';
import type {
  IChartApi,
  LineData,
  UTCTimestamp,
  WhitespaceData,
} from 'lightweight-charts';
import type { ChartPayload } from '../types';

interface Props {
  data: ChartPayload;
}

const MA_COLORS: Record<'ma5' | 'ma10' | 'ma20' | 'ma60', string> = {
  ma5: '#f59e0b',
  ma10: '#3b82f6',
  ma20: '#a855f7',
  ma60: '#6b7280',
};

const MA_LABELS: Record<'ma5' | 'ma10' | 'ma20' | 'ma60', string> = {
  ma5: '均线 MA5',
  ma10: '均线 MA10',
  ma20: '均线 MA20',
  ma60: '均线 MA60',
};

function toTime(date: string): UTCTimestamp {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(4, 6));
  const d = Number(date.slice(6, 8));
  return (Date.UTC(y, m - 1, d, 0, 0, 0) / 1000) as UTCTimestamp;
}

function toLine(
  payload: ChartPayload,
  picker: (date: string) => number | null,
): Array<LineData<UTCTimestamp> | WhitespaceData<UTCTimestamp>> {
  return payload.bars.map((b) => {
    const v = picker(b.t);
    if (v === null || v === undefined || Number.isNaN(v)) {
      return { time: toTime(b.t) } as WhitespaceData<UTCTimestamp>;
    }
    return { time: toTime(b.t), value: v } as LineData<UTCTimestamp>;
  });
}

export function StockChart({ data }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#111827',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#f1f5f9' },
        horzLines: { color: '#f1f5f9' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#e5e7eb' },
      timeScale: {
        borderColor: '#e5e7eb',
        timeVisible: false,
        secondsVisible: false,
      },
      width: containerRef.current.clientWidth,
      height: 500,
    });
    chartRef.current = chart;

    // --- Pane 0: candlestick + MA + volume + BOLL ---
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: '#ef4444',
      downColor: '#10b981',
      borderUpColor: '#ef4444',
      borderDownColor: '#10b981',
      wickUpColor: '#ef4444',
      wickDownColor: '#10b981',
      priceLineVisible: false,
    });
    candle.setData(
      data.bars.map((b) => ({
        time: toTime(b.t),
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
      })),
    );
    candle.applyOptions({ title: `${data.symbol} 日K` });

    const volume = chart.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
        color: '#9ca3af',
      },
      0,
    );
    chart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });
    volume.setData(
      data.bars.map((b) => ({
        time: toTime(b.t),
        value: b.v,
        color: b.c >= b.o ? '#fca5a5' : '#86efac',
      })),
    );

    const maKeys = ['ma5', 'ma10', 'ma20', 'ma60'] as const;
    for (const k of maKeys) {
      const line = chart.addSeries(
        LineSeries,
        {
          color: MA_COLORS[k],
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        },
        0,
      );
      line.setData(
        toLine(data, (d) => {
          const p = data.ma.find((m) => m.date === d);
          if (!p) return null;
          if (k === 'ma60' && p.ma60 === null) return null;
          return p[k];
        }),
      );
      line.applyOptions({ title: MA_LABELS[k] });
    }

    const bollUpper = chart.addSeries(
      LineSeries,
      {
        color: '#94a3b8',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      },
      0,
    );
    bollUpper.setData(toLine(data, (d) => data.boll.find((b) => b.date === d)?.upper ?? null));
    bollUpper.applyOptions({ title: '布林上轨 BOLL Upper' });

    const bollLower = chart.addSeries(
      LineSeries,
      {
        color: '#94a3b8',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      },
      0,
    );
    bollLower.setData(toLine(data, (d) => data.boll.find((b) => b.date === d)?.lower ?? null));
    bollLower.applyOptions({ title: '布林下轨 BOLL Lower' });

    if (data.latest_quote) {
      candle.createPriceLine({
        price: data.latest_quote.price,
        color: '#0ea5e9',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `最新 ${data.latest_quote.price.toFixed(2)}`,
      });
    }

    // --- Pane 1: MACD ---
    const macdHist = chart.addSeries(
      HistogramSeries,
      { priceLineVisible: false, lastValueVisible: false },
      1,
    );
    macdHist.setData(
      data.macd
        .filter((m) => m.histogram !== null)
        .map((m) => ({
          time: toTime(m.date),
          value: m.histogram as number,
          color: (m.histogram as number) >= 0 ? '#ef4444' : '#10b981',
        })),
    );
    macdHist.applyOptions({ title: '指数平滑异同移动平均 MACD' });

    const dif = chart.addSeries(
      LineSeries,
      { color: '#3b82f6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false },
      1,
    );
    dif.setData(toLine(data, (d) => data.macd.find((m) => m.date === d)?.dif ?? null));
    dif.applyOptions({ title: 'DIF' });

    const dea = chart.addSeries(
      LineSeries,
      { color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false },
      1,
    );
    dea.setData(toLine(data, (d) => data.macd.find((m) => m.date === d)?.dea ?? null));
    dea.applyOptions({ title: 'DEA' });

    // --- Pane 2: RSI ---
    const rsi6 = chart.addSeries(
      LineSeries,
      { color: '#8b5cf6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false },
      2,
    );
    rsi6.setData(toLine(data, (d) => data.rsi.find((r) => r.date === d)?.rsi6 ?? null));
    rsi6.applyOptions({ title: '相对强弱指标 RSI(6)' });
    rsi6.createPriceLine({
      price: 70,
      color: '#fca5a5',
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
      title: '70',
    });
    rsi6.createPriceLine({
      price: 30,
      color: '#86efac',
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
      title: '30',
    });
    rsi6.createPriceLine({
      price: 50,
      color: '#cbd5e1',
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: false,
      title: '50',
    });

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
      chartRef.current = null;
    };
  }, [data]);

  return <div ref={containerRef} style={{ width: '100%' }} />;
}
