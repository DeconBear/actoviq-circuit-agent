import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  pdkDeviceCategory,
  pdkDeviceDefaults,
  pdkDeviceToolType,
  validatePdkDeviceParameters,
} from './pdkDevice';
import type { PdkDeviceCatalog, PdkDeviceCatalogDevice } from './types';

interface Props {
  catalog: PdkDeviceCatalog;
  busy: boolean;
  onClose: () => void;
  onPlace: (device: PdkDeviceCatalogDevice, parameters: Record<string, string>) => void;
}

function storageKey(catalog: PdkDeviceCatalog, kind: 'favorites' | 'recent'): string {
  return `actoviq:pdk-device-browser:${catalog.pdk_ref || 'unbound'}:${kind}`;
}

function readStoredIds(catalog: PdkDeviceCatalog, kind: 'favorites' | 'recent'): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(catalog, kind)) || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function PdkDeviceBrowser({ catalog, busy, onClose, onPlace }: Props) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [favorites, setFavorites] = useState<string[]>(() => readStoredIds(catalog, 'favorites'));
  const [recent, setRecent] = useState<string[]>(() => readStoredIds(catalog, 'recent'));
  const [selectedId, setSelectedId] = useState(catalog.devices[0]?.device_id || '');
  const selectedDevice = catalog.devices.find((device) => device.device_id === selectedId) || null;
  const [parameters, setParameters] = useState<Record<string, string>>(() => (
    selectedDevice ? pdkDeviceDefaults(selectedDevice, catalog) : {}
  ));

  useEffect(() => {
    localStorage.setItem(storageKey(catalog, 'favorites'), JSON.stringify(favorites));
  }, [catalog, favorites]);

  useEffect(() => {
    localStorage.setItem(storageKey(catalog, 'recent'), JSON.stringify(recent));
  }, [catalog, recent]);

  const categories = useMemo(() => [
    'All',
    ...new Set(catalog.devices.map(pdkDeviceCategory)),
  ], [catalog.devices]);
  const devices = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return catalog.devices
      .filter((device) => category === 'All' || pdkDeviceCategory(device) === category)
      .filter((device) => !favoritesOnly || favorites.includes(device.device_id))
      .filter((device) => !needle || [
        device.device_id,
        device.kind,
        device.spice?.model,
        pdkDeviceCategory(device),
      ].some((value) => String(value || '').toLowerCase().includes(needle)))
      .sort((left, right) => {
        const leftRecent = recent.indexOf(left.device_id);
        const rightRecent = recent.indexOf(right.device_id);
        if (leftRecent >= 0 || rightRecent >= 0) {
          if (leftRecent < 0) return 1;
          if (rightRecent < 0) return -1;
          return leftRecent - rightRecent;
        }
        return left.device_id.localeCompare(right.device_id);
      });
  }, [catalog.devices, category, favorites, favoritesOnly, query, recent]);
  const diagnostics = selectedDevice
    ? validatePdkDeviceParameters(selectedDevice, catalog, parameters)
    : [];
  const hasErrors = diagnostics.some((item) => item.severity === 'error');
  const parameterFields = selectedDevice
    ? Object.keys(selectedDevice.parameters || {})
    : [];

  function selectDevice(device: PdkDeviceCatalogDevice) {
    setSelectedId(device.device_id);
    setParameters(pdkDeviceDefaults(device, catalog));
  }

  function toggleFavorite(deviceId: string) {
    setFavorites((current) => (
      current.includes(deviceId)
        ? current.filter((value) => value !== deviceId)
        : [...current, deviceId]
    ));
  }

  function placeSelected() {
    if (!selectedDevice || hasErrors) return;
    const nextRecent = [
      selectedDevice.device_id,
      ...recent.filter((value) => value !== selectedDevice.device_id),
    ].slice(0, 8);
    setRecent(nextRecent);
    onPlace(selectedDevice, parameters);
  }

  return (
    <section
      style={styles.shell}
      data-testid="schematic-pdk-device-browser"
      data-pdk-ref={catalog.pdk_ref || ''}
      aria-label="PDK device browser"
    >
      <header style={styles.header}>
        <div>
          <strong>PDK devices</strong>
          <div style={styles.meta}>
            {catalog.pdk_ref || 'Unbound'}
            {catalog.binding?.installation_version ? ` · ${catalog.binding.installation_version}` : ''}
          </div>
        </div>
        <button type="button" style={styles.close} onClick={onClose} aria-label="Close PDK browser">×</button>
      </header>
      <div style={styles.filters}>
        <input
          style={styles.input}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search device or model"
          data-testid="schematic-pdk-search"
          autoFocus
        />
        <select
          style={styles.input}
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          data-testid="schematic-pdk-category"
        >
          {categories.map((value) => <option key={value}>{value}</option>)}
        </select>
        <label style={styles.favoriteFilter}>
          <input
            type="checkbox"
            checked={favoritesOnly}
            onChange={(event) => setFavoritesOnly(event.target.checked)}
          />
          Favorites
        </label>
      </div>
      <div style={styles.body}>
        <div style={styles.results} data-testid="schematic-pdk-results">
          {devices.length === 0 ? <div style={styles.empty}>No matching devices.</div> : null}
          {devices.map((device) => {
            const supported = Boolean(pdkDeviceToolType(device));
            return (
              <div
                key={device.device_id}
                style={{
                  ...styles.deviceRow,
                  ...(selectedId === device.device_id ? styles.deviceRowSelected : {}),
                }}
              >
                <button
                  type="button"
                  style={styles.deviceMain}
                  onClick={() => selectDevice(device)}
                  data-testid={`schematic-pdk-device-${device.device_id}`}
                >
                  <strong>{device.device_id}</strong>
                  <span>{pdkDeviceCategory(device)} · {device.spice?.model || 'model missing'}</span>
                  <small>{supported ? (device.views?.generic_fallback ? `symbol ${device.views.generic_fallback}` : 'catalog symbol') : 'unsupported primitive'}</small>
                </button>
                <button
                  type="button"
                  style={styles.favoriteButton}
                  onClick={() => toggleFavorite(device.device_id)}
                  aria-label={`${favorites.includes(device.device_id) ? 'Remove' : 'Add'} ${device.device_id} favorite`}
                  data-testid={`schematic-pdk-favorite-${device.device_id}`}
                >
                  {favorites.includes(device.device_id) ? '★' : '☆'}
                </button>
              </div>
            );
          })}
        </div>
        <div style={styles.detail}>
          {selectedDevice ? (
            <>
              <strong>{selectedDevice.device_id}</strong>
              <div style={styles.meta}>
                Pins {(selectedDevice.spice?.pin_order || selectedDevice.pins || []).join(' → ') || 'unverified'}
              </div>
              <label style={styles.field}>
                Model
                <input
                  style={styles.input}
                  value={parameters.model || ''}
                  onChange={(event) => setParameters((current) => ({ ...current, model: event.target.value }))}
                  data-testid="schematic-pdk-param-model"
                />
              </label>
              <label style={styles.field}>
                Corner
                <input
                  style={styles.input}
                  value={parameters.corner || ''}
                  onChange={(event) => setParameters((current) => ({ ...current, corner: event.target.value }))}
                  list="schematic-pdk-corners"
                  data-testid="schematic-pdk-param-corner"
                />
                <datalist id="schematic-pdk-corners">
                  {(catalog.binding?.corner_sweep || []).map((value) => <option key={value} value={value} />)}
                </datalist>
              </label>
              <div style={styles.parameterGrid}>
                {parameterFields.map((field) => (
                  <label key={field} style={styles.field}>
                    {field.toUpperCase()}
                    <input
                      style={styles.input}
                      value={parameters[field] || ''}
                      onChange={(event) => setParameters((current) => ({
                        ...current,
                        [field]: event.target.value,
                      }))}
                      data-testid={`schematic-pdk-param-${field}`}
                    />
                  </label>
                ))}
              </div>
              <div style={styles.diagnostics} data-testid="schematic-pdk-diagnostics">
                {diagnostics.map((diagnostic, index) => (
                  <div
                    key={`${diagnostic.code}-${diagnostic.field || ''}-${index}`}
                    style={diagnostic.severity === 'error' ? styles.error : styles.warning}
                    data-code={diagnostic.code}
                  >
                    {diagnostic.message}
                  </div>
                ))}
              </div>
              <button
                type="button"
                style={styles.place}
                disabled={busy || hasErrors}
                onClick={placeSelected}
                data-testid="schematic-pdk-place"
              >
                Place {selectedDevice.device_id}
              </button>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

const styles: Record<string, CSSProperties> = {
  shell: {
    position: 'absolute',
    zIndex: 18,
    left: 12,
    top: 62,
    width: 'min(660px, calc(100% - 24px))',
    maxHeight: 'calc(100% - 74px)',
    overflow: 'auto',
    border: '1px solid #cbd5e1',
    borderRadius: 8,
    background: '#ffffff',
    boxShadow: '0 14px 32px rgba(15, 23, 42, 0.2)',
    color: '#172033',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 12px',
    borderBottom: '1px solid #e2e8f0',
  },
  close: { border: 0, background: 'transparent', fontSize: 22, cursor: 'pointer', color: '#64748b' },
  meta: { fontSize: 10, color: '#64748b', marginTop: 2 },
  filters: {
    display: 'grid',
    gridTemplateColumns: 'minmax(160px, 1fr) 130px auto',
    gap: 8,
    alignItems: 'center',
    padding: '9px 12px',
    borderBottom: '1px solid #e2e8f0',
  },
  input: {
    minWidth: 0,
    border: '1px solid #cbd5e1',
    borderRadius: 4,
    padding: '6px 7px',
    background: '#fff',
    color: '#172033',
    fontSize: 11,
  },
  favoriteFilter: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, whiteSpace: 'nowrap' },
  body: { display: 'grid', gridTemplateColumns: 'minmax(220px, 0.9fr) minmax(260px, 1.1fr)', minHeight: 310 },
  results: { borderRight: '1px solid #e2e8f0', maxHeight: 430, overflow: 'auto', padding: 6 },
  empty: { padding: 12, color: '#64748b', fontSize: 11 },
  deviceRow: { display: 'flex', alignItems: 'stretch', borderRadius: 5, marginBottom: 3 },
  deviceRowSelected: { background: '#eff6ff', outline: '1px solid #93c5fd' },
  deviceMain: {
    flex: 1,
    minWidth: 0,
    display: 'grid',
    gap: 2,
    padding: '7px 8px',
    border: 0,
    background: 'transparent',
    textAlign: 'left',
    cursor: 'pointer',
    color: '#172033',
  },
  favoriteButton: { width: 32, border: 0, background: 'transparent', color: '#b45309', cursor: 'pointer', fontSize: 17 },
  detail: { display: 'grid', alignContent: 'start', gap: 8, padding: 12 },
  field: { display: 'grid', gap: 3, fontSize: 10, fontWeight: 700, color: '#536172' },
  parameterGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 },
  diagnostics: { display: 'grid', gap: 4 },
  error: { padding: '5px 7px', borderRadius: 4, background: '#fef2f2', color: '#b91c1c', fontSize: 10 },
  warning: { padding: '5px 7px', borderRadius: 4, background: '#fff7ed', color: '#9a3412', fontSize: 10 },
  place: {
    border: '1px solid #2563eb',
    borderRadius: 5,
    background: '#2563eb',
    color: '#fff',
    padding: '7px 10px',
    fontWeight: 700,
    cursor: 'pointer',
  },
};
