import type { Geometry } from 'geojson'

export type ParsedBbox = {
  minLng: number
  minLat: number
  maxLng: number
  maxLat: number
}

export type TileCoordinate = {
  x: number
  y: number
}

export type TileRange = {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export type TileRangeFromBboxesOptions = {
  requestBufferTiles?: number
  cacheBufferTiles?: number
}

function clampLatitude(value: number) {
  return Math.max(-85.05112878, Math.min(85.05112878, value))
}

function clampLongitude(value: number) {
  return Math.max(-180, Math.min(180, value))
}

export function parseBbox(value?: string | null): ParsedBbox | null {
  if (!value) {
    return null
  }

  const [minLng, minLat, maxLng, maxLat] = value.split(',').map((item) => Number(item.trim()))

  if (
    [minLng, minLat, maxLng, maxLat].some((item) => !Number.isFinite(item)) ||
    minLng >= maxLng ||
    minLat >= maxLat
  ) {
    return null
  }

  return {
    minLng,
    minLat,
    maxLng,
    maxLat,
  }
}

function extendBounds(bounds: ParsedBbox | null, [lng, lat]: [number, number]) {
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

function boundsFromCoordinates(
  coordinates: unknown,
  bounds: ParsedBbox | null = null,
): ParsedBbox | null {
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

  return coordinates.reduce<ParsedBbox | null>(
    (currentBounds, item) => boundsFromCoordinates(item, currentBounds),
    bounds,
  )
}

export function geometryBounds(geometry: Geometry | null | undefined) {
  if (!geometry) {
    return null
  }

  return boundsFromCoordinates((geometry as { coordinates?: unknown }).coordinates)
}

export function bboxContains(outerValue?: string | null, innerValue?: string | null) {
  const outer = parseBbox(outerValue)
  const inner = parseBbox(innerValue)

  if (!outer || !inner) {
    return false
  }

  return (
    inner.minLng >= outer.minLng &&
    inner.minLat >= outer.minLat &&
    inner.maxLng <= outer.maxLng &&
    inner.maxLat <= outer.maxLat
  )
}

export function clampTileZoom(viewZoom: number, minZoom = 0, maxZoom = 18) {
  if (!Number.isFinite(viewZoom)) {
    return minZoom
  }

  return Math.max(minZoom, Math.min(maxZoom, Math.floor(viewZoom)))
}

function longitudeToTile(longitude: number, zoom: number) {
  const scale = 2 ** zoom
  return Math.max(0, Math.min(scale - 1, Math.floor(((longitude + 180) / 360) * scale)))
}

function latitudeToTile(latitude: number, zoom: number) {
  const boundedLatitude = clampLatitude(latitude)
  const radians = (boundedLatitude * Math.PI) / 180
  const scale = 2 ** zoom
  const mercator =
    (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2

  return Math.max(0, Math.min(scale - 1, Math.floor(mercator * scale)))
}

export function bboxToTileRange(bbox: ParsedBbox, zoom: number): TileRange {
  return {
    minX: longitudeToTile(bbox.minLng, zoom),
    maxX: longitudeToTile(bbox.maxLng, zoom),
    minY: latitudeToTile(bbox.maxLat, zoom),
    maxY: latitudeToTile(bbox.minLat, zoom),
  }
}

export function tileKey(x: number, y: number) {
  return `${x}:${y}`
}

export function tileRangeKeys(range: TileRange) {
  const keys: string[] = []

  for (let x = range.minX; x <= range.maxX; x += 1) {
    for (let y = range.minY; y <= range.maxY; y += 1) {
      keys.push(tileKey(x, y))
    }
  }

  return keys
}

export function decodeTileKey(key: string): TileCoordinate {
  const [x, y] = key.split(':').map((value) => Number(value))
  return {
    x,
    y,
  }
}

function distanceToRange(tile: TileCoordinate, range: TileRange) {
  const dx =
    tile.x < range.minX ? range.minX - tile.x : tile.x > range.maxX ? tile.x - range.maxX : 0
  const dy =
    tile.y < range.minY ? range.minY - tile.y : tile.y > range.maxY ? tile.y - range.maxY : 0

  return dx + dy
}

export function orderedTileKeys(provinceRange: TileRange, visibleRange: TileRange) {
  const allKeys = tileRangeKeys(provinceRange)

  return allKeys.sort((leftKey, rightKey) => {
    const left = decodeTileKey(leftKey)
    const right = decodeTileKey(rightKey)
    const leftDistance = distanceToRange(left, visibleRange)
    const rightDistance = distanceToRange(right, visibleRange)

    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance
    }

    if (left.y !== right.y) {
      return left.y - right.y
    }

    return left.x - right.x
  })
}

export function clipTileRangeToTileRange(
  range: TileRange,
  bounds: TileRange,
): TileRange | null {
  const minX = Math.max(range.minX, bounds.minX)
  const maxX = Math.min(range.maxX, bounds.maxX)
  const minY = Math.max(range.minY, bounds.minY)
  const maxY = Math.min(range.maxY, bounds.maxY)

  if (minX > maxX || minY > maxY) {
    return null
  }

  return {
    minX,
    maxX,
    minY,
    maxY,
  }
}

export function expandTileRange(range: TileRange, bufferTiles: number): TileRange {
  const resolvedBufferTiles = Math.max(0, Math.floor(bufferTiles))

  return {
    minX: range.minX - resolvedBufferTiles,
    maxX: range.maxX + resolvedBufferTiles,
    minY: range.minY - resolvedBufferTiles,
    maxY: range.maxY + resolvedBufferTiles,
  }
}

export function tileRangeFromBboxes(
  provinceBbox: ParsedBbox,
  viewportBbox: ParsedBbox,
  zoom: number,
  options: TileRangeFromBboxesOptions = {},
) {
  const provinceRange = bboxToTileRange(provinceBbox, zoom)
  const visibleRange = bboxToTileRange(viewportBbox, zoom)
  const clippedVisibleRange = clipTileRangeToTileRange(visibleRange, provinceRange) ?? provinceRange
  const requestBufferTiles = Math.max(0, Math.floor(options.requestBufferTiles ?? 0))
  const cacheBufferTiles = Math.max(
    requestBufferTiles,
    Math.floor(options.cacheBufferTiles ?? requestBufferTiles),
  )
  const requestRange =
    clipTileRangeToTileRange(expandTileRange(clippedVisibleRange, requestBufferTiles), provinceRange) ??
    clippedVisibleRange
  const cacheRange =
    clipTileRangeToTileRange(expandTileRange(clippedVisibleRange, cacheBufferTiles), provinceRange) ??
    requestRange

  return {
    provinceRange,
    visibleRange: clippedVisibleRange,
    requestRange,
    cacheRange,
    orderedKeys: orderedTileKeys(requestRange, clippedVisibleRange),
    visibleKeys: tileRangeKeys(clippedVisibleRange),
    cacheKeys: orderedTileKeys(cacheRange, clippedVisibleRange),
  }
}
