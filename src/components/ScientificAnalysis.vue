<script setup>
import { ref, watch, onBeforeUnmount, nextTick, reactive } from 'vue'
import { ElMessage } from 'element-plus'
import { Search, Download, Close, DataAnalysis, Odometer } from '@element-plus/icons-vue'
import axios from 'axios'
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer'
import Graphic from '@arcgis/core/Graphic'
import Point from '@arcgis/core/geometry/Point'
import Polyline from '@arcgis/core/geometry/Polyline'
import * as geometryEngine from '@arcgis/core/geometry/geometryEngine'

// ==================== Props ====================
const props = defineProps({
  map: { type: Object, default: null },
  view: { type: Object, default: null },
  date: { type: String, default: '2025-08-01' }
})

// ==================== 辅助函数 ====================
const getMap = () => props.map || window.map
const getView = () => props.view || window.view

const API = 'http://localhost:3000'

// ==================== 响应式状态 ====================
const visible = ref(false)
const currentMode = ref('hotspot') // 'hotspot' | 'isotherm'
const calculating = ref(false)
const hasResults = ref(false)

// 冷热点分析参数
const hotspotThreshold = ref(0.8)  // 空间权重距离阈值（度）
const hotspotZThreshold = ref(1.96) // Z分数阈值 (95%置信度 = 1.96, 99% = 2.58)

// 等温线分析参数
const contourInterval = ref(0.5)    // 等温线间隔（°C）
const gridResolution = ref(0.1)     // 插值网格分辨率（度）
const contourLevels = ref([])       // 计算出的等温线级别列表

// 结果统计
const hotspotStats = reactive({
  totalPoints: 0,
  hotSpots: 0,
  coldSpots: 0,
  maxZScore: 0,
  minZScore: 0,
  avgAnomaly: 0
})

const isothermStats = reactive({
  totalContours: 0,
  levelRange: '',
  gridPoints: 0
})

// 缓存原始数据用于导出
let cachedSSTData = []
let cachedHotspotResults = []
let cachedContourData = []

// ==================== 图层引用 ====================
let hotspotLayer = null
let isothermLayer = null

// ==================== 方法 ====================

/** 确保图层已初始化 */
function initLayers() {
  const map = getMap()
  if (!map) return

  if (!hotspotLayer) {
    hotspotLayer = new GraphicsLayer({ title: '冷热点分析', listMode: 'hide' })
    map.add(hotspotLayer, 10)
  }
  if (!isothermLayer) {
    isothermLayer = new GraphicsLayer({ title: '等温线分析', listMode: 'hide' })
    map.add(isothermLayer, 10)
  }
}

/** 清除图层 */
function clearLayers() {
  if (hotspotLayer) hotspotLayer.removeAll()
  if (isothermLayer) isothermLayer.removeAll()
  hasResults.value = false
}

/** 打开面板 */
function openPanel(mode) {
  visible.value = true
  if (mode) currentMode.value = mode
  nextTick(() => initLayers())
}

/** 关闭面板 */
function closePanel() {
  visible.value = false
  clearLayers()
}

/** 切换到冷热点分析 */
function switchToHotspot() {
  currentMode.value = 'hotspot'
  if (isothermLayer) isothermLayer.removeAll()
}

/** 切换到等温线分析 */
function switchToIsotherm() {
  currentMode.value = 'isotherm'
  if (hotspotLayer) hotspotLayer.removeAll()
}

// ==================== 冷热点分析：Getis-Ord Gi* ====================

/**
 * 计算 Getis-Ord Gi* 统计量
 */
function computeGetisOrdGi(points, distanceThreshold) {
  const n = points.length
  if (n < 3) {
    ElMessage.warning('数据点过少（<3），无法进行冷热点分析')
    return []
  }

  // 计算均值和标准差
  const values = points.map(p => p.anomaly)
  const mean = values.reduce((a, b) => a + b, 0) / n
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n
  const std = Math.sqrt(variance)

  if (std === 0) {
    ElMessage.warning('所有数据值相同，无法计算Gi*统计量')
    return []
  }

  // 构建空间权重矩阵（距离阈值内为1，否则为0）
  // 使用简单的O(n²)计算，对于中等规模数据可接受
  const weights = []
  for (let i = 0; i < n; i++) {
    const rowWeights = []
    for (let j = 0; j < n; j++) {
      if (i === j) {
        rowWeights.push(1) // 自相关包含自身
        continue
      }
      const dLon = points[i].lon - points[j].lon
      const dLat = points[i].lat - points[j].lat
      const dist = Math.sqrt(dLon * dLon + dLat * dLat)
      rowWeights.push(dist <= distanceThreshold ? 1 : 0)
    }
    weights.push(rowWeights)
  }

  // 计算每个点的 Gi*
  const results = []
  for (let i = 0; i < n; i++) {
    let sumWij = 0
    let sumWijXj = 0
    let sumWijSq = 0

    for (let j = 0; j < n; j++) {
      sumWij += weights[i][j]
      sumWijXj += weights[i][j] * values[j]
      sumWijSq += weights[i][j] * weights[i][j]
    }

    const expected = mean * sumWij
    const numerator = sumWijXj - expected
    const denominator = std * Math.sqrt((n * sumWijSq - sumWij * sumWij) / (n - 1))

    const giStar = denominator !== 0 ? numerator / denominator : 0

    results.push({
      lon: points[i].lon,
      lat: points[i].lat,
      anomaly: points[i].anomaly,
      giStar,
      classification: giStar > hotspotZThreshold.value ? 'hot' :
                       giStar < -hotspotZThreshold.value ? 'cold' : 'neutral'
    })
  }

  return results
}

/** 执行冷热点分析 */
async function runHotspotAnalysis() {
  const view = getView()
  const map = getMap()
  if (!view || !map) { ElMessage.error('地图尚未初始化'); return }

  calculating.value = true
  clearLayers()
  initLayers()

  try {
    const { data } = await axios.get(`${API}/api/sst/all`, { params: { date: props.date } })
    const docs = Array.isArray(data) ? data : []

    if (docs.length === 0) {
      ElMessage.warning(`日期 ${props.date} 没有海温数据`)
      calculating.value = false
      return
    }

    const validDocs = docs.filter(d =>
      Number.isFinite(Number(d.lon)) && Number.isFinite(Number(d.lat)) && Number.isFinite(Number(d.anomaly))
    ).map(d => ({ lon: Number(d.lon), lat: Number(d.lat), anomaly: Number(d.anomaly) }))

    cachedSSTData = validDocs

    // 计算 Gi*
    const results = computeGetisOrdGi(validDocs, hotspotThreshold.value)
    cachedHotspotResults = results

    if (results.length === 0) { calculating.value = false; return }

    // 统计
    const hotSpots = results.filter(r => r.classification === 'hot')
    const coldSpots = results.filter(r => r.classification === 'cold')
    const zScores = results.map(r => r.giStar)

    hotspotStats.totalPoints = results.length
    hotspotStats.hotSpots = hotSpots.length
    hotspotStats.coldSpots = coldSpots.length
    hotspotStats.maxZScore = Math.max(...zScores)
    hotspotStats.minZScore = Math.min(...zScores)
    hotspotStats.avgAnomaly = validDocs.reduce((s, d) => s + d.anomaly, 0) / validDocs.length

    // 绘制结果
    for (const r of results) {
      let color, size, label
      if (r.classification === 'hot') {
        color = [220, 38, 38, 0.9]   // 红色热区
        size = 18
        label = '热点'
      } else if (r.classification === 'cold') {
        color = [30, 64, 175, 0.9]    // 蓝色冷区
        size = 18
        label = '冷点'
      } else {
        color = [156, 163, 175, 0.45] // 灰色中性
        size = 10
        label = '中性'
      }

      hotspotLayer.add(new Graphic({
        geometry: new Point({
          longitude: r.lon,
          latitude: r.lat,
          spatialReference: { wkid: 4326 }
        }),
        attributes: {
          anomaly: r.anomaly.toFixed(3),
          giStar: r.giStar.toFixed(4),
          classification: r.classification
        },
        popupTemplate: {
          title: `🔬 ${label} - 冷热点分析`,
          content: `
            <b>距平值：</b>${r.anomaly.toFixed(3)} °C<br>
            <b>Gi* Z-score：</b>${r.giStar.toFixed(4)}<br>
            <b>分类：</b>${r.classification === 'hot' ? '🔥 热点 (高值聚集)' : r.classification === 'cold' ? '❄️ 冷点 (低值聚集)' : '中性'}<br>
            <b>位置：</b>(${r.lon.toFixed(3)}, ${r.lat.toFixed(3)})
          `
        },
        symbol: {
          type: 'simple-marker',
          style: 'circle',
          color,
          size,
          outline: { color: r.classification !== 'neutral' ? [255, 255, 255, 1] : [180, 180, 180, 0.5], width: r.classification !== 'neutral' ? 2 : 1 }
        }
      }))
    }

    hasResults.value = true

    // 缩放到数据范围
    const lons = validDocs.map(d => d.lon)
    const lats = validDocs.map(d => d.lat)
    if (lons.length > 0) {
      const extent = {
        xmin: Math.min(...lons) - 0.5,
        ymin: Math.min(...lats) - 0.5,
        xmax: Math.max(...lons) + 0.5,
        ymax: Math.max(...lats) + 0.5,
        spatialReference: { wkid: 4326 }
      }
      view.goTo(extent, { duration: 800 })
    }

    ElMessage.success(`冷热点分析完成：发现 ${hotSpots.length} 个热点，${coldSpots.length} 个冷点`)
  } catch (e) {
    console.error('冷热点分析失败:', e)
    ElMessage.error('分析失败：' + (e.message || '未知错误'))
  } finally {
    calculating.value = false
  }
}

// ==================== 等温线分析 ====================

/**
 * IDW 插值到规则网格
 */
function idwInterpolateGrid(points, bbox, resLon, resLat) {
  const cols = Math.ceil((bbox.xmax - bbox.xmin) / resLon) + 1
  const rows = Math.ceil((bbox.ymax - bbox.ymin) / resLat) + 1
  const grid = []

  for (let row = 0; row < rows; row++) {
    const rowValues = []
    const lat = bbox.ymax - row * resLat
    for (let col = 0; col < cols; col++) {
      const lon = bbox.xmin + col * resLon
      // IDW 插值
      let num = 0, den = 0
      for (const p of points) {
        const dLon = p.lon - lon
        const dLat = p.lat - lat
        const dist = Math.sqrt(dLon * dLon + dLat * dLat)
        if (dist < 0.001) {
          num = p.anomaly
          den = 1
          break
        }
        const w = 1 / (dist * dist) // inverse square distance
        num += w * p.anomaly
        den += w
      }
      rowValues.push(den > 0 ? num / den : null)
    }
    grid.push(rowValues)
  }

  return { grid, cols, rows, bbox }
}

/**
 * Marching Squares 提取等温线
 * 返回 { level, polylines: [[[lon, lat], ...], ...] }
 */
function marchContours(gridData, level) {
  const { grid, cols, rows, bbox } = gridData
  const cellW = (bbox.xmax - bbox.xmin) / Math.max(cols - 1, 1)
  const cellH = (bbox.ymax - bbox.ymin) / Math.max(rows - 1, 1)
  const segments = []

  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const tl = grid[r][c]
      const tr = grid[r][c + 1]
      const br = grid[r + 1][c + 1]
      const bl = grid[r + 1][c]
      if ([tl, tr, br, bl].some(v => v === null)) continue

      const cellX = bbox.xmin + c * cellW
      const cellY = bbox.ymax - r * cellH

      // 计算单元格case（0-15）
      let caseIndex = 0
      if (tl >= level) caseIndex |= 8
      if (tr >= level) caseIndex |= 4
      if (br >= level) caseIndex |= 2
      if (bl >= level) caseIndex |= 1

      if (caseIndex === 0 || caseIndex === 15) continue

      // 插值各边交点
      const topX = cellX + ((level - tl) / (tr - tl)) * cellW
      const rightY = cellY - ((level - tr) / (br - tr)) * cellH
      const bottomX = cellX + ((level - bl) / (br - bl)) * cellW
      const leftY = cellY - ((level - tl) / (bl - tl)) * cellH
      const centerX = (cellX + cellW / 2)
      const centerY = (cellY - cellH / 2)
      const centerVal = (tl + tr + br + bl) / 4

      // 根据case生成线段
      const topPt = [topX, cellY]
      const rightPt = [cellX + cellW, rightY]
      const bottomPt = [bottomX, cellY - cellH]
      const leftPt = [cellX, leftY]

      let caseSegs = []
      switch (caseIndex) {
        case 1: case 14: caseSegs = [[leftPt, bottomPt]]; break
        case 2: case 13: caseSegs = [[bottomPt, rightPt]]; break
        case 3: case 12: caseSegs = [[leftPt, rightPt]]; break
        case 4: case 11: caseSegs = [[topPt, rightPt]]; break
        case 5:
          caseSegs = [[leftPt, topPt], [bottomPt, rightPt]]; break
        case 6: case 9: caseSegs = [[topPt, bottomPt]]; break
        case 7: case 8: caseSegs = [[leftPt, topPt]]; break
        case 10:
          caseSegs = [[topPt, rightPt], [bottomPt, leftPt]]; break
        default: break
      }
      for (const seg of caseSegs) {
        segments.push(seg)
      }
    }
  }

  // 连接线段为折线
  const polylines = connectSegments(segments)
  return { level, polylines }
}

/**
 * 简单线段连接算法
 */
function connectSegments(segments) {
  if (segments.length === 0) return []

  const EPS = 0.001
  const remaining = segments.map((s, i) => ({ seg: s, idx: i, used: false }))
  const polylines = []

  for (let i = 0; i < remaining.length; i++) {
    if (remaining[i].used) continue

    const polyline = [remaining[i].seg[0], remaining[i].seg[1]]
    remaining[i].used = true
    let changed = true

    while (changed) {
      changed = false
      const head = polyline[0]
      const tail = polyline[polyline.length - 1]

      for (let j = 0; j < remaining.length; j++) {
        if (remaining[j].used) continue
        const s = remaining[j].seg

        // 检查是否连接到头部
        const d1 = dist(s[1], head)
        const d2 = dist(s[0], head)
        if (d1 < EPS || d2 < EPS) {
          if (d1 < EPS) polyline.unshift(s[0])
          else polyline.unshift(s[1])
          remaining[j].used = true
          changed = true
          break
        }

        // 检查是否连接到尾部
        const d3 = dist(s[0], tail)
        const d4 = dist(s[1], tail)
        if (d3 < EPS || d4 < EPS) {
          if (d3 < EPS) polyline.push(s[1])
          else polyline.push(s[0])
          remaining[j].used = true
          changed = true
          break
        }
      }
    }

    if (polyline.length >= 2) polylines.push(polyline)
  }

  return polylines
}

function dist(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2)
}

/** 执行等温线分析 */
async function runIsothermAnalysis() {
  const view = getView()
  const map = getMap()
  if (!view || !map) { ElMessage.error('地图尚未初始化'); return }

  calculating.value = true
  clearLayers()
  initLayers()

  try {
    const { data } = await axios.get(`${API}/api/sst/all`, { params: { date: props.date } })
    const docs = Array.isArray(data) ? data : []

    if (docs.length === 0) {
      ElMessage.warning(`日期 ${props.date} 没有海温数据`)
      calculating.value = false
      return
    }

    const validDocs = docs.filter(d =>
      Number.isFinite(Number(d.lon)) && Number.isFinite(Number(d.lat)) && Number.isFinite(Number(d.anomaly))
    ).map(d => ({ lon: Number(d.lon), lat: Number(d.lat), anomaly: Number(d.anomaly) }))
    cachedSSTData = validDocs

    // 计算数据范围
    const lons = validDocs.map(d => d.lon)
    const lats = validDocs.map(d => d.lat)
    const anomalies = validDocs.map(d => d.anomaly)
    const dataMin = Math.min(...anomalies)
    const dataMax = Math.max(...anomalies)

    const bbox = {
      xmin: Math.min(...lons) - 0.3,
      ymin: Math.min(...lats) - 0.3,
      xmax: Math.max(...lons) + 0.3,
      ymax: Math.max(...lats) + 0.3
    }

    // 计算等温线级别
    const res = gridResolution.value
    const gridData = idwInterpolateGrid(validDocs, bbox, res, res)
    isothermStats.gridPoints = gridData.cols * gridData.rows

    // 确定等温线级别范围
    const interval = contourInterval.value
    const startLevel = Math.floor(dataMin / interval) * interval
    const endLevel = Math.ceil(dataMax / interval) * interval
    const levels = []
    for (let l = startLevel; l <= endLevel; l += interval) {
      levels.push(Math.round(l * 100) / 100) // 避免浮点精度问题
    }
    contourLevels.value = levels

    // 生成等温线
    const allContourResults = []
    for (const level of levels) {
      const result = marchContours(gridData, level)
      allContourResults.push(result)
    }

    cachedContourData = { gridData, levels, allContourResults, bbox }
    isothermStats.totalContours = allContourResults.reduce((s, c) => s + c.polylines.length, 0)
    isothermStats.levelRange = `${levels[0]} ~ ${levels[levels.length - 1]} °C (间隔 ${interval}°C)`

    // 绘制等温线
    const lineColors = [
      [30, 136, 229],   // 蓝
      [0, 200, 83],     // 绿
      [255, 193, 7],    // 黄
      [255, 87, 34],    // 橙
      [213, 0, 0],      // 红
    ]

    let drawnCount = 0
    for (const cr of allContourResults) {
      const colorIdx = Math.min(Math.floor((cr.level - (levels[0] || 0)) / interval) % lineColors.length, lineColors.length - 1)
      const safeIdx = Math.max(0, colorIdx)
      const [r, g, b] = lineColors[safeIdx]
      const isMainLine = Math.abs(cr.level % (interval * 2)) < 0.001 // 主线加粗

      for (const polyline of cr.polylines) {
        if (polyline.length < 2) continue
        isothermLayer.add(new Graphic({
          geometry: new Polyline({
            paths: [polyline],
            spatialReference: { wkid: 4326 }
          }),
          attributes: {
            level: cr.level,
            label: `${cr.level.toFixed(1)} °C`
          },
          popupTemplate: {
            title: '🌡 等温线',
            content: `<b>距平值：</b>${cr.level.toFixed(1)} °C`
          },
          symbol: {
            type: 'simple-line',
            color: [r, g, b, 0.85],
            width: isMainLine ? 2.5 : 1.5,
            style: isMainLine ? 'solid' : 'dash'
          }
        }))
        drawnCount++
      }
    }

    hasResults.value = true

    // 缩放到数据范围
    view.goTo({
      xmin: bbox.xmin, ymin: bbox.ymin,
      xmax: bbox.xmax, ymax: bbox.ymax,
      spatialReference: { wkid: 4326 }
    }, { duration: 800 })

    ElMessage.success(`等温线分析完成：生成 ${drawnCount} 条等温线 (${levels.length} 个级别)`)
  } catch (e) {
    console.error('等温线分析失败:', e)
    ElMessage.error('分析失败：' + (e.message || '未知错误'))
  } finally {
    calculating.value = false
  }
}

/** 统一分析入口 */
function runAnalysis() {
  if (currentMode.value === 'hotspot') {
    runHotspotAnalysis()
  } else {
    runIsothermAnalysis()
  }
}

// ==================== 导出功能 ====================

/** 通用下载辅助 */
function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  ElMessage.success(`文件已导出：${filename}`)
}

/** 导出冷热点分析结果 */
function exportHotspotResults() {
  if (cachedHotspotResults.length === 0) {
    ElMessage.warning('请先执行冷热点分析')
    return
  }

  const features = cachedHotspotResults.map(r => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
    properties: {
      anomaly: r.anomaly,
      giStar: r.giStar,
      classification: r.classification
    }
  }))

  const geojson = {
    type: 'FeatureCollection',
    features,
    metadata: {
      analysis: 'Getis-Ord Gi* 冷热点分析',
      date: props.date,
      distanceThreshold: hotspotThreshold.value,
      zScoreThreshold: hotspotZThreshold.value,
      stats: { ...hotspotStats },
      timestamp: new Date().toISOString()
    }
  }

  const filename = `冷热点分析_${props.date}.geojson`
  downloadFile(JSON.stringify(geojson, null, 2), filename, 'application/geo+json')

  // 同时导出CSV
  exportHotspotCSV()
}

/** 导出冷热点分析CSV */
function exportHotspotCSV() {
  if (cachedHotspotResults.length === 0) return

  let csv = 'lon,lat,anomaly,giStar,classification\n'
  for (const r of cachedHotspotResults) {
    csv += `${r.lon},${r.lat},${r.anomaly},${r.giStar},${r.classification}\n`
  }

  downloadFile(csv, `冷热点分析_${props.date}.csv`, 'text/csv;charset=utf-8')
}

/** 导出等温线结果 */
function exportIsothermResults() {
  if (!cachedContourData || cachedContourData.allContourResults.length === 0) {
    ElMessage.warning('请先执行等温线分析')
    return
  }

  const features = []
  for (const cr of cachedContourData.allContourResults) {
    for (const polyline of cr.polylines) {
      if (polyline.length < 2) continue
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: polyline },
        properties: {
          level: cr.level,
          label: `${cr.level.toFixed(1)} °C`,
          pointCount: polyline.length
        }
      })
    }
  }

  const geojson = {
    type: 'FeatureCollection',
    features,
    metadata: {
      analysis: '等温线分析',
      date: props.date,
      contourInterval: contourInterval.value,
      gridResolution: gridResolution.value,
      stats: { ...isothermStats },
      timestamp: new Date().toISOString()
    }
  }

  const filename = `等温线分析_${props.date}.geojson`
  downloadFile(JSON.stringify(geojson, null, 2), filename, 'application/geo+json')
}

// ==================== 暴露给父组件 ====================
defineExpose({ openPanel })

// ==================== 生命周期 ====================
onBeforeUnmount(() => {
  clearLayers()
  const map = getMap()
  if (map) {
    if (hotspotLayer) { map.remove(hotspotLayer); hotspotLayer = null }
    if (isothermLayer) { map.remove(isothermLayer); isothermLayer = null }
  }
})
</script>

<template>
  <!-- ========== 触发按钮 ========== -->
  <div class="scientific-trigger" v-if="!visible">
    <el-tooltip content="科学分析" placement="left">
      <el-button
        type="primary"
        circle
        size="large"
        @click="openPanel()"
        class="trigger-btn"
      >
        <el-icon :size="20"><DataAnalysis /></el-icon>
      </el-button>
    </el-tooltip>
  </div>

  <!-- ========== 分析面板 ========== -->
  <div class="scientific-panel-backdrop" v-if="visible" @click.self="closePanel">
    <div class="scientific-panel">
      <!-- 标题栏 -->
      <div class="panel-header">
        <span class="panel-title">
          <el-icon :size="18"><DataAnalysis /></el-icon>
          科学分析
        </span>
        <el-button text circle size="small" @click="closePanel" class="close-btn">
          <el-icon :size="16"><Close /></el-icon>
        </el-button>
      </div>

      <!-- 模式切换 -->
      <div class="mode-tabs">
        <button
          :class="['mode-tab', { active: currentMode === 'hotspot' }]"
          @click="switchToHotspot"
        >
          🔥 冷热点分析
        </button>
        <button
          :class="['mode-tab', { active: currentMode === 'isotherm' }]"
          @click="switchToIsotherm"
        >
          🌡 等温线分析
        </button>
      </div>

      <!-- 面板内容 -->
      <div class="panel-body">
        <!-- 日期显示 -->
        <div class="field">
          <label class="field-label">海温数据日期</label>
          <div class="date-display">{{ props.date }}</div>
        </div>

        <!-- ===== 冷热点分析参数 ===== -->
        <template v-if="currentMode === 'hotspot'">
          <div class="field">
            <label class="field-label">空间权重距离阈值 (度)</label>
            <el-input-number
              v-model="hotspotThreshold"
              :min="0.1"
              :max="5.0"
              :step="0.1"
              :precision="1"
              size="default"
              class="field-input"
            />
            <span class="field-hint">两个数据点在此距离内视为空间相邻</span>
          </div>
          <div class="field">
            <label class="field-label">Z分数显著性阈值</label>
            <el-select v-model="hotspotZThreshold" size="default" class="field-input">
              <el-option :value="1.96" label="95% 置信度 (Z=1.96)" />
              <el-option :value="2.58" label="99% 置信度 (Z=2.58)" />
              <el-option :value="1.65" label="90% 置信度 (Z=1.65)" />
            </el-select>
          </div>
        </template>

        <!-- ===== 等温线分析参数 ===== -->
        <template v-if="currentMode === 'isotherm'">
          <div class="field">
            <label class="field-label">等温线间隔 (°C)</label>
            <el-input-number
              v-model="contourInterval"
              :min="0.1"
              :max="5.0"
              :step="0.1"
              :precision="1"
              size="default"
              class="field-input"
            />
          </div>
          <div class="field">
            <label class="field-label">插值网格分辨率 (度)</label>
            <el-input-number
              v-model="gridResolution"
              :min="0.02"
              :max="1.0"
              :step="0.02"
              :precision="2"
              size="default"
              class="field-input"
            />
            <span class="field-hint">值越小等温线越精细，计算越慢</span>
          </div>
        </template>

        <!-- 操作按钮 -->
        <div class="field actions">
          <el-button
            type="primary"
            :loading="calculating"
            @click="runAnalysis"
            :icon="DataAnalysis"
          >
            {{ calculating ? '分析中...' : (currentMode === 'hotspot' ? '执行冷热点分析' : '执行等温线分析') }}
          </el-button>
          <el-button
            :disabled="!hasResults"
            @click="clearLayers"
          >
            清除结果
          </el-button>
        </div>

        <!-- 导出按钮 -->
        <div class="field" v-if="hasResults">
          <el-button
            type="success"
            :icon="Download"
            @click="currentMode === 'hotspot' ? exportHotspotResults() : exportIsothermResults()"
            class="export-btn"
          >
            {{ currentMode === 'hotspot' ? '导出冷热点分析结果 (GeoJSON)' : '导出等温线结果 (GeoJSON)' }}
          </el-button>
        </div>

        <!-- ===== 冷热点结果统计 ===== -->
        <div class="result-stats" v-if="hasResults && currentMode === 'hotspot'">
          <div class="stat-divider"></div>
          <div class="stat-row">
            <span class="stat-label">总数据点数：</span>
            <span class="stat-value">{{ hotspotStats.totalPoints }}</span>
          </div>
          <div class="stat-row hot">
            <span class="stat-label">🔥 热点数 (高值聚集)：</span>
            <span class="stat-value">{{ hotspotStats.hotSpots }}</span>
          </div>
          <div class="stat-row cold">
            <span class="stat-label">❄️ 冷点数 (低值聚集)：</span>
            <span class="stat-value">{{ hotspotStats.coldSpots }}</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">最大 Z-score：</span>
            <span class="stat-value">{{ hotspotStats.maxZScore.toFixed(4) }}</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">最小 Z-score：</span>
            <span class="stat-value">{{ hotspotStats.minZScore.toFixed(4) }}</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">平均距平：</span>
            <span class="stat-value">{{ hotspotStats.avgAnomaly.toFixed(3) }} °C</span>
          </div>
        </div>

        <!-- ===== 等温线结果统计 ===== -->
        <div class="result-stats" v-if="hasResults && currentMode === 'isotherm'">
          <div class="stat-divider"></div>
          <div class="stat-row">
            <span class="stat-label">等温线总数：</span>
            <span class="stat-value">{{ isothermStats.totalContours }}</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">级别范围：</span>
            <span class="stat-value">{{ isothermStats.levelRange }}</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">插值网格点数：</span>
            <span class="stat-value">{{ isothermStats.gridPoints }}</span>
          </div>
          <div class="stat-row" v-if="contourLevels.length > 0">
            <span class="stat-label">等温线级别：</span>
            <span class="stat-value levels">{{ contourLevels.map(l => l.toFixed(1)).join(', ') }} °C</span>
          </div>
        </div>

        <!-- 图例 -->
        <div class="legend-hint" v-if="hasResults && currentMode === 'hotspot'">
          <div class="legend-item">
            <span class="legend-swatch" style="background:rgba(220,38,38,0.9);border:2px solid #fff;border-radius:50%;"></span>
            <span>热点 (高值聚集)</span>
          </div>
          <div class="legend-item">
            <span class="legend-swatch" style="background:rgba(30,64,175,0.9);border:2px solid #fff;border-radius:50%;"></span>
            <span>冷点 (低值聚集)</span>
          </div>
          <div class="legend-item">
            <span class="legend-swatch" style="background:rgba(156,163,175,0.45);border:1px solid #b4b4b4;border-radius:50%;"></span>
            <span>中性 (不显著)</span>
          </div>
        </div>

        <div class="legend-hint" v-if="hasResults && currentMode === 'isotherm'">
          <div class="legend-item">
            <span class="legend-line" style="background:#1e88e5;"></span>
            <span>低温区等温线</span>
          </div>
          <div class="legend-item">
            <span class="legend-line" style="background:#ff8f00;"></span>
            <span>中温区等温线</span>
          </div>
          <div class="legend-item">
            <span class="legend-line" style="background:#d50000;"></span>
            <span>高温区等温线</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ===== 触发按钮 ===== */
.scientific-trigger {
  position: fixed;
  bottom: 80px;
  right: 32px;
  z-index: 1000;
}

.trigger-btn {
  width: 48px;
  height: 48px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  background: linear-gradient(135deg, #7c4dff, #651fff) !important;
  border: none !important;
}

.trigger-btn:hover {
  transform: scale(1.08);
  box-shadow: 0 6px 20px rgba(101, 31, 255, 0.4);
}

/* ===== 面板遮罩 ===== */
.scientific-panel-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2001;
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  padding: 100px 32px 0 0;
  pointer-events: none;
}

.scientific-panel {
  pointer-events: all;
  width: 380px;
  max-height: calc(100vh - 140px);
  background: rgba(255, 255, 255, 0.93);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.7);
  box-shadow: 0 12px 40px rgba(0, 20, 60, 0.2);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

/* ===== 标题栏 ===== */
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  background: linear-gradient(135deg, #ede7f6, #d1c4e9);
  border-radius: 12px 12px 0 0;
}

.panel-title {
  font-size: 16px;
  font-weight: 700;
  color: #311b92;
  letter-spacing: 0.5px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.close-btn {
  color: #546e7a;
}

.close-btn:hover {
  color: #d32f2f;
  background: rgba(211, 47, 47, 0.08);
}

/* ===== 模式切换 ===== */
.mode-tabs {
  display: flex;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  background: rgba(245, 240, 255, 0.4);
}

.mode-tab {
  flex: 1;
  padding: 10px 8px;
  border: none;
  background: transparent;
  font-size: 13px;
  font-weight: 600;
  color: #6a5acd;
  cursor: pointer;
  transition: all 0.2s;
  border-bottom: 3px solid transparent;
}

.mode-tab:hover {
  background: rgba(122, 77, 255, 0.08);
  color: #4a148c;
}

.mode-tab.active {
  color: #4a148c;
  border-bottom-color: #7c4dff;
  background: rgba(122, 77, 255, 0.12);
}

/* ===== 内容区 ===== */
.panel-body {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 13px;
  font-weight: 600;
  color: #37474f;
}

.field-input {
  width: 100%;
}

.field-hint {
  font-size: 11px;
  color: #90a4ae;
}

.date-display {
  font-size: 14px;
  color: #5e35b1;
  font-weight: 600;
  background: #ede7f6;
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid #d1c4e9;
}

.actions {
  flex-direction: row;
  gap: 10px;
}

.export-btn {
  width: 100%;
}

/* ===== 结果统计 ===== */
.stat-divider {
  height: 1px;
  background: rgba(0, 0, 0, 0.08);
}

.stat-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  padding: 4px 0;
}

.stat-label {
  color: #546e7a;
}

.stat-value {
  font-weight: 700;
  color: #5e35b1;
  font-size: 15px;
}

.stat-row.hot .stat-value {
  color: #c62828;
}

.stat-row.cold .stat-value {
  color: #1565c0;
}

.stat-value.levels {
  font-size: 11px;
  color: #7b1fa2;
  word-break: break-all;
  text-align: right;
  max-width: 200px;
}

/* ===== 图例 ===== */
.legend-hint {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 8px 0 0;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: #455a64;
}

.legend-swatch {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  border-radius: 50%;
}

.legend-line {
  width: 24px;
  height: 3px;
  flex-shrink: 0;
  border-radius: 2px;
}
</style>
