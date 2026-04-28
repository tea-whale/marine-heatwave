import * as turf from '@turf/turf'
import Graphic from '@arcgis/core/Graphic'

const BBOX = [118, 24, 130, 36]
const TARGET_MAX_HEX = 3000
const TARGET_SPACING_DEG = 0.1
const INDEX_BIN_DEG = 0.5
const IDW_NEIGHBORS = 4
const IDW_POWER = 2
const EPS = 1e-9

function toCellKey(lon, lat) {
  const x = Math.floor((lon - BBOX[0]) / INDEX_BIN_DEG)
  const y = Math.floor((lat - BBOX[1]) / INDEX_BIN_DEG)
  return `${x}_${y}`
}

function buildDocIndex(docs) {
  const index = new Map()
  for (const d of docs) {
    if (!Number.isFinite(d?.lon) || !Number.isFinite(d?.lat) || !Number.isFinite(d?.anomaly)) {
      continue
    }
    const key = toCellKey(d.lon, d.lat)
    if (!index.has(key)) index.set(key, [])
    index.get(key).push(d)
  }
  return index
}

function findNearestDocs(index, lon, lat, k = IDW_NEIGHBORS) {
  const cx = Math.floor((lon - BBOX[0]) / INDEX_BIN_DEG)
  const cy = Math.floor((lat - BBOX[1]) / INDEX_BIN_DEG)
  const candidates = []

  // 从近到远扫描网格环，优先在局部找到最近邻
  for (let radius = 0; radius <= 3; radius += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        if (radius > 0 && Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue
        const arr = index.get(`${cx + dx}_${cy + dy}`)
        if (!arr) continue
        for (const p of arr) {
          const dLon = p.lon - lon
          const dLat = p.lat - lat
          const dist2 = dLon * dLon + dLat * dLat
          candidates.push({ p, dist2 })
        }
      }
    }
    if (candidates.length >= k) break
  }

  if (candidates.length === 0) return []
  candidates.sort((a, b) => a.dist2 - b.dist2)
  return candidates.slice(0, k)
}

function idwAnomaly(index, lon, lat) {
  const nearest = findNearestDocs(index, lon, lat, IDW_NEIGHBORS)
  if (nearest.length === 0) return null

  let num = 0
  let den = 0
  for (const item of nearest) {
    if (item.dist2 < EPS) return item.p.anomaly
    const w = 1 / Math.pow(Math.sqrt(item.dist2), IDW_POWER)
    num += w * item.p.anomaly
    den += w
  }
  return den > 0 ? num / den : null
}

function updateRendererStops(layer, values) {
  if (!values.length) return
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const minAnom = sorted[Math.floor(n * 0.05)]
  const maxAnom = sorted[Math.floor(n * 0.95)]

  layer.renderer = {
    type: 'simple',
    symbol: {
      type: 'simple-fill',
      color: [255, 255, 255, 0.05],
      outline: { width: 0 }
    },
    visualVariables: [
      {
        type: 'color',
        field: 'anomaly',
        stops: [
          { value: minAnom, color: [0, 0, 139, 0.85] },
          { value: minAnom / 2, color: [0, 180, 255, 0.7] },
          { value: 0, color: [255, 255, 255, 0.1] },
          { value: maxAnom / 2, color: [255, 200, 0, 0.8] },
          { value: maxAnom, color: [220, 20, 20, 0.9] }
        ]
      }
    ]
  }
}

export function buildHexGrid() {
  if (window.__hexGrid && Array.isArray(window.__hexGrid.features)) {
    return window.__hexGrid
  }

  // 0.1° 约等于 11.1km（纬向）
  let cellSideKm = TARGET_SPACING_DEG * 111
  let grid = turf.hexGrid(BBOX, cellSideKm, { units: 'kilometers' })

  if (grid.features.length > TARGET_MAX_HEX) {
    const ratio = Math.sqrt(grid.features.length / TARGET_MAX_HEX) * 1.05
    cellSideKm = cellSideKm * ratio
    grid = turf.hexGrid(BBOX, cellSideKm, { units: 'kilometers' })
  }

  grid.features.forEach((feature, idx) => {
    const c = turf.centroid(feature)
    const [lon, lat] = c.geometry.coordinates
    feature.properties = {
      ...(feature.properties || {}),
      hexId: idx + 1,
      centroidLon: lon,
      centroidLat: lat,
      anomaly: 0
    }
  })

  window.__hexGrid = grid
  return grid
}

export function applySmoothedData(docs, layer) {
  const hexGrid = buildHexGrid()
  const safeDocs = Array.isArray(docs) ? docs : []
  const docIndex = buildDocIndex(safeDocs)
  const features = hexGrid.features
  const graphics = new Array(features.length)
  const anomalies = []

  return new Promise((resolve) => {
    let i = 0
    const chunkSize = 300

    const step = () => {
      const end = Math.min(i + chunkSize, features.length)
      for (; i < end; i += 1) {
        const f = features[i]
        const { centroidLon, centroidLat, hexId } = f.properties
        const anomaly = idwAnomaly(docIndex, centroidLon, centroidLat)
        const val = Number.isFinite(anomaly) ? anomaly : null
        f.properties.anomaly = val
        if (val !== null) anomalies.push(val)

        graphics[i] = new Graphic({
          geometry: {
            type: 'polygon',
            rings: f.geometry.coordinates[0],
            spatialReference: { wkid: 4326 }
          },
          attributes: {
            ObjectID: hexId,
            anomaly: val
          }
        })
      }

      if (i < features.length) {
        requestAnimationFrame(step)
        return
      }

      // GraphicsLayer: 直接更新 source，避免重复构建 GeoJSONLayer URL
      if (typeof layer.removeAll === 'function' && typeof layer.addMany === 'function') {
        layer.removeAll()
        layer.addMany(graphics)
      } else if ('source' in layer) {
        layer.source = graphics
      }

      updateRendererStops(layer, anomalies)
      resolve({ featureCount: features.length, validCount: anomalies.length })
    }

    requestAnimationFrame(step)
  })
}
