import { WebMercatorViewport, type Layer, type MapViewState, type PickingInfo } from '@deck.gl/core'
import { TileLayer } from '@deck.gl/geo-layers'
import { BitmapLayer, GeoJsonLayer, IconLayer, LineLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import DeckGL from '@deck.gl/react'
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { Loader2 } from 'lucide-react'
import type {
  ImportedColor,
  ImportedFeature,
  ImportedFeatureCollection,
  ImportedPointCluster,
  ImportedPointTilePoint,
  PointTileMode,
  ProvinceFeature,
  ProvinceFeatureCollection,
} from '../lib/api'
import type { DraftFeatureRecord, WorkspaceTool } from './app-shell/types'

export const INITIAL_VIEW_STATE: MapViewState = {
  longitude: 118,
  latitude: -2.5,
  zoom: 4.4,
  pitch: 0,
  bearing: 0,
}

const EMPTY_COLLECTION: FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
}

const DEFAULT_POLYGON_FILL: ImportedColor = [53, 145, 112, 52]
const DEFAULT_LINE_COLOR: ImportedColor = [244, 164, 88, 255]
const DEFAULT_POINT_COLOR: ImportedColor = [255, 106, 69, 230]
const DEFAULT_LABEL_COLOR: ImportedColor = [15, 23, 21, 255]
const PROVINCE_FILL_IDLE: ImportedColor = [88, 156, 146, 46]
const PROVINCE_FILL_ACTIVE: ImportedColor = [244, 164, 88, 0]
const PROVINCE_LINE_IDLE: ImportedColor = [255, 255, 255, 210]
const PROVINCE_LINE_ACTIVE: ImportedColor = [255, 255, 255, 0]
const HOVER_GLOW_COLOR: ImportedColor = [255, 255, 255, 150]
const SELECTED_GLOW_COLOR: ImportedColor = [255, 212, 69, 190]
export const POINT_CLUSTER_ZOOM_THRESHOLD = 13
const POINT_INTERACTION_ZOOM_THRESHOLD = 16
const POINT_LABEL_ZOOM_THRESHOLD = 13
const ROUTE_LABEL_ZOOM_THRESHOLD = 14
const GEOMETRY_LABEL_ZOOM_THRESHOLD = 15
const ROUTE_SEGMENT_LABEL_ZOOM_THRESHOLD = 18
const POINT_OVERLAP_PICK_RADIUS = 16
const POINT_OVERLAP_GROUP_RADIUS = 26
const SPIDERFY_BASE_RADIUS = 34
const VIEWPORT_BBOX_OVERSCAN_RATIO = 0.2
const VIEWPORT_BBOX_DECIMALS = 4
const FIT_BOUNDS_PADDING = 48
const PITCH_DRAG_DEGREES_PER_PIXEL = 0.25
const MAX_MAP_ZOOM = 25
const MAX_MAP_PITCH = 60
const INDONESIA_FALLBACK_BOUNDS: Bounds = {
  minLng: 94.5,
  minLat: -11.5,
  maxLng: 141.5,
  maxLat: 6.5,
}

export type MapViewportBounds = {
  viewportBbox: string | null
  fetchBbox: string | null
  zoom: number
}

export type SelectedMapFeatureDetail = {
  isDrawn: boolean
  legendClassId: string | null
  id: string
  name: string
  geometryType: string
  longitude: number | null
  latitude: number | null
  sourcePath: string | null
}

export type PointRenderState = {
  mode: PointTileMode
  zoom: number
}

export type PointLoadProgress = {
  mode: PointTileMode
  zoom: number
  cachedPoints: number
  cachedTiles: number
  loadedTiles: number
  totalTiles: number
  visibleLoadedTiles: number
  visibleTiles: number
  isLoading: boolean
  isPaused: boolean
}

type ImportedFeatureSubset = {
  type: 'FeatureCollection'
  features: ImportedFeature[]
}

type ViewportSize = {
  width: number
  height: number
}

type Bounds = {
  minLng: number
  minLat: number
  maxLng: number
  maxLat: number
}

type PointOverlapGroup = {
  id: string
  latitude: number
  longitude: number
  points: ImportedPointTilePoint[]
  screenX: number
  screenY: number
}

type SpiderLegDatum = {
  id: string
  sourcePosition: [number, number]
  targetPosition: [number, number]
}

type SpiderfiedPointDatum = ImportedPointTilePoint & {
  anchorLatitude: number
  anchorLongitude: number
}

type CollapsedOverlapDatum = {
  count: number
  id: string
  latitude: number
  longitude: number
  points: ImportedPointTilePoint[]
}

type SessionPointDatum = {
  fillColor: ImportedColor
  id: string
  labelColor: ImportedColor
  labelSize: number
  lineColor: ImportedColor
  name: string
  position: [number, number]
}

type GeometryLabelDatum = {
  id: string
  labelColor: ImportedColor
  labelSize: number
  name: string
  position: [number, number]
}

export type MeasurementOverlay = {
  isRouting: boolean
  points: [number, number][]
  routeCoordinates: [number, number][]
  routingUnavailable: boolean
}

type PointIconDefinition = {
  anchorX: number
  anchorY: number
  height: number
  url: string
  width: number
}

const POINT_ICON_SIZE = 64
const pointIconCache = new Map<string, PointIconDefinition>()

function isFiniteColor(value: unknown): value is ImportedColor {
  return (
    Array.isArray(value) &&
    value.length >= 4 &&
    value.slice(0, 4).every((channel) => Number.isFinite(channel))
  )
}

function clampChannel(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function toColor(value: unknown, fallback: ImportedColor): ImportedColor {
  if (!isFiniteColor(value)) {
    return fallback
  }

  return [
    clampChannel(value[0]),
    clampChannel(value[1]),
    clampChannel(value[2]),
    clampChannel(value[3]),
  ]
}

function darkenColor(color: ImportedColor, factor = 0.65): ImportedColor {
  return [
    clampChannel(color[0] * factor),
    clampChannel(color[1] * factor),
    clampChannel(color[2] * factor),
    color[3],
  ]
}

function pointFillColor(point: ImportedPointTilePoint) {
  return toColor(point.style?.pointColor, DEFAULT_POINT_COLOR)
}

function pointStrokeColor(point: ImportedPointTilePoint) {
  const fill = pointFillColor(point)
  return toColor(point.style?.lineColor, darkenColor(fill))
}

function lineColor(feature: ImportedFeature) {
  return toColor(feature.properties?.style?.lineColor, DEFAULT_LINE_COLOR)
}

function polygonFillColor(feature: ImportedFeature): ImportedColor {
  const color = toColor(feature.properties?.style?.fillColor, DEFAULT_POLYGON_FILL)
  return [color[0], color[1], color[2], Math.min(color[3], 36)]
}

function polygonStrokeColor(feature: ImportedFeature) {
  const fill = polygonFillColor(feature)
  return toColor(feature.properties?.style?.lineColor, darkenColor(fill))
}

function colorBrightness(color: ImportedColor) {
  return Math.sqrt(
    0.299 * color[0] * color[0] +
      0.587 * color[1] * color[1] +
      0.114 * color[2] * color[2],
  )
}

function labelColor(point: ImportedPointTilePoint) {
  const baseColor = toColor(point.style?.labelColor, DEFAULT_LABEL_COLOR)
  const brightness = colorBrightness(baseColor)

  if (brightness >= 205) {
    return darkenColor(baseColor, 0.32)
  }

  if (brightness >= 175) {
    return darkenColor(baseColor, 0.46)
  }

  if (brightness >= 145) {
    return darkenColor(baseColor, 0.62)
  }

  return baseColor
}

function pointRadius(point: ImportedPointTilePoint) {
  const iconScale = point.style?.iconScale
  if (!Number.isFinite(iconScale)) {
    return 6
  }

  return Math.max(5, Math.min(12, Number(iconScale) * 5))
}

function colorToSvg(color: ImportedColor) {
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${Math.max(0, Math.min(1, color[3] / 255))})`
}

function svgDataUrl(svg: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function pointIconKind(point: ImportedPointTilePoint) {
  const href = point.style?.iconHref?.toLowerCase() ?? ''

  if (href.includes('triangle')) {
    return 'triangle'
  }

  if (href.includes('forbidden')) {
    return 'forbidden'
  }

  if (href.includes('target')) {
    return 'target'
  }

  if (href.includes('rail')) {
    return 'rail'
  }

  if (href.includes('square')) {
    return 'square'
  }

  if (href.includes('placemark_circle_highlight')) {
    return 'placemark_circle_highlight'
  }

  if (href.includes('placemark_circle')) {
    return 'placemark_circle'
  }

  if (href.includes('star')) {
    return 'pin_star'
  }

  return 'shaded_dot'
}

function createPointIconSvg(point: ImportedPointTilePoint) {
  const fill = colorToSvg(pointFillColor(point))
  const stroke = colorToSvg(pointStrokeColor(point))
  const shadow = 'rgba(15, 23, 42, 0.2)'
  const kind = pointIconKind(point)

  if (kind === 'triangle') {
    return {
      anchorX: 32,
      anchorY: 40,
      svg: `
        <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
          <filter id="shadow" x="-40%" y="-40%" width="180%" height="180%">
            <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="${shadow}"/>
          </filter>
          <g filter="url(#shadow)">
            <path d="M32 12 L50 44 H14 Z" fill="white" stroke="${stroke}" stroke-width="4.5" stroke-linejoin="round"/>
            <path d="M32 22 L41 38 H23 Z" fill="${fill}" stroke="${stroke}" stroke-width="2.5" stroke-linejoin="round"/>
          </g>
        </svg>
      `,
    }
  }

  if (kind === 'forbidden') {
    return {
      anchorX: 32,
      anchorY: 32,
      svg: `
        <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
          <filter id="shadow" x="-40%" y="-40%" width="180%" height="180%">
            <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="${shadow}"/>
          </filter>
          <g filter="url(#shadow)">
            <circle cx="32" cy="32" r="20" fill="white" stroke="${stroke}" stroke-width="5"/>
            <circle cx="32" cy="32" r="12" fill="${fill}" fill-opacity="0.16"/>
            <path d="M21 43 L43 21" stroke="${stroke}" stroke-width="6" stroke-linecap="round"/>
          </g>
        </svg>
      `,
    }
  }

  if (kind === 'target') {
    return {
      anchorX: 32,
      anchorY: 32,
      svg: `
        <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
          <filter id="shadow" x="-40%" y="-40%" width="180%" height="180%">
            <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="${shadow}"/>
          </filter>
          <g filter="url(#shadow)">
            <circle cx="32" cy="32" r="18" fill="white" stroke="${stroke}" stroke-width="4"/>
            <circle cx="32" cy="32" r="10" fill="${fill}" stroke="${stroke}" stroke-width="2.5"/>
            <circle cx="32" cy="32" r="3.5" fill="${stroke}"/>
            <path d="M32 8 V18 M32 46 V56 M8 32 H18 M46 32 H56" stroke="${stroke}" stroke-width="3" stroke-linecap="round"/>
          </g>
        </svg>
      `,
    }
  }

  if (kind === 'rail') {
    return {
      anchorX: 32,
      anchorY: 32,
      svg: `
        <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
          <filter id="shadow" x="-40%" y="-40%" width="180%" height="180%">
            <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="${shadow}"/>
          </filter>
          <g filter="url(#shadow)">
            <rect x="18" y="10" width="28" height="30" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="3.5"/>
            <path d="M24 16 H40 M24 23 H40 M24 30 H40" stroke="white" stroke-width="3" stroke-linecap="round"/>
            <path d="M24 40 L18 54 M40 40 L46 54" stroke="${stroke}" stroke-width="3.5" stroke-linecap="round"/>
            <path d="M18 50 H46" stroke="${stroke}" stroke-width="3.5" stroke-linecap="round"/>
          </g>
        </svg>
      `,
    }
  }

  if (kind === 'square') {
    return {
      anchorX: 32,
      anchorY: 32,
      svg: `
        <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
          <filter id="shadow" x="-40%" y="-40%" width="180%" height="180%">
            <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="${shadow}"/>
          </filter>
          <rect x="17" y="17" width="30" height="30" rx="6" fill="${fill}" stroke="${stroke}" stroke-width="4" filter="url(#shadow)"/>
          <rect x="24" y="24" width="16" height="16" rx="2" fill="white" fill-opacity="0.22"/>
        </svg>
      `,
    }
  }

  if (kind === 'placemark_circle' || kind === 'placemark_circle_highlight' || kind === 'pin_star') {
    const star = kind === 'pin_star'
      ? '<path d="M32 20 l3.4 6.9 7.6 1.1-5.5 5.4 1.3 7.6-6.8-3.6-6.8 3.6 1.3-7.6-5.5-5.4 7.6-1.1z" fill="white"/>'
      : '<circle cx="32" cy="28" r="7" fill="white" fill-opacity="0.9"/>'
    const halo = kind === 'placemark_circle_highlight'
      ? `<circle cx="32" cy="28" r="16" fill="${fill}" fill-opacity="0.18" stroke="white" stroke-opacity="0.9" stroke-width="2"/>`
      : ''

    return {
      anchorX: 32,
      anchorY: 58,
      svg: `
        <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
          <filter id="shadow" x="-40%" y="-40%" width="180%" height="180%">
            <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="${shadow}"/>
          </filter>
          <g filter="url(#shadow)">
            ${halo}
            <path d="M32 56 C32 56 15 42.5 15 27.5 C15 17.8 22.8 10 32 10 C41.2 10 49 17.8 49 27.5 C49 42.5 32 56 32 56 Z" fill="${fill}" stroke="${stroke}" stroke-width="3.5"/>
            <circle cx="32" cy="28" r="10.5" fill="white" fill-opacity="0.18"/>
            ${star}
          </g>
        </svg>
      `,
    }
  }

  return {
    anchorX: 32,
    anchorY: 32,
    svg: `
      <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
        <filter id="shadow" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="${shadow}"/>
        </filter>
        <g filter="url(#shadow)">
          <circle cx="32" cy="32" r="13" fill="${fill}" stroke="${stroke}" stroke-width="4"/>
          <circle cx="28" cy="28" r="4" fill="white" fill-opacity="0.25"/>
        </g>
      </svg>
    `,
  }
}

function pointIcon(point: ImportedPointTilePoint): PointIconDefinition {
  const fill = pointFillColor(point)
  const stroke = pointStrokeColor(point)
  const cacheKey = [point.style?.iconHref ?? 'default', fill.join(','), stroke.join(',')].join('|')
  const cached = pointIconCache.get(cacheKey)

  if (cached) {
    return cached
  }

  const { anchorX, anchorY, svg } = createPointIconSvg(point)
  const icon = {
    anchorX,
    anchorY,
    height: POINT_ICON_SIZE,
    url: svgDataUrl(svg),
    width: POINT_ICON_SIZE,
  }

  pointIconCache.set(cacheKey, icon)
  return icon
}

function pointMarkerSize(point: ImportedPointTilePoint) {
  const iconScale = point.style?.iconScale
  if (!Number.isFinite(iconScale)) {
    return 22
  }

  return Math.max(18, Math.min(34, Number(iconScale) * 18))
}

function pointLabelOffset(point: ImportedPointTilePoint) {
  if (point.style?.iconHref) {
    return Math.round(pointMarkerSize(point) * 0.9)
  }

  return 16
}

function lineWidth(feature: ImportedFeature, fallback: number) {
  const resolvedWidth = feature.properties?.style?.lineWidth
  if (!Number.isFinite(resolvedWidth)) {
    return fallback
  }

  return Math.max(1, Math.min(8, Number(resolvedWidth)))
}

function pointLabelSize(point: ImportedPointTilePoint) {
  const scale = point.style?.labelScale ?? point.style?.iconScale
  if (!Number.isFinite(scale)) {
    return 15
  }

  return Math.max(13, Math.min(22, Number(scale) * 12 + 2))
}

function clusterFillColor(cluster: ImportedPointCluster): ImportedColor {
  if (cluster.count >= 100) {
    return [51, 65, 85, 240]
  }

  if (cluster.count >= 30) {
    return [71, 85, 105, 236]
  }

  if (cluster.count >= 10) {
    return [100, 116, 139, 232]
  }

  return [148, 163, 184, 226]
}

function clusterStrokeColor(cluster: ImportedPointCluster): ImportedColor {
  return darkenColor(clusterFillColor(cluster), 0.7)
}

function clusterRadius(cluster: ImportedPointCluster) {
  if (cluster.count <= 1) {
    return 8
  }

  return Math.max(12, Math.min(28, 10 + Math.log2(cluster.count) * 4))
}

function clusterLabelSize(cluster: ImportedPointCluster) {
  return Math.max(11, Math.min(18, 11 + Math.log10(cluster.count) * 6))
}

function filterCollection(
  collection: ImportedFeatureCollection,
  matcher: (feature: ImportedFeature) => boolean,
): ImportedFeatureSubset {
  return {
    type: 'FeatureCollection',
    features: collection.features.filter(matcher),
  }
}

function clampLatitude(value: number) {
  return Math.max(-85.0511, Math.min(85.0511, value))
}

function clampLongitude(value: number) {
  return Math.max(-180, Math.min(180, value))
}

function clampValue(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  )
}

function roundCoordinate(value: number) {
  return value.toFixed(VIEWPORT_BBOX_DECIMALS)
}

function calculateViewportBbox(
  viewState: MapViewState,
  viewportSize: ViewportSize,
  paddingRatio = 0,
): string | null {
  if (viewportSize.width <= 0 || viewportSize.height <= 0) {
    return null
  }

  const mercatorViewport = new WebMercatorViewport({
    width: viewportSize.width,
    height: viewportSize.height,
    longitude: viewState.longitude,
    latitude: viewState.latitude,
    zoom: viewState.zoom,
    pitch: viewState.pitch,
    bearing: viewState.bearing,
  })
  const [west, south, east, north] = mercatorViewport.getBounds()

  if (![west, south, east, north].every((value) => Number.isFinite(value))) {
    return null
  }

  const longitudePadding = (east - west) * paddingRatio
  const latitudePadding = (north - south) * paddingRatio
  const minLng = clampLongitude(west - longitudePadding)
  const minLat = clampLatitude(south - latitudePadding)
  const maxLng = clampLongitude(east + longitudePadding)
  const maxLat = clampLatitude(north + latitudePadding)

  return [
    roundCoordinate(minLng),
    roundCoordinate(minLat),
    roundCoordinate(maxLng),
    roundCoordinate(maxLat),
  ].join(',')
}

function createMercatorViewport(viewState: MapViewState, viewportSize: ViewportSize) {
  if (viewportSize.width <= 0 || viewportSize.height <= 0) {
    return null
  }

  return new WebMercatorViewport({
    width: viewportSize.width,
    height: viewportSize.height,
    longitude: viewState.longitude,
    latitude: viewState.latitude,
    zoom: viewState.zoom,
    pitch: viewState.pitch,
    bearing: viewState.bearing,
  })
}

function extendBounds(bounds: Bounds | null, [lng, lat]: [number, number]) {
  const normalizedLng = clampLongitude(lng)
  const normalizedLat = clampLatitude(lat)

  if (!bounds) {
    return {
      minLng: normalizedLng,
      minLat: normalizedLat,
      maxLng: normalizedLng,
      maxLat: normalizedLat,
    }
  }

  return {
    minLng: Math.min(bounds.minLng, normalizedLng),
    minLat: Math.min(bounds.minLat, normalizedLat),
    maxLng: Math.max(bounds.maxLng, normalizedLng),
    maxLat: Math.max(bounds.maxLat, normalizedLat),
  }
}

function boundsFromCoordinates(coordinates: unknown, bounds: Bounds | null = null): Bounds | null {
  if (!Array.isArray(coordinates)) {
    return bounds
  }

  if (
    coordinates.length >= 2 &&
    typeof coordinates[0] === 'number' &&
    typeof coordinates[1] === 'number'
  ) {
    return extendBounds(bounds, [coordinates[0], coordinates[1]])
  }

  return coordinates.reduce<Bounds | null>(
    (currentBounds, item) => boundsFromCoordinates(item, currentBounds),
    bounds,
  )
}

function geometryBounds(geometry: Geometry | null | undefined) {
  if (!geometry) {
    return null
  }

  return boundsFromCoordinates((geometry as { coordinates?: unknown }).coordinates)
}

function mergeBounds(bounds: Bounds | null, nextBounds: Bounds | null) {
  if (!nextBounds) {
    return bounds
  }

  if (!bounds) {
    return nextBounds
  }

  return {
    minLng: Math.min(bounds.minLng, nextBounds.minLng),
    minLat: Math.min(bounds.minLat, nextBounds.minLat),
    maxLng: Math.max(bounds.maxLng, nextBounds.maxLng),
    maxLat: Math.max(bounds.maxLat, nextBounds.maxLat),
  }
}

function provinceCollectionBounds(collection: ProvinceFeatureCollection | null) {
  if (!collection?.features.length) {
    return null
  }

  return collection.features.reduce<Bounds | null>(
    (currentBounds, feature) => mergeBounds(currentBounds, geometryBounds(feature.geometry)),
    null,
  )
}

function boundsCenter(bounds: Bounds | null) {
  if (!bounds) {
    return {
      longitude: null,
      latitude: null,
    }
  }

  return {
    longitude: (bounds.minLng + bounds.maxLng) / 2,
    latitude: (bounds.minLat + bounds.maxLat) / 2,
  }
}

function fitViewStateToBounds(
  bounds: Bounds,
  viewportSize: ViewportSize,
  currentViewState: MapViewState,
): MapViewState {
  const width = Math.max(viewportSize.width, 1)
  const height = Math.max(viewportSize.height, 1)
  const viewport = new WebMercatorViewport({
    width,
    height,
    longitude: currentViewState.longitude,
    latitude: currentViewState.latitude,
    zoom: currentViewState.zoom,
    pitch: 0,
    bearing: 0,
  })
  const next = viewport.fitBounds(
    [
      [bounds.minLng, bounds.minLat],
      [bounds.maxLng, bounds.maxLat],
    ],
    { padding: FIT_BOUNDS_PADDING },
  )

  return {
    longitude: next.longitude,
    latitude: next.latitude,
    zoom: next.zoom,
    pitch: 0,
    bearing: 0,
  }
}

function viewStateEquals(left: MapViewState, right: MapViewState) {
  return (
    Math.abs(left.longitude - right.longitude) < 0.000001 &&
    Math.abs(left.latitude - right.latitude) < 0.000001 &&
    Math.abs(left.zoom - right.zoom) < 0.000001 &&
    Math.abs((left.pitch ?? 0) - (right.pitch ?? 0)) < 0.000001 &&
    Math.abs((left.bearing ?? 0) - (right.bearing ?? 0)) < 0.000001
  )
}

function clampViewStateToBounds(
  viewState: MapViewState,
  viewportSize: ViewportSize,
  bounds: Bounds,
): MapViewState {
  if (viewportSize.width <= 0 || viewportSize.height <= 0) {
    return {
      ...viewState,
      pitch: clampValue(viewState.pitch ?? 0, 0, MAX_MAP_PITCH),
      longitude: clampValue(viewState.longitude, bounds.minLng, bounds.maxLng),
      latitude: clampValue(viewState.latitude, bounds.minLat, bounds.maxLat),
    }
  }

  const minimumViewState = fitViewStateToBounds(bounds, viewportSize, {
    ...viewState,
    pitch: clampValue(viewState.pitch ?? 0, 0, MAX_MAP_PITCH),
    bearing: viewState.bearing ?? 0,
  })
  const normalizedViewState: MapViewState = {
    ...viewState,
    pitch: clampValue(viewState.pitch ?? 0, 0, MAX_MAP_PITCH),
    zoom: Math.min(MAX_MAP_ZOOM, Math.max(minimumViewState.zoom, viewState.zoom)),
  }
  const viewport = new WebMercatorViewport({
    width: viewportSize.width,
    height: viewportSize.height,
    longitude: normalizedViewState.longitude,
    latitude: normalizedViewState.latitude,
    zoom: normalizedViewState.zoom,
    pitch: normalizedViewState.pitch,
    bearing: normalizedViewState.bearing,
  })
  const [west, south, east, north] = viewport.getBounds()
  const viewportLongitudeSpan = east - west
  const viewportLatitudeSpan = north - south
  const boundsLongitudeSpan = bounds.maxLng - bounds.minLng
  const boundsLatitudeSpan = bounds.maxLat - bounds.minLat

  if (
    viewportLongitudeSpan >= boundsLongitudeSpan ||
    viewportLatitudeSpan >= boundsLatitudeSpan
  ) {
    return {
      ...normalizedViewState,
      longitude: (bounds.minLng + bounds.maxLng) / 2,
      latitude: (bounds.minLat + bounds.maxLat) / 2,
    }
  }

  let longitude = normalizedViewState.longitude
  let latitude = normalizedViewState.latitude

  if (west < bounds.minLng) {
    longitude += bounds.minLng - west
  }

  if (east > bounds.maxLng) {
    longitude -= east - bounds.maxLng
  }

  if (south < bounds.minLat) {
    latitude += bounds.minLat - south
  }

  if (north > bounds.maxLat) {
    latitude -= north - bounds.maxLat
  }

  return {
    ...normalizedViewState,
    longitude: clampLongitude(longitude),
    latitude: clampLatitude(latitude),
  }
}

function toSelectedFeatureDetail(feature: ImportedFeature): SelectedMapFeatureDetail {
  const bounds = geometryBounds(feature.geometry)
  const center = boundsCenter(bounds)
  const rawProperties = feature.properties?.rawProperties
  const isDrawn =
    rawProperties &&
    typeof rawProperties === 'object' &&
    !Array.isArray(rawProperties) &&
    rawProperties.source === 'drawn'
  const legendClassId =
    rawProperties &&
    typeof rawProperties === 'object' &&
    !Array.isArray(rawProperties) &&
    typeof rawProperties.legendClassId === 'string'
      ? rawProperties.legendClassId
      : null

  return {
    isDrawn: Boolean(isDrawn),
    legendClassId,
    id: String(feature.id ?? feature.properties?.sourcePath ?? feature.properties?.name ?? 'feature'),
    name: feature.properties?.name?.trim() || 'Unnamed feature',
    geometryType: feature.properties?.geometryType ?? feature.geometry?.type ?? 'Unknown',
    longitude: center.longitude,
    latitude: center.latitude,
    sourcePath: feature.properties?.sourcePath ?? null,
  }
}

function toSelectedPointDetail(point: ImportedPointTilePoint): SelectedMapFeatureDetail {
  const rawProperties = point.rawProperties
  const legendClassId =
    rawProperties &&
    typeof rawProperties === 'object' &&
    !Array.isArray(rawProperties) &&
    typeof rawProperties.legendClassId === 'string'
      ? rawProperties.legendClassId
      : null

  return {
    isDrawn: point.featureId === null && point.sourcePath === null,
    legendClassId,
    id: point.id,
    name: point.name?.trim() || 'Unnamed node',
    geometryType: 'Point',
    longitude: point.longitude,
    latitude: point.latitude,
    sourcePath: point.sourcePath,
  }
}

function formatProgressValue(value: number) {
  return Math.max(0, Math.round(value)).toLocaleString()
}

function focusViewStateToPoint(
  currentViewState: MapViewState,
  viewportSize: ViewportSize,
  bounds: Bounds,
  point: ImportedPointTilePoint,
  targetZoom: number,
): MapViewState {
  return clampViewStateToBounds(
    {
      ...currentViewState,
      longitude: point.longitude,
      latitude: point.latitude,
      zoom: Math.min(MAX_MAP_ZOOM, Math.max(currentViewState.zoom, targetZoom)),
    },
    viewportSize,
    bounds,
  )
}

function sortNearbyPointsByCursorDistance(
  pointData: ImportedPointTilePoint[],
  viewState: MapViewState,
  viewportSize: ViewportSize,
  x: number,
  y: number,
) {
  if (viewportSize.width <= 0 || viewportSize.height <= 0) {
    return []
  }

  const viewport = new WebMercatorViewport({
    width: viewportSize.width,
    height: viewportSize.height,
    longitude: viewState.longitude,
    latitude: viewState.latitude,
    zoom: viewState.zoom,
    pitch: viewState.pitch,
    bearing: viewState.bearing,
  })
  const seen = new Set<string>()

  return pointData
    .flatMap((point) => {
      if (seen.has(point.id)) {
        return []
      }

      const [screenX, screenY] = viewport.project([point.longitude, point.latitude])
      if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) {
        return []
      }

      const dx = screenX - x
      const dy = screenY - y
      const hitRadius = Math.max(POINT_OVERLAP_PICK_RADIUS, pointRadius(point) + 6)
      if (dx * dx + dy * dy > hitRadius * hitRadius) {
        return []
      }

      seen.add(point.id)
      return [
        {
          point,
          distance: dx * dx + dy * dy,
        },
      ]
    })
    .sort((left, right) => {
      if (left.distance !== right.distance) {
        return left.distance - right.distance
      }

      return (left.point.name ?? '').localeCompare(right.point.name ?? '')
    })
    .map(({ point }) => point)
}

function buildPointOverlapGroups(
  pointData: ImportedPointTilePoint[],
  viewState: MapViewState,
  viewportSize: ViewportSize,
) {
  const viewport = createMercatorViewport(viewState, viewportSize)

  if (!viewport || pointData.length === 0) {
    return [] as PointOverlapGroup[]
  }

  const bucketSize = POINT_OVERLAP_GROUP_RADIUS
  const distanceThreshold = POINT_OVERLAP_GROUP_RADIUS * POINT_OVERLAP_GROUP_RADIUS
  const projected = pointData.flatMap((point) => {
    const [screenX, screenY] = viewport.project([point.longitude, point.latitude])

    if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) {
      return []
    }

    return [
      {
        point,
        screenX,
        screenY,
        cellX: Math.floor(screenX / bucketSize),
        cellY: Math.floor(screenY / bucketSize),
      },
    ]
  })
  const buckets = new Map<string, number[]>()

  projected.forEach((entry, index) => {
    const key = `${entry.cellX}:${entry.cellY}`
    const bucket = buckets.get(key)

    if (bucket) {
      bucket.push(index)
      return
    }

    buckets.set(key, [index])
  })

  const groups: PointOverlapGroup[] = []
  const visited = new Set<number>()

  projected.forEach((entry, startIndex) => {
    if (visited.has(startIndex)) {
      return
    }

    visited.add(startIndex)
    const queue = [startIndex]
    const members = [entry]

    while (queue.length > 0) {
      const currentIndex = queue.pop()

      if (currentIndex === undefined) {
        continue
      }

      const current = projected[currentIndex]

      for (let cellX = current.cellX - 1; cellX <= current.cellX + 1; cellX += 1) {
        for (let cellY = current.cellY - 1; cellY <= current.cellY + 1; cellY += 1) {
          const bucket = buckets.get(`${cellX}:${cellY}`)

          if (!bucket) {
            continue
          }

          bucket.forEach((candidateIndex) => {
            if (visited.has(candidateIndex)) {
              return
            }

            const candidate = projected[candidateIndex]
            const dx = current.screenX - candidate.screenX
            const dy = current.screenY - candidate.screenY

            if (dx * dx + dy * dy > distanceThreshold) {
              return
            }

            visited.add(candidateIndex)
            queue.push(candidateIndex)
            members.push(candidate)
          })
        }
      }
    }

    const points = members
      .map((member) => member.point)
      .sort((left, right) => (left.name ?? left.id).localeCompare(right.name ?? right.id))

    const total = members.length
    groups.push({
      id: points.map((point) => point.id).join(':'),
      longitude: members.reduce((sum, member) => sum + member.point.longitude, 0) / total,
      latitude: members.reduce((sum, member) => sum + member.point.latitude, 0) / total,
      screenX: members.reduce((sum, member) => sum + member.screenX, 0) / total,
      screenY: members.reduce((sum, member) => sum + member.screenY, 0) / total,
      points,
    })
  })

  return groups
}

function buildSpiderfiedPoints(
  group: PointOverlapGroup | null,
  viewState: MapViewState,
  viewportSize: ViewportSize,
) {
  if (!group || group.points.length <= 1) {
    return {
      legs: [] as SpiderLegDatum[],
      points: [] as SpiderfiedPointDatum[],
    }
  }

  const viewport = createMercatorViewport(viewState, viewportSize)

  if (!viewport) {
    return {
      legs: [] as SpiderLegDatum[],
      points: [] as SpiderfiedPointDatum[],
    }
  }

  const anchorScreen = [group.screenX, group.screenY] as const
  const pointCount = group.points.length
  const radius =
    pointCount === 2
      ? SPIDERFY_BASE_RADIUS
      : clampValue(SPIDERFY_BASE_RADIUS + Math.log2(pointCount + 1) * 10, 34, 92)

  const points = group.points.map((point, index) => {
    const angle =
      pointCount === 2
        ? -Math.PI / 6 + index * (Math.PI / 3)
        : -Math.PI / 2 + (index / pointCount) * Math.PI * 2
    const screenX = anchorScreen[0] + Math.cos(angle) * radius
    const screenY = anchorScreen[1] + Math.sin(angle) * radius
    const [longitude, latitude] = viewport.unproject([screenX, screenY]) as [number, number]

    return {
      ...point,
      longitude,
      latitude,
      anchorLongitude: group.longitude,
      anchorLatitude: group.latitude,
    } satisfies SpiderfiedPointDatum
  })
  const legs = points.map((point) => ({
    id: `${group.id}:${point.id}`,
    sourcePosition: [group.longitude, group.latitude] as [number, number],
    targetPosition: [point.longitude, point.latitude] as [number, number],
  }))

  return { legs, points }
}

function overlapBadgeRadius(count: number) {
  return Math.max(11, Math.min(22, 10 + Math.log2(count) * 3))
}

function normalizeCoordinate(coordinate: number[]) {
  return [Number(coordinate[0]), Number(coordinate[1])] as [number, number]
}

function labelSizeFromScale(value: unknown, fallback = 1) {
  const resolvedScale = Number.isFinite(value) ? Number(value) : fallback
  return Math.max(13, Math.min(22, resolvedScale * 12 + 2))
}

function midpointAlongLine(coordinates: Position[]) {
  if (coordinates.length === 0) {
    return null
  }

  if (coordinates.length === 1) {
    return normalizeCoordinate(coordinates[0] as number[])
  }

  let totalLength = 0

  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1]
    const current = coordinates[index]
    totalLength += Math.hypot(
      Number(current[0]) - Number(previous[0]),
      Number(current[1]) - Number(previous[1]),
    )
  }

  if (totalLength <= 0) {
    return normalizeCoordinate(coordinates[0] as number[])
  }

  const midpointDistance = totalLength / 2
  let traversed = 0

  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1]
    const current = coordinates[index]
    const segmentLength = Math.hypot(
      Number(current[0]) - Number(previous[0]),
      Number(current[1]) - Number(previous[1]),
    )

    if (segmentLength <= 0) {
      continue
    }

    if (traversed + segmentLength >= midpointDistance) {
      const remaining = midpointDistance - traversed
      const ratio = remaining / segmentLength

      return [
        Number(previous[0]) + (Number(current[0]) - Number(previous[0])) * ratio,
        Number(previous[1]) + (Number(current[1]) - Number(previous[1])) * ratio,
      ] as [number, number]
    }

    traversed += segmentLength
  }

  return normalizeCoordinate(coordinates[coordinates.length - 1] as number[])
}

function lineLabelPosition(geometry: Geometry) {
  if (geometry.type === 'LineString') {
    return midpointAlongLine(geometry.coordinates)
  }

  if (geometry.type !== 'MultiLineString') {
    return null
  }

  let longestLine: Position[] | null = null
  let longestLength = -1

  geometry.coordinates.forEach((line) => {
    let lineLength = 0

    for (let index = 1; index < line.length; index += 1) {
      const previous = line[index - 1]
      const current = line[index]
      lineLength += Math.hypot(
        Number(current[0]) - Number(previous[0]),
        Number(current[1]) - Number(previous[1]),
      )
    }

    if (lineLength > longestLength) {
      longestLength = lineLength
      longestLine = line
    }
  })

  return longestLine ? midpointAlongLine(longestLine) : null
}

function polygonLabelPosition(geometry: Geometry) {
  if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') {
    return null
  }

  const bounds = geometryBounds(geometry)
  const center = boundsCenter(bounds)

  if (center.longitude === null || center.latitude === null) {
    return null
  }

  return [center.longitude, center.latitude] as [number, number]
}

function geometryLabelPosition(geometry: Geometry) {
  if (geometry.type === 'Point') {
    return normalizeCoordinate(geometry.coordinates as number[])
  }

  if (geometry.type === 'LineString' || geometry.type === 'MultiLineString') {
    return lineLabelPosition(geometry)
  }

  if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
    return polygonLabelPosition(geometry)
  }

  return null
}

function isRenderableLabelName(value: unknown) {
  if (typeof value !== 'string') {
    return false
  }

  const name = value.trim()
  if (!name) {
    return false
  }

  const normalizedName = name.toLowerCase()

  if (
    normalizedName === 'untitled path' ||
    normalizedName === 'untitled polygon' ||
    normalizedName === 'untitled placemark' ||
    normalizedName === 'untitled point' ||
    /^placemark \d+$/.test(normalizedName)
  ) {
    return false
  }

  return true
}

function rawPropertiesObject(feature: Feature<Geometry>) {
  const rawProperties = feature.properties?.rawProperties

  if (!rawProperties || typeof rawProperties !== 'object' || Array.isArray(rawProperties)) {
    return null
  }

  return rawProperties as Record<string, unknown>
}

function rawPropertyString(rawProperties: Record<string, unknown> | null, key: string) {
  const value = rawProperties?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function routeGroupKey(feature: Feature<Geometry>) {
  const rawProperties = rawPropertiesObject(feature)
  return rawPropertyString(rawProperties, 'routeGroupId')
}

function routeDisplayName(feature: Feature<Geometry>) {
  const rawProperties = rawPropertiesObject(feature)
  return rawPropertyString(rawProperties, 'routeName')
}

function geometryLabelDatum(feature: Feature<Geometry>, id: string) {
  const name =
    typeof feature.properties?.name === 'string' ? feature.properties.name.trim() : ''

  if (!isRenderableLabelName(name)) {
    return null
  }

  const position = geometryLabelPosition(feature.geometry)

  if (!position) {
    return null
  }

  return {
    id,
    labelColor: toColor(feature.properties?.style?.labelColor, DEFAULT_LABEL_COLOR),
    labelSize: labelSizeFromScale(feature.properties?.style?.labelScale, 1),
    name,
    position,
  } satisfies GeometryLabelDatum
}

function routeLabelDatum(features: Feature<Geometry>[], routeKey: string) {
  const labelFeature = features.reduce<Feature<Geometry> | null>((bestFeature, feature) => {
    if (!bestFeature) {
      return feature
    }

    const bestBounds = geometryBounds(bestFeature.geometry)
    const featureBounds = geometryBounds(feature.geometry)

    if (!bestBounds) {
      return feature
    }

    if (!featureBounds) {
      return bestFeature
    }

    const bestSpan =
      Math.abs(bestBounds.maxLng - bestBounds.minLng) +
      Math.abs(bestBounds.maxLat - bestBounds.minLat)
    const featureSpan =
      Math.abs(featureBounds.maxLng - featureBounds.minLng) +
      Math.abs(featureBounds.maxLat - featureBounds.minLat)

    return featureSpan > bestSpan ? feature : bestFeature
  }, null)

  if (!labelFeature) {
    return null
  }

  const name = routeDisplayName(labelFeature) ?? labelFeature.properties?.name?.trim() ?? ''

  if (!isRenderableLabelName(name)) {
    return null
  }

  const position = geometryLabelPosition(labelFeature.geometry)

  if (!position) {
    return null
  }

  return {
    id: `route-label:${routeKey}`,
    labelColor: toColor(labelFeature.properties?.style?.labelColor, DEFAULT_LABEL_COLOR),
    labelSize: Math.min(labelSizeFromScale(labelFeature.properties?.style?.labelScale, 1), 16),
    name,
    position,
  } satisfies GeometryLabelDatum
}

function buildDraftFeature(
  tool: WorkspaceTool,
  coordinates: Position[],
  cursorCoordinate: Position | null,
): Feature<Geometry> | null {
  const activeCoordinates =
    cursorCoordinate && coordinates.length > 0 ? [...coordinates, cursorCoordinate] : coordinates

  if (tool === 'line' && activeCoordinates.length >= 2) {
    return {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: activeCoordinates,
      },
      properties: {
        description: 'Draft line preview.',
        name: 'Draft line',
      },
    }
  }

  if (tool === 'polygon' && activeCoordinates.length >= 3) {
    return {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[...activeCoordinates, activeCoordinates[0]]],
      },
      properties: {
        description: 'Draft polygon preview.',
        name: 'Draft polygon',
      },
    }
  }

  return null
}

function flattenSessionPoints(entries: DraftFeatureRecord[]): SessionPointDatum[] {
  return entries.flatMap((entry) => {
    if (entry.feature.geometry.type !== 'Point') {
      return []
    }

    const [longitude, latitude] = entry.feature.geometry.coordinates

    return [
      {
        id: entry.id,
        fillColor: toColor(entry.feature.properties?.style?.pointColor, DEFAULT_POINT_COLOR),
        labelColor: toColor(entry.feature.properties?.style?.labelColor, DEFAULT_LABEL_COLOR),
        labelSize: labelSizeFromScale(entry.feature.properties?.style?.labelScale, 1),
        lineColor: toColor(
          entry.feature.properties?.style?.lineColor,
          darkenColor(toColor(entry.feature.properties?.style?.pointColor, DEFAULT_POINT_COLOR)),
        ),
        name:
          typeof entry.feature.properties?.name === 'string'
            ? entry.feature.properties.name
            : 'Draft node',
        position: [longitude, latitude],
      },
    ]
  })
}

function flattenGeometryLabels(features: Feature<Geometry>[]): GeometryLabelDatum[] {
  return features.flatMap((feature, index) => {
    const id = String(feature.id ?? feature.properties?.name ?? `geometry-label-${index}`)
    const datum = geometryLabelDatum(feature, id)
    return datum ? [datum] : []
  })
}

function flattenRouteLabels(features: Feature<Geometry>[]): GeometryLabelDatum[] {
  const groups = new Map<string, Feature<Geometry>[]>()

  for (const feature of features) {
    const key = routeGroupKey(feature)

    if (!key) {
      continue
    }

    groups.set(key, [...(groups.get(key) ?? []), feature])
  }

  return [...groups.entries()].flatMap(([key, groupFeatures]) => {
    const datum = routeLabelDatum(groupFeatures, key)
    return datum ? [datum] : []
  })
}

function flattenNonRouteGeometryLabels(features: Feature<Geometry>[]): GeometryLabelDatum[] {
  return flattenGeometryLabels(features.filter((feature) => !routeGroupKey(feature)))
}

function flattenRouteSegmentLabels(features: Feature<Geometry>[]): GeometryLabelDatum[] {
  return flattenGeometryLabels(features.filter((feature) => Boolean(routeGroupKey(feature))))
}

function flattenSessionGeometryLabels(entries: DraftFeatureRecord[]): GeometryLabelDatum[] {
  return entries.flatMap((entry) => {
    if (entry.feature.geometry.type === 'Point') {
      return []
    }

    const datum = geometryLabelDatum(entry.feature, entry.id)
    return datum ? [datum] : []
  })
}

function featureIdentity(feature: Feature<Geometry>) {
  const geometry = feature.geometry ? JSON.stringify(feature.geometry) : 'null'
  const name =
    typeof feature.properties?.name === 'string' ? feature.properties.name.trim() : ''

  return `${feature.geometry?.type ?? 'unknown'}|${name}|${geometry}`
}

function samePosition(left: Position | undefined, right: Position | undefined) {
  if (!left || !right) {
    return false
  }

  return (
    Math.abs(Number(left[0]) - Number(right[0])) < 0.0000001 &&
    Math.abs(Number(left[1]) - Number(right[1])) < 0.0000001
  )
}

type DeckMapViewProps = {
  activeTool?: WorkspaceTool
  clusterData: ImportedPointCluster[]
  clearVersion?: number
  controlledViewState?: MapViewState | null
  draftFeatures?: DraftFeatureRecord[]
  featureCollection: ImportedFeatureCollection
  isProvinceLoading?: boolean
  isViewportLoading?: boolean
  loadingProvinceName?: string | null
  measurementOverlay?: MeasurementOverlay | null
  onDraftPointCreate?: (feature: Feature<Geometry>) => void
  onDraftSketchChange?: (
    tool: Extract<WorkspaceTool, 'line' | 'polygon'>,
    coordinates: [number, number][],
    isComplete: boolean,
  ) => boolean | void
  onMeasurePointSelect?: (coordinate: [number, number]) => void
  onMapViewStateChange?: (viewState: MapViewState) => void
  onPointerMove?: (coordinates: { lat: number; lng: number } | null) => void
  onStreetViewDrop?: (coordinates: { lat: number; lng: number }) => void
  onViewportBoundsChange?: (viewport: MapViewportBounds) => void
  onProvinceSelect?: (provinceId: string | null) => void
  onFeatureSelect?: (feature: SelectedMapFeatureDetail | null) => void
  pointData: ImportedPointTilePoint[]
  pointLoadProgress?: PointLoadProgress | null
  pointRenderState?: PointRenderState | null
  provinceCollection: ProvinceFeatureCollection | null
  renderedPointCoverage?: number
  savedPointOverlays?: ImportedPointTilePoint[]
  selectedPointId?: string | null
  selectedProvinceId?: string | null
  selectedProvinceName?: string | null
  showChrome?: boolean
}

export function DeckMapView({
  activeTool = 'pan',
  clusterData,
  clearVersion = 0,
  controlledViewState = null,
  draftFeatures = [],
  featureCollection,
  isProvinceLoading = false,
  isViewportLoading = false,
  loadingProvinceName = null,
  measurementOverlay = null,
  onDraftPointCreate,
  onDraftSketchChange,
  onMeasurePointSelect,
  onMapViewStateChange,
  onPointerMove,
  onStreetViewDrop,
  onViewportBoundsChange,
  onProvinceSelect,
  onFeatureSelect,
  pointData,
  pointLoadProgress = null,
  pointRenderState = null,
  provinceCollection,
  renderedPointCoverage = 0,
  savedPointOverlays = [],
  selectedPointId = null,
  selectedProvinceId = null,
  selectedProvinceName = null,
  showChrome = true,
}: DeckMapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [viewState, setViewState] = useState<MapViewState>(INITIAL_VIEW_STATE)
  const [viewportSize, setViewportSize] = useState<ViewportSize>({ width: 0, height: 0 })
  const [draftCoordinates, setDraftCoordinates] = useState<Position[]>([])
  const [cursorCoordinate, setCursorCoordinate] = useState<Position | null>(null)
  const [activeSpiderGroupId, setActiveSpiderGroupId] = useState<string | null>(null)
  const [hoveredPointId, setHoveredPointId] = useState<string | null>(null)
  const pointMode = pointRenderState?.mode ?? 'clusters'
  const showPointClusters = pointMode === 'clusters'
  const isDrafting = activeTool !== 'pan'
  const allowFeaturePicking = activeTool === 'pan'
  const cameraBounds = useMemo(
    () => provinceCollectionBounds(provinceCollection) ?? INDONESIA_FALLBACK_BOUNDS,
    [provinceCollection],
  )
  const selectedProvinceFeature = useMemo(
    () =>
      provinceCollection?.features.find(
        (feature) => feature.properties?.provinceId === selectedProvinceId,
      ) ?? null,
    [provinceCollection, selectedProvinceId],
  )
  const selectedProvinceBounds = useMemo(
    () => geometryBounds(selectedProvinceFeature?.geometry),
    [selectedProvinceFeature],
  )
  const viewStateRef = useRef(viewState)
  const viewportSizeRef = useRef(viewportSize)
  const cameraBoundsRef = useRef(cameraBounds)
  const lastAutoFitProvinceIdRef = useRef<string | null>(null)
  const reportedViewStateRef = useRef<MapViewState | null>(null)
  const pitchGestureRef = useRef<{ startClientY: number; startPitch: number } | null>(null)
  const isPointerInsideMapRef = useRef(false)
  const isSpacePitchModifierRef = useRef(false)
  const draftCoordinatesRef = useRef<Position[]>([])
  const isPointInteractionZoom =
    allowFeaturePicking && viewState.zoom >= POINT_INTERACTION_ZOOM_THRESHOLD

  useEffect(() => {
    viewStateRef.current = viewState
  }, [viewState])

  useEffect(() => {
    draftCoordinatesRef.current = draftCoordinates
  }, [draftCoordinates])

  useEffect(() => {
    if (!controlledViewState) {
      return
    }

    setViewState((current) =>
      viewStateEquals(current, controlledViewState) ? current : controlledViewState,
    )
  }, [controlledViewState])

  useEffect(() => {
    draftCoordinatesRef.current = []
    setDraftCoordinates([])
    setCursorCoordinate(null)
    setHoveredPointId(null)
    setActiveSpiderGroupId(null)
  }, [activeTool])

  useEffect(() => {
    draftCoordinatesRef.current = []
    setDraftCoordinates([])
    setCursorCoordinate(null)
    setHoveredPointId(null)
    setActiveSpiderGroupId(null)
  }, [clearVersion])

  useEffect(() => {
    if (!onMapViewStateChange) {
      return
    }

    if (
      reportedViewStateRef.current &&
      viewStateEquals(reportedViewStateRef.current, viewState)
    ) {
      return
    }

    reportedViewStateRef.current = viewState
    onMapViewStateChange(viewState)
  }, [onMapViewStateChange, viewState])

  useEffect(() => {
    viewportSizeRef.current = viewportSize
  }, [viewportSize])

  useEffect(() => {
    cameraBoundsRef.current = cameraBounds
  }, [cameraBounds])

  useEffect(() => {
    if (!selectedProvinceId) {
      lastAutoFitProvinceIdRef.current = null
      return
    }

    if (!selectedProvinceBounds || viewportSize.width <= 0 || viewportSize.height <= 0) {
      return
    }

    if (lastAutoFitProvinceIdRef.current === selectedProvinceId) {
      return
    }

    lastAutoFitProvinceIdRef.current = selectedProvinceId
    setViewState((current) =>
      clampViewStateToBounds(
        fitViewStateToBounds(selectedProvinceBounds, viewportSize, current),
        viewportSize,
        cameraBounds,
      ),
    )
  }, [cameraBounds, selectedProvinceBounds, selectedProvinceId, viewportSize])

  useEffect(() => {
    const container = containerRef.current

    if (!container) {
      return
    }

    const resizeObserver = new ResizeObserver((entries) => {
      const [entry] = entries

      if (!entry) {
        return
      }

      const nextWidth = Math.round(entry.contentRect.width)
      const nextHeight = Math.round(entry.contentRect.height)

      setViewportSize((current) =>
        current.width === nextWidth && current.height === nextHeight
          ? current
          : { width: nextWidth, height: nextHeight },
      )
    })

    resizeObserver.observe(container)
    setViewportSize({
      width: Math.round(container.clientWidth),
      height: Math.round(container.clientHeight),
    })

    return () => resizeObserver.disconnect()
  }, [])

  useEffect(() => {
    setViewState((current) => {
      const nextViewState = clampViewStateToBounds(current, viewportSize, cameraBounds)
      return viewStateEquals(current, nextViewState) ? current : nextViewState
    })
  }, [cameraBounds, viewportSize])

  useEffect(() => {
    setActiveSpiderGroupId(null)
  }, [pointData, showPointClusters])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space') {
        return
      }

      if (isEditableTarget(event.target)) {
        return
      }

      isSpacePitchModifierRef.current = true

      if (isPointerInsideMapRef.current) {
        event.preventDefault()
      }
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space') {
        return
      }

      isSpacePitchModifierRef.current = false
    }

    const handleWindowBlur = () => {
      isSpacePitchModifierRef.current = false
      pitchGestureRef.current = null
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleWindowBlur)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleWindowBlur)
    }
  }, [])

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      const gesture = pitchGestureRef.current

      if (!gesture) {
        return
      }

      if (event.buttons === 0) {
        pitchGestureRef.current = null
        return
      }

      event.preventDefault()
      const nextPitch = clampValue(
        gesture.startPitch + (gesture.startClientY - event.clientY) * PITCH_DRAG_DEGREES_PER_PIXEL,
        0,
        MAX_MAP_PITCH,
      )

      setViewState((current) => {
        const nextViewState = clampViewStateToBounds(
          {
            ...current,
            pitch: nextPitch,
          },
          viewportSizeRef.current,
          cameraBoundsRef.current,
        )

        return viewStateEquals(current, nextViewState) ? current : nextViewState
      })
    }

    const stopPitchGesture = () => {
      pitchGestureRef.current = null
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', stopPitchGesture)
    window.addEventListener('blur', stopPitchGesture)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', stopPitchGesture)
      window.removeEventListener('blur', stopPitchGesture)
    }
  }, [])

  useEffect(() => {
    if (!isPointInteractionZoom) {
      setHoveredPointId(null)
      setActiveSpiderGroupId(null)
    }
  }, [isPointInteractionZoom])

  const viewportBbox = useMemo(
    () => calculateViewportBbox(viewState, viewportSize),
    [viewState, viewportSize],
  )
  const fetchBbox = useMemo(
    () => calculateViewportBbox(viewState, viewportSize, VIEWPORT_BBOX_OVERSCAN_RATIO),
    [viewState, viewportSize],
  )

  useEffect(() => {
    onViewportBoundsChange?.({
      viewportBbox,
      fetchBbox,
      zoom: viewState.zoom,
    })
  }, [fetchBbox, onViewportBoundsChange, viewportBbox, viewState.zoom])

  const lineCollection = useMemo(
    () =>
      filterCollection(featureCollection, (feature) => {
        const geometryType = feature.geometry?.type
        return geometryType === 'LineString' || geometryType === 'MultiLineString'
      }),
    [featureCollection],
  )

  const polygonCollection = useMemo(
    () =>
      filterCollection(featureCollection, (feature) => {
        const geometryType = feature.geometry?.type
        return geometryType === 'Polygon' || geometryType === 'MultiPolygon'
      }),
    [featureCollection],
  )
  const drawnPointFeatureData = useMemo(
    () =>
      featureCollection.features.flatMap((feature) => {
        if (
          feature.geometry?.type !== 'Point' ||
          feature.properties?.rawProperties?.source !== 'drawn'
        ) {
          return []
        }

        const [longitude, latitude] = feature.geometry.coordinates

        return [
          {
            id: String(feature.id ?? `${longitude}:${latitude}`),
            featureId: null,
            name:
              typeof feature.properties?.name === 'string'
                ? feature.properties.name
                : 'Drawn node',
            longitude: Number(longitude),
            latitude: Number(latitude),
            sourcePath: feature.properties?.sourcePath ?? null,
            rawProperties:
              feature.properties?.rawProperties && typeof feature.properties.rawProperties === 'object'
                ? feature.properties.rawProperties
                : null,
            style: feature.properties?.style ?? null,
            styleUrl: null,
          } satisfies ImportedPointTilePoint,
        ]
      }),
    [featureCollection.features],
  )
  const fetchedFeatureIds = useMemo(
    () =>
      new Set(
        featureCollection.features
          .map((feature) => feature.id)
          .filter((id): id is string | number => id !== undefined && id !== null)
          .map((id) => String(id)),
      ),
    [featureCollection.features],
  )
  const fetchedFeatureIdentities = useMemo(
    () =>
      new Set(
        featureCollection.features.map((feature) =>
          featureIdentity(feature as Feature<Geometry>),
        ),
      ),
    [featureCollection.features],
  )
  const renderableDraftFeatures = useMemo(
    () =>
      draftFeatures.filter((draft) => {
        if (!draft.isSaved) {
          return true
        }

        if (draft.feature.geometry.type === 'Point') {
          return true
        }

        const featureId =
          draft.feature.id !== undefined && draft.feature.id !== null
            ? String(draft.feature.id)
            : null

        if (featureId && fetchedFeatureIds.has(featureId)) {
          return false
        }

        return !fetchedFeatureIdentities.has(featureIdentity(draft.feature))
      }),
    [
      draftFeatures,
      fetchedFeatureIds,
      fetchedFeatureIdentities,
    ],
  )
  const localDraftGeometryCollection = useMemo<FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: renderableDraftFeatures
        .map((entry) => entry.feature)
        .filter((feature) => feature.geometry.type !== 'Point'),
    }),
    [renderableDraftFeatures],
  )
  const localDraftPointData = useMemo(
    () => flattenSessionPoints(renderableDraftFeatures),
    [renderableDraftFeatures],
  )
  const localDraftGeometryLabelData = useMemo(
    () => flattenSessionGeometryLabels(renderableDraftFeatures),
    [renderableDraftFeatures],
  )
  const draftFeature = useMemo(
    () => buildDraftFeature(activeTool, draftCoordinates, cursorCoordinate),
    [activeTool, cursorCoordinate, draftCoordinates],
  )
  const draftVertexData = useMemo(
    () =>
      draftCoordinates.map((position, index) => ({
        id: `draft-vertex-${index}`,
        position: [Number(position[0]), Number(position[1])] as [number, number],
      })),
    [draftCoordinates],
  )
  const draftCollection = useMemo<FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: draftFeature ? [draftFeature] : [],
    }),
    [draftFeature],
  )

  const pointLabelData = useMemo(
    () =>
      pointData.filter((point) => isRenderableLabelName(point.name)),
    [pointData],
  )
  const pointOverlapGroups = useMemo(
    () =>
      showPointClusters ? [] : buildPointOverlapGroups(pointData, viewState, viewportSize),
    [pointData, showPointClusters, viewState, viewportSize],
  )
  const groupedPointIds = useMemo(
    () =>
      new Set(
        pointOverlapGroups.flatMap((group) =>
          group.points.length > 1 ? group.points.map((point) => point.id) : [],
        ),
      ),
    [pointOverlapGroups],
  )
  const collapsedOverlapGroups = useMemo(
    () =>
      pointOverlapGroups
        .filter((group) => group.points.length > 1 && group.id !== activeSpiderGroupId)
        .map((group) => ({
          id: group.id,
          count: group.points.length,
          longitude: group.longitude,
          latitude: group.latitude,
          points: group.points,
        })),
    [activeSpiderGroupId, pointOverlapGroups],
  )
  const isolatedPointData = useMemo(
    () => pointData.filter((point) => !groupedPointIds.has(point.id)),
    [groupedPointIds, pointData],
  )
  const activeSpiderGroup = useMemo(
    () =>
      pointOverlapGroups.find((group) => group.id === activeSpiderGroupId) ?? null,
    [activeSpiderGroupId, pointOverlapGroups],
  )
  const spiderfiedPointState = useMemo(
    () => buildSpiderfiedPoints(activeSpiderGroup, viewState, viewportSize),
    [activeSpiderGroup, viewState, viewportSize],
  )
  const spiderfiedPointData = spiderfiedPointState.points
  const spiderLegData = spiderfiedPointState.legs
  const spiderfiedPointById = useMemo(
    () => new Map(spiderfiedPointData.map((point) => [point.id, point])),
    [spiderfiedPointData],
  )
  const isolatedPointLabelData = useMemo(
    () => pointLabelData.filter((point) => !groupedPointIds.has(point.id)),
    [groupedPointIds, pointLabelData],
  )
  useEffect(() => {
    if (!activeSpiderGroupId) {
      return
    }

    if (pointOverlapGroups.some((group) => group.id === activeSpiderGroupId)) {
      return
    }

    setActiveSpiderGroupId(null)
  }, [activeSpiderGroupId, pointOverlapGroups])
  const importedRouteLabelData = useMemo(
    () => flattenRouteLabels(lineCollection.features),
    [lineCollection.features],
  )
  const importedLineLabelData = useMemo(
    () => flattenNonRouteGeometryLabels(lineCollection.features),
    [lineCollection.features],
  )
  const importedRouteSegmentLabelData = useMemo(
    () => flattenRouteSegmentLabels(lineCollection.features),
    [lineCollection.features],
  )
  const importedPolygonLabelData = useMemo(
    () => flattenGeometryLabels(polygonCollection.features),
    [polygonCollection.features],
  )
  const backendPointIds = useMemo(
    () => new Set([...pointData, ...drawnPointFeatureData].map((point) => point.id)),
    [drawnPointFeatureData, pointData],
  )
  const pointDataById = useMemo(
    () =>
      new Map(
        [...savedPointOverlays, ...drawnPointFeatureData, ...pointData].map((point) => [
          point.id,
          point,
        ]),
      ),
    [drawnPointFeatureData, pointData, savedPointOverlays],
  )
  const persistedOverlayPoints = useMemo(
    () => savedPointOverlays.filter((point) => !backendPointIds.has(point.id)),
    [backendPointIds, savedPointOverlays],
  )
  const persistedOverlayLabelData = useMemo(
    () => persistedOverlayPoints.filter((point) => isRenderableLabelName(point.name)),
    [persistedOverlayPoints],
  )
  const selectedPoint = useMemo(() => {
    if (!isPointInteractionZoom || !selectedPointId) {
      return null
    }

    return spiderfiedPointById.get(selectedPointId) ?? pointDataById.get(selectedPointId) ?? null
  }, [isPointInteractionZoom, pointDataById, selectedPointId, spiderfiedPointById])
  const hoveredPoint = useMemo(() => {
    if (!isPointInteractionZoom || !hoveredPointId || hoveredPointId === selectedPointId) {
      return null
    }

    return spiderfiedPointById.get(hoveredPointId) ?? pointDataById.get(hoveredPointId) ?? null
  }, [hoveredPointId, isPointInteractionZoom, pointDataById, selectedPointId, spiderfiedPointById])

  const handleImportedFeatureClick = useCallback(
    (feature: ImportedFeature | undefined) => {
      if (!feature) {
        return
      }

      setHoveredPointId(null)
      setActiveSpiderGroupId(null)
      onFeatureSelect?.(toSelectedFeatureDetail(feature))
    },
    [onFeatureSelect],
  )

  const handleOverlapGroupExpand = useCallback(
    (group: PointOverlapGroup | CollapsedOverlapDatum | undefined) => {
      if (!group) {
        return
      }

      setHoveredPointId(null)
      setActiveSpiderGroupId(group.id)
      onFeatureSelect?.(null)
      setViewState((current) =>
        clampViewStateToBounds(
          {
            ...current,
            longitude: group.longitude,
            latitude: group.latitude,
            zoom: Math.min(MAX_MAP_ZOOM, Math.max(current.zoom, POINT_LABEL_ZOOM_THRESHOLD + 1)),
          },
          viewportSize,
          cameraBounds,
        ),
      )
    },
    [cameraBounds, onFeatureSelect, viewportSize],
  )

  const handlePointClick = useCallback(
    (point: ImportedPointTilePoint | undefined, x?: number, y?: number) => {
      if (!point) {
        return
      }

      setHoveredPointId(point.id)

      if (!isPointInteractionZoom) {
        setActiveSpiderGroupId(null)
        onFeatureSelect?.(null)
        setViewState((current) =>
          focusViewStateToPoint(current, viewportSize, cameraBounds, point, POINT_INTERACTION_ZOOM_THRESHOLD),
        )
        return
      }

      if (Number.isFinite(x) && Number.isFinite(y)) {
        const overlappingPoints = sortNearbyPointsByCursorDistance(
          isolatedPointData,
          viewState,
          viewportSize,
          Number(x),
          Number(y),
        )

        if (overlappingPoints.length > 1) {
          const nearestGroup = pointOverlapGroups.find((group) =>
            group.points.some((candidate) => candidate.id === point.id),
          )

          if (nearestGroup) {
            setActiveSpiderGroupId(nearestGroup.id)
            onFeatureSelect?.(null)
            return
          }

          onFeatureSelect?.(null)
          return
        }
      }

      setActiveSpiderGroupId(null)
      setViewState((current) => focusViewStateToPoint(current, viewportSize, cameraBounds, point, 20))
      onFeatureSelect?.(toSelectedPointDetail(point))
    },
    [
      cameraBounds,
      isPointInteractionZoom,
      isolatedPointData,
      onFeatureSelect,
      pointOverlapGroups,
      viewState,
      viewportSize,
    ],
  )

  const handlePointOverlapChoice = useCallback(
    (point: ImportedPointTilePoint) => {
      setHoveredPointId(point.id)
      setActiveSpiderGroupId(null)
      setViewState((current) => focusViewStateToPoint(current, viewportSize, cameraBounds, point, 20))
      onFeatureSelect?.(toSelectedPointDetail(point))
    },
    [cameraBounds, onFeatureSelect, viewportSize],
  )

  const handlePointHover = useCallback(
    (point: ImportedPointTilePoint | undefined) => {
      if (!isPointInteractionZoom || !point) {
        setHoveredPointId(null)
        return
      }

      setHoveredPointId(point.id)
    },
    [isPointInteractionZoom],
  )

  const handlePitchGestureStart = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const wantsPitch =
      event.button === 2 ||
      (event.button === 0 &&
        (event.shiftKey || event.ctrlKey || isSpacePitchModifierRef.current))

    if (!wantsPitch) {
      return
    }

    pitchGestureRef.current = {
      startClientY: event.clientY,
      startPitch: viewStateRef.current.pitch ?? 0,
    }
    setHoveredPointId(null)
    setActiveSpiderGroupId(null)
    event.preventDefault()
    event.stopPropagation()
  }, [])

  const handleProvinceClick = useCallback(
    (province: ProvinceFeature | undefined) => {
      if (!province) {
        return
      }

      setHoveredPointId(null)
      setActiveSpiderGroupId(null)
      const provinceId = province.properties.provinceId
      const bounds = geometryBounds(province.geometry)

      if (bounds) {
        setViewState((current) =>
          clampViewStateToBounds(
            fitViewStateToBounds(bounds, viewportSize, current),
            viewportSize,
            cameraBounds,
          ),
        )
      }

      onProvinceSelect?.(provinceId)
      onFeatureSelect?.(null)
    },
    [cameraBounds, onFeatureSelect, onProvinceSelect, viewportSize],
  )

  const commitSketch = useCallback(
    (coordinates: Position[]) => {
      if (activeTool !== 'line' && activeTool !== 'polygon') {
        return false
      }

      return Boolean(
        onDraftSketchChange?.(
          activeTool,
          coordinates.map((coordinate) => [Number(coordinate[0]), Number(coordinate[1])]),
          true,
        ),
      )
    },
    [activeTool, onDraftSketchChange],
  )

  const handleDraftMapClick = useCallback(
    (info: PickingInfo<unknown>) => {
      if (info.layer?.id === 'province-boundaries' && !selectedProvinceId) {
        return
      }

      const coordinate =
        Array.isArray(info.coordinate) && info.coordinate.length >= 2
          ? normalizeCoordinate(info.coordinate)
          : null

      if (!coordinate) {
        return
      }

      if (activeTool === 'placemark') {
        onDraftPointCreate?.({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: coordinate,
          },
          properties: {
            description: 'Placed from the toolbar node tool.',
            name: 'Drawn node',
          },
        })
        return
      }

      if (activeTool === 'measure') {
        onMeasurePointSelect?.([Number(coordinate[0]), Number(coordinate[1])])
        return
      }

      if (activeTool !== 'line' && activeTool !== 'polygon') {
        return
      }

      const nextCoordinates = [...draftCoordinatesRef.current, coordinate]
      draftCoordinatesRef.current = nextCoordinates
      setDraftCoordinates(nextCoordinates)
      onDraftSketchChange?.(
        activeTool,
        nextCoordinates.map((item) => [Number(item[0]), Number(item[1])]),
        false,
      )
    },
    [activeTool, onDraftPointCreate, onDraftSketchChange, onMeasurePointSelect, selectedProvinceId],
  )

  const handleDraftMapDoubleClick = useCallback(() => {
    if (activeTool !== 'line' && activeTool !== 'polygon') {
      return
    }

    const currentCoordinates = draftCoordinatesRef.current
    const lastCoordinate = currentCoordinates[currentCoordinates.length - 1]
    const previousCoordinate = currentCoordinates[currentCoordinates.length - 2]
    const snappedCoordinates =
      samePosition(lastCoordinate, previousCoordinate)
        ? currentCoordinates.slice(0, -1)
        : currentCoordinates

    if (snappedCoordinates.length === 0) {
      return
    }

    const didCommit = commitSketch(snappedCoordinates)
    if (!didCommit) {
      return
    }

    draftCoordinatesRef.current = []
    setDraftCoordinates([])
    setCursorCoordinate(null)
  }, [activeTool, commitSketch])

  useEffect(() => {
    const handleEnterKey = (event: KeyboardEvent) => {
      if (event.code !== 'Enter' || isEditableTarget(event.target)) {
        return
      }

      if (activeTool !== 'line' && activeTool !== 'polygon') {
        return
      }

      event.preventDefault()
      handleDraftMapDoubleClick()
    }

    window.addEventListener('keydown', handleEnterKey)
    return () => window.removeEventListener('keydown', handleEnterKey)
  }, [activeTool, handleDraftMapDoubleClick])

  const layers = useMemo(() => {
    const assembledLayers: Layer[] = [
      new TileLayer({
        id: 'osm-raster-tiles',
        data: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        minZoom: 0,
        maxZoom: 19,
        tileSize: 256,
        maxRequests: 16,
        renderSubLayers: (props) => {
          const [[minX, minY], [maxX, maxY]] = props.tile.boundingBox

          return new BitmapLayer(props, {
            data: undefined,
            image: props.data,
            bounds: [minX, minY, maxX, maxY],
          })
        },
      }),
    ]

    if (provinceCollection?.features.length) {
      assembledLayers.push(
        new GeoJsonLayer({
          id: 'province-boundaries',
          data: provinceCollection,
          pickable: !selectedProvinceId,
          stroked: true,
          filled: true,
          lineWidthUnits: 'pixels',
          lineWidthMinPixels: 1,
          getFillColor: (feature) =>
            feature.properties?.provinceId === selectedProvinceId
              ? PROVINCE_FILL_ACTIVE
              : PROVINCE_FILL_IDLE,
          getLineColor: (feature) =>
            feature.properties?.provinceId === selectedProvinceId
              ? PROVINCE_LINE_ACTIVE
              : PROVINCE_LINE_IDLE,
          getLineWidth: (feature) => (feature.properties?.provinceId === selectedProvinceId ? 0 : 2),
          onClick: (info) => handleProvinceClick(info.object as ProvinceFeature | undefined),
          updateTriggers: {
            getFillColor: [selectedProvinceId],
            getLineColor: [selectedProvinceId],
            getLineWidth: [selectedProvinceId],
          },
        }),
      )
    }

    if (polygonCollection.features.length > 0) {
      assembledLayers.push(
        new GeoJsonLayer({
          id: 'imported-polygons',
          data: polygonCollection,
          pickable: allowFeaturePicking,
          stroked: true,
          filled: true,
          getFillColor: polygonFillColor,
          getLineColor: polygonStrokeColor,
          getLineWidth: (feature) => lineWidth(feature as ImportedFeature, 2),
          lineWidthUnits: 'pixels',
          onClick: allowFeaturePicking
            ? (info) => handleImportedFeatureClick(info.object as ImportedFeature | undefined)
            : undefined,
        }),
      )

      if (viewState.zoom >= GEOMETRY_LABEL_ZOOM_THRESHOLD && importedPolygonLabelData.length > 0) {
        assembledLayers.push(
          new TextLayer<GeometryLabelDatum>({
            id: 'imported-polygon-labels',
            data: importedPolygonLabelData,
            pickable: false,
            billboard: true,
            sizeUnits: 'pixels',
            sizeMinPixels: 12,
            sizeMaxPixels: 20,
            getPosition: (feature) => feature.position,
            getText: (feature) => feature.name,
            getColor: (feature) => feature.labelColor,
            getSize: (feature) => feature.labelSize,
            getTextAnchor: 'middle',
            getAlignmentBaseline: 'center',
            outlineWidth: 3,
            outlineColor: [255, 255, 255, 225],
          }),
        )
      }
    }

    if (lineCollection.features.length > 0) {
      assembledLayers.push(
        new GeoJsonLayer({
          id: 'imported-lines',
          data: lineCollection,
          pickable: allowFeaturePicking,
          stroked: true,
          filled: false,
          getLineColor: lineColor,
          getLineWidth: (feature) => lineWidth(feature as ImportedFeature, 3),
          lineWidthUnits: 'pixels',
          lineCapRounded: true,
          lineJointRounded: true,
          onClick: allowFeaturePicking
            ? (info) => handleImportedFeatureClick(info.object as ImportedFeature | undefined)
            : undefined,
        }),
      )

      if (viewState.zoom >= ROUTE_LABEL_ZOOM_THRESHOLD && importedRouteLabelData.length > 0) {
        assembledLayers.push(
          new TextLayer<GeometryLabelDatum>({
            id: 'imported-route-labels',
            data: importedRouteLabelData,
            pickable: false,
            billboard: true,
            sizeUnits: 'pixels',
            sizeMinPixels: 11,
            sizeMaxPixels: 16,
            getPosition: (feature) => feature.position,
            getText: (feature) => feature.name,
            getColor: (feature) => feature.labelColor,
            getSize: (feature) => feature.labelSize,
            getTextAnchor: 'middle',
            getAlignmentBaseline: 'center',
            outlineWidth: 4,
            outlineColor: [255, 255, 255, 235],
          }),
        )
      }

      if (
        viewState.zoom >= GEOMETRY_LABEL_ZOOM_THRESHOLD &&
        importedLineLabelData.length > 0
      ) {
        assembledLayers.push(
          new TextLayer<GeometryLabelDatum>({
            id: 'imported-line-labels',
            data: importedLineLabelData,
            pickable: false,
            billboard: true,
            sizeUnits: 'pixels',
            sizeMinPixels: 12,
            sizeMaxPixels: 18,
            getPosition: (feature) => feature.position,
            getText: (feature) => feature.name,
            getColor: (feature) => feature.labelColor,
            getSize: (feature) => feature.labelSize,
            getTextAnchor: 'middle',
            getAlignmentBaseline: 'center',
            outlineWidth: 3,
            outlineColor: [255, 255, 255, 225],
          }),
        )
      }

      if (
        viewState.zoom >= ROUTE_SEGMENT_LABEL_ZOOM_THRESHOLD &&
        importedRouteSegmentLabelData.length > 0
      ) {
        assembledLayers.push(
          new TextLayer<GeometryLabelDatum>({
            id: 'imported-route-segment-labels',
            data: importedRouteSegmentLabelData,
            pickable: false,
            billboard: true,
            sizeUnits: 'pixels',
            sizeMinPixels: 11,
            sizeMaxPixels: 16,
            getPosition: (feature) => feature.position,
            getText: (feature) => feature.name,
            getColor: (feature) => feature.labelColor,
            getSize: (feature) => Math.min(feature.labelSize, 14),
            getTextAnchor: 'middle',
            getAlignmentBaseline: 'center',
            outlineWidth: 3,
            outlineColor: [255, 255, 255, 220],
          }),
        )
      }
    }

    if (localDraftGeometryCollection.features.length > 0) {
      assembledLayers.push(
        new GeoJsonLayer({
          id: 'session-geometry',
          data: localDraftGeometryCollection,
          pickable: false,
          stroked: true,
          filled: true,
          getFillColor: [56, 189, 248, 56],
          getLineColor: [14, 165, 233, 255],
          getLineWidth: 3,
          lineWidthUnits: 'pixels',
          pointRadiusUnits: 'pixels',
          pointRadiusMinPixels: 5,
          getPointRadius: 6,
        }),
      )

      if (localDraftGeometryLabelData.length > 0) {
        assembledLayers.push(
          new TextLayer<GeometryLabelDatum>({
            id: 'session-geometry-labels',
            data: localDraftGeometryLabelData,
            pickable: false,
            billboard: true,
            sizeUnits: 'pixels',
            sizeMinPixels: 13,
            sizeMaxPixels: 22,
            getPosition: (feature) => feature.position,
            getText: (feature) => feature.name,
            getColor: (feature) => feature.labelColor,
            getSize: (feature) => feature.labelSize,
            getTextAnchor: 'middle',
            getAlignmentBaseline: 'center',
            outlineWidth: 3,
            outlineColor: [255, 255, 255, 230],
          }),
        )
      }
    }

    if (showPointClusters && clusterData.length > 0) {
      assembledLayers.push(
        new ScatterplotLayer<ImportedPointCluster>({
          id: 'imported-point-clusters',
          data: clusterData,
          pickable: allowFeaturePicking,
          stroked: true,
          filled: true,
          radiusUnits: 'pixels',
          radiusMinPixels: 8,
          radiusMaxPixels: 32,
          getPosition: (cluster) => cluster.position,
          getRadius: clusterRadius,
          getFillColor: clusterFillColor,
          getLineColor: clusterStrokeColor,
          getLineWidth: 2,
          onClick: allowFeaturePicking
            ? (info) => {
                const cluster = info.object

                if (!cluster || cluster.count <= 1) {
                  return
                }

                onFeatureSelect?.(null)
                setViewState((current) =>
                  clampViewStateToBounds(
                    {
                      ...current,
                      longitude: cluster.position[0],
                      latitude: cluster.position[1],
                      zoom: Math.min(
                        MAX_MAP_ZOOM,
                        Math.max(current.zoom + 2, POINT_CLUSTER_ZOOM_THRESHOLD),
                      ),
                    },
                    viewportSize,
                    cameraBounds,
                  ),
                )
                setHoveredPointId(null)
                setActiveSpiderGroupId(null)
              }
            : undefined,
        }),
      )

      assembledLayers.push(
        new TextLayer<ImportedPointCluster>({
          id: 'imported-point-cluster-counts',
          data: clusterData.filter((cluster) => cluster.count > 1),
          pickable: false,
          billboard: true,
          sizeUnits: 'pixels',
          sizeMinPixels: 11,
          sizeMaxPixels: 18,
          getPosition: (cluster) => cluster.position,
          getText: (cluster) => String(cluster.count),
          getColor: [255, 255, 255, 240],
          getSize: clusterLabelSize,
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'center',
        }),
      )
    }

    if (!showPointClusters && collapsedOverlapGroups.length > 0) {
      assembledLayers.push(
        new LineLayer<SpiderLegDatum>({
          id: 'collapsed-overlap-halos',
          data: [],
          pickable: false,
          getSourcePosition: (segment) => segment.sourcePosition,
          getTargetPosition: (segment) => segment.targetPosition,
          getColor: [0, 0, 0, 0],
          getWidth: 0,
        }),
      )

      assembledLayers.push(
        new ScatterplotLayer<CollapsedOverlapDatum>({
          id: 'collapsed-overlap-groups',
          data: collapsedOverlapGroups,
          pickable: allowFeaturePicking,
          stroked: true,
          filled: true,
          radiusUnits: 'pixels',
          radiusMinPixels: 10,
          radiusMaxPixels: 24,
          getPosition: (group) => [group.longitude, group.latitude],
          getRadius: (group) => overlapBadgeRadius(group.count),
          getFillColor: [31, 41, 55, 214],
          getLineColor: [255, 247, 237, 255],
          getLineWidth: 2,
          onClick: allowFeaturePicking
            ? (info) => handleOverlapGroupExpand(info.object as CollapsedOverlapDatum | undefined)
            : undefined,
        }),
      )

      assembledLayers.push(
        new TextLayer<CollapsedOverlapDatum>({
          id: 'collapsed-overlap-counts',
          data: collapsedOverlapGroups,
          pickable: allowFeaturePicking,
          billboard: true,
          sizeUnits: 'pixels',
          sizeMinPixels: 11,
          sizeMaxPixels: 16,
          getPosition: (group) => [group.longitude, group.latitude],
          getText: (group) => String(group.count),
          getColor: [255, 255, 255, 240],
          getSize: () => 12,
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'center',
          onClick: allowFeaturePicking
            ? (info) => handleOverlapGroupExpand(info.object as CollapsedOverlapDatum | undefined)
            : undefined,
        }),
      )
    }

    if (!showPointClusters && isolatedPointData.length > 0) {
      assembledLayers.push(
        new IconLayer<ImportedPointTilePoint>({
          id: 'imported-points',
          data: isolatedPointData,
          pickable: allowFeaturePicking,
          billboard: true,
          sizeUnits: 'pixels',
          sizeMinPixels: 16,
          sizeMaxPixels: 36,
          getPosition: (point) => [point.longitude, point.latitude],
          getIcon: pointIcon,
          getSize: pointMarkerSize,
          onHover: allowFeaturePicking
            ? (info) => handlePointHover(info.object as ImportedPointTilePoint | undefined)
            : undefined,
          onClick: allowFeaturePicking
            ? (info) =>
                handlePointClick(info.object as ImportedPointTilePoint | undefined, info.x, info.y)
            : undefined,
        }),
      )
    }

    if (!showPointClusters && spiderLegData.length > 0) {
      assembledLayers.push(
        new LineLayer<SpiderLegDatum>({
          id: 'spiderfy-legs',
          data: spiderLegData,
          pickable: false,
          getSourcePosition: (leg) => leg.sourcePosition,
          getTargetPosition: (leg) => leg.targetPosition,
          getColor: [15, 23, 42, 150],
          getWidth: 2,
          widthUnits: 'pixels',
        }),
      )
    }

    if (!showPointClusters && spiderfiedPointData.length > 0) {
      assembledLayers.push(
        new IconLayer<SpiderfiedPointDatum>({
          id: 'spiderfied-points',
          data: spiderfiedPointData,
          pickable: allowFeaturePicking,
          billboard: true,
          sizeUnits: 'pixels',
          sizeMinPixels: 18,
          sizeMaxPixels: 38,
          getPosition: (point) => [point.longitude, point.latitude],
          getIcon: pointIcon,
          getSize: pointMarkerSize,
          onHover: allowFeaturePicking
            ? (info) => handlePointHover(info.object as ImportedPointTilePoint | undefined)
            : undefined,
          onClick: allowFeaturePicking
            ? (info) => handlePointOverlapChoice(info.object as ImportedPointTilePoint)
            : undefined,
        }),
      )
    }

    if (localDraftPointData.length > 0) {
      assembledLayers.push(
        new ScatterplotLayer<SessionPointDatum>({
          id: 'session-points',
          data: localDraftPointData,
          pickable: false,
          stroked: true,
          filled: true,
          radiusUnits: 'pixels',
          radiusMinPixels: 5,
          radiusMaxPixels: 11,
          getPosition: (point) => point.position,
          getRadius: 6,
          getFillColor: (point) => point.fillColor,
          getLineColor: (point) => point.lineColor,
          getLineWidth: 1,
        }),
      )

      assembledLayers.push(
        new TextLayer<SessionPointDatum>({
          id: 'session-point-labels',
          data: localDraftPointData.filter((point) => Boolean(point.name.trim())),
          pickable: false,
          billboard: true,
          sizeUnits: 'pixels',
          sizeMinPixels: 13,
          sizeMaxPixels: 22,
          getPosition: (point) => point.position,
          getText: (point) => point.name,
          getColor: (point) => point.labelColor,
          getSize: (point) => point.labelSize,
          getPixelOffset: [0, -16],
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'bottom',
          outlineWidth: 3,
          outlineColor: [255, 255, 255, 230],
        }),
      )
    }

    if (persistedOverlayPoints.length > 0) {
      assembledLayers.push(
        new ScatterplotLayer<ImportedPointTilePoint>({
          id: 'persisted-saved-points',
          data: persistedOverlayPoints,
          pickable: allowFeaturePicking,
          stroked: true,
          filled: true,
          radiusUnits: 'pixels',
          radiusMinPixels: 5,
          radiusMaxPixels: 12,
          getPosition: (point) => [point.longitude, point.latitude],
          getRadius: pointRadius,
          getFillColor: pointFillColor,
          getLineColor: pointStrokeColor,
          getLineWidth: 1,
          onHover: allowFeaturePicking
            ? (info) => handlePointHover(info.object as ImportedPointTilePoint | undefined)
            : undefined,
          onClick: allowFeaturePicking
            ? (info) =>
                handlePointClick(info.object as ImportedPointTilePoint | undefined, info.x, info.y)
            : undefined,
        }),
      )
    }

    if (drawnPointFeatureData.length > 0) {
      assembledLayers.push(
        new ScatterplotLayer<ImportedPointTilePoint>({
          id: 'persisted-drawn-point-features',
          data: drawnPointFeatureData,
          pickable: allowFeaturePicking,
          stroked: true,
          filled: true,
          radiusUnits: 'pixels',
          radiusMinPixels: 5,
          radiusMaxPixels: 12,
          getPosition: (point) => [point.longitude, point.latitude],
          getRadius: pointRadius,
          getFillColor: pointFillColor,
          getLineColor: pointStrokeColor,
          getLineWidth: 1,
          onHover: allowFeaturePicking
            ? (info) => handlePointHover(info.object as ImportedPointTilePoint | undefined)
            : undefined,
          onClick: allowFeaturePicking
            ? (info) =>
                handlePointClick(info.object as ImportedPointTilePoint | undefined, info.x, info.y)
            : undefined,
        }),
      )
    }

    if (
      !showPointClusters &&
      viewState.zoom >= POINT_LABEL_ZOOM_THRESHOLD &&
      isolatedPointLabelData.length > 0
    ) {
      assembledLayers.push(
        new TextLayer<ImportedPointTilePoint>({
          id: 'imported-point-labels',
          data: isolatedPointLabelData,
          pickable: allowFeaturePicking,
          billboard: true,
          sizeUnits: 'pixels',
          sizeMinPixels: 12,
          sizeMaxPixels: 20,
          getPosition: (point) => [point.longitude, point.latitude],
          getText: (point) => point.name ?? '',
          getColor: labelColor,
          getSize: pointLabelSize,
          getPixelOffset: (point) => [0, -pointLabelOffset(point)],
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'bottom',
          outlineWidth: 2,
          outlineColor: [255, 255, 255, 220],
          onHover: allowFeaturePicking
            ? (info) => handlePointHover(info.object as ImportedPointTilePoint | undefined)
            : undefined,
          onClick: allowFeaturePicking
            ? (info) =>
                handlePointClick(info.object as ImportedPointTilePoint | undefined, info.x, info.y)
            : undefined,
        }),
      )
    }

    if (
      !showPointClusters &&
      viewState.zoom >= POINT_LABEL_ZOOM_THRESHOLD &&
      spiderfiedPointData.length > 0
    ) {
      assembledLayers.push(
        new TextLayer<SpiderfiedPointDatum>({
          id: 'spiderfied-point-labels',
          data: spiderfiedPointData.filter((point) => isRenderableLabelName(point.name)),
          pickable: allowFeaturePicking,
          billboard: true,
          sizeUnits: 'pixels',
          sizeMinPixels: 13,
          sizeMaxPixels: 20,
          getPosition: (point) => [point.longitude, point.latitude],
          getText: (point) => point.name ?? '',
          getColor: labelColor,
          getSize: pointLabelSize,
          getPixelOffset: (point) => [0, -pointLabelOffset(point)],
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'bottom',
          outlineWidth: 3,
          outlineColor: [255, 255, 255, 228],
          onHover: allowFeaturePicking
            ? (info) => handlePointHover(info.object as ImportedPointTilePoint | undefined)
            : undefined,
          onClick: allowFeaturePicking
            ? (info) => handlePointOverlapChoice(info.object as ImportedPointTilePoint)
            : undefined,
        }),
      )
    }

    if (viewState.zoom >= POINT_LABEL_ZOOM_THRESHOLD && drawnPointFeatureData.length > 0) {
      assembledLayers.push(
        new TextLayer<ImportedPointTilePoint>({
          id: 'persisted-drawn-point-feature-labels',
          data: drawnPointFeatureData.filter((point) => isRenderableLabelName(point.name)),
          pickable: allowFeaturePicking,
          billboard: true,
          sizeUnits: 'pixels',
          sizeMinPixels: 12,
          sizeMaxPixels: 20,
          getPosition: (point) => [point.longitude, point.latitude],
          getText: (point) => point.name ?? '',
          getColor: labelColor,
          getSize: pointLabelSize,
          getPixelOffset: (point) => [0, -pointLabelOffset(point)],
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'bottom',
          outlineWidth: 2,
          outlineColor: [255, 255, 255, 220],
          onHover: allowFeaturePicking
            ? (info) => handlePointHover(info.object as ImportedPointTilePoint | undefined)
            : undefined,
          onClick: allowFeaturePicking
            ? (info) =>
                handlePointClick(info.object as ImportedPointTilePoint | undefined, info.x, info.y)
            : undefined,
        }),
      )
    }

    if (viewState.zoom >= POINT_LABEL_ZOOM_THRESHOLD && persistedOverlayLabelData.length > 0) {
      assembledLayers.push(
        new TextLayer<ImportedPointTilePoint>({
          id: 'persisted-saved-point-labels',
          data: persistedOverlayLabelData,
          pickable: allowFeaturePicking,
          billboard: true,
          sizeUnits: 'pixels',
          sizeMinPixels: 12,
          sizeMaxPixels: 20,
          getPosition: (point) => [point.longitude, point.latitude],
          getText: (point) => point.name ?? '',
          getColor: labelColor,
          getSize: pointLabelSize,
          getPixelOffset: (point) => [0, -pointLabelOffset(point)],
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'bottom',
          outlineWidth: 2,
          outlineColor: [255, 255, 255, 220],
          onHover: allowFeaturePicking
            ? (info) => handlePointHover(info.object as ImportedPointTilePoint | undefined)
            : undefined,
          onClick: allowFeaturePicking
            ? (info) =>
                handlePointClick(info.object as ImportedPointTilePoint | undefined, info.x, info.y)
            : undefined,
        }),
      )
    }

    if (draftCollection.features.length > 0) {
      assembledLayers.push(
        new GeoJsonLayer({
          id: 'draft-layer',
          data: draftCollection,
          pickable: false,
          stroked: true,
          filled: activeTool === 'polygon',
          getFillColor: (feature) =>
            toColor(feature.properties?.style?.fillColor, [255, 209, 102, 48]),
          getLineColor: (feature) =>
            toColor(feature.properties?.style?.lineColor, [56, 189, 248, 255]),
          getLineWidth: (feature) =>
            Number.isFinite(feature.properties?.style?.lineWidth)
              ? Math.max(2, Math.min(6, Number(feature.properties?.style?.lineWidth)))
              : 3,
          lineWidthUnits: 'pixels',
          lineDashJustified: true,
          getLineDashArray: [6, 4],
          pointRadiusUnits: 'pixels',
          pointRadiusMinPixels: 4,
          getPointRadius: 5,
        }),
      )
    }

    if (measurementOverlay && measurementOverlay.routeCoordinates.length >= 2) {
      assembledLayers.push(
        new GeoJsonLayer({
          id: 'measurement-route',
          data: {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                geometry: {
                  type: 'LineString',
                  coordinates: measurementOverlay.routeCoordinates,
                },
                properties: {},
              },
            ],
          },
          pickable: false,
          stroked: true,
          filled: false,
          getLineColor: measurementOverlay.routingUnavailable
            ? [244, 63, 94, 240]
            : [14, 165, 233, 245],
          getLineWidth: measurementOverlay.isRouting ? 3 : 5,
          lineWidthUnits: 'pixels',
          lineWidthMinPixels: 2,
          lineWidthMaxPixels: 7,
          lineDashJustified: measurementOverlay.routingUnavailable,
          getLineDashArray: measurementOverlay.routingUnavailable ? [6, 4] : [1, 0],
        }),
      )
    }

    if (measurementOverlay && measurementOverlay.points.length > 0) {
      assembledLayers.push(
        new ScatterplotLayer<{ id: string; position: [number, number]; isStart: boolean }>({
          id: 'measurement-markers',
          data: measurementOverlay.points.slice(0, 2).map((position, index) => ({
            id: index === 0 ? 'measurement-start' : 'measurement-end',
            isStart: index === 0,
            position,
          })),
          pickable: false,
          stroked: true,
          filled: true,
          radiusUnits: 'pixels',
          radiusMinPixels: 7,
          radiusMaxPixels: 11,
          getPosition: (item) => item.position,
          getRadius: (item) => (item.isStart ? 7 : 9),
          getFillColor: (item) => (item.isStart ? [14, 165, 233, 245] : [244, 63, 94, 245]),
          getLineColor: [255, 255, 255, 245],
          getLineWidth: 2,
        }),
      )
    }

    if (draftVertexData.length > 0) {
      assembledLayers.push(
        new ScatterplotLayer<{ id: string; position: [number, number] }>({
          id: 'draft-vertices',
          data: draftVertexData,
          pickable: false,
          stroked: true,
          filled: true,
          radiusUnits: 'pixels',
          radiusMinPixels: 3,
          radiusMaxPixels: 6,
          getPosition: (vertex) => vertex.position,
          getRadius: 4,
          getFillColor: [255, 255, 255, 110],
          getLineColor: [255, 255, 255, 180],
          getLineWidth: 1,
        }),
      )
    }

    if (!showPointClusters && isPointInteractionZoom && hoveredPoint) {
      assembledLayers.push(
        new ScatterplotLayer<ImportedPointTilePoint>({
          id: 'hovered-point-glow',
          data: [hoveredPoint],
          pickable: false,
          stroked: false,
          filled: true,
          radiusUnits: 'pixels',
          radiusMinPixels: 12,
          radiusMaxPixels: 28,
          getPosition: (point) => [point.longitude, point.latitude],
          getRadius: (point) => pointRadius(point) + 7,
          getFillColor: HOVER_GLOW_COLOR,
        }),
      )

      if (hoveredPoint.name?.trim() && viewState.zoom >= POINT_LABEL_ZOOM_THRESHOLD) {
        assembledLayers.push(
          new TextLayer<ImportedPointTilePoint>({
            id: 'hovered-point-label-glow',
            data: [hoveredPoint],
            pickable: false,
            billboard: true,
            sizeUnits: 'pixels',
            sizeMinPixels: 14,
            sizeMaxPixels: 24,
            getPosition: (point) => [point.longitude, point.latitude],
            getText: (point) => point.name ?? '',
            getColor: [255, 255, 255, 235],
            getSize: (point) => pointLabelSize(point) + 1,
            getPixelOffset: (point) => [0, -pointLabelOffset(point)],
            getTextAnchor: 'middle',
            getAlignmentBaseline: 'bottom',
            outlineWidth: 4,
            outlineColor: [255, 255, 255, 230],
          }),
        )
      }
    }

    if (!showPointClusters && isPointInteractionZoom && selectedPoint) {
      assembledLayers.push(
        new ScatterplotLayer<ImportedPointTilePoint>({
          id: 'selected-point-glow',
          data: [selectedPoint],
          pickable: false,
          stroked: false,
          filled: true,
          radiusUnits: 'pixels',
          radiusMinPixels: 14,
          radiusMaxPixels: 32,
          getPosition: (point) => [point.longitude, point.latitude],
          getRadius: (point) => pointRadius(point) + 9,
          getFillColor: SELECTED_GLOW_COLOR,
        }),
      )

      if (selectedPoint.name?.trim() && viewState.zoom >= POINT_LABEL_ZOOM_THRESHOLD) {
        assembledLayers.push(
          new TextLayer<ImportedPointTilePoint>({
            id: 'selected-point-label-glow',
            data: [selectedPoint],
            pickable: false,
            billboard: true,
            sizeUnits: 'pixels',
            sizeMinPixels: 14,
            sizeMaxPixels: 24,
            getPosition: (point) => [point.longitude, point.latitude],
            getText: (point) => point.name ?? '',
            getColor: [255, 244, 196, 240],
            getSize: (point) => pointLabelSize(point) + 1.5,
            getPixelOffset: (point) => [0, -pointLabelOffset(point)],
            getTextAnchor: 'middle',
            getAlignmentBaseline: 'bottom',
            outlineWidth: 5,
            outlineColor: [255, 208, 64, 235],
          }),
        )
      }
    }

    return assembledLayers
  }, [
    clusterData,
    draftCollection,
    draftVertexData,
    measurementOverlay,
    localDraftGeometryCollection,
    localDraftGeometryLabelData,
    localDraftPointData,
    activeTool,
    importedLineLabelData,
    importedPolygonLabelData,
    importedRouteLabelData,
    importedRouteSegmentLabelData,
    lineCollection,
    hoveredPoint,
    isPointInteractionZoom,
    allowFeaturePicking,
    drawnPointFeatureData,
    collapsedOverlapGroups,
    onFeatureSelect,
    isolatedPointData,
    isolatedPointLabelData,
    persistedOverlayLabelData,
    persistedOverlayPoints,
    polygonCollection,
    provinceCollection,
    cameraBounds,
    handleImportedFeatureClick,
    handleOverlapGroupExpand,
    handlePointClick,
    handlePointOverlapChoice,
    handlePointHover,
    handleProvinceClick,
    selectedPoint,
    selectedProvinceId,
    showPointClusters,
    spiderLegData,
    spiderfiedPointData,
    viewState.zoom,
    viewportSize,
  ])

  const renderedOverlayCount =
    (showPointClusters ? clusterData.length : pointData.length) +
    localDraftPointData.length +
    localDraftGeometryCollection.features.length
  const renderedFeatureCount = featureCollection.features.length + renderedOverlayCount
  const progressRatio =
    pointLoadProgress && pointLoadProgress.totalTiles > 0
      ? Math.max(0, Math.min(1, pointLoadProgress.loadedTiles / pointLoadProgress.totalTiles))
      : 0
  const showProvinceToast = Boolean(
    selectedProvinceName &&
      (isProvinceLoading ||
        (pointLoadProgress && pointLoadProgress.visibleLoadedTiles < pointLoadProgress.visibleTiles)),
  )
  const provinceToastTitle = pointLoadProgress?.isPaused
    ? `Paused ${selectedProvinceName ?? 'province'} loading`
    : loadingProvinceName
      ? `Loading ${loadingProvinceName}`
      : 'Loading planning area'
  const provinceToastMessage = pointLoadProgress?.isPaused
    ? 'Point requests pause while the map is moving. Stop moving to finish the visible area first.'
    : pointLoadProgress && pointLoadProgress.visibleTiles > 0
      ? pointLoadProgress.visibleLoadedTiles > 0
        ? `Visible area ${pointLoadProgress.visibleLoadedTiles}/${pointLoadProgress.visibleTiles} tiles ready. Nearby cache holds ${pointLoadProgress.cachedTiles} warm tiles.`
        : 'Loading the visible area first and keeping only a small nearby tile cache warm.'
      : 'Preparing the visible area with a bounded nearby tile cache.'

  const handleStreetViewDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!onStreetViewDrop) {
        return
      }

      const dragKind = event.dataTransfer.getData('application/x-geospatial-tool')
      if (dragKind !== 'street-view') {
        return
      }

      const container = containerRef.current
      const viewport = createMercatorViewport(viewStateRef.current, viewportSizeRef.current)
      if (!container || !viewport) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      const bounds = container.getBoundingClientRect()
      const [longitude, latitude] = viewport.unproject([
        event.clientX - bounds.left,
        event.clientY - bounds.top,
      ]) as [number, number]

      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
        return
      }

      onStreetViewDrop({
        lng: clampLongitude(longitude),
        lat: clampLatitude(latitude),
      })
    },
    [onStreetViewDrop],
  )

  return (
    <div
      ref={containerRef}
      className={isDrafting ? 'deck-shell cursor-crosshair' : 'deck-shell'}
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.types).includes('application/x-geospatial-tool')) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={handleStreetViewDrop}
      onContextMenu={(event) => {
        event.preventDefault()
      }}
      onMouseDownCapture={handlePitchGestureStart}
      onDoubleClickCapture={(event) => {
        if (!isDrafting) {
          return
        }

        event.preventDefault()
        event.stopPropagation()
        handleDraftMapDoubleClick()
      }}
      onMouseEnter={() => {
        isPointerInsideMapRef.current = true
      }}
      onMouseLeave={() => {
        isPointerInsideMapRef.current = false
        setCursorCoordinate(null)
        onPointerMove?.(null)
      }}
    >
      <DeckGL
        controller={{
          dragPan: true,
          doubleClickZoom: !isDrafting,
          dragRotate: false,
          touchRotate: false,
        }}
        layers={layers}
        style={{ position: 'absolute', inset: '0' }}
        viewState={viewState}
        onClick={(info) => {
          if (isDrafting) {
            handleDraftMapClick(info)
            return
          }

          if (!info.object) {
            setHoveredPointId(null)
            setActiveSpiderGroupId(null)
            onFeatureSelect?.(null)
          }
        }}
        onHover={(info) => {
          if (Array.isArray(info.coordinate) && info.coordinate.length >= 2) {
            const nextCoordinate = normalizeCoordinate(info.coordinate)
            setCursorCoordinate(nextCoordinate)
            onPointerMove?.({
              lng: nextCoordinate[0],
              lat: nextCoordinate[1],
            })
          } else {
            setCursorCoordinate(null)
            onPointerMove?.(null)
          }

          if (
            !isPointInteractionZoom ||
            !info.object ||
            (info.layer?.id !== 'imported-points' && info.layer?.id !== 'imported-point-labels')
          ) {
            setHoveredPointId(null)
          }
        }}
        onViewStateChange={({ viewState: nextViewState }) => {
          const boundedViewState = clampViewStateToBounds(
            nextViewState as MapViewState,
            viewportSizeRef.current,
            cameraBoundsRef.current,
          )

          if (viewStateEquals(viewStateRef.current, boundedViewState)) {
            return
          }

          setHoveredPointId((current) => (current === null ? current : null))
          setViewState(boundedViewState)
        }}
      />

      {showChrome ? (
        <>
          <div className="absolute top-4 left-4 z-10 w-80 rounded-xl bg-white/90 p-4 shadow backdrop-blur border border-white/20">
            <h3 className="font-semibold text-sm mb-2">Viewport</h3>
            <div className="text-sm font-medium mb-1">
              {viewState.longitude.toFixed(3)}, {viewState.latitude.toFixed(3)}
            </div>
            <p className="text-xs text-slate-500">
              Zoom {viewState.zoom.toFixed(2)}. Click a province polygon to set the active planning
              area. Left drag pans. Right drag pitches. Shift, Ctrl, or Space + left drag also
              pitches.{' '}
              {isViewportLoading
                ? 'Waiting for idle point loading and viewport feature refresh.'
                : 'Idle-driven nearby tile loading is active.'}
            </p>
          </div>

          {showProvinceToast ? (
            <div
              className="absolute top-4 right-4 z-10 w-80 rounded-xl bg-white/90 p-4 shadow backdrop-blur border border-white/20 flex gap-4"
              role="status"
              aria-live="polite"
              aria-busy="true"
            >
              <Loader2 className="h-5 w-5 animate-spin text-slate-500" />
              <div>
                <h3 className="font-semibold text-sm mb-1">{provinceToastTitle}</h3>
                <p className="text-xs text-slate-500">{provinceToastMessage}</p>
              </div>
            </div>
          ) : null}

          <div className="absolute bottom-4 inset-x-4 z-10 flex gap-4 pointer-events-none">
            {pointLoadProgress && selectedProvinceName ? (
              <div className="rounded-xl pointer-events-auto bg-white/90 p-4 shadow backdrop-blur border border-white/20 flex-1 max-w-sm">
                <h3 className="font-semibold text-sm mb-2">Province load</h3>
                <div className="text-sm font-medium mb-1">
                  {formatProgressValue(pointLoadProgress.cachedPoints)} nodes cached across{' '}
                  {formatProgressValue(pointLoadProgress.cachedTiles)} nearby tiles
                </div>
                <p className="text-xs text-slate-500 mb-2">
                  {pointLoadProgress.mode === 'clusters'
                    ? 'Low-zoom cluster cache.'
                    : 'High-zoom raw point cache.'}{' '}
                  {pointLoadProgress.isPaused
                    ? 'Paused while the map is moving.'
                    : pointLoadProgress.isLoading
                      ? `Visible tiles ${pointLoadProgress.visibleLoadedTiles}/${pointLoadProgress.visibleTiles}, requested tiles ${pointLoadProgress.loadedTiles}/${pointLoadProgress.totalTiles}.`
                      : 'Nearby cache is current for this zoom.'}
                </p>
                <div className="h-2 w-full rounded-full bg-slate-200 overflow-hidden">
                  <div className="h-full bg-blue-500" style={{ width: `${Math.round(progressRatio * 100)}%` }} />
                </div>
              </div>
            ) : null}

            <div className="rounded-xl pointer-events-auto bg-white/90 p-4 shadow backdrop-blur border border-white/20 flex-1 max-w-sm">
              <h3 className="font-semibold text-sm mb-2">Planning scene</h3>
              <div className="text-sm font-medium mb-1">
                {selectedProvinceName
                  ? `${renderedFeatureCount.toLocaleString()} rendered items in ${selectedProvinceName}`
                  : 'Choose a province polygon to begin planning'}
              </div>
              <p className="text-xs text-slate-500">
                OpenStreetMap raster basemap.{' '}
                {selectedProvinceName
                  ? `${renderedPointCoverage.toLocaleString()} nearby nodes are cached for this view.`
                  : '(c) OpenStreetMap contributors'}
              </p>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

export function emptyImportedFeatureCollection(): ImportedFeatureCollection {
  return {
    ...(EMPTY_COLLECTION as ImportedFeatureCollection),
    meta: {
      mapId: '',
      provinceId: null,
      bbox: null,
      limit: 0,
      truncated: false,
    },
  }
}
