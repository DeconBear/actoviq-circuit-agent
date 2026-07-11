import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useAppStore, type SimulationMetric } from '../../store/appStore';
import type {
  SimulationAnalysisSummary,
  SimulationDataset,
  SimulationDatasetTrace,
  SimulationRun,
  SimulationRunMetric,
} from '../../types';

type DiagramMode = 'cartesian' | 'bode' | 'polar' | 'smith' | 'table';

const traceColors = ['#176b4d', '#b43b48', '#2368a2', '#7a4f9a', '#9a6a15', '#237d82'];

function matchingTraceName(
  traces: Array<{ name: string }>,
  candidates: string[],
): string | undefined {
  const normalized = new Map(traces.map((trace) => [trace.name.replaceAll(' ', '').toLowerCase(), trace.name]));
  return candidates
    .map((candidate) => normalized.get(candidate.replaceAll(' ', '').toLowerCase()))
    .find((name): name is string => Boolean(name));
}

function defaultTraceNames(dataset: SimulationDataset): string[] {
  const meaningful = dataset.traces.filter((trace) => {
    const values = trace.magnitude ?? trace.real;
    return values.some((value) => Number.isFinite(value) && Math.abs(value) > 1e-18);
  });
  const candidates = meaningful.length > 0 ? meaningful : dataset.traces;
  const voltages = candidates.filter((trace) => trace.unit === 'V');
  return (voltages.length > 0 ? voltages : candidates).slice(0, 4).map((trace) => trace.name);
}

export function SimulationTab() {
  const legacyData = useAppStore((state) => state.simulationData);
  const projectId = useAppStore((state) => state.activeProjectId);
  const bundle = useAppStore((state) => state.circuitProject);
  const build = useAppStore((state) => state.circuitBuild);

  if (projectId && bundle) {
    return (
      <ProjectSimulation
        projectId={projectId}
        projectRevision={bundle.project.revision}
        simulation={build?.simulation ?? null}
        status={build?.manifest?.status}
      />
    );
  }
  return <LegacySimulation data={legacyData} />;
}

function defaultDiagram(analysis?: SimulationAnalysisSummary): DiagramMode {
  if (analysis?.type === 'ac') return 'bode';
  if (analysis?.type === 'sparameter') return 'smith';
  if (analysis?.type === 'pz') return 'polar';
  if (analysis?.type === 'op') return 'table';
  return 'cartesian';
}

function ProjectSimulation({
  projectId,
  projectRevision,
  simulation,
  status,
}: {
  projectId: string;
  projectRevision: number;
  simulation: SimulationRun | null;
  status?: string;
}) {
  const analyses = simulation?.analyses ?? [];
  const [analysisId, setAnalysisId] = useState('');
  const [dataset, setDataset] = useState<SimulationDataset | null>(null);
  const [datasetLoading, setDatasetLoading] = useState(false);
  const [datasetError, setDatasetError] = useState('');
  const [selectedTraces, setSelectedTraces] = useState<string[]>([]);
  const [diagram, setDiagram] = useState<DiagramMode>('cartesian');
  const [probeMessage, setProbeMessage] = useState('');
  const probeRequest = useAppStore((state) => state.simulationProbeRequest);
  const setProbeRequest = useAppStore((state) => state.setSimulationProbeRequest);
  const activeProbe = probeRequest?.projectId === projectId ? probeRequest : null;

  const selectedAnalysis = analyses.find((analysis) => analysis.id === analysisId) ?? analyses[0];

  useEffect(() => {
    const next = analyses[0];
    setAnalysisId(next?.id ?? '');
    setDiagram(defaultDiagram(next));
  }, [simulation?.run_id]);

  useEffect(() => {
    if (!activeProbe) return;
    setProbeMessage(`Finding ${activeProbe.label}...`);
    const target = analyses.find((analysis) => (
      matchingTraceName(analysis.dataset?.traces ?? [], activeProbe.candidates)
    ));
    if (target) setAnalysisId(target.id);
  }, [activeProbe?.id, simulation?.run_id]);

  useEffect(() => {
    if (!selectedAnalysis) return;
    setDiagram(defaultDiagram(selectedAnalysis));
  }, [selectedAnalysis?.id]);

  useEffect(() => {
    let cancelled = false;
    setDataset(null);
    setDatasetError('');
    if (!simulation?.run_id || !selectedAnalysis?.dataset) return () => { cancelled = true; };
    setDatasetLoading(true);
    void window.electronAPI.readCircuitSimulationDataset(projectId, {
      runId: simulation.run_id,
      analysisId: selectedAnalysis.id,
      maxPoints: 1400,
    }).then((nextDataset) => {
      if (cancelled) return;
      setDataset(nextDataset);
      setSelectedTraces(defaultTraceNames(nextDataset));
    }).catch((error) => {
      if (!cancelled) setDatasetError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (!cancelled) setDatasetLoading(false);
    });
    return () => { cancelled = true; };
  }, [projectId, selectedAnalysis?.dataset, selectedAnalysis?.id, simulation?.run_id]);

  useEffect(() => {
    if (!activeProbe || !dataset) return;
    const probedTrace = matchingTraceName(dataset.traces, activeProbe.candidates);
    if (probedTrace) {
      setSelectedTraces((current) => (
        activeProbe.kind === 'current'
          ? [probedTrace]
          : [...new Set([...current, probedTrace])]
      ));
      setProbeMessage(`Added ${probedTrace} from ${activeProbe.moduleId}`);
      setProbeRequest(null);
    } else {
      setProbeMessage(`${activeProbe.label} is not present in this run. Simulate the current revision to capture it.`);
    }
  }, [activeProbe?.id, dataset, setProbeRequest]);

  if (!simulation) {
    return (
      <div style={styles.empty}>
        <div style={styles.emptyTitle}>No simulation run</div>
        <div style={styles.emptyMeta}>
          {activeProbe
            ? `${activeProbe.label} requested. Simulate the current revision to capture it.`
            : status ? `Build status: ${status}` : 'Project is not compiled'}
        </div>
      </div>
    );
  }

  const stale = simulation.source_revision !== undefined && simulation.source_revision !== projectRevision;
  const metrics = selectedAnalysis?.metrics ?? simulation.metrics ?? [];
  const modes: DiagramMode[] = ['cartesian', 'bode', 'polar', 'smith', 'table'];

  return (
    <div style={styles.workbench} data-testid="project-simulation">
      <div style={styles.runHeader}>
        <div style={styles.runIdentity}>
          <strong>{simulation.run_id ?? 'Legacy run'}</strong>
          <span>revision {simulation.source_revision ?? 'unknown'}</span>
          {stale ? <span style={styles.stale}>stale</span> : null}
        </div>
        <div style={styles.statusGroup}>
          <Status label="Run" value={simulation.execution_status ?? (simulation.ok ? 'success' : 'failed')} />
          <Status label="Measurements" value={simulation.measurement_status ?? 'unknown'} />
          <Status label="Specifications" value={simulation.specification_status ?? 'not_evaluated'} />
        </div>
      </div>

      {probeMessage ? (
        <div style={styles.probeStatus} data-testid="simulation-probe-status">{probeMessage}</div>
      ) : null}

      <div style={styles.analysisBar}>
        <label style={styles.fieldLabel}>
          Analysis
          <select
            value={selectedAnalysis?.id ?? ''}
            onChange={(event) => setAnalysisId(event.target.value)}
            style={styles.select}
            data-testid="simulation-analysis-select"
          >
            {analyses.map((analysis) => (
              <option key={analysis.id} value={analysis.id}>
                {analysis.id} | {analysis.directive}
              </option>
            ))}
          </select>
        </label>
        <div style={styles.segmented} aria-label="Simulation diagram">
          {modes.map((mode) => (
            <button
              key={mode}
              type="button"
              style={{ ...styles.segment, ...(diagram === mode ? styles.segmentActive : {}) }}
              onClick={() => setDiagram(mode)}
              disabled={!dataset || ((mode === 'polar' || mode === 'smith') && !dataset.traces.some((trace) => trace.imag))}
              data-testid={`simulation-diagram-${mode}`}
            >
              {mode === 'smith' ? 'Smith' : mode[0]!.toUpperCase() + mode.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div style={styles.content}>
        <aside style={styles.tracePanel} data-testid="simulation-trace-panel">
          <div style={styles.panelTitle}>Traces</div>
          {dataset?.traces.map((trace, index) => (
            <label key={trace.name} style={styles.traceChoice}>
              <input
                type="checkbox"
                checked={selectedTraces.includes(trace.name)}
                onChange={(event) => setSelectedTraces((current) => (
                  event.target.checked
                    ? [...new Set([...current, trace.name])]
                    : current.filter((name) => name !== trace.name)
                ))}
              />
              <span style={{ ...styles.traceSwatch, background: traceColors[index % traceColors.length] }} />
              <span style={styles.traceName}>{trace.name}</span>
              <span style={styles.traceUnit}>{trace.unit}</span>
            </label>
          ))}
          {!dataset && !datasetLoading ? <div style={styles.panelEmpty}>No vectors</div> : null}
        </aside>

        <main style={styles.plotPanel} data-testid="simulation-dataset-view">
          {datasetLoading ? <div style={styles.plotEmpty}>Loading vectors...</div> : null}
          {datasetError ? <div style={styles.plotError}>{datasetError}</div> : null}
          {!datasetLoading && !datasetError && dataset ? (
            <Diagram dataset={dataset} selectedTraces={selectedTraces} mode={diagram} />
          ) : null}
          {!datasetLoading && !datasetError && !dataset ? (
            <div style={styles.plotEmpty}>{selectedAnalysis?.diagnostics?.join('\n') || 'Analysis produced no dataset.'}</div>
          ) : null}
        </main>
      </div>

      <MetricTable metrics={metrics} />
    </div>
  );
}

function Status({ label, value }: { label: string; value: string }) {
  const failed = /fail|error|partial|stale/i.test(value);
  return (
    <div style={styles.statusItem}>
      <span>{label}</span>
      <strong style={{ color: failed ? '#a32d38' : value === 'not_evaluated' ? '#68727e' : '#267346' }}>
        {value.replaceAll('_', ' ')}
      </strong>
    </div>
  );
}

function selectedDatasetTraces(dataset: SimulationDataset, names: string[]): SimulationDatasetTrace[] {
  return dataset.traces.filter((trace) => names.includes(trace.name));
}

function Diagram({
  dataset,
  selectedTraces,
  mode,
}: {
  dataset: SimulationDataset;
  selectedTraces: string[];
  mode: DiagramMode;
}) {
  const traces = selectedDatasetTraces(dataset, selectedTraces);
  const cartesianData = useMemo(() => dataset.x.values.map((x, index) => Object.fromEntries([
    ['x', x],
    ...traces.map((trace) => [trace.name, trace.real[index]]),
  ])), [dataset, traces]);
  const bodeData = useMemo(() => dataset.x.values.map((x, index) => Object.fromEntries([
    ['x', x],
    ...traces.flatMap((trace) => [
      [`${trace.name}:db`, trace.db?.[index]],
      [`${trace.name}:phase`, trace.phase_deg?.[index]],
    ]),
  ])), [dataset, traces]);

  if (mode === 'table') return <DatasetTable dataset={dataset} traces={traces} />;
  if ((mode === 'polar' || mode === 'smith') && traces.length > 0) {
    return <ComplexDiagram traces={traces} smith={mode === 'smith'} />;
  }
  if (mode === 'bode') {
    const frequencyUnit = dataset.x.unit || 'Hz';
    const formatFrequencyTick = (value: number) => formatAxisTick(value, frequencyUnit);
    return (
      <div style={styles.bodeStack} data-testid="simulation-bode-chart">
        <ResponsiveContainer width="100%" height="52%">
          <LineChart data={bodeData} margin={{ top: 12, right: 20, left: 8, bottom: 0 }}>
            <CartesianGrid stroke="#e1e5e9" />
            <XAxis dataKey="x" type="number" scale="log" domain={['auto', 'auto']} hide />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={(value) => formatNumber(Number(value))} label={{ value: 'dB', angle: -90, position: 'insideLeft' }} />
            <Tooltip
              contentStyle={styles.tooltip}
              labelFormatter={(value) => `${formatFrequencyTick(Number(value))} ${frequencyUnit}`}
              formatter={(value) => formatNumber(typeof value === 'number' ? value : Number(value))}
            />
            <Legend />
            {traces.filter((trace) => trace.db).map((trace, index) => (
              <Line key={trace.name} dataKey={`${trace.name}:db`} name={`${trace.name} dB`} stroke={traceColors[index % traceColors.length]} dot={false} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
        <ResponsiveContainer width="100%" height="48%">
          <LineChart data={bodeData} margin={{ top: 0, right: 20, left: 8, bottom: 18 }}>
            <CartesianGrid stroke="#e1e5e9" />
            <XAxis
              dataKey="x"
              type="number"
              scale="log"
              domain={['auto', 'auto']}
              tick={{ fontSize: 10 }}
              tickFormatter={formatFrequencyTick}
              minTickGap={28}
              label={{ value: `${dataset.x.name} (${frequencyUnit})`, position: 'insideBottom', offset: -6 }}
            />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={(value) => formatNumber(Number(value))} label={{ value: 'deg', angle: -90, position: 'insideLeft' }} />
            <Tooltip
              contentStyle={styles.tooltip}
              labelFormatter={(value) => `${formatFrequencyTick(Number(value))} ${frequencyUnit}`}
              formatter={(value) => formatNumber(typeof value === 'number' ? value : Number(value))}
            />
            {traces.filter((trace) => trace.phase_deg).map((trace, index) => (
              <Line key={trace.name} dataKey={`${trace.name}:phase`} name={`${trace.name} phase`} stroke={traceColors[index % traceColors.length]} dot={false} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }
  const xUnit = dataset.x.unit || '';
  const formatXTick = (value: number) => formatAxisTick(value, xUnit);
  return (
    <div style={styles.chart} data-testid="simulation-cartesian-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={cartesianData} margin={{ top: 14, right: 22, left: 8, bottom: 18 }}>
          <CartesianGrid stroke="#e1e5e9" />
          <XAxis
            dataKey="x"
            type="number"
            scale={['ac', 'noise'].includes(dataset.analysis_type) ? 'log' : 'auto'}
            domain={['auto', 'auto']}
            tick={{ fontSize: 10 }}
            tickFormatter={formatXTick}
            minTickGap={28}
            label={{ value: `${dataset.x.name} (${dataset.x.unit})`, position: 'insideBottom', offset: -6 }}
          />
          <YAxis tick={{ fontSize: 10 }} tickFormatter={(value) => formatNumber(Number(value))} />
          <Tooltip
            contentStyle={styles.tooltip}
            labelFormatter={(value) => `${formatXTick(Number(value))}${xUnit ? ` ${xUnit}` : ''}`}
            formatter={(value) => formatNumber(typeof value === 'number' ? value : Number(value))}
          />
          <Legend />
          {traces.map((trace, index) => (
            <Line key={trace.name} dataKey={trace.name} stroke={traceColors[index % traceColors.length]} dot={false} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function ComplexDiagram({ traces, smith }: { traces: SimulationDatasetTrace[]; smith: boolean }) {
  const unitCircle = Array.from({ length: 73 }, (_value, index) => {
    const angle = index * Math.PI / 36;
    return { real: Math.cos(angle), imag: Math.sin(angle) };
  });
  return (
    <div style={styles.chart} data-testid={smith ? 'simulation-smith-chart' : 'simulation-polar-chart'}>
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 16, right: 24, bottom: 20, left: 24 }}>
          <CartesianGrid stroke="#e1e5e9" />
          <XAxis type="number" dataKey="real" domain={smith ? [-1.1, 1.1] : ['auto', 'auto']} tick={{ fontSize: 10 }} />
          <YAxis type="number" dataKey="imag" domain={smith ? [-1.1, 1.1] : ['auto', 'auto']} tick={{ fontSize: 10 }} />
          <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={styles.tooltip} />
          {smith ? <Scatter data={unitCircle} fill="none" stroke="#9ba4ae" line shape={() => null} isAnimationActive={false} /> : null}
          {traces.filter((trace) => trace.imag).map((trace, index) => (
            <Scatter
              key={trace.name}
              name={trace.name}
              data={trace.real.map((real, point) => ({ real, imag: trace.imag?.[point] ?? 0 }))}
              fill={traceColors[index % traceColors.length]}
              line
              isAnimationActive={false}
            />
          ))}
          <Legend />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

function DatasetTable({ dataset, traces }: { dataset: SimulationDataset; traces: SimulationDatasetTrace[] }) {
  return (
    <div style={styles.datasetTableWrap} data-testid="simulation-dataset-table">
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>{dataset.x.name}</th>
            {traces.map((trace) => <th key={trace.name} style={styles.th}>{trace.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {dataset.x.values.slice(0, 300).map((x, index) => (
            <tr key={`${x}-${index}`} style={styles.tr}>
              <td style={styles.tdMono}>{formatNumber(x)}</td>
              {traces.map((trace) => <td key={trace.name} style={styles.tdMono}>{formatNumber(trace.real[index])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MetricTable({ metrics }: { metrics: SimulationRunMetric[] }) {
  if (metrics.length === 0) return null;
  return (
    <div style={styles.metrics}>
      <div style={styles.panelTitle}>Measurements</div>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Metric</th>
            <th style={styles.th}>Value</th>
            <th style={styles.th}>Target</th>
            <th style={styles.th}>Measurement</th>
            <th style={styles.th}>Specification</th>
          </tr>
        </thead>
        <tbody>
          {metrics.map((metric, index) => (
            <tr key={`${metric.name}-${index}`} style={styles.tr}>
              <td style={styles.td}>{metric.name}</td>
              <td style={styles.tdMono}>{formatNumber(metric.value)} {metric.unit}</td>
              <td style={styles.tdMono}>{formatSpecification(metric)}</td>
              <td style={styles.td}>{metric.measurement_status ?? (metric.pass ? 'measured' : 'failed')}</td>
              <td style={styles.td}>{metric.specification_status ?? 'not evaluated'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatSpecification(metric: SimulationRunMetric): string {
  const target = metric.specification;
  if (!target) return '-';
  const unit = target.unit || metric.unit;
  if (target.minimum !== null && target.maximum !== null) {
    return `${formatNumber(target.minimum)} to ${formatNumber(target.maximum)} ${unit}`.trim();
  }
  if (target.minimum !== null) return `>= ${formatNumber(target.minimum)} ${unit}`.trim();
  if (target.maximum !== null) return `<= ${formatNumber(target.maximum)} ${unit}`.trim();
  return '-';
}

function formatSiNumber(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (value === 0) return '0';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const tiers: Array<[number, string]> = [
    [1e12, 'T'],
    [1e9, 'G'],
    [1e6, 'M'],
    [1e3, 'k'],
    [1, ''],
    [1e-3, 'm'],
    [1e-6, 'µ'],
    [1e-9, 'n'],
    [1e-12, 'p'],
  ];
  for (const [scale, suffix] of tiers) {
    if (abs >= scale || scale <= 1e-12) {
      const scaled = abs / scale;
      const rounded = Math.abs(scaled - Math.round(scaled)) < 1e-9 * Math.max(1, scaled)
        ? String(Math.round(scaled))
        : scaled >= 100
          ? scaled.toFixed(0)
          : scaled >= 10
            ? scaled.toFixed(1)
            : scaled.toFixed(2);
      return `${sign}${rounded.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}${suffix}`;
    }
  }
  return String(value);
}

function formatAxisTick(value: number, unit = ''): string {
  if (!Number.isFinite(value)) return '';
  const normalized = unit.trim().toLowerCase();
  if (normalized === 'hz' || normalized === 's' || Math.abs(value) >= 1000 || (value !== 0 && Math.abs(value) < 1e-2)) {
    return formatSiNumber(value);
  }
  return formatNumber(value);
}

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  if (value === 0) return '0';
  if (Math.abs(value) >= 1e4 || Math.abs(value) < 1e-3) return formatSiNumber(value);
  return value.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
}

function LegacySimulation({ data }: { data: SimulationMetric[] | null }) {
  if (!data || data.length === 0) {
    return (
      <div style={styles.empty}>
        <div style={styles.emptyTitle}>No simulation data</div>
      </div>
    );
  }
  return (
    <div style={styles.legacy}>
      <table style={styles.table}>
        <thead><tr><th style={styles.th}>Metric</th><th style={styles.th}>Target</th><th style={styles.th}>Measured</th><th style={styles.th}>Status</th></tr></thead>
        <tbody>{data.map((metric) => (
          <tr key={metric.name} style={styles.tr}>
            <td style={styles.td}>{metric.name}</td><td style={styles.td}>{metric.target}</td><td style={styles.td}>{metric.measured}</td><td style={styles.td}>{metric.pass ? 'pass' : 'fail'}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  workbench: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', background: '#f5f6f8', color: '#2d3540' },
  runHeader: { minHeight: 54, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '8px 14px', borderBottom: '1px solid #d9dee4', background: '#fff' },
  runIdentity: { minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 10, fontSize: 11, color: '#737d88' },
  probeStatus: { minHeight: 30, display: 'flex', alignItems: 'center', padding: '4px 14px', borderBottom: '1px solid #cddbea', background: '#eef5fb', color: '#275f8a', fontSize: 11 },
  stale: { color: '#a32d38', fontWeight: 700 },
  statusGroup: { display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'flex-end' },
  statusItem: { display: 'flex', gap: 6, fontSize: 10, color: '#7a838e', textTransform: 'capitalize' },
  analysisBar: { minHeight: 50, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, padding: '7px 14px', borderBottom: '1px solid #d9dee4', background: '#fff' },
  fieldLabel: { minWidth: 280, display: 'flex', alignItems: 'center', gap: 8, color: '#65707c', fontSize: 10, fontWeight: 700, textTransform: 'uppercase' },
  select: { minWidth: 220, maxWidth: 460, height: 30, flex: 1, border: '1px solid #c6cdd5', borderRadius: 4, background: '#fff', color: '#303a46', fontSize: 11, padding: '0 7px' },
  segmented: { height: 30, display: 'flex', border: '1px solid #c6cdd5', borderRadius: 4, overflow: 'hidden', background: '#fff' },
  segment: { minWidth: 66, border: 0, borderRight: '1px solid #d9dee4', background: '#fff', color: '#596572', cursor: 'pointer', fontSize: 10, padding: '0 8px' },
  segmentActive: { background: '#e8f1fb', color: '#1f5f96', fontWeight: 700 },
  content: { minHeight: 280, flex: 1, display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', borderBottom: '1px solid #d9dee4' },
  tracePanel: { minWidth: 0, overflowY: 'auto', padding: '10px 8px', borderRight: '1px solid #d9dee4', background: '#fafbfc' },
  panelTitle: { padding: '0 6px 7px', color: '#68727d', fontSize: 10, fontWeight: 750, textTransform: 'uppercase' },
  traceChoice: { minHeight: 28, display: 'grid', gridTemplateColumns: '16px 9px minmax(0, 1fr) auto', alignItems: 'center', gap: 6, padding: '2px 6px', color: '#36414d', fontSize: 10 },
  traceSwatch: { width: 8, height: 8 },
  traceName: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'Consolas, monospace' },
  traceUnit: { color: '#8a929c' },
  panelEmpty: { padding: 8, color: '#8a929c', fontSize: 10 },
  plotPanel: { minWidth: 0, minHeight: 0, position: 'relative', background: '#fff' },
  plotEmpty: { height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, color: '#7c8691', fontSize: 12, whiteSpace: 'pre-wrap', textAlign: 'center' },
  plotError: { margin: 16, padding: 10, border: '1px solid #e2b6bc', background: '#fff0f2', color: '#9b303c', fontSize: 11 },
  chart: { width: '100%', height: '100%', minHeight: 280 },
  bodeStack: { width: '100%', height: '100%', minHeight: 300, padding: '0 4px 4px', boxSizing: 'border-box' },
  tooltip: { border: '1px solid #cbd2d9', borderRadius: 4, background: '#fff', color: '#2d3540', fontSize: 10 },
  datasetTableWrap: { height: '100%', overflow: 'auto' },
  metrics: { maxHeight: 210, overflowY: 'auto', padding: '9px 14px 14px', background: '#fff' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { position: 'sticky', top: 0, zIndex: 1, padding: '6px 9px', borderBottom: '1px solid #cbd2d9', background: '#f5f6f8', color: '#69737f', fontSize: 10, fontWeight: 700, textAlign: 'left', textTransform: 'uppercase' },
  tr: { borderBottom: '1px solid #e6e9ed' },
  td: { padding: '6px 9px', color: '#39434e', fontSize: 11 },
  tdMono: { padding: '6px 9px', color: '#39434e', fontFamily: 'Consolas, monospace', fontSize: 10 },
  empty: { height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5, color: '#7d8791' },
  emptyTitle: { color: '#38424d', fontSize: 15, fontWeight: 650 },
  emptyMeta: { fontSize: 11 },
  legacy: { height: '100%', overflow: 'auto', padding: 16, background: '#fff' },
};
