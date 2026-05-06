<script setup>
import { ref, watch, onBeforeUnmount, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import { Search, Delete, Close } from '@element-plus/icons-vue'
import axios from 'axios'
import * as geometryEngine from '@arcgis/core/geometry/geometryEngine'
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer'
import Graphic from '@arcgis/core/Graphic'
import Polygon from '@arcgis/core/geometry/Polygon'
import Point from '@arcgis/core/geometry/Point'

// ==================== Props ====================
const props = defineProps({
  map: { type: Object, default: null },
  view: { type: Object, default: null },
  date: { type: String, default: '2025-08-01' }
})

// ==================== 辅助函数 ====================
const getMap = () => props.map || window.map
const getView = () => props.view || window.view

const ANOMALY_THRESHOLD = 1.0
const API = 'http://localhost:3000'

// ==================== 响应式状态 ====================
const visible = ref(false)
const farms = ref([])
const selectedFarmId = ref(null)
const bufferDistance = ref(10)
const calculating = ref(false)
const intersectCount = ref(0)
const hasResults = ref(false)
const totalHotPoints = ref(0)

// ==================== 图层引用（模块级，非响应式） ====================
let bufferLayer = null
let intersectLayer = null
let highlightLayer = null

// ==================== 方法 ====================

/** 加载养殖区列表 */
async function loadFarms() {
  try {
    const { data } = await axios.get(`${API}/api/farms/in-view`)
    if (data?.features) {
      farms.value = data.features.map((f, idx) => ({
        id: f.properties?.ID ?? `farm-${idx}`,
        label: `养殖区 #${f.properties?.ID ?? (idx + 1)} (${f.properties?.Class ?? '未知'})`,
        geometry: f.geometry,
        properties: f.properties || {}
      }))
    }
  } catch (e) {
    console.error('加载养殖区列表失败:', e)
    ElMessage.error('加载养殖区列表失败，请检查后端服务')
  }
}

/** 初始化三个专属 GraphicsLayer */
function initLayers() {
  const map = getMap()
  if (!map) return

  if (!bufferLayer) {
    bufferLayer = new GraphicsLayer({ title: '缓冲区分析-缓冲区', listMode: 'hide' })
    map.add(bufferLayer)
  }
  if (!intersectLayer) {
    intersectLayer = new GraphicsLayer({ title: '缓冲区分析-相交异常点', listMode: 'hide' })
    map.add(intersectLayer)
  }
  if (!highlightLayer) {
    highlightLayer = new GraphicsLayer({ title: '缓冲区分析-选中养殖区', listMode: 'hide' })
    map.add(highlightLayer)
  }
}

/** 清除分析结果图层 */
function clearLayers() {
  if (bufferLayer) bufferLayer.removeAll()
  if (intersectLayer) intersectLayer.removeAll()
  if (highlightLayer) highlightLayer.removeAll()
  hasResults.value = false
  intersectCount.value = 0
  totalHotPoints.value = 0
}

/** 将 GeoJSON 几何转换为 ArcGIS Polygon */
function geoJSONToArcGISPolygon(geojson) {
  if (!geojson) return null
  const type = geojson.type
  let allRings = []

  if (type === 'Polygon') {
    allRings = geojson.coordinates
  } else if (type === 'MultiPolygon') {
    // 展开多层环
    allRings = geojson.coordinates.flat()
  } else {
    return null
  }

  return new Polygon({
    rings: allRings,
    spatialReference: { wkid: 4326 }
  })
}

/** 打开面板 */
function openPanel() {
  visible.value = true
  if (farms.value.length === 0) loadFarms()
  nextTick(() => initLayers())
}

/** 关闭面板并清理 */
function closePanel() {
  visible.value = false
  clearLayers()
}

/** 执行缓冲区分析 */
async function runAnalysis() {
  const view = getView()
  const map = getMap()

  if (!view || !map) {
    ElMessage.error('地图尚未初始化，请稍后再试')
    return
  }

  if (!selectedFarmId.value) {
    ElMessage.warning('请先选择一个养殖区')
    return
  }

  const dist = Number(bufferDistance.value)
  if (Number.isNaN(dist) || dist <= 0) {
    ElMessage.warning('请输入有效的缓冲距离（公里）')
    return
  }

  calculating.value = true
  clearLayers()
  // 确保图层已创建
  initLayers()

  try {
    // ─── 1. 获取选中养殖区几何 ───
    const farm = farms.value.find(f => f.id == selectedFarmId.value)
    if (!farm) { ElMessage.error('未找到选中的养殖区'); calculating.value = false; return }

    const farmGeom = geoJSONToArcGISPolygon(farm.geometry)
    if (!farmGeom) { ElMessage.error('养殖区几何数据无效'); calculating.value = false; return }

    // ─── 2. geodesicBuffer 生成缓冲区 ───
    const bufferResult = geometryEngine.geodesicBuffer(farmGeom, dist, 'kilometers')
    // geodesicBuffer 可能返回 Polygon 或 Polygon[]
    const bufferGeom = Array.isArray(bufferResult) ? bufferResult[0] : bufferResult
    if (!bufferGeom) { ElMessage.error('缓冲区生成失败'); calculating.value = false; return }

    // ─── 3. 在 bufferLayer 上绘制缓冲区 ───
    bufferLayer.add(new Graphic({
      geometry: bufferGeom,
      symbol: {
        type: 'simple-fill',
        color: [0, 119, 204, 0.12],
        outline: { color: [0, 119, 204, 0.85], width: 2.5, style: 'dash-dot' }
      }
    }))

    // ─── 4. 高亮选中的养殖区 ───
    highlightLayer.add(new Graphic({
      geometry: farmGeom,
      symbol: {
        type: 'simple-fill',
        color: [255, 238, 88, 0.3],
        outline: { color: [255, 193, 7, 1], width: 3 }
      }
    }))

    // ─── 5. 自动缩放至缓冲区 ───
    if (bufferGeom.extent) {
      view.goTo(bufferGeom.extent.expand(1.6), { duration: 800 })
    }

    // ─── 6. 加载当日海温距平数据 ───
    const { data } = await axios.get(`${API}/api/sst/all`, { params: { date: props.date } })
    const docs = Array.isArray(data) ? data : []
    if (docs.length === 0) {
      ElMessage.warning(`日期 ${props.date} 没有海温数据`)
      calculating.value = false
      return
    }

    // ─── 7. 筛选距平 > 2°C 的异常点 ───
    const hotPoints = docs.filter(d => {
      const a = Number(d?.anomaly)
      return Number.isFinite(a) && a > ANOMALY_THRESHOLD
    })
    totalHotPoints.value = hotPoints.length

    if (hotPoints.length === 0) {
      ElMessage.info(`当前日期 (${props.date}) 全球范围没有距平 > ${ANOMALY_THRESHOLD}°C 的异常点`)
      hasResults.value = true
      calculating.value = false
      return
    }

    // ─── 8. 用缓冲区 extent 粗筛候选点 ───
    const ext = bufferGeom.extent
    const pad = 0.5 // 额外 0.5° 缓冲区容差
    const candidates = hotPoints.filter(d =>
      d.lon >= ext.xmin - pad &&
      d.lon <= ext.xmax + pad &&
      d.lat >= ext.ymin - pad &&
      d.lat <= ext.ymax + pad
    )

    if (candidates.length === 0) {
      ElMessage.info(`缓冲区范围内没有距平 > ${ANOMALY_THRESHOLD}°C 的异常点`)
      hasResults.value = true
      calculating.value = false
      return
    }

    // ─── 9. geometryEngine.contains 精确相交判断 ───
    console.log(`[BufferAnalysis] 粗筛候选点: ${candidates.length}，缓冲区extent:`, bufferGeom.extent)
    const intersecting = []
    for (const d of candidates) {
      const pt = new Point({
        longitude: d.lon,
        latitude: d.lat,
        spatialReference: { wkid: 4326 }
      })
      // contains(polygon, point) 判断点是否在面内（含边界）
      if (geometryEngine.contains(bufferGeom, pt)) {
        intersecting.push(d)
      }
    }
    console.log(`[BufferAnalysis] 精确相交结果: ${intersecting.length} 个点`)

    // ─── 10. 在 intersectLayer 上绘制相交异常点 ───
    if (intersecting.length > 0) {
      for (const d of intersecting) {
        const anomaly = Number(d.anomaly)
        // 颜色: 距平值越高越红（2°C 橙色 → 5°C+ 深红）
        const intensity = Math.min(1, (anomaly - ANOMALY_THRESHOLD) / 3)
        const r = Math.round(220 + 35 * intensity)
        const g = Math.round(60 - 40 * intensity)
        const b = Math.round(60 - 40 * intensity)

        intersectLayer.add(new Graphic({
          geometry: new Point({
            longitude: d.lon,
            latitude: d.lat,
            spatialReference: { wkid: 4326 }
          }),
          attributes: { anomaly: anomaly.toFixed(2) },
          popupTemplate: {
            title: '🌡 相交异常点',
            content: `
              <b>距平值：</b>${anomaly.toFixed(3)} °C<br>
              <b>位置：</b>(${d.lon.toFixed(3)}, ${d.lat.toFixed(3)})<br>
              <b>缓冲距离：</b>${dist} km
            `
          },
          symbol: {
            type: 'simple-marker',
            style: 'circle',
            color: [r, g, b, 0.9],
            size: 16,
            outline: { color: [255, 255, 255, 1], width: 2 }
          }
        }))
      }
    }

    intersectCount.value = intersecting.length
    hasResults.value = true

    if (intersecting.length === 0) {
      ElMessage.info(`缓冲区内没有距平 > ${ANOMALY_THRESHOLD}°C 的异常点`)
    }
  } catch (e) {
    console.error('缓冲区分析失败:', e)
    ElMessage.error('分析失败：' + (e.message || '未知错误'))
  } finally {
    calculating.value = false
  }
}

// ==================== 暴露给父组件 ====================
defineExpose({ openPanel })

// ==================== 生命周期 ====================
watch(visible, (v) => {
  if (v && farms.value.length === 0) {
    loadFarms()
  }
})

onBeforeUnmount(() => {
  clearLayers()
  const map = getMap()
  if (map) {
    if (bufferLayer) { map.remove(bufferLayer); bufferLayer = null }
    if (intersectLayer) { map.remove(intersectLayer); intersectLayer = null }
    if (highlightLayer) { map.remove(highlightLayer); highlightLayer = null }
  }
})
</script>

<template>
  <!-- ========== 触发按钮（悬浮在地图右下角） ========== -->
  <div class="buffer-trigger" v-if="!visible">
    <el-tooltip content="缓冲区分析" placement="left">
      <el-button
        type="primary"
        circle
        size="large"
        @click="openPanel"
        class="trigger-btn"
      >
        <el-icon :size="20"><Search /></el-icon>
      </el-button>
    </el-tooltip>
  </div>

  <!-- ========== 分析面板（悬浮弹窗） ========== -->
  <div class="buffer-panel-backdrop" v-if="visible" @click.self="closePanel">
    <div class="buffer-panel">
      <!-- 面板标题栏 -->
      <div class="panel-header">
        <span class="panel-title">🔍 缓冲区分析</span>
        <el-button
          text
          circle
          size="small"
          @click="closePanel"
          class="close-btn"
        >
          <el-icon :size="16"><Close /></el-icon>
        </el-button>
      </div>

      <!-- 面板内容 -->
      <div class="panel-body">
        <!-- 养殖区选择 -->
        <div class="field">
          <label class="field-label">养殖区</label>
          <el-select
            v-model="selectedFarmId"
            placeholder="请选择养殖区"
            size="default"
            class="field-input"
            filterable
          >
            <el-option
              v-for="f in farms"
              :key="f.id"
              :label="f.label"
              :value="f.id"
            />
          </el-select>
        </div>

        <!-- 缓冲距离 -->
        <div class="field">
          <label class="field-label">缓冲距离 (公里)</label>
          <el-input-number
            v-model="bufferDistance"
            :min="0.1"
            :max="500"
            :step="1"
            :precision="1"
            size="default"
            class="field-input"
          />
        </div>

        <!-- 日期信息（只读） -->
        <div class="field">
          <label class="field-label">海温数据日期</label>
          <div class="date-display">{{ props.date }}</div>
        </div>

        <!-- 操作按钮 -->
        <div class="field actions">
          <el-button
            type="primary"
            :loading="calculating"
            @click="runAnalysis"
            :icon="Search"
          >
            {{ calculating ? '分析中...' : '执行分析' }}
          </el-button>
          <el-button
            :disabled="!hasResults"
            @click="clearLayers"
            :icon="Delete"
          >
            清除结果
          </el-button>
        </div>

        <!-- 结果统计 -->
        <div class="result-stats" v-if="hasResults">
          <div class="stat-divider"></div>
          <div class="stat-row">
            <span class="stat-label">全球异常点 (>{{ ANOMALY_THRESHOLD }}°C)：</span>
            <span class="stat-value">{{ totalHotPoints }}</span>
          </div>
          <div class="stat-row highlight">
            <span class="stat-label">与缓冲区相交：</span>
            <span class="stat-value warning" :class="{ zero: intersectCount === 0 }">
              {{ intersectCount }}
            </span>
          </div>
        </div>

        <!-- 图例提示 -->
        <div class="legend-hint" v-if="hasResults">
          <div class="legend-item">
            <span class="legend-swatch" style="background:rgba(0,119,204,0.2);border:2px dashed rgba(0,119,204,0.8);"></span>
            <span>缓冲区 ({{ bufferDistance }} km)</span>
          </div>
          <div class="legend-item">
            <span class="legend-swatch" style="background:rgba(255,193,7,0.5);border:2px solid #ffc107;"></span>
            <span>选中养殖区</span>
          </div>
          <div class="legend-item">
            <span class="legend-swatch" style="background:rgba(255,50,50,0.9);border:2px solid #fff;border-radius:50%;"></span>
            <span>相交异常点 ({{ intersectCount }} 个)</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ===== 触发按钮 ===== */
.buffer-trigger {
  position: fixed;
  bottom: 140px;
  right: 32px;
  z-index: 1000;
}

.trigger-btn {
  width: 48px;
  height: 48px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  background: linear-gradient(135deg, #1976d2, #0d47a1) !important;
  border: none !important;
}

.trigger-btn:hover {
  transform: scale(1.08);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
}

/* ===== 面板遮罩 ===== */
.buffer-panel-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  padding: 100px 32px 0 0;
  pointer-events: none;
}

.buffer-panel {
  pointer-events: all;
  width: 360px;
  max-height: calc(100vh - 140px);
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.7);
  box-shadow: 0 12px 40px rgba(0, 20, 60, 0.18);
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
  background: linear-gradient(135deg, #e3f2fd, #bbdefb);
  border-radius: 12px 12px 0 0;
}

.panel-title {
  font-size: 16px;
  font-weight: 700;
  color: #1a237e;
  letter-spacing: 0.5px;
}

.close-btn {
  color: #546e7a;
}

.close-btn:hover {
  color: #d32f2f;
  background: rgba(211, 47, 47, 0.08);
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

.date-display {
  font-size: 14px;
  color: #1565c0;
  font-weight: 600;
  background: #e3f2fd;
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid #bbdefb;
}

.actions {
  flex-direction: row;
  gap: 10px;
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
  padding: 2px 0;
}

.stat-label {
  color: #546e7a;
}

.stat-value {
  font-weight: 700;
  color: #1565c0;
  font-size: 16px;
}

.stat-value.warning {
  color: #c62828;
}

.stat-value.warning.zero {
  color: #9e9e9e;
}

.stat-row.highlight {
  background: #fff3e0;
  padding: 6px 10px;
  border-radius: 6px;
  margin-top: 2px;
}

/* ===== 图例 ===== */
.legend-hint {
  display: flex;
  flex-direction: column;
  gap: 8px;
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
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  border-radius: 3px;
}
</style>
