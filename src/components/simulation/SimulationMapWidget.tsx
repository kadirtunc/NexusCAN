'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Crosshair,
  Lock,
  Minus,
  Navigation,
  Play,
  Plus,
  Square,
  Trash2,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import type { DatabaseSchemaDto } from '../../types/netdb';
import type {
  SimulationMapTileStyle,
  SimulationSignalBindingDto,
  SimulationWidgetDto,
} from '../../types/simulation';
import { useDatabaseStore } from '../../store/databaseStore';
import type { SimulationRuntimeBus } from './simulationRuntimeBus';
import type { SimulationTelemetrySource } from './SimulationWidgets';
import { ACCENT_HEX_MAP, makeSignalBusKey } from './virtualCanPacking';

export interface SimulationMapWidgetProps {
  widget: SimulationWidgetDto;
  runtimeBus: SimulationRuntimeBus;
  isRunMode: boolean;
  telemetrySource: SimulationTelemetrySource;
  activeSchema: DatabaseSchemaDto | null;
  allBindings: readonly SimulationSignalBindingDto[];
}

interface GpsPoint {
  lat: number;
  lon: number;
}

interface HudTelemetrySnapshot {
  lat: number;
  lon: number;
  headingDeg: number | null;
  speedVal: number | null;
  speedUnit: string;
  trailCount: number;
  hasLiveFix: boolean;
}

interface TileCacheEntry {
  key: string;
  status: 'loading' | 'ready' | 'error';
  img: HTMLImageElement;
  retriedWithoutCors: boolean;
  listeners: Set<() => void>;
}

const TILE_SIZE_PX = 256;
const MAX_MERCATOR_LAT = 85.05112878;
const MIN_INTERACTIVE_ZOOM = 2;
const MAX_INTERACTIVE_ZOOM = 19;
const MAX_TILE_CACHE_ENTRIES = 256;

const DEFAULT_CENTER_LAT = 41.0082;
const DEFAULT_CENTER_LON = 28.9784;
const DEFAULT_ZOOM = 15;
const DEFAULT_TRAIL_MAX_POINTS = 400;

/**
 * Module-level bounded LRU cache for 256x256 XYZ Web Mercator tiles.
 * Never accessed at SSR module-evaluation time; populated strictly on client canvas paint.
 */
const globalTileLruCache = new Map<string, TileCacheEntry>();

function clampLat(lat: number): number {
  if (!Number.isFinite(lat)) return DEFAULT_CENTER_LAT;
  return Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
}

function wrapLon(lon: number): number {
  if (!Number.isFinite(lon)) return DEFAULT_CENTER_LON;
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

function clampZoom(z: number, minZ = 1, maxZ = MAX_INTERACTIVE_ZOOM): number {
  if (!Number.isFinite(z)) return DEFAULT_ZOOM;
  return Math.max(minZ, Math.min(maxZ, Math.round(z)));
}

function lonToWorldX(lon: number, zoom: number): number {
  const worldPx = TILE_SIZE_PX * Math.pow(2, zoom);
  return ((wrapLon(lon) + 180) / 360) * worldPx;
}

function latToWorldY(lat: number, zoom: number): number {
  const worldPx = TILE_SIZE_PX * Math.pow(2, zoom);
  const clamped = clampLat(lat);
  const sinLat = Math.sin((clamped * Math.PI) / 180);
  const mercY = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
  return mercY * worldPx;
}

function worldXToLon(worldX: number, zoom: number): number {
  const worldPx = TILE_SIZE_PX * Math.pow(2, zoom);
  const rawLon = (worldX / worldPx) * 360 - 180;
  return wrapLon(rawLon);
}

function worldYToLat(worldY: number, zoom: number): number {
  const worldPx = TILE_SIZE_PX * Math.pow(2, zoom);
  const normY = Math.max(0, Math.min(1, worldY / worldPx));
  const n = Math.PI - 2 * Math.PI * normY;
  const latDeg = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return clampLat(latDeg);
}

export function computeCompassBearingDeg(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dLambda = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

function resolveTileUrl(
  style: SimulationMapTileStyle,
  customUrl: string | undefined,
  z: number,
  x: number,
  y: number
): { url: string; cachePrefix: string } {
  if (style === 'custom' && customUrl && customUrl.trim().length > 0) {
    const trimmed = customUrl.trim();
    if (
      trimmed.includes('{z}') &&
      trimmed.includes('{x}') &&
      trimmed.includes('{y}')
    ) {
      const url = trimmed
        .replace('{s}', 'a')
        .replace('{z}', String(z))
        .replace('{x}', String(x))
        .replace('{y}', String(y));
      return { url, cachePrefix: `custom:${trimmed}` };
    }
  }

  switch (style) {
    case 'osm_dark':
      return {
        url: `https://a.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`,
        cachePrefix: 'osm_dark',
      };
    case 'osm_hot':
      return {
        url: `https://a.tile.openstreetmap.fr/hot/${z}/${x}/${y}.png`,
        cachePrefix: 'osm_hot',
      };
    case 'osm_standard':
    case 'custom':
    default:
      return {
        url: `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
        cachePrefix: 'osm_standard',
      };
  }
}

function getCachedReadyTile(
  cachePrefix: string,
  z: number,
  x: number,
  y: number
): HTMLImageElement | null {
  const key = `${cachePrefix}::${z}/${x}/${y}`;
  const entry = globalTileLruCache.get(key);
  if (!entry || entry.status !== 'ready') return null;
  // Touch LRU order
  globalTileLruCache.delete(key);
  globalTileLruCache.set(key, entry);
  return entry.img;
}

function requestSlippyTile(
  style: SimulationMapTileStyle,
  customUrl: string | undefined,
  z: number,
  x: number,
  y: number,
  onLoaded: () => void
): { entry: TileCacheEntry | null; cachePrefix: string } {
  const { url, cachePrefix } = resolveTileUrl(style, customUrl, z, x, y);
  if (typeof window === 'undefined') {
    return { entry: null, cachePrefix };
  }

  const key = `${cachePrefix}::${z}/${x}/${y}`;
  const existing = globalTileLruCache.get(key);
  if (existing) {
    globalTileLruCache.delete(key);
    globalTileLruCache.set(key, existing);
    if (existing.status === 'loading') {
      existing.listeners.add(onLoaded);
    }
    return { entry: existing, cachePrefix };
  }

  // Evict least-recently-used tiles when exceeding cap
  while (globalTileLruCache.size >= MAX_TILE_CACHE_ENTRIES) {
    const oldestKey = globalTileLruCache.keys().next().value;
    if (oldestKey === undefined) break;
    globalTileLruCache.delete(oldestKey);
  }

  const img = new window.Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';

  const entry: TileCacheEntry = {
    key,
    status: 'loading',
    img,
    retriedWithoutCors: false,
    listeners: new Set([onLoaded]),
  };

  const notifyAll = () => {
    const callbacks = Array.from(entry.listeners);
    entry.listeners.clear();
    for (const cb of callbacks) {
      cb();
    }
  };

  img.onload = () => {
    entry.status = 'ready';
    notifyAll();
  };

  img.onerror = () => {
    // If a custom tile server lacks CORS headers, retry without crossOrigin
    // (safe because we never invoke getImageData/toDataURL on the map canvas)
    if (!entry.retriedWithoutCors) {
      entry.retriedWithoutCors = true;
      const retryImg = new window.Image();
      retryImg.decoding = 'async';
      entry.img = retryImg;
      retryImg.onload = () => {
        entry.status = 'ready';
        notifyAll();
      };
      retryImg.onerror = () => {
        entry.status = 'error';
        notifyAll();
      };
      retryImg.src = url;
      return;
    }
    entry.status = 'error';
    notifyAll();
  };

  globalTileLruCache.set(key, entry);
  img.src = url;
  return { entry, cachePrefix };
}

function convertSpeedToBindingUnit(
  speedMps: number,
  unitRaw: string | undefined
): number {
  const u = (unitRaw ?? '').trim().toLowerCase();
  if (u === 'm/s' || u === 'mps') return speedMps;
  if (u === 'mph') return speedMps * 2.236936;
  if (u === 'kn' || u === 'kt' || u === 'knots') return speedMps * 1.943844;
  return speedMps * 3.6; // Default km/h
}

export function SimulationMapWidget({
  widget,
  runtimeBus,
  isRunMode,
  telemetrySource,
  activeSchema,
  allBindings,
}: SimulationMapWidgetProps): React.JSX.Element {
  const { t } = useI18n();
  const theme = useDatabaseStore().theme;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const repaintTriggerRef = useRef<(() => void) | null>(null);

  const latBinding = widget.binding;
  const lonBinding = widget.config.lonBinding ?? null;
  const headingBinding = widget.config.headingBinding ?? null;
  const speedBinding = widget.config.speedBinding ?? null;

  const latKey = useMemo(
    () =>
      latBinding
        ? makeSignalBusKey(latBinding.messageKey, latBinding.signalName)
        : null,
    [latBinding]
  );
  const lonKey = useMemo(
    () =>
      lonBinding
        ? makeSignalBusKey(lonBinding.messageKey, lonBinding.signalName)
        : null,
    [lonBinding]
  );
  const headingKey = useMemo(
    () =>
      headingBinding
        ? makeSignalBusKey(headingBinding.messageKey, headingBinding.signalName)
        : null,
    [headingBinding]
  );
  const speedKey = useMemo(
    () =>
      speedBinding
        ? makeSignalBusKey(speedBinding.messageKey, speedBinding.signalName)
        : null,
    [speedBinding]
  );

  const hasLatLonBindings = latKey !== null && lonKey !== null;
  const canStimulateGps = isRunMode && telemetrySource === 'virtual';
  const isLiveBridgeReadOnly = isRunMode && telemetrySource === 'live_bridge';

  const cfgCenterLat = clampLat(
    widget.config.mapCenterLat ?? DEFAULT_CENTER_LAT
  );
  const cfgCenterLon = wrapLon(
    widget.config.mapCenterLon ?? DEFAULT_CENTER_LON
  );
  const cfgZoom = clampZoom(widget.config.mapZoom ?? DEFAULT_ZOOM, 1, 19);
  const cfgTileStyle: SimulationMapTileStyle =
    widget.config.mapTileStyle ?? 'osm_standard';
  const cfgCustomTileUrl = widget.config.mapCustomTileUrl;
  const cfgShowTrail = widget.config.mapShowTrail ?? true;
  const cfgTrailMaxPoints = Math.max(
    10,
    Math.min(5000, widget.config.mapTrailMaxPoints ?? DEFAULT_TRAIL_MAX_POINTS)
  );
  const cfgClickToSimulate = widget.config.mapClickToSimulate ?? true;

  // Interactive runtime state (toolbar overrides in RUN mode; synced when config changes in DESIGN)
  const [activeTileStyle, setActiveTileStyle] =
    useState<SimulationMapTileStyle>(cfgTileStyle);
  const [zoom, setZoom] = useState<number>(cfgZoom);
  const [followLocked, setFollowLocked] = useState<boolean>(
    widget.config.mapAutoFollow ?? true
  );
  const [driveLoopActive, setDriveLoopActive] = useState<boolean>(false);

  // Sync interactive state whenever designer updates widget.config
  useEffect(() => {
    setActiveTileStyle(cfgTileStyle);
  }, [cfgTileStyle]);

  useEffect(() => {
    setZoom(cfgZoom);
  }, [cfgZoom]);

  useEffect(() => {
    setFollowLocked(widget.config.mapAutoFollow ?? true);
  }, [widget.config.mapAutoFollow]);

  // Mutable camera & telemetry refs for zero-jitter 60 FPS canvas loop
  const viewCenterRef = useRef<GpsPoint>({
    lat: cfgCenterLat,
    lon: cfgCenterLon,
  });
  const zoomRef = useRef<number>(cfgZoom);
  zoomRef.current = zoom;

  const followLockedRef = useRef<boolean>(followLocked);
  followLockedRef.current = followLocked;

  const trailRef = useRef<GpsPoint[]>([]);
  const computedBearingRef = useRef<number>(0);
  const lastElapsedSecRef = useRef<number>(0);

  // Unbound local preview GPS state so operator can test clicking/looping even before binding DBC
  const unboundPreviewPosRef = useRef<GpsPoint | null>(null);
  const unboundPreviewSpeedRef = useRef<number | null>(null);

  // Keep view center synced when designer edits Default Center in DESIGN mode
  useEffect(() => {
    if (!isRunMode) {
      viewCenterRef.current = { lat: cfgCenterLat, lon: cfgCenterLon };
      repaintTriggerRef.current?.();
    }
  }, [cfgCenterLat, cfgCenterLon, isRunMode]);

  // Safety lock: immediately halt virtual drive loop if leaving VIRTUAL BUS + RUN mode
  useEffect(() => {
    if (!canStimulateGps && driveLoopActive) {
      setDriveLoopActive(false);
      unboundPreviewSpeedRef.current = null;
    }
  }, [canStimulateGps, driveLoopActive]);

  const [hud, setHud] = useState<HudTelemetrySnapshot>({
    lat: cfgCenterLat,
    lon: cfgCenterLon,
    headingDeg: null,
    speedVal: null,
    speedUnit: speedBinding?.unit || 'km/h',
    trailCount: 0,
    hasLiveFix: false,
  });

  // Latest bindings/schema ref for drive-loop & click stimulus without restarting effects unnecessarily
  const stimulusDepsRef = useRef({
    latBinding,
    lonBinding,
    headingBinding,
    speedBinding,
    allBindings,
    activeSchema,
  });
  stimulusDepsRef.current = {
    latBinding,
    lonBinding,
    headingBinding,
    speedBinding,
    allBindings,
    activeSchema,
  };

  const writeGpsStimulusBatch = useCallback(
    (
      nextLat: number,
      nextLon: number,
      nextHeadingDeg?: number | null,
      nextSpeedMps?: number | null
    ) => {
      if (!canStimulateGps) return;
      const deps = stimulusDepsRef.current;
      const clampedLat = Number(clampLat(nextLat).toFixed(6));
      const wrappedLon = Number(wrapLon(nextLon).toFixed(6));

      unboundPreviewPosRef.current = { lat: clampedLat, lon: wrappedLon };
      if (typeof nextHeadingDeg === 'number' && Number.isFinite(nextHeadingDeg)) {
        computedBearingRef.current = ((nextHeadingDeg % 360) + 360) % 360;
      }
      if (typeof nextSpeedMps === 'number' && Number.isFinite(nextSpeedMps)) {
        unboundPreviewSpeedRef.current = convertSpeedToBindingUnit(
          nextSpeedMps,
          deps.speedBinding?.unit
        );
      }

      const writes: Array<{
        binding: SimulationSignalBindingDto;
        val: number;
      }> = [];
      if (deps.latBinding) {
        writes.push({ binding: deps.latBinding, val: clampedLat });
      }
      if (deps.lonBinding) {
        writes.push({ binding: deps.lonBinding, val: wrappedLon });
      }
      if (
        deps.headingBinding &&
        typeof nextHeadingDeg === 'number' &&
        Number.isFinite(nextHeadingDeg)
      ) {
        writes.push({
          binding: deps.headingBinding,
          val: Number((((nextHeadingDeg % 360) + 360) % 360).toFixed(1)),
        });
      }
      if (
        deps.speedBinding &&
        typeof nextSpeedMps === 'number' &&
        Number.isFinite(nextSpeedMps)
      ) {
        const unitSpeed = convertSpeedToBindingUnit(
          nextSpeedMps,
          deps.speedBinding.unit
        );
        writes.push({
          binding: deps.speedBinding,
          val: Number(unitSpeed.toFixed(1)),
        });
      }

      writes.forEach((item, idx) => {
        const isLast = idx === writes.length - 1;
        runtimeBus.writeStimulus(
          item.binding,
          item.val,
          isLast
            ? {
                allBindings: deps.allBindings,
                schema: deps.activeSchema,
              }
            : undefined
        );
      });

      repaintTriggerRef.current?.();
    },
    [canStimulateGps, runtimeBus]
  );

  // Virtual Test-Track [DRIVE LOOP] (~50 km/h closed circuit around current center)
  useEffect(() => {
    if (!driveLoopActive || !canStimulateGps) {
      unboundPreviewSpeedRef.current = null;
      return;
    }

    // Anchor track center around current valid GNSS position or map view center
    let originLat = viewCenterRef.current.lat;
    let originLon = viewCenterRef.current.lon;
    if (latKey && lonKey) {
      const busLat = runtimeBus.getValue(latKey, 0);
      const busLon = runtimeBus.getValue(lonKey, 0);
      if (Math.abs(busLat) > 1e-5 || Math.abs(busLon) > 1e-5) {
        originLat = clampLat(busLat);
        originLon = wrapLon(busLon);
      }
    }

    const metersPerDegLat = 111_132;
    const metersPerDegLon = Math.max(
      12_000,
      111_320 * Math.cos((originLat * Math.PI) / 180)
    );

    // Proving-ground rounded circuit (~210m x 125m) driven at ~50 km/h (~13.89 m/s)
    const radiusEastM = 210;
    const radiusNorthM = 125;
    const harmonicNorthM = 24;

    let phaseRad = 0;
    let lastMs = performance.now();
    let rafId = 0;

    const stepLoop = (nowMs: number) => {
      const dtSec = Math.min(0.1, Math.max(0.001, (nowMs - lastMs) / 1000));
      lastMs = nowMs;

      // Realistic speed profile: ~53 km/h on straights, ~46 km/h through turns (avg ~50 km/h)
      const targetSpeedMps = 13.89 + 1.15 * Math.cos(2 * phaseRad);

      // Analytic curve derivatives with respect to phaseRad:
      // east(p)  = -R_e * (1 - cos(p))  (starts right at origin when p = 0!)
      // north(p) = R_n * sin(p) + H_n * sin(2p)
      const dEastDp = -radiusEastM * Math.sin(phaseRad);
      const dNorthDp =
        radiusNorthM * Math.cos(phaseRad) +
        2 * harmonicNorthM * Math.cos(2 * phaseRad);
      const dsDp = Math.max(1, Math.hypot(dEastDp, dNorthDp));

      phaseRad = (phaseRad + (targetSpeedMps * dtSec) / dsDp) % (Math.PI * 2);

      const eastM = radiusEastM * (Math.cos(phaseRad) - 1);
      const northM =
        radiusNorthM * Math.sin(phaseRad) +
        harmonicNorthM * Math.sin(2 * phaseRad);

      const nextDeadEast = -radiusEastM * Math.sin(phaseRad);
      const nextDeadNorth =
        radiusNorthM * Math.cos(phaseRad) +
        2 * harmonicNorthM * Math.cos(2 * phaseRad);
      const headingDeg =
        (((Math.atan2(nextDeadEast, nextDeadNorth) * 180) / Math.PI) % 360 +
          360) %
        360;

      const simLat = originLat + northM / metersPerDegLat;
      const simLon = wrapLon(originLon + eastM / metersPerDegLon);

      writeGpsStimulusBatch(simLat, simLon, headingDeg, targetSpeedMps);
      rafId = window.requestAnimationFrame(stepLoop);
    };

    rafId = window.requestAnimationFrame(stepLoop);
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [canStimulateGps, driveLoopActive, latKey, lonKey, runtimeBus, writeGpsStimulusBatch]);

  // Resolve active GPS coordinates from runtimeBus (or fallback center)
  const readActiveTelemetry = useCallback(() => {
    let activeLat = cfgCenterLat;
    let activeLon = cfgCenterLon;
    let hasLiveFix = false;

    if (latKey && lonKey) {
      const rawLat = runtimeBus.getValue(latKey, 0);
      const rawLon = runtimeBus.getValue(lonKey, 0);
      if (Math.abs(rawLat) > 1e-5 || Math.abs(rawLon) > 1e-5) {
        activeLat = clampLat(rawLat);
        activeLon = wrapLon(rawLon);
        hasLiveFix = true;
      }
    } else if (unboundPreviewPosRef.current) {
      activeLat = unboundPreviewPosRef.current.lat;
      activeLon = unboundPreviewPosRef.current.lon;
      hasLiveFix = true;
    }

    let headingDeg: number | null = null;
    if (headingKey) {
      const rawHdg = runtimeBus.getValue(headingKey, 0);
      headingDeg = ((rawHdg % 360) + 360) % 360;
    } else if (hasLiveFix) {
      headingDeg = computedBearingRef.current;
    }

    let speedVal: number | null = null;
    if (speedKey) {
      speedVal = runtimeBus.getValue(speedKey, 0);
    } else if (unboundPreviewSpeedRef.current !== null) {
      speedVal = unboundPreviewSpeedRef.current;
    }

    return { activeLat, activeLon, headingDeg, speedVal, hasLiveFix };
  }, [cfgCenterLat, cfgCenterLon, headingKey, latKey, lonKey, runtimeBus, speedKey]);

  // Main 60 FPS Canvas Slippy Map + GNSS Telemetry Renderer
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    let widthCss = Math.max(140, container.clientWidth || 360);
    let heightCss = Math.max(100, container.clientHeight || 220);

    const syncCanvasSize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      widthCss = Math.max(140, container.clientWidth || 360);
      heightCss = Math.max(100, container.clientHeight || 220);
      canvas.width = Math.floor(widthCss * dpr);
      canvas.height = Math.floor(heightCss * dpr);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    };

    syncCanvasSize();

    let rafId = 0;
    let pendingSinglePaint = false;
    let tickCounter = 0;

    const scheduleSingleRepaint = () => {
      if (isRunMode || pendingSinglePaint) return;
      pendingSinglePaint = true;
      rafId = window.requestAnimationFrame(() => {
        pendingSinglePaint = false;
        renderMapFrame();
      });
    };
    repaintTriggerRef.current = () => {
      if (!isRunMode) {
        scheduleSingleRepaint();
      }
    };

    const ro = new ResizeObserver(() => {
      syncCanvasSize();
      scheduleSingleRepaint();
    });
    ro.observe(container);

    const onTileLoaded = () => {
      if (!isRunMode) {
        scheduleSingleRepaint();
      }
    };

    const renderMapFrame = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        if (isRunMode) {
          rafId = window.requestAnimationFrame(renderMapFrame);
        }
        return;
      }

      // Detect bus reset so stale trails don't connect across resets
      const elapsedSec = runtimeBus.getElapsedSec();
      if (elapsedSec + 0.05 < lastElapsedSecRef.current) {
        trailRef.current = [];
        unboundPreviewPosRef.current = null;
      }
      lastElapsedSecRef.current = elapsedSec;

      const { activeLat, activeLon, headingDeg, speedVal, hasLiveFix } =
        readActiveTelemetry();

      // Append breadcrumb trail whenever valid (lat, lon) moves by > 1e-6 deg
      if (hasLiveFix && Number.isFinite(activeLat) && Number.isFinite(activeLon)) {
        const trail = trailRef.current;
        const prevPt = trail[trail.length - 1];
        if (!prevPt) {
          trail.push({ lat: activeLat, lon: activeLon });
        } else {
          const dLat = Math.abs(activeLat - prevPt.lat);
          const dLon = Math.abs(activeLon - prevPt.lon);
          if (dLat > 1e-6 || dLon > 1e-6) {
            if (!headingKey) {
              computedBearingRef.current = computeCompassBearingDeg(
                prevPt.lat,
                prevPt.lon,
                activeLat,
                activeLon
              );
            }
            trail.push({ lat: activeLat, lon: activeLon });
            if (trail.length > cfgTrailMaxPoints) {
              trail.splice(0, trail.length - cfgTrailMaxPoints);
            }
          }
        }
      }

      // Auto-follow smooth camera lock
      if (followLockedRef.current) {
        const targetLat = hasLiveFix ? activeLat : cfgCenterLat;
        const targetLon = hasLiveFix ? activeLon : cfgCenterLon;
        if (isRunMode) {
          const cur = viewCenterRef.current;
          const dLat = targetLat - cur.lat;
          const dLon = wrapLon(targetLon - cur.lon);
          if (Math.abs(dLat) > 0.5 || Math.abs(dLon) > 0.5) {
            viewCenterRef.current = { lat: targetLat, lon: targetLon };
          } else {
            viewCenterRef.current = {
              lat: clampLat(cur.lat + dLat * 0.28),
              lon: wrapLon(cur.lon + dLon * 0.28),
            };
          }
        } else {
          viewCenterRef.current = { lat: targetLat, lon: targetLon };
        }
      }

      const curZoom = zoomRef.current;
      const numTiles = 1 << curZoom;
      const worldPx = TILE_SIZE_PX * numTiles;
      const centerWorldX = lonToWorldX(viewCenterRef.current.lon, curZoom);
      const centerWorldY = latToWorldY(viewCenterRef.current.lat, curZoom);
      const topLeftWorldX = centerWorldX - widthCss * 0.5;
      const topLeftWorldY = centerWorldY - heightCss * 0.5;

      // 1. Base Coordinate Graticule Background (shown while tiles load or offline)
      const isDarkSurface =
        activeTileStyle === 'osm_dark' || theme === 'dark';
      ctx.fillStyle = isDarkSurface ? '#0f141c' : '#dde4ec';
      ctx.fillRect(0, 0, widthCss, heightCss);

      const gridHairline = isDarkSurface
        ? 'rgba(139, 148, 158, 0.14)'
        : 'rgba(51, 65, 85, 0.14)';
      ctx.strokeStyle = gridHairline;
      ctx.lineWidth = 1;

      const startTileX = Math.floor(topLeftWorldX / TILE_SIZE_PX);
      const endTileX = Math.floor((topLeftWorldX + widthCss) / TILE_SIZE_PX);
      const startTileY = Math.floor(topLeftWorldY / TILE_SIZE_PX);
      const endTileY = Math.floor((topLeftWorldY + heightCss) / TILE_SIZE_PX);

      ctx.beginPath();
      for (let tx = startTileX; tx <= endTileX + 1; tx += 1) {
        const sx = Math.round(tx * TILE_SIZE_PX - topLeftWorldX) + 0.5;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, heightCss);
      }
      for (let ty = startTileY; ty <= endTileY + 1; ty += 1) {
        const sy = Math.round(ty * TILE_SIZE_PX - topLeftWorldY) + 0.5;
        ctx.moveTo(0, sy);
        ctx.lineTo(widthCss, sy);
      }
      ctx.stroke();

      // 2. Render 256x256 XYZ Web Mercator Tiles from LRU Cache
      let missingTiles = 0;
      for (let ty = startTileY; ty <= endTileY; ty += 1) {
        if (ty < 0 || ty >= numTiles) continue;
        const drawY = Math.round(ty * TILE_SIZE_PX - topLeftWorldY);

        for (let tx = startTileX; tx <= endTileX; tx += 1) {
          const wrappedTx = ((tx % numTiles) + numTiles) % numTiles;
          const drawX = Math.round(tx * TILE_SIZE_PX - topLeftWorldX);

          const { entry, cachePrefix } = requestSlippyTile(
            activeTileStyle,
            cfgCustomTileUrl,
            curZoom,
            wrappedTx,
            ty,
            onTileLoaded
          );

          if (entry && entry.status === 'ready') {
            ctx.drawImage(entry.img, drawX, drawY, TILE_SIZE_PX, TILE_SIZE_PX);
          } else {
            missingTiles += 1;
            // Smooth parent-zoom quadrant fallback while tile is downloading
            if (curZoom > 1) {
              const parentImg = getCachedReadyTile(
                cachePrefix,
                curZoom - 1,
                Math.floor(wrappedTx / 2),
                Math.floor(ty / 2)
              );
              if (parentImg) {
                const subX = (wrappedTx % 2) * 128;
                const subY = (ty % 2) * 128;
                ctx.drawImage(
                  parentImg,
                  subX,
                  subY,
                  128,
                  128,
                  drawX,
                  drawY,
                  TILE_SIZE_PX,
                  TILE_SIZE_PX
                );
              }
            }
          }
        }
      }

      // If offline or tiles still loading, draw subtle lat/lon graticule labels
      if (missingTiles > 0) {
        ctx.fillStyle = isDarkSurface
          ? 'rgba(139, 148, 158, 0.55)'
          : 'rgba(51, 65, 85, 0.6)';
        ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'left';
        for (let tx = startTileX; tx <= endTileX; tx += 1) {
          const sx = Math.round(tx * TILE_SIZE_PX - topLeftWorldX);
          if (sx >= 6 && sx <= widthCss - 54) {
            const lonAtLine = worldXToLon(tx * TILE_SIZE_PX, curZoom);
            ctx.fillText(`${lonAtLine.toFixed(3)}°E`, sx + 4, heightCss - 22);
          }
        }
        for (let ty = startTileY; ty <= endTileY; ty += 1) {
          const sy = Math.round(ty * TILE_SIZE_PX - topLeftWorldY);
          if (sy >= 36 && sy <= heightCss - 26) {
            const latAtLine = worldYToLat(ty * TILE_SIZE_PX, curZoom);
            ctx.fillText(`${latAtLine.toFixed(3)}°N`, 6, sy - 4);
          }
        }
      }

      // Helper to project any (lat, lon) onto current canvas (choosing shortest wrap around worldPx)
      const projectToCanvas = (lat: number, lon: number): { x: number; y: number } => {
        let wx = lonToWorldX(lon, curZoom);
        const wy = latToWorldY(lat, curZoom);
        const diffX = wx - centerWorldX;
        if (diffX > worldPx * 0.5) wx -= worldPx;
        else if (diffX < -worldPx * 0.5) wx += worldPx;
        return {
          x: wx - topLeftWorldX,
          y: wy - topLeftWorldY,
        };
      };

      const accentHex =
        latBinding?.color || ACCENT_HEX_MAP[widget.accentColor] || '#38bdf8';

      // 3. Breadcrumb GPS Trail Polyline (glowing + crisp)
      const trail = trailRef.current;
      if (cfgShowTrail && trail.length >= 2) {
        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        // Outer low-glare halo
        ctx.strokeStyle = `${accentHex}45`;
        ctx.lineWidth = 5;
        ctx.beginPath();
        trail.forEach((pt, idx) => {
          const p = projectToCanvas(pt.lat, pt.lon);
          if (idx === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.stroke();

        // Crisp core telemetry line
        ctx.strokeStyle = accentHex;
        ctx.lineWidth = 2;
        ctx.beginPath();
        trail.forEach((pt, idx) => {
          const p = projectToCanvas(pt.lat, pt.lon);
          if (idx === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.stroke();

        // Origin fix square marker
        const originPx = projectToCanvas(trail[0]!.lat, trail[0]!.lon);
        ctx.fillStyle = '#0f141c';
        ctx.strokeStyle = accentHex;
        ctx.lineWidth = 1.5;
        ctx.fillRect(originPx.x - 3, originPx.y - 3, 6, 6);
        ctx.strokeRect(originPx.x - 3, originPx.y - 3, 6, 6);
        ctx.restore();
      }

      // 4. Directional GNSS Vehicle / Target Reticle Marker
      const markerLat = hasLiveFix ? activeLat : cfgCenterLat;
      const markerLon = hasLiveFix ? activeLon : cfgCenterLon;
      const markerPt = projectToCanvas(markerLat, markerLon);
      const markerRotRad = (((headingDeg ?? computedBearingRef.current) * Math.PI) / 180);

      if (
        markerPt.x >= -32 &&
        markerPt.x <= widthCss + 32 &&
        markerPt.y >= -32 &&
        markerPt.y <= heightCss + 32
      ) {
        ctx.save();
        ctx.translate(markerPt.x, markerPt.y);

        // Outer GNSS CEP range ring + cardinal ticks
        ctx.beginPath();
        ctx.arc(0, 0, 14, 0, Math.PI * 2);
        ctx.fillStyle = `${accentHex}24`;
        ctx.fill();
        ctx.lineWidth = 1.25;
        ctx.strokeStyle = accentHex;
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(0, -18);
        ctx.lineTo(0, -14);
        ctx.moveTo(0, 14);
        ctx.lineTo(0, 18);
        ctx.moveTo(-18, 0);
        ctx.lineTo(-14, 0);
        ctx.moveTo(14, 0);
        ctx.lineTo(18, 0);
        ctx.stroke();

        // Sharp directional navigation chevron rotated by heading / course
        ctx.rotate(markerRotRad);
        ctx.beginPath();
        ctx.moveTo(0, -11);
        ctx.lineTo(7.5, 8.5);
        ctx.lineTo(0, 4.2);
        ctx.lineTo(-7.5, 8.5);
        ctx.closePath();
        ctx.fillStyle = accentHex;
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = '#0b0e14';
        ctx.stroke();

        // High-contrast nose center pip
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-1.2, -5.5, 2.4, 2.4);

        ctx.restore();
      }

      // Throttle React HUD state updates to ~15Hz so DOM stays ultra-light
      tickCounter += 1;
      if (!isRunMode || tickCounter === 1 || tickCounter % 4 === 0) {
        const displayHeading =
          headingKey !== null || trailRef.current.length >= 2 || driveLoopActive
            ? headingDeg ?? computedBearingRef.current
            : null;
        setHud({
          lat: markerLat,
          lon: markerLon,
          headingDeg: displayHeading,
          speedVal,
          speedUnit: speedBinding?.unit || 'km/h',
          trailCount: trailRef.current.length,
          hasLiveFix,
        });
      }

      if (isRunMode) {
        rafId = window.requestAnimationFrame(renderMapFrame);
      }
    };

    renderMapFrame();
    if (isRunMode) {
      rafId = window.requestAnimationFrame(renderMapFrame);
    }

    // Subscribe to runtimeBus signal keys so paused / single-click stimulus repaints immediately
    const unsubs: Array<() => void> = [];
    for (const k of [latKey, lonKey, headingKey, speedKey]) {
      if (k) {
        unsubs.push(
          runtimeBus.subscribeKey(k, () => {
            if (!isRunMode) {
              scheduleSingleRepaint();
            }
          })
        );
      }
    }

    return () => {
      window.cancelAnimationFrame(rafId);
      ro.disconnect();
      repaintTriggerRef.current = null;
      for (const fn of unsubs) {
        fn();
      }
    };
  }, [
    activeTileStyle,
    cfgCenterLat,
    cfgCenterLon,
    cfgCustomTileUrl,
    cfgShowTrail,
    cfgTrailMaxPoints,
    driveLoopActive,
    followLocked,
    headingKey,
    isRunMode,
    latBinding?.color,
    latKey,
    lonKey,
    readActiveTelemetry,
    runtimeBus,
    speedBinding?.unit,
    speedKey,
    theme,
    widget.accentColor,
    zoom,
  ]);

  // Native non-passive wheel zoom in RUN mode (prevents outer workbench scroll)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !isRunMode) return;

    let wheelAccum = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      wheelAccum += e.deltaY;
      if (Math.abs(wheelAccum) < 40) return;

      const step = wheelAccum < 0 ? 1 : -1;
      wheelAccum = 0;

      const prevZ = zoomRef.current;
      const nextZ = clampZoom(
        prevZ + step,
        MIN_INTERACTIVE_ZOOM,
        MAX_INTERACTIVE_ZOOM
      );
      if (nextZ === prevZ) return;

      // Zoom around cursor position when unlocked from auto-follow
      if (!followLockedRef.current) {
        const rect = canvas.getBoundingClientRect();
        const localX = e.clientX - rect.left;
        const localY = e.clientY - rect.top;
        const curCenterWx = lonToWorldX(viewCenterRef.current.lon, prevZ);
        const curCenterWy = latToWorldY(viewCenterRef.current.lat, prevZ);
        const focusLat = worldYToLat(
          curCenterWy + (localY - rect.height * 0.5),
          prevZ
        );
        const focusLon = worldXToLon(
          curCenterWx + (localX - rect.width * 0.5),
          prevZ
        );
        const nextFocusWx = lonToWorldX(focusLon, nextZ);
        const nextFocusWy = latToWorldY(focusLat, nextZ);
        viewCenterRef.current = {
          lat: worldYToLat(nextFocusWy - (localY - rect.height * 0.5), nextZ),
          lon: worldXToLon(nextFocusWx - (localX - rect.width * 0.5), nextZ),
        };
      }

      zoomRef.current = nextZ;
      setZoom(nextZ);
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [isRunMode]);

  // Pointer Pan Drag vs Clean Click (< 5px movement) for Virtual GPS Stimulus
  const pointerDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    didPan: boolean;
  } | null>(null);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isRunMode || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointerDragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      didPan: false,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId || !isRunMode) return;

    const totalDist = Math.hypot(
      e.clientX - drag.startX,
      e.clientY - drag.startY
    );
    if (!drag.didPan && totalDist >= 5) {
      drag.didPan = true;
      if (followLockedRef.current) {
        followLockedRef.current = false;
        setFollowLocked(false);
      }
    }

    if (drag.didPan) {
      const dx = e.clientX - drag.lastX;
      const dy = e.clientY - drag.lastY;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;

      const curZ = zoomRef.current;
      const nextWx = lonToWorldX(viewCenterRef.current.lon, curZ) - dx;
      const nextWy = latToWorldY(viewCenterRef.current.lat, curZ) - dy;
      viewCenterRef.current = {
        lat: worldYToLat(nextWy, curZ),
        lon: worldXToLon(nextWx, curZ),
      };
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    pointerDragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }

    const totalDist = Math.hypot(
      e.clientX - drag.startX,
      e.clientY - drag.startY
    );
    if (!drag.didPan && totalDist < 5 && canStimulateGps && cfgClickToSimulate) {
      const rect = e.currentTarget.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;
      const curZ = zoomRef.current;
      const centerWx = lonToWorldX(viewCenterRef.current.lon, curZ);
      const centerWy = latToWorldY(viewCenterRef.current.lat, curZ);

      const clickedLon = worldXToLon(
        centerWx + (localX - rect.width * 0.5),
        curZ
      );
      const clickedLat = worldYToLat(
        centerWy + (localY - rect.height * 0.5),
        curZ
      );

      const prev = readActiveTelemetry();
      const prevLat = prev.hasLiveFix ? prev.activeLat : cfgCenterLat;
      const prevLon = prev.hasLiveFix ? prev.activeLon : cfgCenterLon;
      const bearing =
        Math.abs(clickedLat - prevLat) > 1e-7 ||
        Math.abs(clickedLon - prevLon) > 1e-7
          ? computeCompassBearingDeg(prevLat, prevLon, clickedLat, clickedLon)
          : computedBearingRef.current;

      if (driveLoopActive) {
        setDriveLoopActive(false);
      }
      writeGpsStimulusBatch(clickedLat, clickedLon, bearing, null);
    }
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointerDragRef.current?.pointerId === e.pointerId) {
      pointerDragRef.current = null;
    }
  };

  const handleReCenterFollow = () => {
    const { activeLat, activeLon, hasLiveFix } = readActiveTelemetry();
    viewCenterRef.current = {
      lat: hasLiveFix ? activeLat : cfgCenterLat,
      lon: hasLiveFix ? activeLon : cfgCenterLon,
    };
    followLockedRef.current = true;
    setFollowLocked(true);
  };

  const handleClearTrail = () => {
    trailRef.current = [];
    setHud((prev) => ({ ...prev, trailCount: 0 }));
    repaintTriggerRef.current?.();
  };

  const handleStepZoom = (delta: number) => {
    setZoom((prev) => {
      const next = clampZoom(
        prev + delta,
        MIN_INTERACTIVE_ZOOM,
        MAX_INTERACTIVE_ZOOM
      );
      zoomRef.current = next;
      return next;
    });
  };

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full min-h-0 overflow-hidden bg-canvas select-none"
    >
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        className={`block h-full w-full ${
          !isRunMode
            ? 'pointer-events-none'
            : canStimulateGps && cfgClickToSimulate
              ? 'cursor-crosshair'
              : 'cursor-grab active:cursor-grabbing'
        }`}
        aria-label={t('simWdg.map.ariaLabel', { title: widget.title })}
      />

      {/* Top-Left Compact GNSS Coordinate HUD Overlay (font-mono tabular-nums, 0-2px geometry) */}
      <div className="pointer-events-none absolute top-1.5 left-1.5 z-10 flex max-w-[66%] flex-col gap-1">
        <div className="rounded-[2px] border border-strong bg-surface/95 px-2 py-1 font-mono text-[10px] tabular-nums">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
            <span>
              <span className="text-muted">{t('simWdg.map.lat')}</span>{' '}
              <strong className="text-ink">{hud.lat.toFixed(6)}°</strong>
            </span>
            <span>
              <span className="text-muted">{t('simWdg.map.lon')}</span>{' '}
              <strong className="text-ink">{hud.lon.toFixed(6)}°</strong>
            </span>
          </div>

          {(hud.headingDeg !== null || hud.speedVal !== null) && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 border-t border-hairline pt-0.5 text-[9px]">
              {hud.headingDeg !== null && (
                <span>
                  <span className="text-muted">{t('simWdg.map.hdg')}</span>{' '}
                  <strong className="text-focus">
                    {hud.headingDeg.toFixed(1).padStart(5, '0')}°
                  </strong>
                </span>
              )}
              {hud.speedVal !== null && (
                <span>
                  <span className="text-muted">{t('simWdg.map.spd')}</span>{' '}
                  <strong className="text-nominal">
                    {hud.speedVal.toFixed(1)}
                  </strong>{' '}
                  <span className="text-subtle">{hud.speedUnit}</span>
                </span>
              )}
              {cfgShowTrail && hud.trailCount > 1 && (
                <span className="text-subtle">{t('simWdg.map.trk')}{hud.trailCount}</span>
              )}
            </div>
          )}
        </div>

        {/* Binding / Read-Only Safety Status Pill */}
        <div className="flex flex-wrap items-center gap-1 font-mono text-[9px] tabular-nums">
          {!hasLatLonBindings && (
            <span
              className="inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 font-semibold uppercase"
              style={{
                backgroundColor: 'var(--status-warn-bg)',
                borderColor: 'var(--status-warn-border)',
                color: 'var(--status-warn)',
              }}
            >
              {t('simWdg.map.unboundPill')}
            </span>
          )}
          {isLiveBridgeReadOnly && (
            <span
              className="inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 font-semibold uppercase"
              style={{
                backgroundColor: 'var(--status-nominal-bg)',
                borderColor: 'var(--status-nominal-border)',
                color: 'var(--status-nominal)',
              }}
            >
              <Lock className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
              {t('simWdg.map.readOnlyCloud')}
            </span>
          )}
        </div>
      </div>

      {/* Top-Right Compact Industrial Map Controls (Interactive in RUN mode; non-interfering in DESIGN mode) */}
      <div
        className={`absolute top-1.5 right-1.5 z-10 flex flex-wrap items-center justify-end gap-1 font-mono text-[9px] tabular-nums ${
          isRunMode ? 'pointer-events-auto' : 'pointer-events-none opacity-80'
        }`}
      >
        {/* Quick Tile Switch (OSM / DARK) */}
        <div className="inline-flex h-6 items-center rounded-[2px] border border-strong bg-surface/95 p-0.5">
          <button
            type="button"
            disabled={!isRunMode}
            onClick={() => setActiveTileStyle('osm_standard')}
            aria-pressed={activeTileStyle !== 'osm_dark'}
            title={t('simWdg.map.osmStandardTitle')}
            className={`h-full cursor-pointer rounded-[1px] px-1.5 font-semibold uppercase ${
              activeTileStyle !== 'osm_dark'
                ? 'bg-elevated text-focus'
                : 'text-muted hover:text-ink'
            }`}
          >
            OSM
          </button>
          <button
            type="button"
            disabled={!isRunMode}
            onClick={() => setActiveTileStyle('osm_dark')}
            aria-pressed={activeTileStyle === 'osm_dark'}
            title={t('simWdg.map.osmDarkTitle')}
            className={`h-full cursor-pointer rounded-[1px] px-1.5 font-semibold uppercase ${
              activeTileStyle === 'osm_dark'
                ? 'bg-elevated text-focus'
                : 'text-muted hover:text-ink'
            }`}
          >
            DARK
          </button>
        </div>

        {/* FOLLOW Lock Toggle */}
        <button
          type="button"
          disabled={!isRunMode}
          onClick={() => {
            if (followLocked) {
              followLockedRef.current = false;
              setFollowLocked(false);
            } else {
              handleReCenterFollow();
            }
          }}
          aria-pressed={followLocked}
          title={t('simWdg.map.followTitle')}
          className={`inline-flex h-6 cursor-pointer items-center gap-1 rounded-[2px] border px-1.5 font-semibold uppercase ${
            followLocked
              ? 'border-focus bg-surface text-focus'
              : 'border-strong bg-surface/95 text-muted hover:text-ink'
          }`}
        >
          <Crosshair className="h-2.5 w-2.5" aria-hidden="true" />
          {t('simWdg.map.followBtn')}
        </button>

        {/* [DRIVE LOOP] Virtual Test-Track Stimulus (VIRTUAL BUS Mode ONLY!) */}
        {telemetrySource === 'virtual' && (
          <button
            type="button"
            disabled={!canStimulateGps}
            onClick={() => {
              const next = !driveLoopActive;
              setDriveLoopActive(next);
              if (next) {
                followLockedRef.current = true;
                setFollowLocked(true);
              }
            }}
            aria-pressed={driveLoopActive}
            title={t('simWdg.map.driveLoopTitle')}
            className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-[2px] border px-1.5 font-semibold uppercase"
            style={
              driveLoopActive
                ? {
                    backgroundColor: 'var(--status-nominal-bg)',
                    borderColor: 'var(--status-nominal-border)',
                    color: 'var(--status-nominal)',
                  }
                : {
                    backgroundColor: 'var(--bg-surface)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-ink)',
                  }
            }
          >
            {driveLoopActive ? (
              <Square className="h-2.5 w-2.5" aria-hidden="true" />
            ) : (
              <Play className="h-2.5 w-2.5 text-nominal" aria-hidden="true" />
            )}
            {t('simWdg.map.driveLoopBtn')}
          </button>
        )}

        {/* CLR Breadcrumb Trail */}
        <button
          type="button"
          disabled={!isRunMode}
          onClick={handleClearTrail}
          title={t('simWdg.map.clearTrailTitle')}
          className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-[2px] border border-strong bg-surface/95 px-1.5 font-semibold uppercase text-muted hover:text-ink"
        >
          <Trash2 className="h-2.5 w-2.5" aria-hidden="true" />
          {t('simWdg.map.clearTrailBtn')}
        </button>

        {/* Zoom - / Z{n} / + */}
        <div className="inline-flex h-6 items-center rounded-[2px] border border-strong bg-surface/95">
          <button
            type="button"
            disabled={!isRunMode || zoom <= MIN_INTERACTIVE_ZOOM}
            onClick={() => handleStepZoom(-1)}
            aria-label={t('simWdg.map.zoomOutAria')}
            title={t('simWdg.map.zoomOutTitle')}
            className="inline-flex h-full w-5 cursor-pointer items-center justify-center border-r border-hairline text-ink hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Minus className="h-2.5 w-2.5" />
          </button>
          <span className="px-1.5 font-semibold text-muted">Z{zoom}</span>
          <button
            type="button"
            disabled={!isRunMode || zoom >= MAX_INTERACTIVE_ZOOM}
            onClick={() => handleStepZoom(1)}
            aria-label={t('simWdg.map.zoomInAria')}
            title={t('simWdg.map.zoomInTitle')}
            className="inline-flex h-full w-5 cursor-pointer items-center justify-center border-l border-hairline text-ink hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus className="h-2.5 w-2.5" />
          </button>
        </div>
      </div>

      {/* Bottom-Left Virtual GPS Stimulus Hint (RUN + VIRTUAL BUS only) */}
      {canStimulateGps && cfgClickToSimulate && (
        <div className="pointer-events-none absolute bottom-1.5 left-1.5 z-10 inline-flex items-center gap-1 rounded-[2px] border border-hairline bg-surface/90 px-1.5 py-0.5 font-mono text-[9px] uppercase tabular-nums text-muted">
          <Navigation className="h-2.5 w-2.5 text-focus" aria-hidden="true" />
          <span>
            {driveLoopActive
              ? t('simWdg.map.hintLoop')
              : t('simWdg.map.hintClick')}
          </span>
        </div>
      )}

      {/* Bottom-Right Attribution Tag */}
      <div className="pointer-events-none absolute right-1.5 bottom-1.5 z-10 rounded-[2px] border border-hairline bg-surface/90 px-1.5 py-0.5 font-mono text-[9px] text-subtle">
        © OpenStreetMap contributors
      </div>
    </div>
  );
}
